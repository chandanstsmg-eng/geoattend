/**
 * Tracking sessions: start → permission check → location ingestion through the
 * state-machine engine → end. Every state change is written to
 * session_state_transitions together with its reason and actor.
 *
 * Concurrency: all mutations of a session run in a transaction that holds a
 * row lock on the session (SELECT … FOR UPDATE), so concurrent uploads from a
 * device, the sweeper and admin actions are serialised.
 */
import type pg from 'pg';
import { distanceMeters, isValidLatLng, OPEN_STATES, STATE_LABELS, TRACKING_STATES, type SessionState } from '@geoattend/shared';
import { one, q, tx, type Queryable } from '../../db/pool.js';
import { HttpError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { currentInstance, nextInstance, type DateRange } from '../../lib/shift-window.js';
import { getSettings, hasAcknowledgedNotice, orgOfUser, type Settings } from '../settings/settings.service.js';
import { challengeFor } from '../faces/faces.js';
import { config } from '../../config.js';
import { createUploadUrl, deleteObject, inspectObject, newObjectKey } from '../../lib/storage.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { evaluate, type EngineEffect, type EngineRules } from './engine.js';
import { closeBreak } from './breaks.service.js';
import { canStartOvertime, closeOvertime, finalizeOvertimeSession, onOvertime, type OvertimeEndReason } from './overtime.service.js';

export type Actor = 'SYSTEM' | 'EMPLOYEE' | 'ADMIN' | 'SIMULATOR';

export interface ReadingInput {
  clientEventId: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  clientTime: string; // ISO
  altitudeM?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
  isMocked?: boolean;
  source: 'FOREGROUND' | 'BACKGROUND' | 'SUBMISSION' | 'SIMULATOR';
}

export interface ReadingResult {
  clientEventId: string;
  status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
  reason?: string;
}

const MAX_CLOCK_SKEW_MS = 2 * 60_000;
/** Phones keep network time; a fix more than a minute "in the future" means a changed clock (GPS-08). */
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_BACKLOG_MS = 24 * 3600_000;

/** The session's clock: real time, plus the demo simulator's virtual offset (always 0 for real sessions). */
export const sessionNow = (s: { sim_clock_offset_sec?: number | null }) => new Date(Date.now() + (s.sim_clock_offset_sec ?? 0) * 1000);

export function engineRules(settings: Settings, radiusM: number): EngineRules {
  const t = settings.tracking;
  return {
    radiusM,
    maxAccuracyM: t.maxAccuracyM,
    boundaryFactor: t.boundaryFactor,
    exitHysteresisM: t.exitHysteresisM,
    entryStabilizationSec: t.entryStabilizationSec,
    entryMinReadings: t.entryMinReadings,
    exitStabilizationSec: t.exitStabilizationSec,
    exitMinReadings: t.exitMinReadings,
    returnStabilizationSec: t.returnStabilizationSec,
    returnMinReadings: t.returnMinReadings,
    entryMinServerSpanSec: t.entryMinServerSpanSec,
  };
}

export async function lockSession(db: pg.PoolClient, sessionId: string) {
  return one(
    `SELECT s.*, w.name AS workplace_name, w.latitude AS wp_lat, w.longitude AS wp_lng, w.radius_m, w.config_version,
            w.is_active AS workplace_active, w.absence_threshold_minutes AS wp_absence_threshold,
            sh.absence_threshold_minutes AS shift_absence_threshold, sh.arrival_grace_minutes, sh.name AS shift_name,
            u.full_name AS employee_name, u.org_id,
            EXISTS (SELECT 1 FROM attendance_records ar WHERE ar.employee_id = s.employee_id AND ar.shift_id = s.shift_id
                    AND ar.shift_date = s.shift_date AND ar.verification_status <> 'VOIDED') AS has_attendance,
            COALESCE((SELECT b.left_at IS NOT NULL FROM session_breaks b WHERE b.session_id = s.id AND b.ended_at IS NULL), false) AS break_left
     FROM tracking_sessions s
     JOIN workplaces w ON w.id = s.workplace_id
     JOIN shifts sh ON sh.id = s.shift_id
     JOIN users u ON u.id = s.employee_id
     WHERE s.id = $1
     FOR UPDATE OF s`,
    [sessionId],
    db,
  );
}

export async function transition(
  db: Queryable,
  outbox: Outbox,
  session: { id: string; employee_id: string; state: string; is_simulated: boolean },
  to: SessionState,
  reason: string,
  actor: Actor,
  actorId: string | null = null,
  extra: { resumeState?: SessionState | null; metadata?: Record<string, unknown> } = {},
) {
  if (session.state === to) return;
  await q(
    `UPDATE tracking_sessions SET state = $2, resume_state = $3, state_changed_at = now(), updated_at = now() WHERE id = $1`,
    [session.id, to, extra.resumeState ?? null],
    db,
  );
  await q(
    `INSERT INTO session_state_transitions (session_id, from_state, to_state, reason, actor, actor_id, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [session.id, session.state, to, reason, actor, actorId, JSON.stringify(extra.metadata ?? {})],
    db,
  );
  outbox.push({ type: 'session.updated', sessionId: session.id, employeeId: session.employee_id, state: to, simulated: session.is_simulated });
  session.state = to;
}

// ───────────────────────── assignment lookup ─────────────────────────

/**
 * The employee's home workplace and their rostered shifts. Each shift carries its own workplace
 * and every date range it is rostered for (from yesterday on, so an overnight shift that began
 * yesterday still counts); callers decide which dates matter via `ranges`.
 */
export async function employeeAssignment(employeeId: string, db?: Queryable) {
  const workplace = await one(
    `SELECT w.* FROM workplace_assignments wa JOIN workplaces w ON w.id = wa.workplace_id
     WHERE wa.employee_id = $1 AND wa.effective_to IS NULL AND wa.effective_from <= CURRENT_DATE`,
    [employeeId],
    db,
  );
  const rows = await q(
    `SELECT sh.*, esa.id AS assignment_id, esa.effective_from, esa.effective_to, esa.manager_id, m.full_name AS manager_name, esa.notes AS assignment_notes,
            w.name AS wp_name, w.address AS wp_address, w.latitude AS wp_latitude, w.longitude AS wp_longitude, w.radius_m AS wp_radius_m,
            w.timezone AS wp_timezone, w.is_active AS wp_is_active, w.is_demo AS wp_is_demo, w.absence_threshold_minutes AS wp_absence_threshold
     FROM employee_shift_assignments esa
     JOIN shifts sh ON sh.id = esa.shift_id
     JOIN workplaces w ON w.id = sh.workplace_id
     LEFT JOIN users m ON m.id = esa.manager_id
     WHERE esa.employee_id = $1 AND (esa.effective_to IS NULL OR esa.effective_to >= CURRENT_DATE - 1)
     ORDER BY sh.start_time, esa.effective_from`,
    [employeeId],
    db,
  );
  const byShift = new Map<string, any>();
  for (const r of rows) {
    const entry = byShift.get(r.id) ?? { ...r, ranges: [] as Array<DateRange & { managerName: string | null; notes: string | null }> };
    entry.ranges.push({ from: r.effective_from, to: r.effective_to, managerName: r.manager_name, notes: r.assignment_notes ?? null });
    byShift.set(r.id, entry);
  }
  return { workplace, shifts: [...byShift.values()] };
}

// ───────────────────────── start ─────────────────────────

export async function startSession(employeeId: string, shiftId: string, deviceId: string | null, actor: Actor, now = new Date()) {
  const orgId = await orgOfUser(employeeId);
  const settings = await getSettings(orgId);
  if (actor === 'EMPLOYEE' && !(await hasAcknowledgedNotice(employeeId, orgId))) {
    throw new HttpError(412, 'NOTICE_ACK_REQUIRED', 'Please review the location-tracking notice before starting your shift.');
  }
  if (actor === 'EMPLOYEE' && settings.workforce.faceEnrollment === 'REQUIRED' && !(await one('SELECT 1 FROM employee_face_profiles WHERE employee_id = $1', [employeeId]))) {
    throw new HttpError(412, 'FACE_ENROLLMENT_REQUIRED', 'Enroll your face once (five photos) before your first shift.');
  }
  const { shifts } = await employeeAssignment(employeeId);
  const shift = shifts.find((s) => s.id === shiftId);
  if (!shift) throw forbidden('You are not rostered for this shift. Contact your administrator.');
  // The roster decides the workplace: the shift's own site, not the employee's home workplace.
  const workplace = { id: shift.workplace_id, name: shift.wp_name };
  if (!shift.wp_is_active) throw conflict('WORKPLACE_DISABLED', 'The workplace for this shift is currently disabled.');
  if (!shift.is_active) throw conflict('SHIFT_DISABLED', 'This shift is currently disabled.');

  const inst = currentInstance(shift, now, settings.tracking.earlyStartMinutes, settings.tracking.endGraceMinutes, shift.ranges);
  if (!inst) {
    const next = nextInstance(shift, now, settings.tracking.earlyStartMinutes, settings.tracking.endGraceMinutes, shift.ranges);
    throw conflict('OUTSIDE_SHIFT_WINDOW', 'Tracking can only start during your shift window.', next && { nextWindowOpensAt: next.windowOpensAt, nextShiftStartsAt: next.startsAt });
  }

  const outbox = new Outbox();
  const result = await tx(async (db) => {
    const existing = await one('SELECT * FROM tracking_sessions WHERE employee_id = $1 AND shift_id = $2 AND shift_date = $3 FOR UPDATE', [employeeId, shiftId, inst.shiftDate], db);
    if (existing) {
      if (existing.ended_at) throw conflict('SHIFT_ALREADY_COMPLETED', 'This shift has already been completed. Contact your administrator if it was ended by mistake.');
      if (deviceId && existing.device_id !== deviceId) await q('UPDATE tracking_sessions SET device_id = $2 WHERE id = $1', [existing.id, deviceId], db);
      return existing;
    }
    const other = await one(`SELECT id, state, resume_state FROM tracking_sessions WHERE employee_id = $1 AND ended_at IS NULL`, [employeeId], db);
    if (other && onOvertime(other)) {
      // Overtime from an earlier shift that was never ended: the new shift ends it.
      const prev = await lockSession(db, other.id);
      if (prev && !prev.ended_at) await finalizeOvertimeSession(db, outbox, prev, now, 'NEXT_SHIFT');
    } else if (other) throw conflict('ANOTHER_SESSION_OPEN', 'Another shift session is still open. End it first.');

    const isSimulated = actor === 'SIMULATOR';
    const s = await one(
      `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, device_id, is_simulated)
       VALUES ($1,$2,$3,$4,$5,$6,'SHIFT_START_PENDING',$7,$8) RETURNING *`,
      [employeeId, shiftId, workplace.id, inst.shiftDate, inst.startsAt, inst.endsAt, deviceId, isSimulated],
      db,
    );
    await q(
      `INSERT INTO session_state_transitions (session_id, from_state, to_state, reason, actor, actor_id) VALUES ($1, NULL, 'SHIFT_START_PENDING', 'shift started by employee', $2, $3)`,
      [s.id, actor, actor === 'EMPLOYEE' ? employeeId : null],
      db,
    );
    const emp = await one('SELECT full_name FROM users WHERE id = $1', [employeeId], db);
    await notify(db, outbox, {
      type: 'SHIFT_STARTED',
      severity: 'INFO',
      body: `${emp.full_name} started ${shift.name} at ${workplace.name}.`,
      employeeId,
      workplaceId: workplace.id,
      sessionId: s.id,
      dedupeKey: `shift-started:${s.id}`,
      simulated: isSimulated,
    });
    outbox.push({ type: 'session.updated', sessionId: s.id, employeeId, state: s.state, simulated: isSimulated });
    return s;
  });
  outbox.flush();
  return result;
}

// ───────────────────────── permissions ─────────────────────────

export interface PermissionReport {
  foreground: 'granted' | 'denied' | 'undetermined';
  background: 'granted' | 'denied' | 'undetermined' | 'unavailable';
  locationServicesEnabled: boolean;
  precise?: boolean | null;
  batteryOptimization?: string | null;
  clientTime?: string | null;
  deviceId?: string | null;
}

export async function reportPermissions(sessionId: string, employeeId: string, p: PermissionReport, actor: Actor = 'EMPLOYEE') {
  const outbox = new Outbox();
  await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    if (!s) throw notFound('Session');
    if (s.employee_id !== employeeId) throw forbidden();
    await q(
      `INSERT INTO permission_status_events (employee_id, session_id, device_id, foreground, background, location_services_enabled, precise, battery_optimization, client_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [employeeId, sessionId, p.deviceId ?? s.device_id, p.foreground, p.background, p.locationServicesEnabled, p.precise ?? null, p.batteryOptimization ?? null, p.clientTime ?? null],
      db,
    );
    if (s.ended_at) return;
    await q(
      `UPDATE tracking_sessions SET foreground_permission = $2, background_permission = $3, location_services_enabled = $4, updated_at = now() WHERE id = $1`,
      [sessionId, p.foreground, p.background, p.locationServicesEnabled],
      db,
    );

    // Company policy can also require "Allow all the time" (no gaps when the app is closed) and precise location.
    const { tracking } = await getSettings(s.org_id, db);
    const missing = !p.locationServicesEnabled
      ? 'device location services disabled'
      : p.foreground !== 'granted'
        ? `location permission ${p.foreground}`
        : tracking.requireBackgroundLocation && p.background !== 'granted'
          ? `background location ${p.background} — "Allow all the time" is required`
          : tracking.requirePreciseLocation && p.precise === false
            ? 'precise location is off'
            : null;
    const usable = missing === null;
    const state = s.state as SessionState;
    if (!usable) {
      if (state === 'SHIFT_START_PENDING' || TRACKING_STATES.includes(state) || state === 'TRACKING_INTERRUPTED') {
        const wasTracking = state !== 'SHIFT_START_PENDING';
        await transition(db, outbox, s, 'TRACKING_PERMISSION_REQUIRED', missing, actor, null, {
          resumeState: state === 'TRACKING_INTERRUPTED' ? (s.resume_state as SessionState) : state,
        });
        if (wasTracking) {
          await notify(db, outbox, {
            type: 'PERMISSION_REVOKED',
            severity: 'WARNING',
            body: `${s.employee_name}: ${missing} during ${s.shift_name}. Tracking is paused until it is fixed on the phone; this is not evidence that the employee left.`,
            employeeId,
            workplaceId: s.workplace_id,
            sessionId,
            data: { foreground: p.foreground, background: p.background, precise: p.precise ?? null, locationServicesEnabled: p.locationServicesEnabled, previousState: state, reason: missing },
            dedupeKey: `perm-revoked:${sessionId}:${Date.now()}`,
            simulated: s.is_simulated,
          });
        }
      }
      return;
    }
    if (state === 'SHIFT_START_PENDING') {
      await transition(db, outbox, s, 'TRACKING_ACTIVE', 'location permission granted', actor);
    } else if (state === 'TRACKING_PERMISSION_REQUIRED') {
      const resume = (s.resume_state as SessionState | null) ?? (s.has_attendance ? 'PRESENT' : 'TRACKING_ACTIVE');
      const target: SessionState = resume === 'ARRIVAL_CANDIDATE' || resume === 'SHIFT_START_PENDING' ? 'TRACKING_ACTIVE' : resume;
      await q('UPDATE tracking_sessions SET candidate_since = NULL, candidate_count = 0 WHERE id = $1', [sessionId], db);
      await transition(db, outbox, s, target, 'location permission restored', actor);
    }
    // Usable foreground permission but no background permission: updates will have gaps. (Deduplicated per session and status.)
    if (p.background !== 'granted') {
      await notify(db, outbox, {
        type: 'BACKGROUND_UNAVAILABLE',
        severity: 'WARNING',
        body: `${s.employee_name}: background location is ${p.background}. Updates will only arrive while the app is open, so gaps are expected.`,
        employeeId,
        workplaceId: s.workplace_id,
        sessionId,
        data: { background: p.background },
        dedupeKey: `bg-unavailable:${sessionId}:${p.background}`,
        simulated: s.is_simulated,
      });
    }
  });
  outbox.flush();
}

