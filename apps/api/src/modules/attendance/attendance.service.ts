/**
 * Attendance submission.
 *
 *  1. POST /attendance/intents  — allowed only in ATTENDANCE_READY. Reserves a
 *     private object key, returns a short-lived signed upload URL and moves the
 *     session to ATTENDANCE_SUBMISSION_PENDING.
 *  2. The app PUTs the camera JPEG to that URL.
 *  3. POST /attendance — the server re-validates everything independently:
 *     session ownership and state, photo existence/type/size, and a fresh GPS
 *     evidence reading which is run through the same state machine as tracking
 *     readings. Only then is the record inserted, with SERVER time.
 *
 * Exactly-once: the request carries an idempotency key (unique in the DB) and
 * the table has UNIQUE (employee_id, shift_id, shift_date). A replay with the
 * same key returns the original record; a different key for the same shift is
 * reported as a suspected duplicate submission and rejected.
 */
import type pg from 'pg';
import { classifyReading, distanceMeters } from '@geoattend/shared';
import { one, q, tx, type Queryable } from '../../db/pool.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { createUploadUrl, inspectObject, newObjectKey, type PhotoType } from '../../lib/storage.js';
import { config } from '../../config.js';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { getSettings } from '../settings/settings.service.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { engineRules, ingestLocked, lockSession, sessionNow, transition, type Actor, type ReadingInput } from '../tracking/tracking.service.js';
import { challengeFor } from '../faces/faces.js';
import { assertPayrollMonthOpen } from '../payroll/guard.js';
import { DateTime } from 'luxon';

export interface IntentInput {
  capturedOffline?: boolean;
  sessionId: string;
  idempotencyKey: string;
  contentType: PhotoType;
  sizeBytes: number;
}

export async function createIntent(employeeId: string, input: IntentInput, origin: string, actor: Actor = 'EMPLOYEE') {
  if (input.sizeBytes > config.storage.maxPhotoBytes) {
    throw new HttpError(413, 'PHOTO_TOO_LARGE', `Photo must be at most ${Math.round(config.storage.maxPhotoBytes / 1024 / 1024)} MB.`);
  }
  const outbox = new Outbox();
  const photo = await tx(async (db) => {
    const s = await lockSession(db, input.sessionId);
    if (!s) throw notFound('Session');
    if (s.employee_id !== employeeId) throw forbidden();
    if (s.has_attendance) throw conflict('ALREADY_RECORDED', 'Attendance is already recorded for this shift.');
    const offline = !!input.capturedOffline;
    if (offline && !(await getSettings(s.org_id, db)).tracking.offlineAttendanceHours) throw conflict('OFFLINE_ATTENDANCE_OFF', 'This company does not accept attendance saved without a connection.');
    if (!offline && s.state !== 'ATTENDANCE_READY' && s.state !== 'ATTENDANCE_SUBMISSION_PENDING') {
      throw conflict('ATTENDANCE_LOCKED', 'Attendance is not available yet. Reach the workplace area and wait for verification.', { state: s.state });
    }
    // A retake replaces any earlier unused upload slot.
    await q(`UPDATE attendance_photos SET status = 'EXPIRED' WHERE session_id = $1 AND status IN ('PENDING_UPLOAD', 'UPLOADED')`, [s.id], db);
    const key = newObjectKey(employeeId, input.contentType);
    const photo = await one(
      `INSERT INTO attendance_photos (employee_id, session_id, object_key, content_type, declared_bytes, idempotency_key, upload_expires_at, is_simulated)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), $8) RETURNING *`,
      [employeeId, s.id, key, input.contentType, input.sizeBytes, input.idempotencyKey, config.storage.uploadUrlTtlSec, s.is_simulated],
      db,
    );
    if (!offline) await transition(db, outbox, s, 'ATTENDANCE_SUBMISSION_PENDING', 'attendance photo capture started', actor, actor === 'EMPLOYEE' ? employeeId : null);
    return photo;
  });
  outbox.flush();
  const upload = await createUploadUrl(photo.object_key, input.contentType, input.sizeBytes, origin);
  return { photoId: photo.id as string, upload };
}

export interface SubmitInput {
  sessionId: string;
  photoId: string;
  idempotencyKey: string;
  evidence: Omit<ReadingInput, 'source'>;
  device?: Record<string, unknown>;
  capturedOffline?: boolean;
}

type SubmitOutcome = { ok: true; record: any; replay: boolean } | { ok: false; error: HttpError };

async function fail(db: pg.PoolClient, outbox: Outbox, s: any, code: string, message: string, details?: unknown): Promise<SubmitOutcome> {
  await notify(db, outbox, {
    type: 'ATTENDANCE_SUBMISSION_FAILED',
    severity: 'WARNING',
    body: `${s.employee_name}: attendance submission rejected — ${message}`,
    employeeId: s.employee_id,
    workplaceId: s.workplace_id,
    sessionId: s.id,
    data: { code, details },
    dedupeKey: `submit-failed:${s.id}:${code}:${Math.floor(Date.now() / 600_000)}`,
    simulated: s.is_simulated,
  });
  return { ok: false, error: new HttpError(422, code, message, details) };
}

