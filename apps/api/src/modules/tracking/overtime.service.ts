/**
 * Overtime, approved by an administrator.
 *
 *  1. The regular shift counts only up to its scheduled end. From then on, an employee with
 *     recorded attendance whose session is still open is offered "Still working? Start overtime"
 *     (the sweeper also sends a push at the end time).
 *  2. POST /tracking/sessions/:id/overtime/photo reserves the selfie upload (purpose OVERTIME).
 *  3. POST /tracking/sessions/:id/overtime — selfie, optional note and a fresh GPS fix. Overtime
 *     may be worked anywhere, so the fix is not required to be inside the workplace area: its
 *     distance is kept as evidence. Overtime starts at server time and the session moves to
 *     ON_OVERTIME: the shift window no longer closes it, location is still collected, and leaving
 *     the area raises no absence.
 *  4. Ending the shift while on overtime (the usual end-of-shift selfie) ends the overtime and the
 *     session. If the phone sends no location for OVERTIME_LOST_AFTER_MIN, the sweeper ends it at
 *     the last location received; starting the next shift ends it too.
 *  5. An owner, or a supervisor of the workplace, approves it (optionally with fewer minutes) or
 *     rejects it. Only approved minutes count (attendance_work.overtime_minutes → reports → payroll).
 */
import type pg from 'pg';
import { distanceMeters, type SessionState } from '@geoattend/shared';
import { getPool, one, q, tx } from '../../db/pool.js';
import { HttpError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { createUploadUrl, inspectObject, newObjectKey, type PhotoType } from '../../lib/storage.js';
import { config } from '../../config.js';
import { getSettings } from '../settings/settings.service.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { closeBreak } from './breaks.service.js';
import { finalizeLocked, ingestLocked, lockSession, sessionNow, transition, type Actor, type ReadingInput } from './tracking.service.js';

export type OvertimeEndReason = 'EMPLOYEE' | 'ADMIN' | 'TRACKING_LOST' | 'NEXT_SHIFT' | 'SYSTEM';

/** No location for this long while on overtime ends it at the last location received. */
export const OVERTIME_LOST_AFTER_MIN = 60;

/** States from which overtime can start (attendance recorded, still tracked). Interrupted sessions resume with the fresh fix first. */
const START_STATES: readonly SessionState[] = ['PRESENT', 'TEMPORARILY_AWAY', 'PROLONGED_ABSENCE', 'ON_BREAK'];

const mins = (from: Date | string, to: Date | string) => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000));

export const fmtMinutes = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

/** Overtime is on (or interrupted while on) for this session. */
export const onOvertime = (s: { state: string; resume_state?: string | null }) => s.state === 'ON_OVERTIME' || s.resume_state === 'ON_OVERTIME';

/** True when the employee may start overtime now. `s` needs has_attendance (lockSession) or an attendance flag. */
export function canStartOvertime(s: any, now: Date, hasAttendance = !!s.has_attendance) {
  if (s.ended_at || !hasAttendance || onOvertime(s)) return false;
  if (now.getTime() < new Date(s.scheduled_end_at).getTime()) return false;
  return START_STATES.includes(s.state) || s.state === 'TRACKING_INTERRUPTED' || s.state === 'TRACKING_PERMISSION_REQUIRED';
}

function assertCanStart(s: any, employeeId: string) {
  if (!s) throw notFound('Session');
  if (s.employee_id !== employeeId) throw forbidden();
  if (s.ended_at) throw conflict('SESSION_CLOSED', 'This shift session has ended.');
  if (onOvertime(s)) throw conflict('OVERTIME_ALREADY_OPEN', 'You are already on overtime.');
  if (!s.has_attendance) throw conflict('OVERTIME_NOT_ALLOWED', 'Overtime needs attendance recorded for this shift.');
  const now = sessionNow(s);
  if (now.getTime() < new Date(s.scheduled_end_at).getTime()) {
    throw conflict('OVERTIME_TOO_EARLY', 'Overtime can start once your shift has ended.', { shiftEndsAt: s.scheduled_end_at });
  }
  if (!canStartOvertime(s, now)) throw conflict('OVERTIME_NOT_ALLOWED', 'Overtime cannot be started in the current shift state.', { state: s.state });
}