// ───────────────────────── ingestion ─────────────────────────

function validateReading(r: ReadingInput, session: any, now: Date): string | null {
  if (!isValidLatLng(r.latitude, r.longitude)) return 'INVALID_COORDINATES';
  if (r.latitude === 0 && r.longitude === 0) return 'NULL_ISLAND';
  if (!(r.accuracyM > 0) || r.accuracyM > 5000) return 'IMPLAUSIBLE_ACCURACY';
  const t = new Date(r.clientTime);
  if (Number.isNaN(t.getTime())) return 'INVALID_TIMESTAMP';
  if (t.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) return 'TIMESTAMP_IN_FUTURE';
  if (t.getTime() < now.getTime() - MAX_BACKLOG_MS) return 'TIMESTAMP_TOO_OLD';
  if (t.getTime() < new Date(session.started_at).getTime() - MAX_CLOCK_SKEW_MS) return 'BEFORE_SESSION_START';
  return null;
}

export interface IngestOutcome {
  results: ReadingResult[];
  evaluated: number;
}

/**
 * Validates and stores readings, then runs each new reading through the engine
 * in device-time order. Must be called inside a transaction holding the session lock.
 */
export async function ingestLocked(db: pg.PoolClient, outbox: Outbox, s: any, readings: ReadingInput[], actor: Actor, now = new Date()): Promise<IngestOutcome> {
  const settings = await getSettings(s.org_id, db);
  const rules = engineRules(settings, Number(s.radius_m));
  const results: ReadingResult[] = [];
  let evaluated = 0;
  const workplace = { lat: s.wp_lat, lng: s.wp_lng };
  const sorted = [...readings].sort((a, b) => new Date(a.clientTime).getTime() - new Date(b.clientTime).getTime());

  for (const r of sorted) {
    if (s.ended_at || !OPEN_STATES.includes(s.state)) {
      results.push({ clientEventId: r.clientEventId, status: 'REJECTED', reason: 'SESSION_CLOSED' });
      continue;
    }
    const invalid = validateReading(r, s, now);
    if (invalid) {
      results.push({ clientEventId: r.clientEventId, status: 'REJECTED', reason: invalid });
      continue;
    }
    const clientTime = new Date(r.clientTime);
    const distance = distanceMeters(workplace, { lat: r.latitude, lng: r.longitude });
    const lastClient = s.last_location_client_at ? new Date(s.last_location_client_at) : null;
    const isHistorical = lastClient !== null && clientTime <= lastClient;
    const delayed = now.getTime() - clientTime.getTime() > settings.tracking.staleAfterSec * 1000;

    // Evaluate first (pure) so the stored row carries the classification used.
    const res = isHistorical
      ? null
      : evaluate(
          {
            state: s.state,
            resumeState: s.resume_state,
            candidateSince: s.candidate_since ? new Date(s.candidate_since) : null,
            candidateCount: s.candidate_count,
            candidateReceivedSince: s.candidate_received_since ? new Date(s.candidate_received_since) : null,
            hasAttendance: s.has_attendance,
            breakLeft: s.break_left,
          },
          // Server receipt time (GPS-01). The demo simulator runs on a virtual clock, so it is judged on device time only.
          { distanceM: distance, accuracyM: r.accuracyM, time: clientTime, receivedAt: s.is_simulated ? undefined : new Date() },
          rules,
        );

    const inserted = await one(
      `INSERT INTO location_updates (session_id, employee_id, client_event_id, latitude, longitude, accuracy_m, altitude_m, speed_mps, heading_deg,
                                     is_mocked, source, client_time, distance_m, classification, validation_status, workplace_config_version, is_simulated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (session_id, client_event_id) DO NOTHING RETURNING id`,
      [
        s.id,
        s.employee_id,
        r.clientEventId,
        r.latitude,
        r.longitude,
        r.accuracyM,
        r.altitudeM ?? null,
        r.speedMps ?? null,
        r.headingDeg ?? null,
        !!r.isMocked,
        r.source,
        clientTime,
        distance,
        res?.classification ?? 'AMBIGUOUS',
        isHistorical ? 'HISTORICAL' : delayed ? 'DELAYED' : 'EVALUATED',
        s.config_version,
        s.is_simulated,
      ],
      db,
    );
    if (!inserted) {
      results.push({ clientEventId: r.clientEventId, status: 'DUPLICATE' });
      continue;
    }
    results.push({ clientEventId: r.clientEventId, status: 'ACCEPTED' });
    if (!res) continue;
    evaluated++;

    const reading = { lat: r.latitude, lng: r.longitude, accuracy: r.accuracyM, distance, time: clientTime };
    const uncertain = res.classification === 'AMBIGUOUS' || res.classification === 'INSUFFICIENT_ACCURACY';
    const newUncertainSince = uncertain ? (s.uncertain_since ?? clientTime) : null;
    if (res.classification === 'INSUFFICIENT_ACCURACY' && !s.uncertain_since) {
      await insertGeofenceEvent(db, s, 'ACCURACY_INSUFFICIENT', reading, { maxAccuracyM: rules.maxAccuracyM });
    }

    await q(
      `UPDATE tracking_sessions SET last_location_at = $12, last_location_client_at = $2, last_latitude = $3, last_longitude = $4,
              last_accuracy_m = $5, last_distance_m = $6, last_classification = $7, last_is_mocked = $8,
              candidate_since = $9, candidate_count = $10, uncertain_since = $11, candidate_received_since = $13, updated_at = now()
       WHERE id = $1`,
      [s.id, clientTime, r.latitude, r.longitude, r.accuracyM, distance, res.classification, !!r.isMocked, res.candidateSince, res.candidateCount, newUncertainSince, now, res.candidateReceivedSince],
      db,
    );
    s.prev_location_at = s.last_location_at;
    s.last_location_client_at = clientTime;
    s.last_location_at = now;
    s.last_latitude = r.latitude;
    s.last_longitude = r.longitude;
    s.last_accuracy_m = r.accuracyM;
    s.last_distance_m = distance;
    s.last_classification = res.classification;
    s.candidate_since = res.candidateSince;
    s.candidate_count = res.candidateCount;
    s.candidate_received_since = res.candidateReceivedSince;
    s.uncertain_since = newUncertainSince;

    if (r.isMocked) {
      await notify(db, outbox, {
        type: 'MOCK_LOCATION_FLAGGED',
        severity: 'WARNING',
        body: `${s.employee_name}'s device reported that a location was provided by a mock-location source. This is a risk indicator, not proof of fraud.`,
        employeeId: s.employee_id,
        workplaceId: s.workplace_id,
        sessionId: s.id,
        dedupeKey: `mock:${s.id}`,
        simulated: s.is_simulated,
      });
    }

    await applyEffects(db, outbox, s, res.effects, reading, actor, settings, now);
    if (res.state !== s.state) {
      await transition(db, outbox, s, res.state, res.reason, actor, null, { resumeState: res.resumeState, metadata: { distanceM: Math.round(distance * 10) / 10, accuracyM: r.accuracyM, classification: res.classification } });
    } else if (res.resumeState !== s.resume_state) {
      await q('UPDATE tracking_sessions SET resume_state = $2 WHERE id = $1', [s.id, res.resumeState], db);
    } else {
      outbox.push({ type: 'session.updated', sessionId: s.id, employeeId: s.employee_id, state: s.state, simulated: s.is_simulated });
    }
    s.resume_state = res.resumeState;
  }
  return { results, evaluated };
}