export async function submitAttendance(employeeId: string, input: SubmitInput, actor: Actor = 'EMPLOYEE') {
  // Idempotent replay: same key → same answer, no side effects.
  const prior = await one('SELECT * FROM attendance_records WHERE idempotency_key = $1', [input.idempotencyKey]);
  if (prior) {
    if (prior.employee_id !== employeeId) throw forbidden();
    return { record: prior, replay: true };
  }

  const outbox = new Outbox();
  const outcome = await tx(async (db): Promise<SubmitOutcome> => {
    const s = await lockSession(db, input.sessionId);
    if (!s) throw notFound('Session');
    if (s.employee_id !== employeeId) throw forbidden();
    const offline = !!input.capturedOffline;
    if (s.ended_at && !offline) throw conflict('SESSION_CLOSED', 'This shift session has ended.');
    const settings = await getSettings(s.org_id, db);
    const now = sessionNow(s);

    if (s.has_attendance) {
      await notify(db, outbox, {
        type: 'DUPLICATE_SUBMISSION',
        severity: 'WARNING',
        body: `${s.employee_name} submitted attendance again for ${s.shift_name} on ${s.shift_date}. The original record was kept.`,
        employeeId,
        workplaceId: s.workplace_id,
        sessionId: s.id,
        dedupeKey: `dup:${s.id}:${input.idempotencyKey}`,
        simulated: s.is_simulated,
      });
      return { ok: false, error: conflict('DUPLICATE_SUBMISSION', 'Attendance is already recorded for this shift.') };
    }

    // Photo must be the one reserved for this session, uploaded and genuinely an image.
    const photo = await one('SELECT * FROM attendance_photos WHERE id = $1 FOR UPDATE', [input.photoId], db);
    if (!photo || photo.session_id !== s.id || photo.employee_id !== employeeId) throw notFound('Photo');
    if (photo.status === 'EXPIRED' || photo.status === 'DELETED') {
      return fail(db, outbox, s, 'PHOTO_EXPIRED', 'The photo upload slot expired or was cancelled. Capture the photo again.');
    }
    const obj = await inspectObject(photo.object_key);
    if (!obj) return fail(db, outbox, s, 'PHOTO_MISSING', 'The photo was not uploaded. Please retry.');
    if (obj.sizeBytes > config.storage.maxPhotoBytes || obj.sizeBytes === 0) return fail(db, outbox, s, 'PHOTO_INVALID', 'The photo size is not acceptable.');
    if (obj.type !== photo.content_type) return fail(db, outbox, s, 'PHOTO_INVALID', 'The uploaded file is not a valid camera image.');

    // Evidence reading: fresh, plausible, and judged by the same rules as tracking.
    const ev = input.evidence;
    const evTime = new Date(ev.clientTime);
    const ageSec = (now.getTime() - evTime.getTime()) / 1000;
    if (offline) {
      // Saved on the phone without a connection. Phone clocks can be changed, so the arrival can never
      // be earlier than the session start the server recorded itself.
      const hours = settings.tracking.offlineAttendanceHours;
      if (!hours) return { ok: false, error: conflict('OFFLINE_ATTENDANCE_OFF', 'This company does not accept attendance saved without a connection.') };
      if (ageSec > hours * 3600) return fail(db, outbox, s, 'OFFLINE_TOO_OLD', `This check-in was saved more than ${hours} hours ago. Ask your manager to correct the record.`);
      if (s.ended_at && evTime > new Date(s.ended_at)) return { ok: false, error: conflict('SESSION_CLOSED', 'This shift session had ended before this check-in.') };
      await assertPayrollMonthOpen(s.org_id, s.shift_date, db);
    } else if (!(ageSec <= settings.tracking.evidenceMaxAgeSec)) {
      return fail(db, outbox, s, 'EVIDENCE_STALE', `The location fix is older than ${settings.tracking.evidenceMaxAgeSec} seconds. Get a fresh fix and retry.`);
    }
    // Fake GPS anywhere in this shift's trail counts, not only in the final fix (GPS-06).
    const mockedTrail = !!(await one('SELECT 1 FROM location_updates WHERE session_id = $1 AND is_mocked LIMIT 1', [s.id], db));
    if ((ev.isMocked || mockedTrail) && settings.tracking.mockLocationPolicy === 'BLOCK_ATTENDANCE') {
      return fail(db, outbox, s, 'MOCK_LOCATION', 'This phone reported a fake-location (mock location) source during this shift. Turn it off and uninstall the app providing it, or request a manual review.');
    }
    // Rooted / jailbroken phones and emulators can fake location without the phone reporting it.
    const dev = input.device ?? {};
    const untrusted = [dev.isPhysicalDevice === false ? 'EMULATOR' : null, dev.isRooted === true ? 'ROOTED_DEVICE' : null].filter((f): f is string => !!f);
    if (untrusted.length && settings.tracking.deviceIntegrityPolicy === 'BLOCK_ATTENDANCE' && actor !== 'SIMULATOR') {
      return fail(
        db,
        outbox,
        s,
        'DEVICE_NOT_TRUSTED',
        `Attendance cannot be marked from ${untrusted.includes('EMULATOR') ? 'an emulator' : 'a rooted or jailbroken phone'}: its location cannot be trusted. Use an unmodified phone, or request a manual review.`,
        { flags: untrusted },
      );
    }
    const ingest = await ingestLocked(db, outbox, s, [{ ...ev, source: actor === 'SIMULATOR' ? 'SIMULATOR' : 'SUBMISSION' }], actor, now);
    const r0 = ingest.results[0];
    if (r0?.status === 'REJECTED') return fail(db, outbox, s, 'EVIDENCE_INVALID', `The location evidence was rejected (${r0.reason}).`);

    // The state machine may just have re-locked attendance (employee left before submitting).
    if (!offline && s.state !== 'ATTENDANCE_SUBMISSION_PENDING' && s.state !== 'ATTENDANCE_READY') {
      return fail(db, outbox, s, 'NOT_ELIGIBLE', 'You are no longer inside the workplace area. Attendance is locked again.', { state: s.state });
    }
    const distance = distanceMeters({ lat: s.wp_lat, lng: s.wp_lng }, { lat: ev.latitude, lng: ev.longitude });
    const cls = classifyReading(distance, ev.accuracyM, engineRules(settings, Number(s.radius_m)), 'EXIT');
    if (cls !== 'INSIDE') {
      if (!offline) await transition(db, outbox, s, 'ATTENDANCE_READY', `submission evidence ${cls.toLowerCase()}`, actor);
      return fail(
        db,
        outbox,
        s,
        cls === 'INSUFFICIENT_ACCURACY' ? 'GPS_ACCURACY_INSUFFICIENT' : 'EVIDENCE_NOT_INSIDE',
        cls === 'INSUFFICIENT_ACCURACY'
          ? `GPS accuracy (±${Math.round(ev.accuracyM)} m) is not sufficient to confirm your location. Retry in an open area.`
          : `Your location could not be confirmed inside the workplace area (${Math.round(distance)} m, ±${Math.round(ev.accuracyM)} m). Retry.`,
      );
    }

    const arrivedAt = offline ? new Date(Math.max(evTime.getTime(), new Date(s.started_at).getTime())) : now;
    const { minutes: lateBy, isLate } = lateness(arrivedAt, new Date(s.scheduled_start_at), s.arrival_grace_minutes);
    const flags: string[] = [];
    if (offline) flags.push('OFFLINE_CAPTURE');
    if (s.is_simulated) flags.push('SIMULATED');
    if (ev.isMocked || mockedTrail) flags.push('MOCK_LOCATION_REPORTED');
    flags.push(...untrusted);
    if (s.background_permission && s.background_permission !== 'granted') flags.push('BACKGROUND_LOCATION_UNAVAILABLE');

    const record = await one(
      `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, photo_id,
         evidence_latitude, evidence_longitude, evidence_accuracy_m, evidence_distance_m, evidence_client_time, radius_m_at_record,
         is_late, late_by_minutes, verification_status, risk_flags, device_meta, is_simulated, challenge, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$21,$16,$17,$18,$19,COALESCE($20::timestamptz, now()))
       ON CONFLICT (employee_id, shift_id, shift_date) DO NOTHING
       RETURNING *`,
      [
        employeeId,
        s.workplace_id,
        s.shift_id,
        s.id,
        s.shift_date,
        input.idempotencyKey,
        photo.id,
        ev.latitude,
        ev.longitude,
        ev.accuracyM,
        distance,
        evTime,
        s.radius_m,
        isLate,
        isLate ? lateBy : 0,
        flags,
        JSON.stringify({ ...(input.device ?? {}), ...(offline ? { receivedAt: now.toISOString() } : {}) }),
        s.is_simulated,
        challengeFor(s.id).en,
        offline ? arrivedAt : null,
        // The server did not see this happen, so it is never recorded as verified. A person decides.
        offline ? 'PENDING_VERIFICATION' : 'VERIFIED',
      ],
      db,
    );
    if (!record) return { ok: false, error: conflict('DUPLICATE_SUBMISSION', 'Attendance is already recorded for this shift.') };

    await q(
      `UPDATE attendance_photos SET status = 'ATTACHED', uploaded_at = COALESCE(uploaded_at, now()), size_bytes = $2, sha256 = $3,
              retention_until = now() + make_interval(days => $4) WHERE id = $1`,
      [photo.id, obj.sizeBytes, obj.sha256, settings.retention.photoDays],
      db,
    );
    s.has_attendance = true;
    await q('UPDATE tracking_sessions SET candidate_since = NULL, candidate_count = 0 WHERE id = $1', [s.id], db);
    if (!s.ended_at) {
      await transition(db, outbox, s, 'PRESENT', 'attendance verified and recorded by server', actor, actor === 'EMPLOYEE' ? employeeId : null, {
        metadata: { attendanceId: record.id, distanceM: Math.round(distance * 10) / 10, accuracyM: ev.accuracyM },
      });
    }
    await notify(db, outbox, {
      type: 'ATTENDANCE_MARKED',
      severity: 'INFO',
      body: `${s.employee_name} marked attendance at ${s.workplace_name} (${Math.round(distance)} m from centre, ±${Math.round(ev.accuracyM)} m).`,
      employeeId,
      workplaceId: s.workplace_id,
      sessionId: s.id,
      data: { attendanceId: record.id, riskFlags: flags },
      dedupeKey: `marked:${record.id}`,
      simulated: s.is_simulated,
    });
    if (isLate) {
      await notify(db, outbox, {
        type: 'LATE_ARRIVAL',
        severity: 'WARNING',
        body: `${s.employee_name} marked attendance ${lateBy} min after the start of ${s.shift_name} (grace ${s.arrival_grace_minutes} min).`,
        employeeId,
        workplaceId: s.workplace_id,
        sessionId: s.id,
        data: { attendanceId: record.id, lateByMinutes: lateBy },
        dedupeKey: `late:${record.id}`,
        simulated: s.is_simulated,
      });
    }
    outbox.push({ type: 'attendance.recorded', attendanceId: record.id, employeeId });
    return { ok: true, record, replay: false };
  });
  outbox.flush();
  if (!outcome.ok) throw outcome.error;
  return { record: outcome.record, replay: outcome.replay };
}