export async function reserveOvertimePhoto(employeeId: string, sessionId: string, input: { contentType: PhotoType; sizeBytes: number }, origin: string) {
  if (input.sizeBytes > config.storage.maxPhotoBytes) {
    throw new HttpError(413, 'PHOTO_TOO_LARGE', `Photo must be at most ${Math.round(config.storage.maxPhotoBytes / 1024 / 1024)} MB.`);
  }
  const photo = await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    assertCanStart(s, employeeId);
    return one(
      `INSERT INTO attendance_photos (employee_id, session_id, object_key, content_type, declared_bytes, idempotency_key, upload_expires_at, is_simulated, purpose)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), $8, 'OVERTIME') RETURNING *`,
      [employeeId, s.id, newObjectKey(employeeId, input.contentType), input.contentType, input.sizeBytes, `overtime:${crypto.randomUUID()}`, config.storage.uploadUrlTtlSec, s.is_simulated],
      db,
    );
  });
  const upload = await createUploadUrl(photo.object_key, input.contentType, input.sizeBytes, origin);
  return { photoId: photo.id as string, upload };
}

export interface StartOvertimeInput {
  note?: string | null;
  photoId?: string | null;
  evidence: Omit<ReadingInput, 'source'>;
}

export async function startOvertime(employeeId: string, sessionId: string, input: StartOvertimeInput, actor: Actor = 'EMPLOYEE') {
  const outbox = new Outbox();
  await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    assertCanStart(s, employeeId);
    const settings = await getSettings(s.org_id, db);
    const now = sessionNow(s);

    // The selfie is the proof that the employee is still working; only the demo simulator may skip it.
    let photo: any = null;
    if (input.photoId) {
      photo = await one('SELECT * FROM attendance_photos WHERE id = $1 FOR UPDATE', [input.photoId], db);
      if (!photo || photo.session_id !== s.id || photo.employee_id !== employeeId || photo.purpose !== 'OVERTIME') throw notFound('Photo');
      if (photo.status !== 'UPLOADED') throw new HttpError(422, 'PHOTO_MISSING', 'The photo was not uploaded. Please retry.');
      const obj = await inspectObject(photo.object_key);
      if (!obj || obj.type !== photo.content_type || obj.sizeBytes === 0) throw new HttpError(422, 'PHOTO_INVALID', 'The photo could not be read. Please take it again.');
      photo.obj = obj;
    } else if (actor !== 'SIMULATOR') {
      throw new HttpError(422, 'PHOTO_REQUIRED', 'Take a selfie to start overtime.');
    }

    const ev = input.evidence;
    const ageSec = (now.getTime() - new Date(ev.clientTime).getTime()) / 1000;
    if (!(ageSec <= settings.tracking.evidenceMaxAgeSec)) {
      throw new HttpError(422, 'EVIDENCE_STALE', `The location fix is older than ${settings.tracking.evidenceMaxAgeSec} seconds. Get a fresh fix and retry.`);
    }
    const ingest = await ingestLocked(db, outbox, s, [{ ...ev, source: actor === 'SIMULATOR' ? 'SIMULATOR' : 'SUBMISSION' }], actor, now);
    const r0 = ingest.results[0];
    if (r0?.status === 'REJECTED') throw new HttpError(422, 'EVIDENCE_INVALID', `The location evidence was rejected (${r0.reason}).`);
    if (!START_STATES.includes(s.state)) throw conflict('OVERTIME_NOT_ALLOWED', 'Overtime cannot be started in the current shift state.', { state: s.state });
    const distance = distanceMeters({ lat: s.wp_lat, lng: s.wp_lng }, { lat: ev.latitude, lng: ev.longitude });

    const attendance = await one(
      `SELECT id FROM attendance_records WHERE employee_id = $1 AND shift_id = $2 AND shift_date = $3 AND verification_status <> 'VOIDED'`,
      [s.employee_id, s.shift_id, s.shift_date],
      db,
    );
    if (!attendance) throw conflict('OVERTIME_NOT_ALLOWED', 'Overtime needs attendance recorded for this shift.');

    // The regular shift is over: whatever was open belongs to it.
    await q(`UPDATE absence_intervals SET ended_at = GREATEST($2, started_at), status = 'SHIFT_ENDED' WHERE session_id = $1 AND status = 'OPEN'`, [s.id, now], db);
    await closeBreak(db, outbox, s, now, 'SHIFT_ENDED');

    const o = await one(
      `INSERT INTO overtime_entries (session_id, attendance_id, employee_id, workplace_id, shift_date, note, started_at, start_photo_id,
                                     start_latitude, start_longitude, start_accuracy_m, start_distance_m, start_face_status, is_simulated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [s.id, attendance.id, employeeId, s.workplace_id, s.shift_date, input.note?.trim() || null, now, photo?.id ?? null, ev.latitude, ev.longitude, ev.accuracyM, distance, photo ? null : 'NO_PHOTO', s.is_simulated],
      db,
    );
    if (photo) {
      await q(
        `UPDATE attendance_photos SET status = 'ATTACHED', size_bytes = $2, sha256 = $3, retention_until = now() + make_interval(days => $4) WHERE id = $1`,
        [photo.id, photo.obj.sizeBytes, photo.obj.sha256, settings.retention.photoDays],
        db,
      );
    }
    await q('UPDATE tracking_sessions SET candidate_since = NULL, candidate_count = 0 WHERE id = $1', [s.id], db);
    await transition(db, outbox, s, 'ON_OVERTIME', 'overtime started', actor, actor === 'EMPLOYEE' ? employeeId : null, {
      metadata: { overtimeId: o.id, distanceM: Math.round(distance * 10) / 10, accuracyM: ev.accuracyM },
    });
    const late = mins(s.scheduled_end_at, now);
    const where = distance <= Number(s.radius_m) ? `at ${s.workplace_name}` : `${Math.round(distance)} m from ${s.workplace_name}`;
    await notify(db, outbox, {
      type: 'OVERTIME_STARTED',
      severity: 'INFO',
      body: `${s.employee_name} started overtime after ${s.shift_name}${late ? ` (${fmtMinutes(late)} after the shift ended)` : ''}, ${where}${o.note ? `: “${String(o.note).slice(0, 120)}”` : ''}.`,
      employeeId,
      workplaceId: s.workplace_id,
      sessionId: s.id,
      data: { overtimeId: o.id, distanceM: Math.round(distance), hasPhoto: !!photo },
      dedupeKey: `ot-started:${o.id}`,
      simulated: s.is_simulated,
    });
  });
  outbox.flush();
}

/**
 * Ends the open overtime of a locked session (the caller closes the session). Returns the row, or null.
 * The admins are told it is waiting for approval.
 */
export async function closeOvertime(db: pg.PoolClient, outbox: Outbox, s: any, endedAt: Date, reason: OvertimeEndReason) {
  const o = await one(
    `UPDATE overtime_entries SET ended_at = GREATEST($2, started_at), end_reason = $3 WHERE session_id = $1 AND ended_at IS NULL RETURNING *`,
    [s.id, endedAt, reason],
    db,
  );
  if (!o) return null;
  const took = mins(o.started_at, o.ended_at);
  const how: Record<OvertimeEndReason, string> = {
    EMPLOYEE: 'ended overtime',
    ADMIN: 'had overtime ended by an administrator',
    TRACKING_LOST: `stopped sending location ${OVERTIME_LOST_AFTER_MIN}+ min ago, so overtime was ended at the last location received`,
    NEXT_SHIFT: 'started the next shift, so overtime was ended',
    SYSTEM: 'had overtime ended automatically',
  };
  await notify(db, outbox, {
    type: 'OVERTIME_ENDED',
    severity: 'INFO',
    body: `${s.employee_name} ${how[reason]}: ${fmtMinutes(took)} after ${s.shift_name}. Approve or reject it on the Overtime page.`,
    employeeId: s.employee_id,
    workplaceId: s.workplace_id,
    sessionId: s.id,
    data: { overtimeId: o.id, minutes: took, reason },
    dedupeKey: `ot-ended:${o.id}`,
    simulated: s.is_simulated,
  });
  return o;
}

/** Ends a session that is on overtime (next shift starting, lost tracking). Must hold the session lock. */
export async function finalizeOvertimeSession(db: pg.PoolClient, outbox: Outbox, s: any, at: Date, reason: OvertimeEndReason) {
  await finalizeLocked(db, outbox, s, {
    actor: 'SYSTEM',
    actorId: null,
    authorization: 'EXPIRED',
    reason: reason === 'NEXT_SHIFT' ? 'overtime ended: next shift started' : 'overtime ended: no location received',
    overtimeEnd: { at, reason },
  });
}

/**
 * Sweeper:
 *  - at a shift's scheduled end, ask the employee (once) whether they are still working;
 *  - end overtime whose phone has sent nothing for OVERTIME_LOST_AFTER_MIN, at the last location.
 */
export async function sweepOvertime(realNow = new Date()) {
  const outbox = new Outbox();
  const prompts = await q(
    `SELECT s.id, s.employee_id, s.is_simulated, sh.name AS shift_name FROM tracking_sessions s JOIN shifts sh ON sh.id = s.shift_id
     WHERE s.ended_at IS NULL AND s.state = ANY($2) AND s.scheduled_end_at <= $1::timestamptz + make_interval(secs => s.sim_clock_offset_sec)
       AND s.scheduled_end_at > $1::timestamptz + make_interval(secs => s.sim_clock_offset_sec) - interval '6 hours'
       AND EXISTS (SELECT 1 FROM attendance_records ar WHERE ar.session_id = s.id AND ar.verification_status <> 'VOIDED')
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.dedupe_key = 'ot-prompt:' || s.id)`,
    [realNow, START_STATES],
  );
  for (const s of prompts) {
    await notify(getPool(), outbox, {
      type: 'OVERTIME_PROMPT',
      audience: 'EMPLOYEE',
      severity: 'INFO',
      title: 'Your shift has ended',
      body: `${s.shift_name} is over. Still working? Open GeoAttend and tap “Start overtime” (selfie needed). Otherwise, end your shift.`,
      employeeId: s.employee_id,
      sessionId: s.id,
      dedupeKey: `ot-prompt:${s.id}`,
      simulated: s.is_simulated,
    });
  }

  const lost = await q(
    `SELECT id FROM tracking_sessions
     WHERE ended_at IS NULL AND (state = 'ON_OVERTIME' OR resume_state = 'ON_OVERTIME')
       AND COALESCE(last_location_at, started_at) < $1::timestamptz + make_interval(secs => sim_clock_offset_sec) - make_interval(mins => $2)`,
    [realNow, OVERTIME_LOST_AFTER_MIN],
  );
  for (const { id } of lost) {
    await tx(async (db) => {
      const s = await lockSession(db, id);
      if (!s || s.ended_at || !onOvertime(s)) return;
      const now = new Date(realNow.getTime() + s.sim_clock_offset_sec * 1000);
      const last = new Date(s.last_location_at ?? s.started_at);
      if (now.getTime() - last.getTime() < OVERTIME_LOST_AFTER_MIN * 60_000) return;
      await finalizeOvertimeSession(db, outbox, s, last, 'TRACKING_LOST');
    });
  }
  outbox.flush();
}
