/**
 * The attendance / presence state machine — a pure function.
 *
 * Given the current session snapshot and ONE validated location reading it
 * returns the next state and the side effects to persist. It has no I/O so it
 * is exhaustively unit-tested, and the live API and the demo simulator call
 * exactly the same code.
 *
 * Time-driven transitions (prolonged absence, stale updates, shift window end)
 * are handled by the sweeper, because they happen when *no* reading arrives.
 */
import { classifyReading, type Classification, type ClassificationRules, type SessionState } from '@geoattend/shared';

export interface EngineRules extends ClassificationRules {
  entryStabilizationSec: number;
  entryMinReadings: number;
  exitStabilizationSec: number;
  exitMinReadings: number;
  returnStabilizationSec: number;
  returnMinReadings: number;
  /** Arrival must also span this long in server receipt time (readings from separate uploads). 0 = off. */
  entryMinServerSpanSec?: number;
}

export interface EngineSession {
  state: SessionState;
  resumeState: SessionState | null;
  candidateSince: Date | null;
  candidateCount: number;
  hasAttendance: boolean;
  /** ON_BREAK only: the employee has been verified outside the area since the break started. */
  breakLeft?: boolean;
  /** Server time at which the current candidate's first reading was received. */
  candidateReceivedSince?: Date | null;
}

export interface EngineReading {
  distanceM: number;
  accuracyM: number;
  time: Date; // device time of the fix (bounded by the server)
  /** Server time the reading was received. Phone clocks can be set freely, so arrival also needs this to advance. */
  receivedAt?: Date;
}

export type GeofenceEventType = 'ENTRY_CANDIDATE' | 'ENTRY_VERIFIED' | 'LEFT_BEFORE_ATTENDANCE' | 'EXIT_CANDIDATE' | 'EXIT_VERIFIED' | 'RETURN_VERIFIED';

export type EngineEffect =
  | { kind: 'GEOFENCE_EVENT'; eventType: GeofenceEventType; time: Date; details?: Record<string, unknown> }
  | { kind: 'OPEN_ABSENCE'; startedAt: Date }
  | { kind: 'CLOSE_ABSENCE'; endedAt: Date }
  | { kind: 'CANCEL_SUBMISSION' }
  | { kind: 'RESUMED'; from: SessionState; to: SessionState }
  | { kind: 'BREAK_LEFT'; departedAt: Date }
  | { kind: 'END_BREAK'; endedAt: Date };

export interface EngineResult {
  state: SessionState;
  resumeState: SessionState | null;
  candidateSince: Date | null;
  candidateCount: number;
  candidateReceivedSince: Date | null;
  classification: Classification;
  effects: EngineEffect[];
  reason: string;
}

const secondsBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 1000;

/** Which hysteresis frame applies in a state: once counted inside, leaving needs the wider boundary. */
export function frameFor(state: SessionState, hasAttendance: boolean): 'ENTRY' | 'EXIT' {
  switch (state) {
    case 'ATTENDANCE_READY':
    case 'ATTENDANCE_SUBMISSION_PENDING':
    case 'PRESENT':
    case 'ON_BREAK':
    case 'ON_OVERTIME':
      return 'EXIT';
    case 'MANUAL_REVIEW_REQUIRED':
      return hasAttendance ? 'EXIT' : 'ENTRY';
    default:
      return 'ENTRY';
  }
}

/** State to continue from after an interruption, discarding half-finished candidates. */
function resumeTarget(s: EngineSession): SessionState {
  const base = s.resumeState ?? (s.hasAttendance ? 'PRESENT' : 'TRACKING_ACTIVE');
  if (base === 'ARRIVAL_CANDIDATE' || base === 'SHIFT_START_PENDING' || base === 'TRACKING_PERMISSION_REQUIRED' || base === 'TRACKING_INTERRUPTED') {
    return s.hasAttendance ? 'PRESENT' : 'TRACKING_ACTIVE';
  }
  return base;
}