// ───────────────────────── reviews, disputes, corrections ─────────────────────────

/** The one rule for lateness: minutes after the scheduled start, late only beyond the grace period. */
export function lateness(arrival: Date, scheduledStart: Date, graceMinutes: number) {
  const minutes = Math.floor((arrival.getTime() - scheduledStart.getTime()) / 60000);
  const isLate = minutes > graceMinutes;
  return { minutes, isLate, lateBy: isLate ? minutes : 0 };
}

/** The shift's start on `date` and its grace period, as they were on that date. */
async function shiftStartOn(db: Queryable, shiftId: string, date: string) {
  const d = await one(
    `SELECT COALESCE(r.start_time, sh.start_time) AS start_time, COALESCE(r.timezone, sh.timezone) AS timezone, COALESCE(r.arrival_grace_minutes, sh.arrival_grace_minutes) AS grace
     FROM shifts sh LEFT JOIN LATERAL (
       SELECT * FROM shift_revisions x WHERE x.shift_id = sh.id AND $2::date <= x.valid_to AND (x.valid_from IS NULL OR $2::date >= x.valid_from) ORDER BY x.valid_to LIMIT 1
     ) r ON true WHERE sh.id = $1`,
    [shiftId, date],
    db,
  );
  return { at: DateTime.fromISO(`${date}T${d.start_time}`, { zone: d.timezone }).toJSDate(), grace: d.grace as number };
}

