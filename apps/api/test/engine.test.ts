import { describe, expect, it } from 'vitest';
import { evaluate, type EngineRules, type EngineSession } from '../src/modules/tracking/engine.js';

const rules: EngineRules = {
  radiusM: 30,
  maxAccuracyM: 25,
  boundaryFactor: 0.5,
  exitHysteresisM: 10,
  entryStabilizationSec: 20,
  entryMinReadings: 2,
  exitStabilizationSec: 60,
  exitMinReadings: 2,
  returnStabilizationSec: 20,
  returnMinReadings: 2,
};
const t0 = new Date('2026-10-27T04:00:00Z');
const at = (sec: number) => new Date(t0.getTime() + sec * 1000);
const session = (over: Partial<EngineSession> = {}): EngineSession => ({ state: 'TRACKING_ACTIVE', resumeState: null, candidateSince: null, candidateCount: 0, hasAttendance: false, ...over });

/** Feed readings through the engine, carrying state forward like the service does. */
function run(start: EngineSession, readings: Array<[number, number, number]>) {
  let s = start;
  const all = [];
  for (const [sec, distanceM, accuracyM] of readings) {
    const r = evaluate(s, { distanceM, accuracyM, time: at(sec) }, rules);
    all.push(r);
    s = { ...s, state: r.state, resumeState: r.resumeState, candidateSince: r.candidateSince, candidateCount: r.candidateCount };
  }
  return { final: s, results: all };
}

describe('arrival', () => {
  it('stays locked outside the radius (scenario 1)', () => {
    const { final, results } = run(session(), [[0, 42, 8], [30, 38, 6]]);
    expect(final.state).toBe('OUTSIDE_GEOFENCE');
    expect(results[0]!.classification).toBe('OUTSIDE');
  });

  it('unlocks only after the stabilisation window and minimum readings (scenario 2)', () => {
    const { results } = run(session(), [[0, 10, 8], [10, 9, 7], [21, 8, 6]]);
    expect(results.map((r) => r.state)).toEqual(['ARRIVAL_CANDIDATE', 'ARRIVAL_CANDIDATE', 'ATTENDANCE_READY']);
    expect(results[2]!.effects.some((e) => e.kind === 'GEOFENCE_EVENT' && e.eventType === 'ENTRY_VERIFIED')).toBe(true);
  });

  it('never approves on insufficient accuracy (scenario 3)', () => {
    const { final, results } = run(session(), [[0, 5, 60], [30, 5, 45], [60, 5, 30]]);
    expect(final.state).toBe('TRACKING_ACTIVE');
    expect(results.every((r) => r.classification === 'INSUFFICIENT_ACCURACY')).toBe(true);
  });

  it('treats a boundary-straddling reading as ambiguous, not as inside', () => {
    const r = evaluate(session(), { distanceM: 28, accuracyM: 12, time: at(0) }, rules);
    expect(r.classification).toBe('AMBIGUOUS');
    expect(r.state).toBe('TRACKING_ACTIVE');
  });

  // Approved policy (Phase I): before attendance, leaving is confirmed like leaving after it (exitMinReadings over
  // exitStabilizationSec); one stray reading no longer re-locks. Scenario 4 itself (a real departure) still re-locks.
  it('re-locks attendance when the employee leaves before submitting, once the departure is confirmed (scenario 4)', () => {
    const { results } = run(session({ state: 'ATTENDANCE_SUBMISSION_PENDING' }), [[0, 80, 8], [rules.exitStabilizationSec, 85, 8]]);
    expect(results[0]!.state).toBe('ATTENDANCE_SUBMISSION_PENDING'); // one reading: not yet
    expect(results[0]!.effects).toEqual([]);
    expect(results[1]!.state).toBe('OUTSIDE_GEOFENCE');
    expect(results[1]!.effects.map((e) => e.kind)).toEqual(['CANCEL_SUBMISSION', 'GEOFENCE_EVENT']);
    expect(results[1]!.effects[1]).toMatchObject({ eventType: 'LEFT_BEFORE_ATTENDANCE', details: { departedAt: at(0).toISOString(), readings: 2 } });
  });

  it('a single stray reading before attendance does not re-lock, and a reading inside cancels it', () => {
    const { final, results } = run(session({ state: 'ATTENDANCE_READY' }), [[0, 400, 8], [10, 8, 6], [rules.exitStabilizationSec + 5, 400, 8]]);
    expect(results.map((r) => r.state)).toEqual(['ATTENDANCE_READY', 'ATTENDANCE_READY', 'ATTENDANCE_READY']);
    expect(results[1]!.reason).toContain('departure candidate cancelled');
    expect(final.candidateCount).toBe(1); // the third reading starts a new candidate, it does not finish the old one
  });

  it('never infers a departure before attendance from an uncertain reading', () => {
    const { results } = run(session({ state: 'ATTENDANCE_READY' }), [[0, 80, 8], [30, 80, 60], [rules.exitStabilizationSec, 28, 12]]);
    expect(results.every((r) => r.state === 'ATTENDANCE_READY')).toBe(true);
    expect(results[1]!.candidateCount).toBe(1); // an inaccurate reading neither counts nor cancels
  });

  it('a single outside reading during the candidate phase resets it', () => {
    const { final } = run(session(), [[0, 10, 8], [10, 70, 8], [25, 10, 8]]);
    expect(final.state).toBe('ARRIVAL_CANDIDATE');
  });
});

