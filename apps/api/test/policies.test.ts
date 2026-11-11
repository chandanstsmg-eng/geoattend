/**
 * The four business rules approved after Phase I (docs/POLICY-SPECS.md):
 *   1. work on a day off is an explicit extra day, with a reason, counted only with the owner's approval;
 *   2. full-day leave is refused on a day with attendance; a half day worked counts as present;
 *   3. impossible GPS jumps are kept and flagged, and take part in no automatic decision;
 *   4. a supervisor sees only their own team at their own workplaces; an owner sees the whole company.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { getSettings, invalidateSettings, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { adminAgent, assignTeam, createEmployee, createTestDatabase, deviceClock, mobileLogin, reading, seedBase } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
let owner: Awaited<ReturnType<typeof adminAgent>>;
type Sup = { agent: ReturnType<typeof request.agent>; csrf: string; id: string };
let sup1: Sup;
let sup2: Sup;
let weekdays: string; // a Monday–Friday 09:00–17:00 UTC shift at the base workplace

const day = (n: number) => DateTime.utc().plus({ days: n }).toISODate()!;
/** The most recent date before today (and at least 2 days back) that falls on ISO weekday `wd`. */
const lastWeekday = (wd: number) => {
  let d = DateTime.utc().minus({ days: 2 });
  while (d.weekday !== wd) d = d.minus({ days: 1 });
  return d.toISODate()!;
};
const as = (who: { agent: any; csrf: string }) => ({
  post: (path: string, body: object = {}) => who.agent.post(`/api/v1${path}`).set('X-CSRF-Token', who.csrf).send(body),
  get: (path: string) => who.agent.get(`/api/v1${path}`),
});

async function supervisor(name: string): Promise<Sup> {
  const email = `sup-${crypto.randomUUID()}@policy.test`;
  const added = (await as(owner).post('/team', { fullName: name, email, access: 'SUPERVISOR', siteIds: [base.workplaceId] }).expect(201)).body;
  await q('UPDATE users SET must_change_password = false WHERE email = $1', [email]);
  const agent = request.agent(app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: added.temporaryPassword, client: 'web' }).expect(200);
  return { agent, csrf: login.body.csrfToken, id: added.admin.id };
}