export async function requestManualReview(employeeId: string, sessionId: string, reason: string) {
  const outbox = new Outbox();
  const review = await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    if (!s) throw notFound('Session');
    if (s.employee_id !== employeeId) throw forbidden();
    if (s.ended_at) throw conflict('SESSION_CLOSED', 'This shift session has ended.');
    if (s.has_attendance) throw conflict('ALREADY_RECORDED', 'Attendance is already recorded. Use a dispute instead.');
    const open = await one(`SELECT id FROM review_requests WHERE session_id = $1 AND kind = 'MANUAL_REVIEW' AND status = 'OPEN'`, [sessionId], db);
    if (open) throw conflict('REVIEW_ALREADY_OPEN', 'A manual review request is already open.');
    const review = await one(
      `INSERT INTO review_requests (kind, employee_id, session_id, reason, requested_by, before_data, is_simulated)
       VALUES ('MANUAL_REVIEW', $1, $2, $3, $1, $4, $5) RETURNING *`,
      [employeeId, sessionId, reason, JSON.stringify({ state: s.state, lastDistanceM: s.last_distance_m, lastAccuracyM: s.last_accuracy_m, lastClassification: s.last_classification }), s.is_simulated],
      db,
    );
    await transition(db, outbox, s, 'MANUAL_REVIEW_REQUIRED', 'employee requested manual review', 'EMPLOYEE', employeeId, { resumeState: s.state });
    await notify(db, outbox, {
      type: 'MANUAL_REVIEW_REQUESTED',
      severity: 'WARNING',
      body: `${s.employee_name} requested a manual attendance review: "${reason.slice(0, 200)}"`,
      employeeId,
      workplaceId: s.workplace_id,
      sessionId,
      data: { reviewId: review.id, lastDistanceM: s.last_distance_m, lastAccuracyM: s.last_accuracy_m },
      dedupeKey: `review:${review.id}`,
      simulated: s.is_simulated,
    });
    return review;
  });
  outbox.flush();
  return review;
}

export async function cancelManualReview(employeeId: string, sessionId: string) {
  const outbox = new Outbox();
  await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    if (!s) throw notFound('Session');
    if (s.employee_id !== employeeId) throw forbidden();
    const r = await one(`UPDATE review_requests SET status = 'CANCELLED', resolved_at = now() WHERE session_id = $1 AND kind = 'MANUAL_REVIEW' AND status = 'OPEN' RETURNING id`, [sessionId], db);
    if (!r) throw notFound('Open review request');
    if (s.state === 'MANUAL_REVIEW_REQUIRED') {
      await transition(db, outbox, s, 'TRACKING_ACTIVE', 'employee cancelled manual review', 'EMPLOYEE', employeeId);
    }
  });
  outbox.flush();
}

export async function reportIssue(employeeId: string, input: { sessionId?: string | null; kind: 'TECHNICAL_ISSUE' | 'DISPUTE'; attendanceId?: string | null; reason: string }) {
  const outbox = new Outbox();
  const row = await tx(async (db) => {
    if (input.sessionId) {
      const s = await one('SELECT employee_id FROM tracking_sessions WHERE id = $1', [input.sessionId], db);
      if (!s || s.employee_id !== employeeId) throw forbidden();
    }
    let attendance: any = null;
    if (input.attendanceId) {
      attendance = await one('SELECT * FROM attendance_records WHERE id = $1 FOR UPDATE', [input.attendanceId], db);
      if (!attendance || attendance.employee_id !== employeeId) throw forbidden();
    }
    if (input.kind === 'DISPUTE' && !attendance) throw new HttpError(400, 'ATTENDANCE_REQUIRED', 'A dispute must reference an attendance record.');
    if (input.kind === 'DISPUTE') {
      // A voided record is final: a dispute must not lift it back into reports.
      if (attendance.verification_status === 'VOIDED') throw conflict('ATTENDANCE_VOIDED', 'This attendance record was voided and cannot be disputed. Speak to your administrator.');
      if (await one(`SELECT 1 FROM review_requests WHERE attendance_id = $1 AND kind = 'DISPUTE' AND status = 'OPEN'`, [attendance.id], db)) throw conflict('DISPUTE_OPEN', 'A dispute for this record is already open.');
    }
    const emp = await one('SELECT full_name, is_demo, org_id FROM users WHERE id = $1', [employeeId], db);
    const row = await one(
      `INSERT INTO review_requests (kind, employee_id, session_id, attendance_id, reason, requested_by, before_data, is_simulated)
       VALUES ($1,$2,$3,$4,$5,$2,$6,$7) RETURNING *`,
      [input.kind, employeeId, input.sessionId ?? null, input.attendanceId ?? null, input.reason, attendance ? JSON.stringify(attendance) : null, emp.is_demo],
      db,
    );
    if (attendance && input.kind === 'DISPUTE') {
      await q(`UPDATE attendance_records SET verification_status = 'DISPUTED', updated_at = now() WHERE id = $1`, [attendance.id], db);
      await audit({ actor: { id: employeeId, role: 'EMPLOYEE', orgId: emp.org_id }, action: 'attendance.dispute', resourceType: 'attendance_record', resourceId: attendance.id, before: { status: attendance.verification_status }, after: { status: 'DISPUTED' }, reason: input.reason }, db);
    }
    await notify(db, outbox, {
      type: input.kind === 'DISPUTE' ? 'MANUAL_REVIEW_REQUESTED' : 'TECHNICAL_ISSUE_REPORTED',
      severity: 'WARNING',
      body: `${emp.full_name} ${input.kind === 'DISPUTE' ? 'disputed an attendance record' : 'reported a technical issue'}: "${input.reason.slice(0, 200)}"`,
      employeeId,
      sessionId: input.sessionId ?? null,
      data: { reviewId: row.id, kind: input.kind },
      dedupeKey: `issue:${row.id}`,
      simulated: emp.is_demo,
    });
    return row;
  });
  outbox.flush();
  return row;
}