async function insertGeofenceEvent(db: Queryable, s: any, type: string, reading: { lat: number; lng: number; accuracy: number; distance: number; time: Date }, validation: Record<string, unknown>) {
  return one(
    `INSERT INTO geofence_events (employee_id, workplace_id, session_id, event_type, event_time, latitude, longitude, accuracy_m, distance_m, validation, is_simulated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [s.employee_id, s.workplace_id, s.id, type, reading.time, reading.lat, reading.lng, reading.accuracy, reading.distance, JSON.stringify({ radiusM: Number(s.radius_m), ...validation }), s.is_simulated],
    db,
  );
}

const fmtM = (m: number) => `${Math.round(m)} m`;

async function applyEffects(
  db: pg.PoolClient,
  outbox: Outbox,
  s: any,
  effects: EngineEffect[],
  reading: { lat: number; lng: number; accuracy: number; distance: number; time: Date },
  actor: Actor,
  settings: Settings,
  now: Date,
) {
  for (const e of effects) {
    switch (e.kind) {
      case 'GEOFENCE_EVENT': {
        await insertGeofenceEvent(db, s, e.eventType, reading, { ...(e.details ?? {}), actor });
        if (e.eventType === 'ENTRY_VERIFIED') {
          if (settings.alerts.notifyOnArrival) {
            await notify(db, outbox, {
              type: 'ARRIVED',
              severity: 'INFO',
              body: `${s.employee_name} arrived at ${s.workplace_name} (${fmtM(reading.distance)} from centre, ±${Math.round(reading.accuracy)} m). Attendance unlocked.`,
              employeeId: s.employee_id,
              workplaceId: s.workplace_id,
              sessionId: s.id,
              dedupeKey: `arrived:${s.id}:${reading.time.getTime()}`,
              simulated: s.is_simulated,
            });
          }
          await notify(db, outbox, {
            type: 'ATTENDANCE_READY',
            audience: 'EMPLOYEE',
            severity: 'INFO',
            title: 'Attendance is ready',
            body: 'Workplace location verified. Open GeoAttend to capture your attendance photo.',
            employeeId: s.employee_id,
            sessionId: s.id,
            dedupeKey: `ready:${s.id}:${reading.time.getTime()}`,
            simulated: s.is_simulated,
          });
        } else if (e.eventType === 'EXIT_VERIFIED') {
          await notify(db, outbox, {
            type: 'GEOFENCE_EXIT',
            severity: 'WARNING',
            body: `${s.employee_name} left ${s.workplace_name} at ${new Date(String(e.details?.departedAt)).toISOString()} (now ${fmtM(reading.distance)} from centre, ±${Math.round(reading.accuracy)} m).`,
            employeeId: s.employee_id,
            workplaceId: s.workplace_id,
            sessionId: s.id,
            data: { departedAt: e.details?.departedAt, lastKnown: { lat: reading.lat, lng: reading.lng, accuracyM: reading.accuracy, at: reading.time } },
            dedupeKey: `exit:${s.id}:${e.details?.departedAt}`,
            simulated: s.is_simulated,
          });
        } else if (e.eventType === 'RETURN_VERIFIED' && settings.alerts.notifyOnReturn) {
          const open = await one(`SELECT started_at FROM absence_intervals WHERE session_id = $1 AND status = 'OPEN'`, [s.id], db);
          const mins = open ? Math.round((new Date(String(e.details?.returnedAt)).getTime() - new Date(open.started_at).getTime()) / 60000) : null;
          await notify(db, outbox, {
            type: 'RETURNED',
            severity: 'INFO',
            body: `${s.employee_name} returned to ${s.workplace_name}${mins !== null ? ` after ${mins} min away` : ''}.`,
            employeeId: s.employee_id,
            workplaceId: s.workplace_id,
            sessionId: s.id,
            data: { returnedAt: e.details?.returnedAt, awayMinutes: mins },
            dedupeKey: `return:${s.id}:${e.details?.returnedAt}`,
            simulated: s.is_simulated,
          });
        }
        break;
      }
      case 'OPEN_ABSENCE': {
        const threshold = s.shift_absence_threshold ?? s.wp_absence_threshold;
        await q(
          `INSERT INTO absence_intervals (session_id, employee_id, workplace_id, started_at, threshold_minutes, last_known_latitude, last_known_longitude, last_known_at, is_simulated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [s.id, s.employee_id, s.workplace_id, e.startedAt, threshold, reading.lat, reading.lng, reading.time, s.is_simulated],
          db,
        );
        break;
      }
      case 'CLOSE_ABSENCE':
        await q(
          `UPDATE absence_intervals SET ended_at = GREATEST($2, started_at), status = 'RETURNED' WHERE session_id = $1 AND status = 'OPEN'`,
          [s.id, e.endedAt],
          db,
        );
        break;
      case 'CANCEL_SUBMISSION':
        await q(`UPDATE attendance_photos SET status = 'EXPIRED' WHERE session_id = $1 AND status IN ('PENDING_UPLOAD', 'UPLOADED')`, [s.id], db);
        break;
      case 'RESUMED':
        if (e.from === 'TRACKING_INTERRUPTED') {
          const gapMin = s.prev_location_at ? Math.round((now.getTime() - new Date(s.prev_location_at).getTime()) / 60000) : null;
          await notify(db, outbox, {
            type: 'TRACKING_RESUMED',
            severity: 'INFO',
            body: `${s.employee_name}: location updates resumed${gapMin !== null ? ` after a gap of about ${gapMin} min` : ''}.`,
            employeeId: s.employee_id,
            workplaceId: s.workplace_id,
            sessionId: s.id,
            dedupeKey: `resumed:${s.id}:${new Date(s.state_changed_at).getTime()}`,
            simulated: s.is_simulated,
          });
        }
        break;
      case 'BREAK_LEFT':
        await q(`UPDATE session_breaks SET left_at = $2 WHERE session_id = $1 AND ended_at IS NULL AND left_at IS NULL`, [s.id, e.departedAt], db);
        s.break_left = true;
        break;
      case 'END_BREAK':
        await closeBreak(db, outbox, s, e.endedAt, 'RETURNED');
        break;
    }
  }
  // Keep the open absence interval's last-known position current.
  if (s.state === 'TEMPORARILY_AWAY' || s.state === 'PROLONGED_ABSENCE') {
    await q(`UPDATE absence_intervals SET last_known_latitude = $2, last_known_longitude = $3, last_known_at = $4 WHERE session_id = $1 AND status = 'OPEN'`, [s.id, reading.lat, reading.lng, reading.time], db);
  }
}

