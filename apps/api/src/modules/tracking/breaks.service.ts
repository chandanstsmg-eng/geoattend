/**
 * Declared breaks.
 *
 *  1. POST /tracking/sessions/:id/breaks/photo — allowed only while PRESENT. Reserves a private
 *     upload slot for the break selfie (an attendance_photos row with purpose BREAK).
 *  2. The app PUTs the camera JPEG to that URL.
 *  3. POST /tracking/sessions/:id/breaks — break type, photo and a fresh GPS fix. The fix goes
 *     through the same ingestion and state machine as tracking readings and must be inside the
 *     workplace area. Only then is the break opened (server time) and the session moved to ON_BREAK.
 *
 * While ON_BREAK, leaving the area opens no absence and raises no alert; location is still
 * collected. The break ends when the employee taps "End break", when the engine verifies a
 * return after a verified exit, or when the shift closes. Past its time limit the sweeper
 * marks it overdue and alerts administrators once.
 */
import type pg from 'pg';
import { classifyReading, distanceMeters } from '@geoattend/shared';
import { one, q, tx } from '../../db/pool.js';
import { eachCompany, eachRecord, throwIfAny } from '../jobs/runner.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { createUploadUrl, inspectObject, newObjectKey, type PhotoType } from '../../lib/storage.js';
import { confirmUpload } from '../attendance/photo-upload.js';
import { config } from '../../config.js';
import { getSettings } from '../settings/settings.service.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { engineRules, ingestLocked, lockSession, sessionNow, transition, type Actor, type ReadingInput } from './tracking.service.js';

export type BreakEndReason = 'EMPLOYEE' | 'RETURNED' | 'SHIFT_ENDED';

const mins = (from: Date | string, to: Date) => Math.max(0, Math.round((to.getTime() - new Date(from).getTime()) / 60000));

function assertCanStart(s: any, employeeId: string) {
  if (!s) throw notFound('Session');
  if (s.employee_id !== employeeId) throw forbidden();
  if (s.ended_at) throw conflict('SESSION_CLOSED', 'This shift session has ended.');
  if (s.state === 'ON_BREAK') throw conflict('BREAK_ALREADY_OPEN', 'You are already on a break.');
  if (s.state !== 'PRESENT') {
    throw conflict('BREAK_NOT_ALLOWED', 'You can start a break only while you are marked present inside the workplace area.', { state: s.state });
  }
}

export async function reserveBreakPhoto(employeeId: string, sessionId: string, input: { contentType: PhotoType; sizeBytes: number }, origin: string) {
  if (input.sizeBytes > config.storage.maxPhotoBytes) {
    throw new HttpError(413, 'PHOTO_TOO_LARGE', `Photo must be at most ${Math.round(config.storage.maxPhotoBytes / 1024 / 1024)} MB.`);
  }
  const photo = await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    assertCanStart(s, employeeId);
    return one(
      `INSERT INTO attendance_photos (employee_id, session_id, object_key, content_type, declared_bytes, idempotency_key, upload_expires_at, is_simulated, purpose)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), $8, 'BREAK') RETURNING *`,
      [employeeId, s.id, newObjectKey(employeeId, input.contentType), input.contentType, input.sizeBytes, `break:${crypto.randomUUID()}`, config.storage.uploadUrlTtlSec, s.is_simulated],
      db,
    );
  });
  const upload = await createUploadUrl(photo.object_key, input.contentType, input.sizeBytes, origin);
  return { photoId: photo.id as string, upload };
}

export interface StartBreakInput {
  typeKey: string;
  note?: string | null;
  photoId?: string | null;
  evidence: Omit<ReadingInput, 'source'>;
}