/** Admin decision on a manual review / dispute / technical issue. */
export async function resolveReview(admin: AuthUser, reviewId: string, decision: 'APPROVE' | 'REJECT' | 'ACKNOWLEDGE', note: string, req?: any) {
  const outbox = new Outbox();
  const result = await tx(async (db) => {
    const r = await one('SELECT * FROM review_requests WHERE id = $1 FOR UPDATE', [reviewId], db);
    if (!r) throw notFound('Review request');
    if (r.status !== 'OPEN') throw conflict('REVIEW_CLOSED', 'This request has already been resolved.');
    if (r.kind === 'ADMIN_CORRECTION') return decideCorrection(db, outbox, admin, r, decision, note, req);
    let attendanceId: string | null = r.attendance_id;
    let arrivalAt: Date | null = null;

    if (r.kind === 'MANUAL_REVIEW') {
      if (decision === 'ACKNOWLEDGE') throw new HttpError(400, 'BAD_DECISION', 'Approve or reject a manual review.');
      const s = r.session_id ? await lockSession(db, r.session_id) : null;
      if (decision === 'APPROVE') {
        if (!s) throw conflict('SESSION_REQUIRED', 'The related session no longer exists.');
        if (s.has_attendance) throw conflict('ALREADY_RECORDED', 'Attendance is already recorded for this shift.');
        await assertPayrollMonthOpen(admin.orgId, s.shift_date, db);
        // Arrival is when the employee asked to be marked present, not when someone got to the request.
        // The approver's name and time are stored separately. No location at that moment: flagged for anyone reading the record.
        arrivalAt = new Date(r.created_at);
        const supported = r.before_data?.lastDistanceM != null;
        const { isLate, lateBy } = lateness(arrivalAt, new Date(s.scheduled_start_at), s.arrival_grace_minutes);
        const rec = await one(
          `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key,
             evidence_latitude, evidence_longitude, evidence_accuracy_m, evidence_distance_m, evidence_client_time, radius_m_at_record,
             is_late, late_by_minutes, verification_status, risk_flags, is_simulated, recorded_at, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'MANUAL_APPROVED',$15,$16,$17,$18,now())
           ON CONFLICT (employee_id, shift_id, shift_date) DO NOTHING RETURNING id`,
          [s.employee_id, s.workplace_id, s.shift_id, s.id, s.shift_date, `review:${r.id}`, s.last_latitude, s.last_longitude, s.last_accuracy_m, s.last_distance_m, s.last_location_client_at, s.radius_m, isLate, lateBy, supported ? ['MANUAL_REVIEW'] : ['MANUAL_REVIEW', 'ARRIVAL_TIME_UNVERIFIED'], s.is_simulated, arrivalAt, admin.id],
          db,
        );
        if (!rec) throw conflict('ALREADY_RECORDED', 'Attendance is already recorded for this shift.');
        attendanceId = rec.id;
        s.has_attendance = true;
        if (!s.ended_at) await transition(db, outbox, s, 'PRESENT', 'manual review approved by administrator', 'ADMIN', admin.id);
        outbox.push({ type: 'attendance.recorded', attendanceId: rec.id, employeeId: s.employee_id });
      } else if (s && !s.ended_at && s.state === 'MANUAL_REVIEW_REQUIRED') {
        const back = s.resume_state && s.resume_state !== 'ATTENDANCE_SUBMISSION_PENDING' && s.resume_state !== 'ARRIVAL_CANDIDATE' ? s.resume_state : 'TRACKING_ACTIVE';
        await transition(db, outbox, s, back, 'manual review rejected by administrator', 'ADMIN', admin.id);
      }
    } else if (r.kind === 'DISPUTE' && r.attendance_id) {
      // Rejecting a dispute restores the previous status; approving requires a correction (separate call).
      const prevStatus = r.before_data?.verification_status ?? 'VERIFIED';
      if (decision !== 'APPROVE') await q(`UPDATE attendance_records SET verification_status = $2, updated_at = now() WHERE id = $1 AND verification_status = 'DISPUTED'`, [r.attendance_id, prevStatus], db);
    }

    const status = decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'ACKNOWLEDGED';
    await q(`UPDATE review_requests SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4, attendance_id = COALESCE(attendance_id, $5) WHERE id = $1`, [reviewId, status, admin.id, note, attendanceId], db);
    await audit({ actor: admin, action: `review.${decision.toLowerCase()}`, resourceType: 'review_request', resourceId: reviewId, before: { status: r.status }, after: { status, attendanceId, ...(arrivalAt ? { arrivalAt, approvedAt: new Date() } : {}) }, reason: note, req }, db);
    return { status, attendanceId };
  });
  outbox.flush();
  return result;
}