export async function ingestReadings(sessionId: string, employeeId: string, readings: ReadingInput[], actor: Actor) {
  const outbox = new Outbox();
  const out = await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    if (!s) throw notFound('Session');
    if (s.employee_id !== employeeId) throw forbidden();
    return ingestLocked(db, outbox, s, readings, actor, sessionNow(s));
  });
  outbox.flush();
  return out;
}

// ───────────────────────── end / terminate ─────────────────────────

export async function finalizeLocked(
  db: pg.PoolClient,
  outbox: Outbox,
  s: any,
  opts: {
    actor: Actor;
    actorId: string | null;
    authorization: 'ENDED' | 'TERMINATED' | 'EXPIRED';
    reason: string;
    /** When and why open overtime ends (default: now, by whoever closes the session). */
    overtimeEnd?: { at: Date; reason: OvertimeEndReason };
  },
) {
  if (s.ended_at) return;
  await q(`UPDATE absence_intervals SET ended_at = GREATEST(now(), started_at), status = 'SHIFT_ENDED' WHERE session_id = $1 AND status = 'OPEN'`, [s.id], db);
  await closeBreak(db, outbox, s, new Date(), 'SHIFT_ENDED');
  const overtime = await closeOvertime(
    db,
    outbox,
    s,
    opts.overtimeEnd?.at ?? sessionNow(s),
    opts.overtimeEnd?.reason ?? (opts.authorization === 'TERMINATED' ? 'ADMIN' : opts.authorization === 'ENDED' ? 'EMPLOYEE' : 'SYSTEM'),
  );
  await q(`UPDATE attendance_photos SET status = 'EXPIRED' WHERE session_id = $1 AND status IN ('PENDING_UPLOAD', 'UPLOADED')`, [s.id], db);
  // An open manual review stays open: the shift ending must not turn an unanswered request into an absence.
  await transition(db, outbox, s, 'SHIFT_END_PENDING', opts.reason, opts.actor, opts.actorId);
  await q(
    `UPDATE tracking_sessions SET ended_at = now(), authorization_status = $2, termination_reason = $3, terminated_by = $4, candidate_since = NULL, candidate_count = 0 WHERE id = $1`,
    [s.id, opts.authorization, opts.reason, opts.authorization === 'TERMINATED' ? opts.actorId : null],
    db,
  );
  await transition(db, outbox, s, 'SHIFT_COMPLETED', 'location collection stopped', 'SYSTEM');
  s.ended_at = new Date();

  const type = opts.authorization === 'TERMINATED' ? 'TRACKING_TERMINATED' : 'SHIFT_COMPLETED';
  await notify(db, outbox, {
    type,
    severity: 'INFO',
    body: `${s.employee_name}: ${s.shift_name} ${opts.authorization === 'TERMINATED' ? 'tracking ended by an administrator' : opts.authorization === 'EXPIRED' ? 'closed automatically at the end of the shift window' : 'ended by the employee'}. ${s.has_attendance ? '' : 'No attendance was recorded for this shift.'}`.trim(),
    employeeId: s.employee_id,
    workplaceId: s.workplace_id,
    sessionId: s.id,
    data: { reason: opts.reason },
    dedupeKey: `ended:${s.id}`,
    simulated: s.is_simulated,
  });
  if (opts.authorization !== 'ENDED') {
    await notify(db, outbox, {
      type,
      audience: 'EMPLOYEE',
      severity: 'INFO',
      title: 'Location tracking stopped',
      body:
        opts.authorization === 'TERMINATED'
          ? 'An administrator ended your tracking session. Location is no longer being collected.'
          : overtime
            ? `Your overtime was ended ${opts.overtimeEnd?.reason === 'NEXT_SHIFT' ? 'because your next shift started' : 'because no location arrived from your phone'}. It now waits for your manager’s approval.`
            : 'Your shift window has closed. Location is no longer being collected.',
      employeeId: s.employee_id,
      sessionId: s.id,
      dedupeKey: `ended-emp:${s.id}`,
      simulated: s.is_simulated,
    });
  }
}