async function onWeekdays(supervisorId?: string) {
  const emp = await createEmployee({ workplaceId: base.workplaceId, supervisorId });
  await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3)`, [emp.id, weekdays, day(-40)]);
  return emp;
}

const manual = (employeeId: string, date: string, extra: object = {}) => ({
  employeeId, shiftId: weekdays, shiftDate: date, recordedAt: `${date}T09:05:00Z`, workedMinutes: 420, reason: 'Phone was broken', ...extra,
});

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
  owner = await adminAgent(app);
  weekdays = (await as(owner).post('/shifts', { workplaceId: base.workplaceId, name: 'Weekdays', startTime: '09:00', endTime: '17:00', timezone: 'UTC', daysOfWeek: [1, 2, 3, 4, 5], arrivalGraceMinutes: 0 }).expect(201)).body.id;
  sup1 = await supervisor('Sue One');
  sup2 = await supervisor('Sam Two');
});
afterAll(async () => {
  await db.drop();
});

describe('1. work on a day off is an extra day, with a reason, counted only with the owner', () => {
  it('a day the shift does not run is refused as ordinary manual attendance', async () => {
    const emp = await onWeekdays();
    const r = await as(owner).post('/attendance/manual', manual(emp.id, lastWeekday(7))).expect(409);
    expect(r.body.error.code).toBe('NOT_A_WORKING_DAY');
    expect(r.body.error.message).toContain('Sunday');
  });

  it('needs a real reason', async () => {
    const emp = await onWeekdays();
    const r = await as(owner).post('/attendance/manual', manual(emp.id, lastWeekday(7), { extraDay: true, reason: 'extra' })).expect(400);
    expect(r.body.error.code).toBe('REASON_REQUIRED');
  });

  it('recorded by the owner: counted at once, never late, flagged and audited, and in the hours', async () => {
    const emp = await onWeekdays();
    const sunday = lastWeekday(7);
    const rec = (await as(owner).post('/attendance/manual', manual(emp.id, sunday, { extraDay: true, reason: 'Stocktaking on Sunday', recordedAt: `${sunday}T13:00:00Z` })).expect(201)).body;
    expect(rec.verification_status).toBe('MANUAL_APPROVED');
    expect([rec.is_late, rec.late_by_minutes]).toEqual([false, 0]); // 13:00 against a 09:00 start: still not late
    expect(rec.risk_flags).toEqual(expect.arrayContaining(['ADMIN_ENTERED', 'EXTRA_DAY']));
    const log = await one(`SELECT reason, after_data FROM audit_logs WHERE action = 'attendance.extra_day' AND resource_id = $1`, [rec.id]);
    expect(log.reason).toBe('Stocktaking on Sunday');
    expect(log.after_data.weekday).toBe('Sunday');
    const hours = (await as(owner).get(`/reports/hours?from=${sunday}&to=${sunday}&employeeId=${emp.id}`).expect(200)).body.rows[0];
    expect(hours).toMatchObject({ days: 1, total_minutes: 420 });
  });

  it('entered by a supervisor: waits for the owner and does not count until then', async () => {
    const emp = await onWeekdays(sup1.id);
    const saturday = lastWeekday(6);
    const rec = (await as(sup1).post('/attendance/manual', manual(emp.id, saturday, { extraDay: true, reason: 'Emergency repair on Saturday' })).expect(201)).body;
    expect(rec.verification_status).toBe('PENDING_VERIFICATION');
    expect(rec.approved_by).toBeNull();
    expect(rec.risk_flags).toEqual(expect.arrayContaining(['SUPERVISOR_ENTERED', 'EXTRA_DAY']));
    const hours = (await as(owner).get(`/reports/hours?from=${saturday}&to=${saturday}&employeeId=${emp.id}`).expect(200)).body.rows[0];
    expect(hours.total_minutes).toBe(0);
    expect(hours.pending_minutes).toBe(420);
  });

  it('a working day cannot be called an extra day, and working days are unchanged (lateness still counts)', async () => {
    const emp = await onWeekdays();
    const monday = lastWeekday(1);
    expect((await as(owner).post('/attendance/manual', manual(emp.id, monday, { extraDay: true, reason: 'Not really extra' })).expect(400)).body.error.code).toBe('IS_A_WORKING_DAY');
    const rec = (await as(owner).post('/attendance/manual', manual(emp.id, monday, { recordedAt: `${monday}T09:40:00Z` })).expect(201)).body;
    expect([rec.is_late, rec.late_by_minutes, rec.risk_flags.includes('EXTRA_DAY')]).toEqual([true, 40, false]);
  });
});

describe('2. leave on a day with attendance', () => {
  it('full-day leave is refused, naming the records to correct; a half day is allowed', async () => {
    const emp = await onWeekdays();
    const tuesday = lastWeekday(2);
    const rec = (await as(owner).post('/attendance/manual', manual(emp.id, tuesday)).expect(201)).body;
    const r = await as(owner).post('/leave', { employeeId: emp.id, leaveType: 'CASUAL', startDate: DateTime.fromISO(tuesday).minus({ days: 1 }).toISODate(), endDate: tuesday, reason: 'Family matter' }).expect(409);
    expect(r.body.error.code).toBe('LEAVE_ON_ATTENDED_DAY');
    expect(r.body.error.details.records).toEqual([expect.objectContaining({ id: rec.id, date: tuesday, status: 'MANUAL_APPROVED' })]);
    expect(await one(`SELECT 1 FROM leave_requests WHERE employee_id = $1`, [emp.id])).toBeNull();
    await as(owner).post('/leave', { employeeId: emp.id, leaveType: 'CASUAL', startDate: tuesday, endDate: tuesday, halfDay: true, reason: 'Afternoon off' }).expect(201);
  });

  it('a record still waiting for verification blocks it too; a voided one does not', async () => {
    const emp = await onWeekdays(sup1.id);
    const wednesday = lastWeekday(3);
    await as(sup1).post('/attendance/manual', manual(emp.id, wednesday)).expect(201); // pending the owner
    expect((await as(owner).post('/leave', { employeeId: emp.id, leaveType: 'SICK', startDate: wednesday, endDate: wednesday, reason: 'Fever' }).expect(409)).body.error.code).toBe('LEAVE_ON_ATTENDED_DAY');
    await q(`UPDATE attendance_records SET verification_status = 'VOIDED' WHERE employee_id = $1`, [emp.id]);
    await as(owner).post('/leave', { employeeId: emp.id, leaveType: 'SICK', startDate: wednesday, endDate: wednesday, reason: 'Fever' }).expect(201);
  });

  it('attendance recorded after the request is checked again when the leave is approved', async () => {
    const emp = await onWeekdays();
    const date = (() => { let d = DateTime.utc().minus({ days: 1 }); while (d.weekday > 5) d = d.minus({ days: 1 }); return d.toISODate()!; })();
    const token = await mobileLogin(app, emp.email);
    const leave = (await request(app).post('/api/v1/leave/mine').set({ Authorization: `Bearer ${token}` }).send({ leaveType: 'CASUAL', startDate: date, endDate: date, reason: 'Personal work' }).expect(201)).body;
    await as(owner).post('/attendance/manual', manual(emp.id, date)).expect(201);
    expect((await as(owner).post(`/leave/${leave.id}/decide`, { decision: 'APPROVED' }).expect(409)).body.error.code).toBe('LEAVE_ON_ATTENDED_DAY');
    expect((await one(`SELECT status FROM leave_requests WHERE id = $1`, [leave.id])).status).toBe('PENDING');
  });

  it('a half day worked counts as present and expected, with lateness from the shift start', async () => {
    const emp = await onWeekdays();
    const thursday = lastWeekday(4);
    await as(owner).post('/leave', { employeeId: emp.id, leaveType: 'CASUAL', startDate: thursday, endDate: thursday, halfDay: true, reason: 'Morning off' }).expect(201);
    const rec = (await as(owner).post('/attendance/manual', manual(emp.id, thursday, { recordedAt: `${thursday}T13:00:00Z`, workedMinutes: 240 })).expect(201)).body;
    expect([rec.is_late, rec.late_by_minutes]).toEqual([true, 240]); // measured from 09:00, as approved
    const s = (await as(owner).get(`/analytics/dashboard?from=${thursday}&to=${thursday}&employeeId=${emp.id}`).expect(200)).body.summary;
    expect([s.expected, s.present, s.absent]).toEqual([1, 1, 0]);
  });
});

describe('3. impossible GPS jumps', () => {
  async function tracking() {
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const token = await mobileLogin(app, emp.email);
    const bearer = { Authorization: `Bearer ${token}` };
    const sessionId = (await request(app).post('/api/v1/tracking/sessions').set(bearer).send({ shiftId: base.shiftId, deviceId: `dev-${crypto.randomUUID()}` }).expect(201)).body.session.id as string;
    await request(app).post(`/api/v1/tracking/sessions/${sessionId}/permissions`).set(bearer).send({ foreground: 'granted', background: 'granted', locationServicesEnabled: true }).expect(200);
    const send = async (...readings: any[]) => (await request(app).post('/api/v1/tracking/locations').set(bearer).send({ sessionId, source: 'BACKGROUND', readings }).expect(200)).body;
    const stored = () => q(`SELECT suspect_reason, implied_speed_kmh FROM location_updates WHERE session_id = $1 ORDER BY client_time, id`, [sessionId]);
    return { emp, sessionId, send, stored, clock: deviceClock() };
  }

  it('a jump is kept and flagged, changes nothing, is audited, and managers are told once per session', async () => {
    const t = await tracking();
    await t.send(reading(5, 6, t.clock(0)));
    const ready = await t.send(reading(4, 6, t.clock(21)));
    expect(ready.status.session.state).toBe('ATTENDANCE_READY');
    // 2 km away 5 seconds later (about 1,400 km/h), then back at the gate: neither re-locks attendance.
    const jump = await t.send(reading(2000, 8, t.clock(5)));
    expect(jump.status.session.state).toBe('ATTENDANCE_READY');
    await t.send(reading(2100, 8, t.clock(5)));
    const rows = await t.stored();
    expect(rows.map((r) => r.suspect_reason)).toEqual([null, null, 'IMPOSSIBLE_SPEED', 'IMPOSSIBLE_SPEED']);
    expect(rows[2]!.implied_speed_kmh).toBeGreaterThan(1000);
    expect((await one(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'location.implausible_jump' AND resource_id = $1`, [t.sessionId])).n).toBe(2);
    expect((await one(`SELECT count(*)::int AS n FROM notifications WHERE session_id = $1 AND title = 'GPS jump ignored'`, [t.sessionId])).n).toBe(1);
    // The live position stays the last good one.
    const s = await one(`SELECT last_distance_m FROM tracking_sessions WHERE id = $1`, [t.sessionId]);
    expect(s.last_distance_m).toBeLessThan(10);
  });

  it('the readings after a jump are compared with the last good one, so a correct reading is not flagged', async () => {
    const t = await tracking();
    await t.send(reading(5, 6, t.clock(0)), reading(2000, 8, t.clock(3)), reading(6, 6, t.clock(3)));
    expect((await t.stored()).map((r) => r.suspect_reason)).toEqual([null, 'IMPOSSIBLE_SPEED', null]);
  });

  it('when the first fix was the wrong one, three readings agreeing with each other become the new reference', async () => {
    const t = await tracking();
    await t.send(reading(3000, 8, t.clock(0))); // a bad first fix, 3 km away
    await t.send(reading(5, 6, t.clock(10)), reading(4, 6, t.clock(10)), reading(4, 6, t.clock(10)), reading(5, 6, t.clock(10)));
    expect((await t.stored()).map((r) => r.suspect_reason)).toEqual([null, 'IMPOSSIBLE_SPEED', 'IMPOSSIBLE_SPEED', null, null]);
  });

  it('follows the company limit (Settings › Tracking), and ordinary GPS noise is never a jump', async () => {
    const before = (await getSettings(DEFAULT_ORG_ID)).tracking;
    await saveSettingsSection(DEFAULT_ORG_ID, 'tracking', { ...before, maxPlausibleSpeedKmh: 1000 }, null);
    invalidateSettings();
    try {
      const t = await tracking();
      // 25 m and 28 m in 1 s, within both fixes' accuracy: noise, not movement. Then about 710 km/h: under 1,000.
      await t.send(reading(5, 6, t.clock(0)), reading(30, 20, t.clock(1)), reading(2, 20, t.clock(1)), reading(2000, 8, t.clock(10)));
      expect((await t.stored()).map((r) => r.suspect_reason)).toEqual([null, null, null, null]);
    } finally {
      await saveSettingsSection(DEFAULT_ORG_ID, 'tracking', before, null);
      invalidateSettings();
    }
  });
});