describe('presence after attendance', () => {
  const present = () => session({ state: 'PRESENT', hasAttendance: true });

  it('does not flap at the edge thanks to hysteresis', () => {
    const { final } = run(present(), [[0, 36, 6], [60, 37, 6], [120, 38, 6]]);
    expect(final.state).toBe('PRESENT');
  });

  it('verifies an exit only after stabilisation, then opens an absence at the first outside reading (scenario 8)', () => {
    const { results } = run(present(), [[0, 80, 8], [30, 90, 8], [61, 95, 8]]);
    expect(results.map((r) => r.state)).toEqual(['PRESENT', 'PRESENT', 'TEMPORARILY_AWAY']);
    const open = results[2]!.effects.find((e) => e.kind === 'OPEN_ABSENCE');
    expect(open && 'startedAt' in open && open.startedAt.getTime()).toBe(at(0).getTime());
  });

  it('never infers departure from uncertain readings', () => {
    const { final } = run(present(), [[0, 80, 60], [120, 90, 70], [240, 40, 15]]);
    expect(final.state).toBe('PRESENT');
  });

  it('closes the absence when the return is verified (scenario 9)', () => {
    const { results } = run(session({ state: 'TEMPORARILY_AWAY', hasAttendance: true }), [[0, 5, 6], [21, 6, 6]]);
    expect(results[1]!.state).toBe('PRESENT');
    expect(results[1]!.effects.map((e) => e.kind)).toContain('CLOSE_ABSENCE');
  });
});

describe('interruptions', () => {
  it('resumes the pre-interruption state on the next valid reading', () => {
    const r = evaluate(session({ state: 'TRACKING_INTERRUPTED', resumeState: 'PRESENT', hasAttendance: true }), { distanceM: 5, accuracyM: 6, time: at(0) }, rules);
    expect(r.state).toBe('PRESENT');
    expect(r.effects[0]).toMatchObject({ kind: 'RESUMED', from: 'TRACKING_INTERRUPTED', to: 'PRESENT' });
  });

  it('discards a half-finished arrival candidate after an interruption', () => {
    const r = evaluate(session({ state: 'TRACKING_INTERRUPTED', resumeState: 'ARRIVAL_CANDIDATE' }), { distanceM: 100, accuracyM: 6, time: at(0) }, rules);
    expect(r.state).toBe('OUTSIDE_GEOFENCE');
  });

  it('keeps a manual review frozen and preserves where to resume', () => {
    const r = evaluate(session({ state: 'MANUAL_REVIEW_REQUIRED', resumeState: 'OUTSIDE_GEOFENCE' }), { distanceM: 5, accuracyM: 6, time: at(0) }, rules);
    expect(r.state).toBe('MANUAL_REVIEW_REQUIRED');
    expect(r.resumeState).toBe('OUTSIDE_GEOFENCE');
  });
});

