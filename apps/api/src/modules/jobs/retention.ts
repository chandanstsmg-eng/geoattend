/**
 * Data retention. Raw location history is deleted after each company's configured
 * period; attendance records themselves (times, status, evidence summary) are kept for
 * payroll/legal record keeping. Photos are deleted only where photoDeletionAllowed() says so.
 * Each run is summarised in that company's audit log.
 */
import { asSystem, q, withOrg } from '../../db/pool.js';
import { eachCompany } from './runner.js';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { deleteObject } from '../../lib/storage.js';
import { logger } from '../../lib/logger.js';
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
    // Platform-wide housekeeping: expired refresh tokens, and the job failure log.
    await asSystem(async () => {
      await q(`DELETE FROM refresh_tokens WHERE expires_at < $1::timestamptz - interval '7 days'`, [now]);
      await q(`DELETE FROM job_failures WHERE at < $1::timestamptz - interval '30 days'`, [now]);
    });
  }
  return last;
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
    `SELECT id, object_key FROM attendance_photos
     WHERE deleted_at IS NULL AND employee_id IN (SELECT id FROM users WHERE org_id = $2)
       AND id NOT IN (SELECT photo_id FROM employee_faces) -- reference photos for the face check are kept
       AND (
       (status = 'ATTACHED' AND retention_until IS NOT NULL AND retention_until < $1)
       OR (status IN ('PENDING_UPLOAD', 'UPLOADED', 'EXPIRED') AND created_at < $1::timestamptz - interval '1 day'))`,
    [now, orgId],
  );
  // On hold, the photos stay and are only counted, so the run can say what is waiting.
  const deleting = photoDeletionAllowed(settings);
  const photosHeld = deleting ? 0 : photos.length;
  let photosDeleted = 0;
  for (const p of deleting ? photos : []) {
    try {
      await deleteObject(p.object_key);
      await q(`UPDATE attendance_photos SET status = 'DELETED', deleted_at = now(), deleted_reason = 'retention policy' WHERE id = $1`, [p.id]);
      photosDeleted++;
    } catch (err) {
      logger.warn({ err, photoId: p.id }, 'retention: photo delete failed; will retry next run');
    }
  }

  // 3. Old notifications.
  const notes = await q(`DELETE FROM notifications WHERE created_at < $1::timestamptz - make_interval(days => $2) AND org_id = $3 RETURNING id`, [now, retention.notificationDays, orgId]);

  const summary = { locationUpdatesDeleted: loc.length, photosDeleted, photosHeld, notificationsDeleted: notes.length, policy: retention };
  if (actor || loc.length || photosDeleted || notes.length) {
    await audit({ actor, orgId, action: 'retention.run', resourceType: 'retention', after: summary });
  }
  return summary;
}