export interface CorrectionInput {
  reason: string;
  verificationStatus?: 'VERIFIED' | 'MANUAL_APPROVED' | 'CORRECTED' | 'DISPUTED' | 'VOIDED';
  recordedAt?: string;
  isLate?: boolean;
  lateByMinutes?: number;
}

/**
 * Applies a correction. The whole record before and after is kept in review history and the audit log.
 * `pending` is the supervisor's request being approved; without it the approver is also the requester.
 */
async function applyCorrection(db: Queryable, outbox: Outbox, approver: AuthUser, attendanceId: string, c: CorrectionInput, req?: any, pending?: { id: string; requestedBy: string; note: string }) {
  const before = await one('SELECT * FROM attendance_records WHERE id = $1 FOR UPDATE', [attendanceId], db);
  if (!before) throw notFound('Attendance record');
  if (before.verification_status === 'VOIDED') throw conflict('ATTENDANCE_VOIDED', 'A voided record cannot be changed. Its history stays in the audit log.');
  await assertPayrollMonthOpen(approver.orgId, before.shift_date, db);
  if (before.verification_status === 'PENDING_VERIFICATION' && c.verificationStatus === 'VERIFIED') {
    throw conflict('NEEDS_VERIFICATION', 'This record was sent late from the phone. Decide it in Approvals.');
  }
  // A new arrival time re-judges lateness by the same rule, unless the administrator set it explicitly.
  let isLate = c.isLate ?? null;
  let lateBy = c.lateByMinutes ?? null;
  if (c.recordedAt && isLate === null && lateBy === null) {
    const session = before.session_id ? await one('SELECT scheduled_start_at FROM tracking_sessions WHERE id = $1', [before.session_id], db) : null;
    const shift = await shiftStartOn(db, before.shift_id, before.shift_date);
    const l = lateness(new Date(c.recordedAt), session ? new Date(session.scheduled_start_at) : shift.at, shift.grace);
    isLate = l.isLate;
    lateBy = l.lateBy;
  }
  const after = await one(
    `UPDATE attendance_records SET
       verification_status = COALESCE($2, CASE WHEN verification_status = 'VERIFIED' THEN 'CORRECTED' ELSE verification_status END),
       original_recorded_at = CASE WHEN $3::timestamptz IS NOT NULL THEN COALESCE(original_recorded_at, recorded_at) ELSE original_recorded_at END,
       recorded_at = COALESCE($3::timestamptz, recorded_at),
       is_late = COALESCE($4, is_late),
       late_by_minutes = COALESCE($5, late_by_minutes),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [attendanceId, c.verificationStatus ?? null, c.recordedAt ?? null, isLate, lateBy],
    db,
  );
  if (pending) {
    await q(
      `UPDATE review_requests SET status = 'APPLIED', before_data = $2, after_data = $3, resolved_by = $4, resolved_at = now(), resolution_note = $5 WHERE id = $1`,
      [pending.id, JSON.stringify(before), JSON.stringify({ ...after, proposed: c }), approver.id, pending.note],
      db,
    );
  } else {
    await q(
      `INSERT INTO review_requests (kind, employee_id, session_id, attendance_id, reason, status, before_data, after_data, requested_by, resolved_by, resolved_at, is_simulated)
       VALUES ('ADMIN_CORRECTION', $1, $2, $3, $4, 'APPLIED', $5, $6, $7, $7, now(), $8)`,
      [before.employee_id, before.session_id, attendanceId, c.reason, JSON.stringify(before), JSON.stringify(after), approver.id, before.is_simulated],
      db,
    );
  }
  // A corrected dispute is resolved by the correction.
  await q(`UPDATE review_requests SET status = 'APPROVED', resolved_by = $2, resolved_at = now(), resolution_note = $3 WHERE attendance_id = $1 AND kind = 'DISPUTE' AND status = 'OPEN'`, [attendanceId, approver.id, `Corrected: ${c.reason}`], db);
  await audit({ actor: approver, action: 'attendance.correct', resourceType: 'attendance_record', resourceId: attendanceId, before, after: { ...after, requestedBy: pending?.requestedBy ?? approver.id, approvedBy: approver.id }, reason: c.reason, req }, db);
  outbox.push({ type: 'attendance.recorded', attendanceId, employeeId: before.employee_id });
  return after;
}

/** A correction that applies at once: by an owner, or as the outcome of a decided face review. */
export async function correctAttendance(admin: AuthUser, attendanceId: string, c: CorrectionInput, req?: any) {
  const outbox = new Outbox();
  const updated = await tx((db) => applyCorrection(db, outbox, admin, attendanceId, c, req));
  outbox.flush();
  return updated;
}

/** A supervisor's correction: nothing on the record changes until an owner approves it. */
export async function requestCorrection(supervisor: AuthUser, attendanceId: string, c: CorrectionInput, req?: any) {
  const { reason, ...change } = c;
  if (!Object.values(change).some((v) => v !== undefined)) throw badRequest('NOTHING_TO_CORRECT', 'Say what should change on this record.');
  const outbox = new Outbox();
  const review = await tx(async (db) => {
    const before = await one('SELECT * FROM attendance_records WHERE id = $1 FOR UPDATE', [attendanceId], db);
    if (!before) throw notFound('Attendance record');
    if (before.verification_status === 'VOIDED') throw conflict('ATTENDANCE_VOIDED', 'A voided record cannot be changed. Its history stays in the audit log.');
    await assertPayrollMonthOpen(supervisor.orgId, before.shift_date, db);
    if (await one(`SELECT 1 FROM review_requests WHERE attendance_id = $1 AND kind = 'ADMIN_CORRECTION' AND status = 'OPEN'`, [attendanceId], db)) {
      throw conflict('CORRECTION_OPEN', 'A correction for this record is already waiting for an owner.');
    }
    const row = await one(
      `INSERT INTO review_requests (kind, employee_id, session_id, attendance_id, reason, before_data, after_data, requested_by, is_simulated)
       VALUES ('ADMIN_CORRECTION', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [before.employee_id, before.session_id, attendanceId, reason, JSON.stringify(before), JSON.stringify(c), supervisor.id, before.is_simulated],
      db,
    );
    await audit({ actor: supervisor, action: 'attendance.correction_request', resourceType: 'attendance_record', resourceId: attendanceId, before, after: change, reason, req }, db);
    await notify(db, outbox, {
      type: 'MANUAL_REVIEW_REQUESTED',
      severity: 'WARNING',
      body: `${supervisor.fullName} proposed an attendance correction, waiting for an owner: "${reason.slice(0, 200)}"`,
      employeeId: before.employee_id,
      workplaceId: before.workplace_id,
      data: { reviewId: row.id, kind: 'ADMIN_CORRECTION' },
      dedupeKey: `correction:${row.id}`,
      simulated: before.is_simulated,
    });
    return row;
  });
  outbox.flush();
  return { pending: true, review };
}