describe('declared breaks', () => {
  const onBreak = (over: Partial<EngineSession> = {}) => session({ state: 'ON_BREAK', hasAttendance: true, ...over });

  it('records a verified exit without opening an absence', () => {
    const r1 = evaluate(onBreak(), { distanceM: 90, accuracyM: 6, time: at(0) }, rules);
    expect(r1.state).toBe('ON_BREAK');
    expect(r1.effects).toEqual([]);
    const r2 = evaluate(onBreak({ candidateSince: r1.candidateSince, candidateCount: r1.candidateCount }), { distanceM: 95, accuracyM: 6, time: at(61) }, rules);
    expect(r2.state).toBe('ON_BREAK');
    expect(r2.effects).toEqual([{ kind: 'BREAK_LEFT', departedAt: at(0) }]);
  });

  it('stays on break while inside until the employee ends it', () => {
    const { final } = run(onBreak(), [[0, 5, 6], [30, 6, 6], [600, 4, 6]]);
    expect(final.state).toBe('ON_BREAK');
  });

  it('ends the break on a verified return after leaving', () => {
    const r1 = evaluate(onBreak({ breakLeft: true }), { distanceM: 5, accuracyM: 6, time: at(0) }, rules);
    expect(r1.state).toBe('ON_BREAK');
    const r2 = evaluate(onBreak({ breakLeft: true, candidateSince: r1.candidateSince, candidateCount: r1.candidateCount }), { distanceM: 4, accuracyM: 6, time: at(21) }, rules);
    expect(r2.state).toBe('PRESENT');
    expect(r2.effects).toEqual([{ kind: 'END_BREAK', endedAt: at(0) }]);
  });

  it('resumes the break after an interruption', () => {
    const r = evaluate(session({ state: 'TRACKING_INTERRUPTED', resumeState: 'ON_BREAK', hasAttendance: true }), { distanceM: 300, accuracyM: 6, time: at(0) }, rules);
    expect(r.state).toBe('ON_BREAK');
  });
});

describe('arrival on the server clock (GPS-01)', () => {
  const strict = { ...rules, entryMinServerSpanSec: 20 };
  const step = (s: EngineSession, deviceSec: number, receivedSec: number) => {
    const r = evaluate(s, { distanceM: 5, accuracyM: 6, time: at(deviceSec), receivedAt: at(receivedSec) }, strict);
    return { r, next: { ...s, state: r.state, candidateSince: r.candidateSince, candidateCount: r.candidateCount, candidateReceivedSince: r.candidateReceivedSince } };
  };

  it('does not unlock from readings with invented phone times uploaded together', () => {
    const { next } = step(session(), 0, 0);
    const { r } = step(next, 60, 1); // a minute apart on the phone, one second apart at the server
    expect(r.state).toBe('ARRIVAL_CANDIDATE');
    expect(r.reason).toContain('waiting for more location updates');
  });

  it('unlocks once the server has also seen the arrival for long enough', () => {
    let { next } = step(session(), 0, 0);
    ({ next } = step(next, 25, 10));
    const { r } = step(next, 40, 25);
    expect(r.state).toBe('ATTENDANCE_READY');
  });
});

describe('overtime', () => {
  it('stays on overtime wherever the employee goes, with no absence', () => {
    const { final, results } = run(session({ state: 'ON_OVERTIME', hasAttendance: true }), [[0, 900, 8], [30, 950, 8], [600, 1200, 8], [900, 4, 6]]);
    expect(final.state).toBe('ON_OVERTIME');
    expect(results.flatMap((r) => r.effects)).toEqual([]);
  });

  it('resumes overtime after an interruption', () => {
    const r = evaluate(session({ state: 'TRACKING_INTERRUPTED', resumeState: 'ON_OVERTIME', hasAttendance: true }), { distanceM: 2000, accuracyM: 8, time: at(0) }, rules);
    expect(r.state).toBe('ON_OVERTIME');
  });
});