describe('4. supervisors see their own team at their own workplaces; owners see everyone', () => {
  let mine: { id: string; email: string };
  let theirs: { id: string; email: string };
  let nobodys: { id: string; email: string };
  const date = () => lastWeekday(5);
  beforeAll(async () => {
    mine = await onWeekdays(sup1.id);
    theirs = await onWeekdays(sup2.id); // same workplace, the other supervisor's team
    nobodys = await onWeekdays(); // same workplace, no supervisor
    for (const e of [mine, theirs, nobodys]) await as(owner).post('/attendance/manual', manual(e.id, date())).expect(201);
    for (const e of [mine, theirs]) {
      const token = await mobileLogin(app, e.email);
      await request(app).post('/api/v1/leave/mine').set({ Authorization: `Bearer ${token}` }).send({ leaveType: 'CASUAL', startDate: day(20), endDate: day(20), reason: 'Wedding' }).expect(201);
    }
  });

  it('employee lists and details', async () => {
    const list = (await as(sup1).get('/employees').expect(200)).body.map((e: any) => e.id);
    expect(list).toContain(mine.id);
    expect(list).not.toContain(theirs.id);
    expect(list).not.toContain(nobodys.id);
    await as(sup1).get(`/employees/${mine.id}`).expect(200);
    await as(sup1).get(`/employees/${theirs.id}`).expect(404);
    await as(sup1).get(`/employees/${nobodys.id}`).expect(404);
    const all = (await as(owner).get('/employees').expect(200)).body.map((e: any) => e.id);
    expect(all).toEqual(expect.arrayContaining([mine.id, theirs.id, nobodys.id]));
  });

  it('attendance records, single records and actions on them', async () => {
    const rows = (await as(sup1).get(`/attendance?from=${date()}&to=${date()}`).expect(200)).body.items;
    expect([...new Set(rows.map((r: any) => r.employee_id))]).toEqual([mine.id]);
    const other = await one(`SELECT id FROM attendance_records WHERE employee_id = $1`, [theirs.id]);
    await as(sup1).get(`/attendance/${other.id}`).expect(404);
    await as(sup1).post(`/attendance/${other.id}/corrections`, { reason: 'Arrived earlier', recordedAt: `${date()}T09:00:00Z` }).expect(404);
    await as(sup1).post('/attendance/manual', manual(theirs.id, lastWeekday(1))).expect(404);
    expect((await as(owner).get(`/attendance?from=${date()}&to=${date()}`).expect(200)).body.items.length).toBeGreaterThanOrEqual(3);
  });

  it('leave and approvals', async () => {
    const leave = (await as(sup1).get('/leave').expect(200)).body.map((l: any) => l.employee_id);
    expect(leave).toContain(mine.id);
    expect(leave).not.toContain(theirs.id);
    const inbox = JSON.stringify((await as(sup1).get('/approvals').expect(200)).body);
    expect(inbox).toContain(mine.id);
    expect(inbox).not.toContain(theirs.id);
    const theirLeave = await one(`SELECT id FROM leave_requests WHERE employee_id = $1`, [theirs.id]);
    await as(sup1).post(`/leave/${theirLeave.id}/decide`, { decision: 'APPROVED' }).expect(404);
  });

  it('the dashboard, and an owner filtering by a supervisor sees exactly what that supervisor sees', async () => {
    const range = `from=${date()}&to=${date()}&includeSimulated=false`;
    const s1 = (await as(sup1).get(`/analytics/dashboard?${range}`).expect(200)).body;
    expect(s1.summary.present).toBe(1); // their own worker only, of the three present that day
    const asOwner = (await as(owner).get(`/analytics/dashboard?${range}&supervisorId=${sup1.id}`).expect(200)).body;
    const { serverTime: _a, ...a } = s1;
    const { serverTime: _b, supervisors: _c, ...b } = asOwner;
    expect(b.summary).toEqual(a.summary);
    expect(b.byWorkspace).toEqual(a.byWorkspace);
    expect((await as(owner).get(`/analytics/dashboard?${range}`).expect(200)).body.summary.present).toBeGreaterThanOrEqual(3);
  });

  it('the live map', async () => {
    const t = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    await assignTeam(sup2.id, t.id);
    await q(
      `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, last_location_at, last_latitude, last_longitude)
       VALUES ($1,$2,$3,$4, now() - interval '1 hour', now() + interval '6 hours', 'PRESENT', now() - interval '1 hour', now(), 1, 1)`,
      [t.id, base.shiftId, base.workplaceId, day(0)],
    );
    const live = (body: any) => JSON.stringify(body);
    expect(live((await as(sup1).get('/tracking/live').expect(200)).body)).not.toContain(t.id);
    expect(live((await as(sup2).get('/tracking/live').expect(200)).body)).toContain(t.id);
    expect(live((await as(owner).get('/tracking/live').expect(200)).body)).toContain(t.id);
  });

  it('moving a worker to another supervisor changes what both see at once', async () => {
    const e = await onWeekdays(sup2.id);
    await as(sup1).get(`/employees/${e.id}`).expect(404);
    await owner.agent.put(`/api/v1/employees/${e.id}/supervisor`).set('X-CSRF-Token', owner.csrf).send({ supervisorId: sup1.id }).expect(200);
    await as(sup1).get(`/employees/${e.id}`).expect(200);
    await as(sup2).get(`/employees/${e.id}`).expect(404);
  });

  it('their own team at a workplace that is not theirs stays out of reach', async () => {
    const elsewhere = (await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Elsewhere', 1, 1, 50, 'UTC', $1) RETURNING id`, [DEFAULT_ORG_ID])).id;
    const e = await createEmployee({ workplaceId: elsewhere });
    await assignTeam(sup1.id, e.id);
    await as(sup1).get(`/employees/${e.id}`).expect(404);
  });
});