export async function endSession(sessionId: string, actorUser: { id: string; role: string }, actor: Actor, reason?: string, endPhotoId?: string | null) {
  const outbox = new Outbox();
  const s = await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    if (!s) throw notFound('Session');
    if (actorUser.role === 'EMPLOYEE' && s.employee_id !== actorUser.id) throw forbidden();
    if (s.ended_at) return s;
    if (endPhotoId) await attachEndPhoto(db, s, endPhotoId);
    const terminated = actorUser.role === 'ADMIN';
    await finalizeLocked(db, outbox, s, {
      actor,
      actorId: actorUser.id,
      authorization: terminated ? 'TERMINATED' : 'ENDED',
      reason: terminated ? `terminated by administrator: ${reason ?? 'no reason given'}` : 'shift ended by employee',
    });
    return s;
  });
  outbox.flush();
  return s;
}

/**
 * The end-of-shift selfie goes with the shift's attendance record (on overtime: with the overtime)
 * and is face-checked by the sweeper like the start photo. Without an attendance record there is
 * nothing to verify, so it is discarded.
 */
async function attachEndPhoto(db: pg.PoolClient, s: any, photoId: string) {
  const p = await one(`SELECT * FROM attendance_photos WHERE id = $1 FOR UPDATE`, [photoId], db);
  if (!p || p.session_id !== s.id || p.employee_id !== s.employee_id || p.purpose !== 'SHIFT_END') throw notFound('Photo');
  if (p.status !== 'UPLOADED') throw new HttpError(422, 'PHOTO_MISSING', 'The end-of-shift photo was not uploaded. Take it again.');
  const obj = await inspectObject(p.object_key);
  if (!obj || obj.type !== p.content_type) throw new HttpError(422, 'PHOTO_INVALID', 'The end-of-shift photo could not be read. Take it again.');
  const settings = await getSettings(s.org_id, db);
  const rec = onOvertime(s)
    ? await one(`UPDATE overtime_entries SET end_photo_id = $2, end_face_status = NULL WHERE session_id = $1 AND ended_at IS NULL RETURNING id`, [s.id, p.id], db)
    : await one(
        `UPDATE attendance_records SET end_photo_id = $4, end_face_status = NULL
         WHERE employee_id = $1 AND shift_id = $2 AND shift_date = $3 AND verification_status <> 'VOIDED' RETURNING id`,
        [s.employee_id, s.shift_id, s.shift_date, p.id],
        db,
      );
  if (rec) {
    await q(
      `UPDATE attendance_photos SET status = 'ATTACHED', size_bytes = $2, sha256 = $3, retention_until = now() + make_interval(days => $4) WHERE id = $1`,
      [p.id, obj.sizeBytes, obj.sha256, settings.retention.photoDays],
      db,
    );
  } else {
    await deleteObject(p.object_key);
    await q(`UPDATE attendance_photos SET status = 'DELETED', deleted_at = now(), deleted_reason = 'no attendance to verify' WHERE id = $1`, [p.id], db);
  }
}

