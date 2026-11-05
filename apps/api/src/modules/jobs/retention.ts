/**
 * Data retention. Raw location history is deleted after each company's configured
 * period; attendance records themselves (times, status, evidence summary) are kept for
 * payroll/legal record keeping. Photos are deleted only where photoDeletionAllowed() says so,
 * never while they are in use (see PHOTO_IN_USE), and each deletion has its own audit entry.
 * Each run is summarised in that company's audit log.
 */
import { asSystem, one, q, tx, withOrg } from '../../db/pool.js';
import { eachCompany, eachRecord, throwIfAny } from './runner.js';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { deleteObject } from '../../lib/storage.js';
import { getSettings, photoDeletionAllowed } from '../settings/settings.service.js';

/** Runs retention for one company, or for every company when `orgId` is omitted. */
export async function runRetention(actor: AuthUser | null = null, orgId?: string, now = new Date()) {
  if (orgId) return withOrg(orgId, () => runForOrg(orgId, actor, now));
  let last: Awaited<ReturnType<typeof runForOrg>> | null = null;
  try {
    await eachCompany(async (id) => {
      last = await runForOrg(id, actor, now);
    });
  } finally {
    // Platform-wide housekeeping: expired refresh tokens, and the job records.
    await asSystem(async () => {
      await q(`DELETE FROM refresh_tokens WHERE expires_at < $1::timestamptz - interval '7 days'`, [now]);
      await q(`DELETE FROM job_failures WHERE at < $1::timestamptz - interval '30 days'`, [now]);
      await q(`DELETE FROM job_runs WHERE started_at < $1::timestamptz - CASE WHEN status = 'OK' THEN interval '3 days' ELSE interval '30 days' END`, [now]);
      await q(`DELETE FROM ops_alerts WHERE closed_at < $1::timestamptz - interval '90 days'`, [now]);
    });
  }
  return last;
}

/**
 * A photo someone still depends on: the face reference, or the evidence for anything not yet decided.
 * Its time being up does not matter until the decision is made. `$p` is the photo id.
 */
const PHOTO_IN_USE = (p: string) => `(
  EXISTS (SELECT 1 FROM employee_faces f WHERE f.photo_id = ${p})
  OR EXISTS (SELECT 1 FROM employee_face_profiles fp WHERE ${p} = ANY(fp.photo_ids))
  OR EXISTS (SELECT 1 FROM attendance_records ar WHERE (ar.photo_id = ${p} OR ar.end_photo_id = ${p})
     AND (ar.verification_status IN ('PENDING_VERIFICATION', 'DISPUTED') OR ar.face_review = 'PENDING'
          OR EXISTS (SELECT 1 FROM review_requests r WHERE r.attendance_id = ar.id AND r.status = 'OPEN')))
  OR EXISTS (SELECT 1 FROM overtime_entries o WHERE (o.start_photo_id = ${p} OR o.end_photo_id = ${p}) AND o.status = 'PENDING'))`;

/**
 * Deletes one photo. The row is locked and checked again first, in case it came into use after the list was
 * made. Its file goes last, inside the transaction: if storage fails nothing changes and the next run tries
 * again, and if the commit fails the next run finds the file already gone, which is not an error.
 */
async function deletePhoto(orgId: string, id: string, now: Date, actor: AuthUser | null) {
  return tx(async (db) => {
    const p = await one(
      `SELECT p.id, p.object_key, p.employee_id, p.status, p.retention_until FROM attendance_photos p
       WHERE p.id = $1 AND p.deleted_at IS NULL AND NOT ${PHOTO_IN_USE('p.id')} FOR UPDATE OF p`,
      [id],
      db,
    );
    if (!p) return false;
    await q(`UPDATE attendance_photos SET status = 'DELETED', deleted_at = $2, deleted_reason = 'retention policy' WHERE id = $1`, [id, now], db);
    await audit({ actor, orgId, action: 'attendance_photo.delete', resourceType: 'attendance_photo', resourceId: id, before: { status: p.status, employeeId: p.employee_id, retentionUntil: p.retention_until }, reason: 'retention policy' }, db);
    await deleteObject(p.object_key);
    return true;
  });
}

async function runForOrg(orgId: string, actor: AuthUser | null, now: Date) {
  const settings = await getSettings(orgId);
  const { retention } = settings;
  const inOrg = `employee_id IN (SELECT id FROM users WHERE org_id = $3)`;

  // 1. Raw location history (only of closed sessions — never cut a live session's trail).
  const loc = await q(
    `DELETE FROM location_updates lu USING tracking_sessions s
     WHERE lu.session_id = s.id AND s.ended_at IS NOT NULL AND lu.received_at < $1::timestamptz - make_interval(days => $2) AND lu.${inOrg}
     RETURNING lu.id`,
    [now, retention.locationDays, orgId],
  );
  await q(`DELETE FROM geofence_events WHERE event_time < $1::timestamptz - make_interval(days => $2) AND ${inOrg}`, [now, retention.locationDays, orgId]);
  await q(`DELETE FROM permission_status_events WHERE received_at < $1::timestamptz - make_interval(days => $2) AND ${inOrg}`, [now, retention.locationDays, orgId]);

  // 2. Photos: attached ones past retention, and abandoned uploads after a day.
  const photos = await q(
    `SELECT p.id FROM attendance_photos p
     WHERE p.deleted_at IS NULL AND p.employee_id IN (SELECT id FROM users WHERE org_id = $2)
       AND NOT ${PHOTO_IN_USE('p.id')}
       AND (
       (p.status = 'ATTACHED' AND p.retention_until IS NOT NULL AND p.retention_until < $1)
       OR (p.status IN ('PENDING_UPLOAD', 'UPLOADED', 'EXPIRED') AND p.created_at < $1::timestamptz - interval '1 day'))`,
    [now, orgId],
  );
  // On hold, the photos stay and are only counted, so the run can say what is waiting.
  const deleting = photoDeletionAllowed(settings);
  const photosHeld = deleting ? 0 : photos.length;
  let photosDeleted = 0;
  const failures = await eachRecord(deleting ? photos : [], async (p) => {
    if (await deletePhoto(orgId, p.id, now, actor)) photosDeleted++;
  });

  // 3. Old notifications.
  const notes = await q(`DELETE FROM notifications WHERE created_at < $1::timestamptz - make_interval(days => $2) AND org_id = $3 RETURNING id`, [now, retention.notificationDays, orgId]);

  const summary = { locationUpdatesDeleted: loc.length, photosDeleted, photosHeld, photosFailed: failures.length, notificationsDeleted: notes.length, policy: retention };
  if (actor || loc.length || photosDeleted || failures.length || notes.length) {
    await audit({ actor, orgId, action: 'retention.run', resourceType: 'retention', after: summary });
  }
  throwIfAny(failures); // a photo that could not be deleted must show as a failing job, not pass as a good run
  return summary;
}