/** An owner's decision on a supervisor's correction. Rejecting leaves the record as it was. */
async function decideCorrection(db: Queryable, outbox: Outbox, admin: AuthUser, r: any, decision: 'APPROVE' | 'REJECT' | 'ACKNOWLEDGE', note: string, req?: any) {
  if (admin.access !== 'OWNER') throw new HttpError(403, 'OWNER_ONLY', 'Only the company owner can do this.');
  if (r.requested_by === admin.id) throw new HttpError(403, 'OWN_REQUEST', 'A correction must be decided by someone other than the person who asked for it.');
  if (decision === 'ACKNOWLEDGE') throw new HttpError(400, 'BAD_DECISION', 'Approve or reject a correction.');
  if (decision === 'APPROVE') {
    await applyCorrection(db, outbox, admin, r.attendance_id, r.after_data, req, { id: r.id, requestedBy: r.requested_by, note });
    return { status: 'APPLIED', attendanceId: r.attendance_id };
  }
  await q(`UPDATE review_requests SET status = 'REJECTED', resolved_by = $2, resolved_at = now(), resolution_note = $3 WHERE id = $1`, [r.id, admin.id, note], db);
  await audit({ actor: admin, action: 'review.reject', resourceType: 'review_request', resourceId: r.id, before: { status: r.status }, after: { status: 'REJECTED', attendanceId: r.attendance_id, requestedBy: r.requested_by }, reason: note, req }, db);
  return { status: 'REJECTED', attendanceId: r.attendance_id };
}

/**
 * A supervisor or owner decides a record the phone sent late. Approving counts it as approved by that
 * person, never as verified by the server. Rejecting voids it with a reason, and an owner can override that.
 * The evidence, the device's own time and the whole record before and after stay.
 */
export async function verifyOfflineRecord(reviewer: AuthUser, attendanceId: string, decision: 'APPROVE' | 'REJECT', note: string, req?: any) {
  const outbox = new Outbox();
  const updated = await tx(async (db) => {
    const before = await one('SELECT * FROM attendance_records WHERE id = $1 FOR UPDATE', [attendanceId], db);
    if (!before) throw notFound('Attendance record');
    if (before.verification_status !== 'PENDING_VERIFICATION') throw conflict('NOT_PENDING', 'This record is not waiting for verification.');
    await assertPayrollMonthOpen(reviewer.orgId, before.shift_date, db);
    const after = await one(
      decision === 'APPROVE'
        ? `UPDATE attendance_records SET verification_status = 'MANUAL_APPROVED', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1 RETURNING *`
        : `UPDATE attendance_records SET verification_status = 'VOIDED', risk_flags = array_append(risk_flags, 'VERIFICATION_REJECTED'), updated_at = now() WHERE id = $1 AND $2::uuid IS NOT NULL RETURNING *`,
      [attendanceId, reviewer.id],
      db,
    );
    await q(
      `INSERT INTO review_requests (kind, employee_id, session_id, attendance_id, reason, status, before_data, after_data, requested_by, resolved_by, resolved_at, resolution_note, is_simulated)
       VALUES ('ADMIN_CORRECTION', $1, $2, $3, $4, 'APPLIED', $5, $6, $7, $7, now(), $8, $9)`,
      [before.employee_id, before.session_id, attendanceId, `Offline record ${decision === 'APPROVE' ? 'approved' : 'rejected'}: ${note}`, JSON.stringify(before), JSON.stringify(after), reviewer.id, note, before.is_simulated],
      db,
    );
    await audit({ actor: reviewer, action: decision === 'APPROVE' ? 'attendance.verify' : 'attendance.verify_reject', resourceType: 'attendance_record', resourceId: attendanceId, before, after, reason: note, req }, db);
    outbox.push({ type: 'attendance.recorded', attendanceId, employeeId: before.employee_id });
    return after;
  });
  outbox.flush();
  return updated;
}

/**
 * The owner overrides a rejected face check or a rejected offline record: the record counts again, as CORRECTED. The rejection,
 * its reason and the whole record before and after stay in review history and the audit log.
 */