/** Reserves a private upload slot for the end-of-shift selfie (only while the session is open). */
export async function reserveEndPhoto(employeeId: string, sessionId: string, input: { contentType: 'image/jpeg' | 'image/png'; sizeBytes: number }, origin: string) {
  if (input.sizeBytes > config.storage.maxPhotoBytes) throw new HttpError(413, 'PHOTO_TOO_LARGE', 'Photo is too large.');
  const photo = await tx(async (db) => {
    const s = await lockSession(db, sessionId);
    if (!s) throw notFound('Session');
    if (s.employee_id !== employeeId) throw forbidden();
    if (s.ended_at) throw conflict('SESSION_CLOSED', 'This shift session has ended.');
    return one(
      `INSERT INTO attendance_photos (employee_id, session_id, object_key, content_type, declared_bytes, idempotency_key, upload_expires_at, is_simulated, purpose)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), $8, 'SHIFT_END') RETURNING *`,
      [employeeId, s.id, newObjectKey(employeeId, input.contentType), input.contentType, input.sizeBytes, `end:${crypto.randomUUID()}`, config.storage.uploadUrlTtlSec, s.is_simulated],
      db,
    );
  });
  return { photoId: photo.id as string, upload: await createUploadUrl(photo.object_key, input.contentType, input.sizeBytes, origin) };
}