export async function startBreak(employeeId: string, sessionId: string, input: StartBreakInput, actor: Actor = 'EMPLOYEE') {
  const outbox = new Outbox();
  await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    assertCanStart(s, employeeId);
    const settings = await getSettings(s.org_id, db);
    const now = sessionNow(s);
    const type = settings.breaks.types.find((t) => t.key === input.typeKey);
    if (!type) throw badRequest('UNKNOWN_BREAK_TYPE', 'Choose one of the break types offered by your company.');

    let photo: any = null;
    if (input.photoId) {
      photo = await one('SELECT * FROM attendance_photos WHERE id = $1 FOR UPDATE', [input.photoId], db);
      if (!photo || photo.session_id !== s.id || photo.employee_id !== employeeId || photo.purpose !== 'BREAK') throw notFound('Photo');
      if (!(await confirmUpload('attendance_photos', photo, db))) throw new HttpError(422, 'PHOTO_MISSING', 'The photo was not uploaded. Please retry.');
      const obj = await inspectObject(photo.object_key);
      if (!obj || obj.type !== photo.content_type || obj.sizeBytes === 0) throw new HttpError(422, 'PHOTO_INVALID', 'The photo could not be read. Please take it again.');
      photo.obj = obj;
    } else if (settings.breaks.requirePhoto) {
      throw new HttpError(422, 'PHOTO_REQUIRED', 'Take a selfie to start your break.');
    }

    // Evidence: fresh, and judged by the same rules as attendance.
    const ev = input.evidence;
    const ageSec = (now.getTime() - new Date(ev.clientTime).getTime()) / 1000;
    if (!(ageSec <= settings.tracking.evidenceMaxAgeSec)) {
      throw new HttpError(422, 'EVIDENCE_STALE', `The location fix is older than ${settings.tracking.evidenceMaxAgeSec} seconds. Get a fresh fix and retry.`);
    }
    const ingest = await ingestLocked(db, outbox, s, [{ ...ev, source: actor === 'SIMULATOR' ? 'SIMULATOR' : 'SUBMISSION' }], actor, now);
    const r0 = ingest.results[0];
    if (r0?.status === 'REJECTED') throw new HttpError(422, 'EVIDENCE_INVALID', `The location evidence was rejected (${r0.reason}).`);
    if (s.state !== 'PRESENT') throw conflict('BREAK_NOT_ALLOWED', 'You are no longer marked present inside the workplace area.', { state: s.state });
    const distance = distanceMeters({ lat: s.wp_lat, lng: s.wp_lng }, { lat: ev.latitude, lng: ev.longitude });
    const cls = classifyReading(distance, ev.accuracyM, engineRules(settings, Number(s.radius_m)), 'EXIT');
    if (cls !== 'INSIDE') {
      throw new HttpError(
        422,
        cls === 'INSUFFICIENT_ACCURACY' ? 'GPS_ACCURACY_INSUFFICIENT' : 'BREAK_OUTSIDE',
        cls === 'INSUFFICIENT_ACCURACY'
          ? `GPS accuracy (±${Math.round(ev.accuracyM)} m) is not good enough to confirm you are at the workplace. Retry in an open area.`
          : `Start your break before you leave: your location could not be confirmed inside the workplace area (${Math.round(distance)} m, ±${Math.round(ev.accuracyM)} m).`,
      );
    }

    const b = await one(
      `INSERT INTO session_breaks (session_id, employee_id, workplace_id, type_key, type_label, paid, max_minutes, note, photo_id, started_at,
                                   start_latitude, start_longitude, start_accuracy_m, start_distance_m, is_simulated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [s.id, employeeId, s.workplace_id, type.key, type.label, type.paid, type.maxMinutes, input.note?.trim() || null, photo?.id ?? null, now, ev.latitude, ev.longitude, ev.accuracyM, distance, s.is_simulated],
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
    await transition(db, outbox, s, 'ON_BREAK', `${type.label} break started`, actor, actor === 'EMPLOYEE' ? employeeId : null, {
      metadata: { breakId: b.id, typeKey: type.key, distanceM: Math.round(distance * 10) / 10, accuracyM: ev.accuracyM },
    });
    await notify(db, outbox, {
      type: 'BREAK_STARTED',
      severity: 'INFO',
      body: `${s.employee_name} started a ${type.label.toLowerCase()} break (${type.paid ? 'paid' : 'unpaid'}, up to ${type.maxMinutes} min)${b.note ? `: “${String(b.note).slice(0, 120)}”` : ''}.`,
      employeeId,
      workplaceId: s.workplace_id,
      sessionId: s.id,
      data: { breakId: b.id, typeKey: type.key, maxMinutes: type.maxMinutes, paid: type.paid, hasPhoto: !!photo },
      dedupeKey: `break-started:${b.id}`,
      simulated: s.is_simulated,
    });
  });
  outbox.flush();
}

/**
 * Closes the open break of a locked session (no state change — callers transition).
 * Returns the closed row, or null when there was none.
 */
export async function closeBreak(db: pg.PoolClient, outbox: Outbox, s: any, endedAt: Date, reason: BreakEndReason) {
  const b = await one(
    `UPDATE session_breaks SET ended_at = GREATEST($2, started_at), end_reason = $3 WHERE session_id = $1 AND ended_at IS NULL RETURNING *`,
    [s.id, endedAt, reason],
    db,
  );
  s.break_left = false;
  if (!b || reason === 'SHIFT_ENDED') return b;
  const took = mins(b.started_at, new Date(b.ended_at));
  const over = took - b.max_minutes;
  await notify(db, outbox, {
    type: 'BREAK_ENDED',
    severity: over > 0 ? 'WARNING' : 'INFO',
    body: `${s.employee_name} ${reason === 'RETURNED' ? 'returned from' : 'ended'} their ${String(b.type_label).toLowerCase()} break after ${took} min${over > 0 ? ` — ${over} min over the ${b.max_minutes} min limit` : ''}.`,
    employeeId: s.employee_id,
    workplaceId: s.workplace_id,
    sessionId: s.id,
    data: { breakId: b.id, minutes: took, overMinutes: Math.max(0, over), reason },
    dedupeKey: `break-ended:${b.id}`,
    simulated: s.is_simulated,
  });
  return b;
}

export async function endBreak(employeeId: string, sessionId: string, actor: Actor = 'EMPLOYEE') {
  const outbox = new Outbox();
  await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    if (!s) throw notFound('Session');
    if (s.employee_id !== employeeId) throw forbidden();
    if (s.ended_at) throw conflict('SESSION_CLOSED', 'This shift session has ended.');
    const b = await closeBreak(db, outbox, s, sessionNow(s), 'EMPLOYEE');
    if (!b) throw conflict('NO_OPEN_BREAK', 'You are not on a break.');
    if (s.state === 'ON_BREAK') {
      // From here the normal rules apply again: if they are still outside, the exit is verified as an absence.
      await q('UPDATE tracking_sessions SET candidate_since = NULL, candidate_count = 0 WHERE id = $1', [s.id], db);
      await transition(db, outbox, s, 'PRESENT', 'break ended by employee', actor, actor === 'EMPLOYEE' ? employeeId : null, { metadata: { breakId: b.id } });
    } else if (s.resume_state === 'ON_BREAK') {
      // Ended while updates were interrupted / permission missing: resume as present.
      await q(`UPDATE tracking_sessions SET resume_state = 'PRESENT' WHERE id = $1`, [s.id], db);
    }
  });
  outbox.flush();
}

/** Breaks past their time limit: alert administrators (and remind the employee) once per break. */
export const sweepOverdueBreaks = (realNow = new Date()) => eachCompany(() => overdueBreaksForCompany(realNow));

async function overdueBreaksForCompany(realNow: Date) {
  const outbox = new Outbox();
  const due = await q(
    `SELECT b.id, b.session_id FROM session_breaks b JOIN tracking_sessions s ON s.id = b.session_id
     WHERE b.ended_at IS NULL AND b.overdue_at IS NULL AND s.ended_at IS NULL
       AND b.started_at + make_interval(mins => b.max_minutes) <= $1::timestamptz + make_interval(secs => s.sim_clock_offset_sec)`,
    [realNow],
  );
  const failures = await eachRecord(due, (row) =>
    tx(async (db) => {
      const s = await lockSession(db, row.session_id);
      if (!s || s.ended_at) return;
      const now = new Date(realNow.getTime() + s.sim_clock_offset_sec * 1000);
      const b = await one(`UPDATE session_breaks SET overdue_at = $2 WHERE id = $1 AND ended_at IS NULL AND overdue_at IS NULL RETURNING *`, [row.id, now], db);
      if (!b) return;
      const took = mins(b.started_at, now);
      const where = b.left_at
        ? `Left the workplace at ${new Date(b.left_at).toISOString()}${s.last_distance_m != null ? `; last seen ${Math.round(s.last_distance_m)} m away` : ''}.`
        : 'Still inside the workplace area.';
      await notify(db, outbox, {
        type: 'BREAK_OVERDUE',
        severity: 'WARNING',
        body: `${s.employee_name}'s ${String(b.type_label).toLowerCase()} break has run ${took} min (limit ${b.max_minutes} min). ${where}`,
        employeeId: s.employee_id,
        workplaceId: s.workplace_id,
        sessionId: s.id,
        data: {
          breakId: b.id,
          minutes: took,
          maxMinutes: b.max_minutes,
          leftAt: b.left_at,
          lastKnown: s.last_latitude != null ? { lat: s.last_latitude, lng: s.last_longitude, accuracyM: s.last_accuracy_m, at: s.last_location_client_at } : null,
        },
        dedupeKey: `break-overdue:${b.id}`,
        simulated: s.is_simulated,
      });
      await notify(db, outbox, {
        type: 'BREAK_OVERDUE',
        audience: 'EMPLOYEE',
        severity: 'WARNING',
        title: 'Break time is over',
        body: `Your ${String(b.type_label).toLowerCase()} break was ${b.max_minutes} min. Your manager has been told. Open GeoAttend and tap “End break” when you are back.`,
        employeeId: s.employee_id,
        sessionId: s.id,
        dedupeKey: `break-overdue-emp:${b.id}`,
        simulated: s.is_simulated,
      });
    }),
  );
  outbox.flush();
  throwIfAny(failures);
}