export function evaluate(session: EngineSession, reading: EngineReading, rules: EngineRules): EngineResult {
  const effects: EngineEffect[] = [];
  let state = session.state;
  let since = session.candidateSince;
  let count = session.candidateCount;
  const reasons: string[] = [];

  if (state === 'TRACKING_INTERRUPTED' || state === 'TRACKING_PERMISSION_REQUIRED') {
    const to = resumeTarget(session);
    effects.push({ kind: 'RESUMED', from: state, to });
    reasons.push(`location updates resumed (${state} → ${to})`);
    state = to;
    since = null;
    count = 0;
  } else if (state === 'SHIFT_START_PENDING') {
    state = 'TRACKING_ACTIVE';
    reasons.push('first location received');
  }

  const t = reading.time;
  const recv = reading.receivedAt ?? null;
  // When the current candidate began in server time: kept while the same candidate continues.
  const receivedSince = () => {
    if (since === null) return null;
    const continued = session.candidateSince !== null && since.getTime() === session.candidateSince.getTime();
    return continued ? (session.candidateReceivedSince ?? recv) : recv;
  };
  const cls = classifyReading(reading.distanceM, reading.accuracyM, rules, frameFor(state, session.hasAttendance));
  const done = (reason?: string): EngineResult => {
    if (reason) reasons.push(reason);
    return {
      state,
      resumeState: state === 'MANUAL_REVIEW_REQUIRED' ? session.resumeState : null,
      candidateSince: since,
      candidateCount: count,
      candidateReceivedSince: receivedSince(),
      classification: cls,
      effects,
      reason: reasons.join('; ') || `reading ${cls.toLowerCase()}, no change`,
    };
  };

  switch (state) {
    case 'TRACKING_ACTIVE':
    case 'OUTSIDE_GEOFENCE': {
      if (cls === 'OUTSIDE') {
        state = 'OUTSIDE_GEOFENCE';
        since = null;
        count = 0;
        return done();
      }
      if (cls !== 'INSIDE') return done(); // ambiguous / inaccurate: neither approve nor reject
      since = t;
      count = 1;
      state = 'ARRIVAL_CANDIDATE';
      effects.push({ kind: 'GEOFENCE_EVENT', eventType: 'ENTRY_CANDIDATE', time: t });
      reasons.push('inside geofence, stabilising');
      return checkEntry();
    }
    case 'ARRIVAL_CANDIDATE': {
      if (cls === 'OUTSIDE') {
        state = 'OUTSIDE_GEOFENCE';
        since = null;
        count = 0;
        return done('left the geofence while arrival was being verified');
      }
      if (cls !== 'INSIDE') return done();
      count += 1;
      since ??= t;
      return checkEntry();
    }
    case 'ATTENDANCE_READY':
    case 'ATTENDANCE_SUBMISSION_PENDING': {
      if (cls === 'OUTSIDE') {
        if (state === 'ATTENDANCE_SUBMISSION_PENDING') effects.push({ kind: 'CANCEL_SUBMISSION' });
        effects.push({ kind: 'GEOFENCE_EVENT', eventType: 'LEFT_BEFORE_ATTENDANCE', time: t });
        state = 'OUTSIDE_GEOFENCE';
        since = null;
        count = 0;
        return done('left the geofence before attendance was recorded — attendance locked again');
      }
      return done();
    }
    case 'PRESENT': {
      if (cls === 'INSIDE') {
        if (since) reasons.push('exit candidate cancelled — back inside');
        since = null;
        count = 0;
        return done();
      }
      if (cls !== 'OUTSIDE') return done(); // never infer departure from an uncertain reading
      if (!since) {
        since = t;
        count = 1;
        effects.push({ kind: 'GEOFENCE_EVENT', eventType: 'EXIT_CANDIDATE', time: t });
      } else {
        count += 1;
      }
      if (secondsBetween(since, t) >= rules.exitStabilizationSec && count >= rules.exitMinReadings) {
        effects.push({ kind: 'GEOFENCE_EVENT', eventType: 'EXIT_VERIFIED', time: t, details: { departedAt: since.toISOString(), readings: count } });
        effects.push({ kind: 'OPEN_ABSENCE', startedAt: since });
        state = 'TEMPORARILY_AWAY';
        since = null;
        count = 0;
        return done('workplace exit verified');
      }
      return done('outside, exit not yet stabilised');
    }
    case 'TEMPORARILY_AWAY':
    case 'PROLONGED_ABSENCE': {
      if (cls === 'OUTSIDE') {
        since = null;
        count = 0;
        return done();
      }
      if (cls !== 'INSIDE') return done();
      if (!since) {
        since = t;
        count = 1;
      } else count += 1;
      if (secondsBetween(since, t) >= rules.returnStabilizationSec && count >= rules.returnMinReadings) {
        effects.push({ kind: 'GEOFENCE_EVENT', eventType: 'RETURN_VERIFIED', time: t, details: { returnedAt: since.toISOString(), readings: count } });
        effects.push({ kind: 'CLOSE_ABSENCE', endedAt: since });
        state = 'PRESENT';
        since = null;
        count = 0;
        return done('return verified');
      }
      return done('inside, return not yet stabilised');
    }
    case 'ON_BREAK': {
      // Leaving is allowed and never opens an absence. Once a verified exit was seen, a verified
      // return ends the break; staying inside (a canteen on site) leaves it to the employee.
      if (!session.breakLeft) {
        if (cls === 'INSIDE') {
          since = null;
          count = 0;
          return done();
        }
        if (cls !== 'OUTSIDE') return done();
        if (!since) {
          since = t;
          count = 1;
        } else count += 1;
        if (secondsBetween(since, t) >= rules.exitStabilizationSec && count >= rules.exitMinReadings) {
          effects.push({ kind: 'BREAK_LEFT', departedAt: since });
          since = null;
          count = 0;
          return done('left the workplace during a declared break');
        }
        return done();
      }
      if (cls === 'OUTSIDE') {
        since = null;
        count = 0;
        return done();
      }
      if (cls !== 'INSIDE') return done();
      if (!since) {
        since = t;
        count = 1;
      } else count += 1;
      if (secondsBetween(since, t) >= rules.returnStabilizationSec && count >= rules.returnMinReadings) {
        effects.push({ kind: 'END_BREAK', endedAt: since });
        state = 'PRESENT';
        since = null;
        count = 0;
        return done('returned from break');
      }
      return done('inside, return from break not yet stabilised');
    }
    default:
      // MANUAL_REVIEW_REQUIRED, ON_OVERTIME (may be worked anywhere) and closed states:
      // the reading is recorded, the state is frozen.
      return done();
  }

  function checkEntry(): EngineResult {
    if (since && secondsBetween(since, t) >= rules.entryStabilizationSec && count >= rules.entryMinReadings) {
      // Phone times alone could be invented in one upload: the server must also have watched the arrival.
      const span = rules.entryMinServerSpanSec ?? 0;
      const rs = receivedSince();
      if (recv && span > 0 && (!rs || secondsBetween(rs, recv) < span)) return done('inside, waiting for more location updates to confirm arrival');
      effects.push({ kind: 'GEOFENCE_EVENT', eventType: 'ENTRY_VERIFIED', time: t, details: { readings: count, since: since.toISOString() } });
      state = 'ATTENDANCE_READY';
      since = null;
      count = 0;
      return done('arrival verified — attendance unlocked');
    }
    return done();
  }
}