// ───────────────────────── employee-facing status ─────────────────────────

export interface Guidance {
  tone: 'info' | 'warning' | 'success' | 'danger';
  title: string;
  message: string;
}

export function guidanceFor(s: any, settings: Settings, isStale: boolean): Guidance {
  const radius = Math.round(Number(s.radius_m));
  const d = s.last_distance_m == null ? null : Math.round(s.last_distance_m);
  const acc = s.last_accuracy_m == null ? null : Math.round(s.last_accuracy_m);
  const state = s.state as SessionState;
  if (s.ended_at || state === 'SHIFT_COMPLETED') {
    return { tone: 'info', title: 'Shift completed', message: 'Tracking stopped.' };
  }
  if (state === 'TRACKING_PERMISSION_REQUIRED') {
    if (s.foreground_permission === 'granted' && s.location_services_enabled !== false && settings.tracking.requireBackgroundLocation && s.background_permission !== 'granted') {
      return { tone: 'danger', title: 'Allow location all the time', message: 'Settings → Apps → GeoAttend → Location → “Allow all the time”, with “Use precise location” on.' };
    }
    return { tone: 'danger', title: 'Location permission needed', message: 'Turn on location for GeoAttend, with precise location on.' };
  }
  if (state === 'TRACKING_INTERRUPTED') {
    return { tone: 'warning', title: 'Location updates interrupted', message: 'Check internet, GPS and battery settings.' };
  }
  if (state === 'MANUAL_REVIEW_REQUIRED') {
    return { tone: 'warning', title: 'Waiting for manual review', message: 'Your manager will check your attendance.' };
  }
  if (state === 'SHIFT_START_PENDING' || (state === 'TRACKING_ACTIVE' && d === null)) {
    return { tone: 'info', title: 'Getting your location', message: 'Waiting for GPS…' };
  }
  if (s.last_classification === 'INSUFFICIENT_ACCURACY' && ['TRACKING_ACTIVE', 'OUTSIDE_GEOFENCE', 'ARRIVAL_CANDIDATE'].includes(state)) {
    return { tone: 'warning', title: 'GPS accuracy insufficient', message: `±${acc} m now, ±${settings.tracking.maxAccuracyM} m needed. Move near a window or outside.` };
  }
  switch (state) {
    case 'TRACKING_ACTIVE':
    case 'OUTSIDE_GEOFENCE':
      if (s.last_classification === 'AMBIGUOUS')
        return { tone: 'warning', title: 'Near the boundary', message: `${d} m away (±${acc} m). Move a little closer.` };
      return { tone: 'info', title: 'Attendance locked', message: `${d} m away. Unlocks within ${radius} m.` };
    case 'ARRIVAL_CANDIDATE':
      return { tone: 'info', title: 'Verifying your arrival', message: `Keep the app open for ~${settings.tracking.entryStabilizationSec} s.` };
    case 'ATTENDANCE_READY':
      return { tone: 'success', title: 'Workplace location verified', message: 'Take your photo to mark attendance.' };
    case 'ATTENDANCE_SUBMISSION_PENDING':
      return { tone: 'info', title: 'Submitting attendance', message: 'Not recorded yet — finish your photo.' };
    case 'PRESENT':
      return isStale
        ? { tone: 'warning', title: 'Present — location not updating', message: 'Recent location updates are missing.' }
        : { tone: 'success', title: 'Present', message: 'Attendance recorded.' };
    case 'TEMPORARILY_AWAY':
      return { tone: 'warning', title: 'Away from workplace', message: `${d} m outside. Manager is told after ${s.shift_absence_threshold ?? s.wp_absence_threshold} min.` };
    case 'PROLONGED_ABSENCE':
      return { tone: 'danger', title: 'Prolonged absence', message: 'Your manager has been told.' };
    case 'ON_BREAK':
      return { tone: 'info', title: 'On break', message: 'You may leave the workplace.' };
    case 'ON_OVERTIME':
      return isStale
        ? { tone: 'warning', title: 'On overtime — location not updating', message: 'Keep the app running. Overtime ends at the last location received if updates stop.' }
        : { tone: 'info', title: 'On overtime', message: 'Counted once your manager approves it. End it when you finish.' };
    default:
      return { tone: 'info', title: STATE_LABELS[state] ?? state, message: '' };
  }
}