export async function overrideFaceRejection(owner: AuthUser, attendanceId: string, reason: string, req?: any) {
  const overridable = (r: any) => r.verification_status === 'VOIDED' && (r.face_review === 'REJECTED' || (r.risk_flags ?? []).includes('VERIFICATION_REJECTED'));
  const outbox = new Outbox();
  const updated = await tx(async (db) => {
    const before = await one('SELECT * FROM attendance_records WHERE id = $1 FOR UPDATE', [attendanceId], db);
    if (!before) throw notFound('Attendance record');
    if (!overridable(before)) throw conflict('NOT_FACE_REJECTED', 'Only attendance voided by a rejected face check or a rejected offline record can be overridden.');
    await assertPayrollMonthOpen(owner.orgId, before.shift_date, db);
    // Lasts for this transaction only; the database refuses every other way of lifting a void.
    await q(`SELECT set_config('geoattend.face_override', 'on', true)`, [], db);
    const after = await one(
      `UPDATE attendance_records SET verification_status = 'CORRECTED', face_review = CASE WHEN face_review = 'REJECTED' THEN 'APPROVED' ELSE face_review END,
         face_reviewed_by = CASE WHEN face_review = 'REJECTED' THEN $2 ELSE face_reviewed_by END, face_reviewed_at = CASE WHEN face_review = 'REJECTED' THEN now() ELSE face_reviewed_at END,
         face_review_note = CASE WHEN face_review = 'REJECTED' THEN $3 ELSE face_review_note END, approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [attendanceId, owner.id, `Owner override: ${reason}`],
      db,
    );
    await q(
      `INSERT INTO review_requests (kind, employee_id, session_id, attendance_id, reason, status, before_data, after_data, requested_by, resolved_by, resolved_at, is_simulated)
       VALUES ('ADMIN_CORRECTION', $1, $2, $3, $4, 'APPLIED', $5, $6, $7, $7, now(), $8)`,
      [before.employee_id, before.session_id, attendanceId, `Rejection overridden: ${reason}`, JSON.stringify(before), JSON.stringify(after), owner.id, before.is_simulated],
      db,
    );
    await audit({ actor: owner, action: 'face_review.override', resourceType: 'attendance_record', resourceId: attendanceId, before, after, reason, req }, db);
    outbox.push({ type: 'attendance.recorded', attendanceId, employeeId: before.employee_id });
    return after;
  });
  outbox.flush();
  return updated;
}

/** Admin-entered attendance when no device evidence exists (e.g. broken phone). Always MANUAL_APPROVED and audited. */
export async function createManualAttendance(admin: AuthUser, input: { employeeId: string; shiftId: string; shiftDate: string; recordedAt: string; workedMinutes?: number; reason: string }, req?: any) {
  return tx(async (db) => {
    await assertPayrollMonthOpen(admin.orgId, input.shiftDate, db);
    const shift = await one(
      `SELECT sh.* FROM employee_shift_assignments esa JOIN shifts sh ON sh.id = esa.shift_id WHERE esa.employee_id = $1 AND esa.shift_id = $2
       AND esa.effective_from <= $3::date AND (esa.effective_to IS NULL OR esa.effective_to >= $3::date)`,
      [input.employeeId, input.shiftId, input.shiftDate],
      db,
    );
    if (!shift) throw new HttpError(400, 'NOT_ASSIGNED', 'The employee was not assigned to this shift on that date.');
    const wp = await one('SELECT * FROM workplaces WHERE id = $1', [shift.workplace_id], db);
    const emp = await one('SELECT is_demo FROM users WHERE id = $1', [input.employeeId], db);
    const start = await shiftStartOn(db, shift.id, input.shiftDate);
    const { isLate, lateBy } = lateness(new Date(input.recordedAt), start.at, start.grace);
    const rec = await one(
      `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, shift_date, recorded_at, idempotency_key, radius_m_at_record, verification_status, risk_flags, is_simulated, is_late, late_by_minutes, manual_worked_minutes, approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'MANUAL_APPROVED','{ADMIN_ENTERED}',$8,$9,$10,$11,$12,now())
       ON CONFLICT (employee_id, shift_id, shift_date) DO NOTHING RETURNING *`,
      [input.employeeId, wp.id, shift.id, input.shiftDate, input.recordedAt, `manual:${crypto.randomUUID()}`, wp.radius_m, emp?.is_demo ?? false, isLate, lateBy, input.workedMinutes ?? null, admin.id],
      db,
    );
    if (!rec) throw conflict('ALREADY_RECORDED', 'An attendance record already exists for this employee, shift and date.');
    await audit({ actor: admin, action: 'attendance.manual_create', resourceType: 'attendance_record', resourceId: rec.id, after: rec, reason: input.reason, req }, db);
    return rec;
  });
}

export async function expireStaleIntents(outbox: Outbox) {
  const rows = await q(
    `SELECT DISTINCT p.session_id FROM attendance_photos p JOIN tracking_sessions s ON s.id = p.session_id
     WHERE p.status IN ('PENDING_UPLOAD', 'UPLOADED') AND p.upload_expires_at < now() - interval '5 minutes'
       AND s.state = 'ATTENDANCE_SUBMISSION_PENDING' AND s.ended_at IS NULL`,
  );
  for (const r of rows) {
    await tx(async (c) => {
      const s = await lockSession(c, r.session_id);
      if (!s || s.state !== 'ATTENDANCE_SUBMISSION_PENDING') return;
      await q(`UPDATE attendance_photos SET status = 'EXPIRED' WHERE session_id = $1 AND status IN ('PENDING_UPLOAD', 'UPLOADED')`, [s.id], c);
      await transition(c, outbox, s, 'ATTENDANCE_READY', 'attendance submission not completed in time', 'SYSTEM');
    });
  }
}