export async function sessionStatus(sessionId: string, db?: Queryable) {
  const s = await one(
    `SELECT s.*, w.org_id, w.name AS workplace_name, w.latitude AS wp_lat, w.longitude AS wp_lng, w.radius_m, w.address,
            w.absence_threshold_minutes AS wp_absence_threshold, sh.absence_threshold_minutes AS shift_absence_threshold,
            sh.name AS shift_name, sh.arrival_grace_minutes
     FROM tracking_sessions s JOIN workplaces w ON w.id = s.workplace_id JOIN shifts sh ON sh.id = s.shift_id WHERE s.id = $1`,
    [sessionId],
    db,
  );
  if (!s) throw notFound('Session');
  const settings = await getSettings(s.org_id, db);
  const attendance = await one(
    `SELECT id, recorded_at, verification_status, is_late, late_by_minutes FROM attendance_records
     WHERE employee_id = $1 AND shift_id = $2 AND shift_date = $3 AND verification_status <> 'VOIDED'`,
    [s.employee_id, s.shift_id, s.shift_date],
    db,
  );
  const openAbsence = await one(`SELECT started_at, threshold_minutes, prolonged_at FROM absence_intervals WHERE session_id = $1 AND status = 'OPEN'`, [sessionId], db);
  const openReview = await one(`SELECT id, reason, created_at FROM review_requests WHERE session_id = $1 AND kind = 'MANUAL_REVIEW' AND status = 'OPEN'`, [sessionId], db);
  const openBreak = await one(`SELECT id, type_key, type_label, paid, max_minutes, note, started_at, left_at, overdue_at FROM session_breaks WHERE session_id = $1 AND ended_at IS NULL`, [sessionId], db);
  const overtime = await one(`SELECT id, note, started_at, ended_at, status, approved_minutes FROM overtime_entries WHERE session_id = $1`, [sessionId], db);
  const isOpen = !s.ended_at;
  const nowMs = Date.now() + s.sim_clock_offset_sec * 1000; // offset is 0 for real sessions
  const overtimeOn = isOpen && onOvertime(s);
  const lastAt = s.last_location_at ? new Date(s.last_location_at) : null;
  const isStale = isOpen && (!lastAt || nowMs - lastAt.getTime() > settings.tracking.staleAfterSec * 1000);
  const uncertainForSec = s.uncertain_since ? Math.max(0, (nowMs - new Date(s.uncertain_since).getTime()) / 1000) : 0;

  return {
    session: {
      id: s.id,
      state: s.state as SessionState,
      stateLabel: STATE_LABELS[s.state as SessionState],
      shiftId: s.shift_id,
      shiftName: s.shift_name,
      shiftDate: s.shift_date,
      scheduledStartAt: s.scheduled_start_at,
      scheduledEndAt: s.scheduled_end_at,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      terminationReason: s.termination_reason,
      authorizationStatus: s.authorization_status,
      lastLocationAt: s.last_location_at,
      lastLocationClientAt: s.last_location_client_at,
      lastDistanceM: s.last_distance_m,
      lastAccuracyM: s.last_accuracy_m,
      lastClassification: s.last_classification,
      isStale,
      isSimulated: s.is_simulated,
      simClockOffsetSec: s.sim_clock_offset_sec,
      foregroundPermission: s.foreground_permission,
      backgroundPermission: s.background_permission,
    },
    workplace: { id: s.workplace_id, name: s.workplace_name, address: s.address, latitude: s.wp_lat, longitude: s.wp_lng, radiusM: Number(s.radius_m) },
    attendance: attendance && { id: attendance.id, recordedAt: attendance.recorded_at, verificationStatus: attendance.verification_status, isLate: attendance.is_late, lateByMinutes: attendance.late_by_minutes },
    absence: openAbsence && { startedAt: openAbsence.started_at, thresholdMinutes: openAbsence.threshold_minutes, prolongedAt: openAbsence.prolonged_at },
    review: openReview && { id: openReview.id, reason: openReview.reason, createdAt: openReview.created_at },
    break: openBreak && {
      id: openBreak.id,
      typeKey: openBreak.type_key,
      label: openBreak.type_label,
      paid: openBreak.paid,
      maxMinutes: openBreak.max_minutes,
      note: openBreak.note,
      startedAt: openBreak.started_at,
      endsAt: new Date(new Date(openBreak.started_at).getTime() + openBreak.max_minutes * 60_000),
      leftAt: openBreak.left_at,
      overdueAt: openBreak.overdue_at,
    },
    overtime: overtime && {
      id: overtime.id,
      note: overtime.note,
      startedAt: overtime.started_at,
      endedAt: overtime.ended_at,
      status: overtime.ended_at ? overtime.status : 'RUNNING',
      approvedMinutes: overtime.approved_minutes,
    },
    /** The shift has ended and the employee may start overtime (selfie + location). */
    canStartOvertime: isOpen && canStartOvertime(s, new Date(nowMs), !!attendance),
    canStartBreak: isOpen && s.state === 'PRESENT',
    breakOptions: { types: settings.breaks.types, requirePhoto: settings.breaks.requirePhoto },
    guidance: guidanceFor(s, settings, isStale),
    attendanceAvailable: isOpen && (s.state === 'ATTENDANCE_READY' || s.state === 'ATTENDANCE_SUBMISSION_PENDING'),
    // Shown on the camera only once attendance unlocks, so it cannot be prepared in advance.
    attendanceChallenge: isOpen && !attendance && (s.state === 'ATTENDANCE_READY' || s.state === 'ATTENDANCE_SUBMISSION_PENDING') ? challengeFor(s.id) : null,
    canRequestReview: isOpen && !openReview && !attendance && s.state !== 'MANUAL_REVIEW_REQUIRED',
    suggestReview: uncertainForSec >= settings.tracking.uncertainReviewAfterSec,
    tracking: {
      shouldTrack: isOpen,
      stopReason: isOpen ? null : (s.termination_reason ?? 'session closed'),
      updateIntervalSec: settings.tracking.updateIntervalSec,
      distanceFilterM: settings.tracking.distanceFilterM,
      maxAccuracyM: settings.tracking.maxAccuracyM,
      offlineQueueMax: settings.tracking.offlineQueueMax,
      staleAfterSec: settings.tracking.staleAfterSec,
      evidenceMaxAgeSec: settings.tracking.evidenceMaxAgeSec,
      requireBackgroundLocation: settings.tracking.requireBackgroundLocation,
      requirePreciseLocation: settings.tracking.requirePreciseLocation,
      // Overtime is not bound to the shift window: it runs until the employee ends it.
      windowClosesAt: overtimeOn ? null : new Date(new Date(s.scheduled_end_at).getTime() + settings.tracking.endGraceMinutes * 60_000),
    },
  };
}
export type SessionStatus = Awaited<ReturnType<typeof sessionStatus>>;
