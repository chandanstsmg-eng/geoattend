/**
 * Regression tests for defects found in the Phase H independent QA (docs/PHASE-H-QA.md).
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { DEFAULT_SETTINGS, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { adminAgent, createEmployee, createTestDatabase, PASSWORD, seedBase } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
let owner: Awaited<ReturnType<typeof adminAgent>>;
let sup: { agent: ReturnType<typeof request.agent>; csrf: string; id: string };

const day = (n: number) => DateTime.utc().plus({ days: n }).toISODate()!;
const as = (who: { agent: any; csrf: string }) => ({
  post: (path: string, body: object = {}) => who.agent.post(`/api/v1${path}`).set('X-CSRF-Token', who.csrf).send(body),
  del: (path: string) => who.agent.delete(`/api/v1${path}`).set('X-CSRF-Token', who.csrf),
});

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
  owner = await adminAgent(app);
  const email = `sup-${crypto.randomUUID()}@qa.test`;
  const added = (await as(owner).post('/team', { fullName: 'Quinn Supervisor', email, access: 'SUPERVISOR', siteIds: [base.workplaceId] }).expect(201)).body;
  await q('UPDATE users SET must_change_password = false WHERE email = $1', [email]);
  const agent = request.agent(app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: added.temporaryPassword, client: 'web' }).expect(200);
  sup = { agent, csrf: login.body.csrfToken, id: added.admin.id };
});
afterAll(async () => {
  await db.drop();
});

describe('Phase I review: time zones are names both the API and PostgreSQL read the same way', () => {
  it('refuses abbreviations and offsets, accepts IANA names, UTC and the old Asia/Calcutta', async () => {
    const { isValidTimezone } = await import('../src/lib/shift-window.js');
    for (const tz of ['IST', 'EST', 'GMT', 'PST8PDT', '+05:30', 'UTC+5', 'asia/kolkata', '']) expect(isValidTimezone(tz), tz).toBe(false);
    for (const tz of ['Asia/Kolkata', 'Asia/Calcutta', 'UTC', 'America/Argentina/Buenos_Aires', 'Etc/GMT-5', 'Asia/Dubai']) expect(isValidTimezone(tz), tz).toBe(true);
  });

  it('a shift or workplace in "IST" is refused (it was India to the API and Israel to SQL)', async () => {
    const shift = { workplaceId: base.workplaceId, name: 'IST test', startTime: '09:00', endTime: '17:00', daysOfWeek: [1, 2, 3, 4, 5] };
    const bad = await as(owner).post('/shifts', { ...shift, timezone: 'IST' }).expect(400);
    expect(bad.body.error.code).toBe('BAD_TIMEZONE');
    expect(bad.body.error.message).toMatch(/Asia\/Kolkata/);
    await as(owner).post('/shifts', { ...shift, timezone: 'Asia/Kolkata' }).expect(201);
    const wp = await owner.agent.patch(`/api/v1/workplaces/${base.workplaceId}`).set('X-CSRF-Token', owner.csrf).send({ timezone: 'IST' }).expect(400);
    expect(wp.body.error.code).toBe('BAD_TIMEZONE');
  });
});

describe('Phase I review: lateness flag and minutes stay consistent after a correction', () => {
  it('"not late" clears the minutes; minutes alone set the flag; "late" with 0 minutes is refused', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3)`, [emp.id, base.shiftId, day(-10)]);
    const rec = (await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-2), recordedAt: `${day(-2)}T09:00:00Z`, workedMinutes: 300, reason: 'Phone was broken' }).expect(201)).body;
    const state = async () => one(`SELECT is_late, late_by_minutes FROM attendance_records WHERE id = $1`, [rec.id]);
    await as(owner).post(`/attendance/${rec.id}/corrections`, { lateByMinutes: 90, reason: 'Came in at half past ten' }).expect(200);
    expect(await state()).toEqual({ is_late: true, late_by_minutes: 90 });
    await as(owner).post(`/attendance/${rec.id}/corrections`, { isLate: false, reason: 'Was on an approved errand' }).expect(200);
    expect(await state()).toEqual({ is_late: false, late_by_minutes: 0 });
    const bad = await as(owner).post(`/attendance/${rec.id}/corrections`, { isLate: true, lateByMinutes: 0, reason: 'Late after all' }).expect(400);
    expect(bad.body.error.code).toBe('LATENESS_INCONSISTENT');
  });
});

describe('ending a roster entry keeps the days already rostered', () => {
  it('ends a started entry yesterday even when the employee only has manual attendance', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    const a = await one(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3) RETURNING id`, [emp.id, base.shiftId, day(-30)]);
    await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-10), recordedAt: `${day(-10)}T09:00:00Z`, workedMinutes: 480, reason: 'Phone was broken' }).expect(201);
    expect(await one('SELECT 1 FROM tracking_sessions WHERE employee_id = $1', [emp.id])).toBeNull();
    await as(owner).del(`/employees/${emp.id}/shifts/${a.id}`).expect(200);
    const after = await one('SELECT effective_from::text AS f, effective_to::text AS t FROM employee_shift_assignments WHERE id = $1', [a.id]);
    expect(after).toEqual({ f: day(-30), t: day(-1) });
  });

  it('still removes an entry that has not started', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    const a = await one(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3) RETURNING id`, [emp.id, base.shiftId, day(3)]);
    await as(owner).del(`/employees/${emp.id}/shifts/${a.id}`).expect(200);
    expect(await one('SELECT 1 FROM employee_shift_assignments WHERE id = $1', [a.id])).toBeNull();
  });
});

describe('manual attendance', () => {
  const entry = (empId: string, over: object = {}) => ({ employeeId: empId, shiftId: base.shiftId, shiftDate: day(0), recordedAt: new Date(Date.now() - 3600_000).toISOString(), workedMinutes: 60, reason: 'Phone was broken', ...over });

  it('refuses a day that has not happened yet', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId, shiftId: base.shiftId });
    const r = await as(owner).post('/attendance/manual', entry(emp.id, { shiftDate: day(2), recordedAt: `${day(2)}T09:00:00Z` })).expect(400);
    expect(r.body.error.code).toBe('FUTURE_DATE');
    expect((await as(owner).post('/attendance/manual', entry(emp.id, { recordedAt: new Date(Date.now() + 3 * 3600_000).toISOString() })).expect(400)).body.error.code).toBe('FUTURE_TIME');
  });

  it('refuses more worked time than the shift is long', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId, shiftId: base.shiftId });
    // The base shift runs 00:00–23:59, so 1440 minutes is one minute too many.
    expect((await as(owner).post('/attendance/manual', entry(emp.id, { workedMinutes: 1440 })).expect(400)).body.error.code).toBe('TOO_MANY_MINUTES');
    await as(owner).post('/attendance/manual', entry(emp.id, { workedMinutes: 1439 })).expect(201);
  });

  it('keeps a supervisor’s entry pending and uncounted until the owner decides', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId, shiftId: base.shiftId });
    const rec = (await as(sup).post('/attendance/manual', entry(emp.id, { workedMinutes: 600 })).expect(201)).body;
    expect(rec.verification_status).toBe('PENDING_VERIFICATION');
    expect(rec.approved_by).toBeNull();
    expect(rec.risk_flags).toContain('SUPERVISOR_ENTERED');
    const hours = async () => (await owner.agent.get(`/api/v1/reports/hours?from=${day(0)}&to=${day(0)}`).expect(200)).body.rows.find((r: any) => r.employee_id === emp.id)?.total_minutes ?? 0;
    expect(await hours()).toBe(0);
    const self = await as(sup).post(`/attendance/${rec.id}/verification`, { decision: 'APPROVE', note: 'Looks right' }).expect(403);
    expect(self.body.error.code).toBe('OWNER_ONLY');
    await as(owner).post(`/attendance/${rec.id}/verification`, { decision: 'APPROVE', note: 'Confirmed with the site' }).expect(200);
    expect(await hours()).toBe(600);
  });

  it('still lets a supervisor decide records sent late from a phone', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId, shiftId: base.shiftId });
    const r = await one(
      `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, shift_date, recorded_at, idempotency_key, radius_m_at_record, verification_status, risk_flags)
       VALUES ($1,$2,$3,$4,now(),$5,30,'PENDING_VERIFICATION','{OFFLINE_CAPTURE}') RETURNING id`,
      [emp.id, base.workplaceId, base.shiftId, day(0), crypto.randomUUID()],
    );
    await as(sup).post(`/attendance/${r.id}/verification`, { decision: 'APPROVE', note: 'Seen on site' }).expect(200);
  });
});

describe('administrator password reset', () => {
  it('lets an owner give a supervisor a temporary password, signing them out', async () => {
    const email = `locked-${crypto.randomUUID()}@qa.test`;
    const added = (await as(owner).post('/team', { fullName: 'Lee Locked', email, access: 'SUPERVISOR', siteIds: [base.workplaceId] }).expect(201)).body;
    await q('UPDATE users SET must_change_password = false WHERE email = $1', [email]);
    const old = request.agent(app);
    await old.post('/api/v1/auth/login').send({ email, password: added.temporaryPassword, client: 'web' }).expect(200);
    await old.get('/api/v1/auth/me').expect(200);
    await q(`UPDATE users SET failed_login_count = 8, locked_until = now() + interval '1 hour' WHERE email = $1`, [email]);
    const r = (await as(owner).post(`/team/${added.admin.id}/reset-password`).expect(200)).body;
    expect(r.temporaryPassword).toMatch(/^[A-Za-z]+\d{8}$/);
    const after = await one('SELECT must_change_password, failed_login_count, locked_until FROM users WHERE email = $1', [email]);
    expect(after).toEqual({ must_change_password: true, failed_login_count: 0, locked_until: null });
    await old.post('/api/v1/auth/refresh').send({}).expect(401);
    await request(app).post('/api/v1/auth/login').send({ email, password: r.temporaryPassword, client: 'web' }).expect(200);
    expect(await one(`SELECT 1 FROM audit_logs WHERE action = 'team.reset_password' AND resource_id = $1`, [added.admin.id])).not.toBeNull();
  });

  it('is for owners only, and not for oneself', async () => {
    expect((await as(sup).post(`/team/${base.adminId}/reset-password`)).status).toBe(403);
    expect((await as(owner).post(`/team/${base.adminId}/reset-password`).expect(400)).body.error.code).toBe('SELF');
  });
});

describe('SOS while working away from home', () => {
  it('goes to the workplace of the open shift, not the home workplace', async () => {
    await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, faceEnrollment: 'OFF', deviceBinding: 'OFF' }, null);
    const siteB = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Site B', 12.99, 77.6, 50, 'UTC', $1) RETURNING id`, [DEFAULT_ORG_ID]);
    const shiftB = await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1, 'B all day', '00:00', '23:59', 'UTC', '{1,2,3,4,5,6,7}', 240) RETURNING id`, [siteB.id]);
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId, shiftId: shiftB.id });
    const token = (await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD, client: 'mobile' }).expect(200)).body.accessToken;
    const bearer = { Authorization: `Bearer ${token}` };
    await request(app).post('/api/v1/tracking/sessions').set(bearer).send({ shiftId: shiftB.id }).expect(201);
    const sos = (await request(app).post('/api/v1/sos/mine').set(bearer).send({ message: 'Help' }).expect(200)).body;
    expect((await one('SELECT workplace_id FROM sos_alerts WHERE id = $1', [sos.id])).workplace_id).toBe(siteB.id);
    const n = await one(`SELECT workplace_id, session_id FROM notifications WHERE type = 'SOS' AND employee_id = $1`, [emp.id]);
    expect(n.workplace_id).toBe(siteB.id);
    expect(n.session_id).not.toBeNull();
  });

  it('goes to the home workplace when not on shift', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    const token = (await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD, client: 'mobile' }).expect(200)).body.accessToken;
    const sos = (await request(app).post('/api/v1/sos/mine').set({ Authorization: `Bearer ${token}` }).send({}).expect(200)).body;
    expect((await one('SELECT workplace_id FROM sos_alerts WHERE id = $1', [sos.id])).workplace_id).toBe(base.workplaceId);
  });
});

describe('reports keep their history and their definitions', () => {
  const csvRow = async (empName: string) => {
    const text = (await owner.agent.get(`/api/v1/reports/attendance.csv?from=${day(-5)}&to=${day(0)}`).expect(200)).text.replace(/^\uFEFF/, '');
    const cells = (l: string) => [...l.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].slice(0, -1).map((m) => m[1]!.replace(/^"|"$/g, '').replaceAll('""', '"'));
    const [head, ...rows] = text.trim().split(/\r?\n/).map(cells);
    const row = rows.find((r) => r.includes(empName))!;
    return Object.fromEntries(head.map((h, i) => [h.replaceAll('"', ''), row[i]?.replaceAll('"', '')]));
  };

  it('a shift moved to another time zone does not rewrite past local times in the attendance CSV', async () => {
    const shift = await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1, 'TZ shift', '00:00', '23:59', 'Asia/Kolkata', '{1,2,3,4,5,6,7}', 240) RETURNING id`, [base.workplaceId]);
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3)`, [emp.id, shift.id, day(-5)]);
    await q(`UPDATE users SET full_name = 'Tara Zone' WHERE id = $1`, [emp.id]);
    await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: shift.id, shiftDate: day(-3), recordedAt: `${day(-3)}T04:00:00Z`, workedMinutes: 300, reason: 'Phone was broken' }).expect(201);
    const before = (await csvRow('Tara Zone'))['Recorded at (local)'];
    expect(before).toContain('09:30');
    await owner.agent.patch(`/api/v1/shifts/${shift.id}`).set('X-CSRF-Token', owner.csrf).send({ timezone: 'Asia/Dubai', reason: 'Moved' }).expect(200);
    expect((await csvRow('Tara Zone'))['Recorded at (local)']).toBe(before);
  });

  it('work on a holiday is not counted as present in the attendance rate', async () => {
    const site = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Holiday site', 13.0, 77.7, 50, 'UTC', $1) RETURNING id`, [DEFAULT_ORG_ID]);
    const shift = await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1, 'H shift', '00:00', '23:59', 'UTC', '{1,2,3,4,5,6,7}', 240) RETURNING id`, [site.id]);
    const emp = await createEmployee({ workplaceId: site.id });
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3)`, [emp.id, shift.id, day(-4)]);
    await q(`INSERT INTO holidays (org_id, holiday_date, name, workplace_id) VALUES ($1,$2,'Festival',$3)`, [DEFAULT_ORG_ID, day(-2), site.id]);
    for (const d of [-3, -2]) await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: shift.id, shiftDate: day(d), recordedAt: `${day(d)}T08:00:00Z`, workedMinutes: 480, reason: 'Phone was broken' }).expect(201);
    const s = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${day(-3)}&to=${day(-2)}&workplaceId=${site.id}`).expect(200)).body.summary;
    expect([s.expected, s.present]).toEqual([1, 1]);
    expect(s.attendanceRate).toBe(1);
  });

  it('the dashboard counts a supervisor’s correction waiting for the owner', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3)`, [emp.id, base.shiftId, day(-5)]);
    const rec = (await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-1), recordedAt: `${day(-1)}T08:00:00Z`, workedMinutes: 480, reason: 'Phone was broken' }).expect(201)).body;
    const count = async () => (await owner.agent.get(`/api/v1/analytics/dashboard?from=${day(-1)}&to=${day(0)}`).expect(200)).body.attention.pendingCorrections;
    const before = await count();
    await as(sup).post(`/attendance/${rec.id}/corrections`, { verificationStatus: 'CORRECTED', reason: 'Arrived earlier than recorded', recordedAt: `${day(-1)}T07:30:00Z` }).expect(202);
    expect(await count()).toBe(before + 1);
  });
});

// Since the Phase I visibility policy a supervisor sees only their own team: workers at the supervisor's site are
// created in that team (supervisorId) so the supervisor tests below are about what they say.
describe('half-day leave (existing rules, pinned)', () => {
  const setup = async (leaveType: string, worked: boolean) => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    // rostered for that one day only, so the month's figures are about it alone
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, effective_to) VALUES ($1,$2,$3,$3)`, [emp.id, base.shiftId, day(-2)]);
    await as(owner).post('/leave', { employeeId: emp.id, leaveType, startDate: day(-2), endDate: day(-2), halfDay: true, reason: 'Half day for a family matter' }).expect(201);
    if (worked) await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-2), recordedAt: `${day(-2)}T13:00:00Z`, workedMinutes: 240, reason: 'Phone was broken' }).expect(201);
    const monthly = (await owner.agent.get(`/api/v1/reports/monthly?month=${day(-2).slice(0, 7)}`).expect(200)).body.rows.find((r: any) => r.employee_id === emp.id);
    const dash = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${day(-2)}&to=${day(-2)}&employeeId=${emp.id}`).expect(200)).body.summary;
    return { monthly, dash };
  };

  it('worked on a paid half day: half present, half paid leave, not absent', async () => {
    const { monthly, dash } = await setup('CASUAL', true);
    expect(monthly).toMatchObject({ present: 0.5, leave: 0.5, paid_leave: 0.5, unpaid_leave: 0, absent: 0 });
    // Approved policy (Phase I): a half-day leave on a day worked counts as present, so it is in the dashboard
    // rate on both sides (until then it was left out of both). Lateness stays measured from the shift start.
    expect([dash.expected, dash.present]).toEqual([1, 1]);
  });

  it('a half-day leave without attendance stays out of the dashboard rate', async () => {
    const { dash } = await setup('CASUAL', false);
    expect([dash.expected, dash.present, dash.absent]).toEqual([0, 0, 0]);
  });

  it('did not work on an unpaid half day: half unpaid leave, half absent', async () => {
    const { monthly } = await setup('UNPAID', false);
    expect(monthly).toMatchObject({ present: 0, leave: 0.5, paid_leave: 0, unpaid_leave: 0.5, absent: 0.5 });
  });

  it('a half day must be a single date', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    const r = await as(owner).post('/leave', { employeeId: emp.id, leaveType: 'CASUAL', startDate: day(-3), endDate: day(-2), halfDay: true, reason: 'Two half days at once' }).expect(400);
    expect(r.body.error.code).toBe('BAD_RANGE');
  });
});

describe('analytics ranges and export filters', () => {
  let siteX: string;
  let shiftX: string;
  let inScope: string;
  let outScope: string;
  beforeAll(async () => {
    siteX = (await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Range site', 13.1, 77.8, 50, 'UTC', $1) RETURNING id`, [DEFAULT_ORG_ID])).id;
    shiftX = (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1, 'X shift', '00:00', '23:59', 'UTC', '{1,2,3,4,5,6,7}', 240) RETURNING id`, [siteX])).id;
    // One worker at the supervisor's site and one at site X, each with one old and one recent record.
    for (const [site, shift] of [[base.workplaceId, base.shiftId], [siteX, shiftX]] as const) {
      const emp = await createEmployee({ workplaceId: site, supervisorId: site === base.workplaceId ? sup.id : undefined }); // the base site's worker is in the supervisor's team
      await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, effective_to) VALUES ($1,$2,$3,$4)`, [emp.id, shift, day(-100), day(-1)]);
      for (const d of [-80, -5]) await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: shift, shiftDate: day(d), recordedAt: `${day(d)}T08:00:00Z`, workedMinutes: 300, reason: 'Phone was broken' }).expect(201);
      if (site === siteX) outScope = emp.id;
      else inScope = emp.id;
    }
  });

  it('attendance figures cover the whole range, not just its last 62 days', async () => {
    const d = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${day(-89)}&to=${day(-1)}&workplaceId=${siteX}&includeSimulated=false`).expect(200)).body;
    expect(d.trend).toHaveLength(89);
    expect(d.summary.present).toBe(2);
    expect(d.summary.totalMinutes).toBe(600); // hours and attendance describe the same days
  });

  it('answers a range longer than a year for its latest year, says so, and keeps hours and attendance on the same days', async () => {
    const d = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${day(-400)}&to=${day(-1)}&workplaceId=${siteX}&includeSimulated=false`).expect(200)).body;
    expect(d.limited).toBe(true);
    expect(d.requestedFrom).toBe(day(-400));
    expect(d.from).toBe(day(-366));
    expect(d.trend).toHaveLength(366);
    expect([d.summary.present, d.summary.totalMinutes]).toEqual([2, 600]);
    const short = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${day(-30)}&to=${day(0)}`).expect(200)).body;
    expect(short.limited).toBe(false);
  });

  it('the supervisor filter applies to the attendance, absences and daily exports', async () => {
    const csv = (await owner.agent.get(`/api/v1/reports/attendance.csv?from=${day(-90)}&to=${day(0)}&supervisorId=${sup.id}`).expect(200)).text;
    const ids = await q('SELECT id, full_name FROM users WHERE id = ANY($1)', [[inScope, outScope]]);
    const name = (id: string) => ids.find((u: any) => u.id === id).full_name;
    expect(csv).toContain(name(inScope));
    expect(csv).not.toContain(name(outScope));
    await owner.agent.get(`/api/v1/reports/absences.csv?from=${day(-90)}&to=${day(0)}&supervisorId=${sup.id}`).expect(200);
    const daily = (await owner.agent.get(`/api/v1/reports/daily-summary?from=${day(-90)}&to=${day(0)}&supervisorId=${sup.id}`).expect(200)).body;
    expect(daily.every((r: any) => r.workplace_name !== 'Range site')).toBe(true);
  });

  it('the monthly summary follows the supervisor and employee filters', async () => {
    const month = day(-5).slice(0, 7);
    const bySup = (await owner.agent.get(`/api/v1/reports/monthly?month=${month}&supervisorId=${sup.id}`).expect(200)).body.rows.map((r: any) => r.employee_id);
    expect(bySup).toContain(inScope);
    expect(bySup).not.toContain(outScope);
    const byEmp = (await owner.agent.get(`/api/v1/reports/monthly?month=${month}&employeeId=${outScope}`).expect(200)).body.rows;
    expect(byEmp.map((r: any) => r.employee_id)).toEqual([outScope]);
    const csv = (await owner.agent.get(`/api/v1/reports/monthly.csv?month=${month}&employeeId=${outScope}`).expect(200)).text.trim().split(/\r?\n/);
    expect(csv).toHaveLength(2);
  });

  it('a supervisor still cannot use these exports', async () => {
    expect((await sup.agent.get(`/api/v1/reports/attendance.csv?from=${day(-9)}&to=${day(0)}&supervisorId=${sup.id}`)).status).toBe(403);
    expect((await sup.agent.get(`/api/v1/reports/monthly?month=${day(0).slice(0, 7)}`)).status).toBe(403);
  });
});

describe('remaining QA findings', () => {
  const rostered = async (from = -10) => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    const a = await one(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3) RETURNING id`, [emp.id, base.shiftId, day(from)]);
    return { ...emp, assignmentId: a.id as string };
  };

  it('AT1: a correction cannot make a record GPS-verified', async () => {
    const emp = await rostered();
    const rec = (await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-2), recordedAt: `${day(-2)}T08:00:00Z`, workedMinutes: 300, reason: 'Phone was broken' }).expect(201)).body;
    const r = await as(owner).post(`/attendance/${rec.id}/corrections`, { verificationStatus: 'VERIFIED', reason: 'Make it look verified' }).expect(400);
    expect(r.body.error.code).toBe('NOT_GPS_VERIFIED');
    await as(owner).post(`/attendance/${rec.id}/corrections`, { verificationStatus: 'CORRECTED', reason: 'Checked with the site' }).expect(200);
  });

  it('Phase I: an arrival must be on the shift\'s day, for manual entries and corrections', async () => {
    const emp = await rostered();
    const bad = await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-2), recordedAt: `${day(-9)}T09:00:00Z`, workedMinutes: 300, reason: 'Phone was broken' }).expect(400);
    expect(bad.body.error.code).toBe('ARRIVAL_NOT_ON_SHIFT');
    const rec = (await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-2), recordedAt: `${day(-2)}T09:00:00Z`, workedMinutes: 300, reason: 'Phone was broken' }).expect(201)).body;
    expect((await as(owner).post(`/attendance/${rec.id}/corrections`, { recordedAt: `${day(-30)}T09:00:00Z`, reason: 'Wrong day' }).expect(400)).body.error.code).toBe('ARRIVAL_NOT_ON_SHIFT');
    expect((await as(sup).post(`/attendance/${rec.id}/corrections`, { recordedAt: `${day(-30)}T09:00:00Z`, reason: 'Wrong day' }).expect(400)).body.error.code).toBe('ARRIVAL_NOT_ON_SHIFT');
  });

  it('Phase I: a supervisor cannot even ask for GPS-verified', async () => {
    const emp = await rostered();
    const rec = (await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-2), recordedAt: `${day(-2)}T09:00:00Z`, workedMinutes: 300, reason: 'Phone was broken' }).expect(201)).body;
    expect((await as(sup).post(`/attendance/${rec.id}/corrections`, { verificationStatus: 'VERIFIED', reason: 'Make it verified' }).expect(400)).body.error.code).toBe('NOT_GPS_VERIFIED');
  });

  it('AT4: manual attendance must state the hours worked', async () => {
    const emp = await rostered();
    await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-2), recordedAt: `${day(-2)}T08:00:00Z`, reason: 'Phone was broken' }).expect(400);
  });

  it('R3: a supervisor cannot roster a day that has passed; the owner can', async () => {
    const a = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    expect((await as(sup).post(`/employees/${a.id}/shifts`, { shiftId: base.shiftId, effectiveFrom: day(-7) }).expect(400)).body.error.code).toBe('PAST_DATE');
    await as(sup).post(`/employees/${a.id}/shifts`, { shiftId: base.shiftId, effectiveFrom: day(1) }).expect(200);
    const b = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    await as(owner).post(`/employees/${b.id}/shifts`, { shiftId: base.shiftId, effectiveFrom: day(-7) }).expect(200);
  });

  it('R2: deactivation changes no roster; a return ends the old roster at the leaving date, audited', async () => {
    const emp = await rostered(-30);
    const future = await one(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3) RETURNING id`, [emp.id, (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week) VALUES ($1,'Later','00:00','01:00','UTC','{1}') RETURNING id`, [base.workplaceId])).id, day(20)]);
    await as(owner).post(`/employees/${emp.id}/deactivate`, { reason: 'Left the company', lastWorkingDay: day(-10) }).expect(200);
    // Leaving rewrites nothing: a mistaken or backdated deactivation can be undone without losing roster history.
    expect((await one('SELECT effective_to FROM employee_shift_assignments WHERE id = $1', [emp.assignmentId])).effective_to).toBeNull();
    expect(await one('SELECT 1 FROM employee_shift_assignments WHERE id = $1', [future.id])).not.toBeNull();
    await as(owner).post(`/employees/${emp.id}/reactivate`).expect(200);
    expect((await one('SELECT effective_to::text AS t FROM employee_shift_assignments WHERE id = $1', [emp.assignmentId])).t).toBe(day(-10));
    expect(await one('SELECT 1 FROM employee_shift_assignments WHERE id = $1', [future.id])).toBeNull();
    const a = await one(`SELECT before_data FROM audit_logs WHERE action = 'employee.reactivate' AND resource_id = $1`, [emp.id]);
    expect(a.before_data.leftOn).toBe(day(-10));
    expect(a.before_data.rosterEnded).toHaveLength(2);
    const row = (await owner.agent.get(`/api/v1/reports/monthly?month=${day(-5).slice(0, 7)}&employeeId=${emp.id}`).expect(200)).body.rows[0];
    // Only days up to the last working day can be absences; the days away are not rostered.
    expect(row?.absent ?? 0).toBeLessThanOrEqual(Math.max(0, DateTime.fromISO(day(-10)).day));
    expect(await one('SELECT 1 FROM employee_shift_assignments WHERE employee_id = $1 AND (effective_to IS NULL OR effective_to > $2)', [emp.id, day(-10)])).toBeNull();
  });

  it('A2: changing your password keeps this browser signed in and ends the others', async () => {
    const email = `pw-${crypto.randomUUID()}@qa.test`;
    const added = (await as(owner).post('/team', { fullName: 'Pat Password', email, access: 'SUPERVISOR', siteIds: [base.workplaceId] }).expect(201)).body;
    const here = request.agent(app);
    const other = request.agent(app);
    const login = await here.post('/api/v1/auth/login').send({ email, password: added.temporaryPassword, client: 'web' }).expect(200);
    await other.post('/api/v1/auth/login').send({ email, password: added.temporaryPassword, client: 'web' }).expect(200);
    const r = await here.post('/api/v1/auth/change-password').set('X-CSRF-Token', login.body.csrfToken).send({ currentPassword: added.temporaryPassword, newPassword: 'A-much-better-pass-2026' }).expect(200);
    expect(r.body.csrfToken).toBeTruthy();
    await here.post('/api/v1/auth/refresh').send({}).expect(200);
    await other.post('/api/v1/auth/refresh').send({}).expect(401);
  });

  it('D2: a signed-out or revoked phone stops getting pushes', async () => {
    await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, faceEnrollment: 'OFF', deviceBinding: 'OFF' }, null);
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    const phone = `push-${crypto.randomUUID()}`;
    const body = (await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD, client: 'mobile', deviceId: phone, platform: 'android' }).expect(200)).body;
    await q(`INSERT INTO device_registrations (user_id, device_id, platform, status, push_token) VALUES ($1,$2,'android','APPROVED','ExponentPushToken[a]') ON CONFLICT (user_id, device_id) DO UPDATE SET push_token = 'ExponentPushToken[a]', status = 'APPROVED'`, [emp.id, phone]);
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: body.refreshToken }).expect(200);
    expect((await one('SELECT push_token FROM device_registrations WHERE user_id = $1 AND device_id = $2', [emp.id, phone])).push_token).toBeNull();
    await q(`UPDATE device_registrations SET push_token = 'ExponentPushToken[b]' WHERE user_id = $1 AND device_id = $2`, [emp.id, phone]);
    const d = await one('SELECT id FROM device_registrations WHERE user_id = $1 AND device_id = $2', [emp.id, phone]);
    await as(owner).post(`/devices/${d.id}/revoke`, { note: 'Lost' }).expect(200);
    expect((await one('SELECT push_token FROM device_registrations WHERE id = $1', [d.id])).push_token).toBeNull();
  });

  it('S1: an SOS reaches administrators who are marked away', async () => {
    const { config } = await import('../src/config.js');
    const smtp = config.email.smtpUrl;
    (config.email as any).smtpUrl = 'smtp://test.invalid';
    try {
      await owner.agent.put('/api/v1/team/me/away').set('X-CSRF-Token', owner.csrf).send({ awayUntil: day(5) }).expect(200);
      const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
      const token = (await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD, client: 'mobile' }).expect(200)).body.accessToken;
      const sos = (await request(app).post('/api/v1/sos/mine').set({ Authorization: `Bearer ${token}` }).send({ message: 'Help' }).expect(200)).body;
      const sent = await q(`SELECT d.target FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.data->>'sosId' = $1 AND d.channel = 'EMAIL'`, [sos.id]);
      expect(sent.map((s: any) => s.target)).toContain(base.adminEmail);
    } finally {
      (config.email as any).smtpUrl = smtp;
      await owner.agent.put('/api/v1/team/me/away').set('X-CSRF-Token', owner.csrf).send({ awayUntil: null }).expect(200);
    }
  });

  it('LOW: an SOS is closed once; tasks go to active employees; payroll pay setup is off with payroll', async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    const token = (await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD, client: 'mobile' }).expect(200)).body.accessToken;
    const sos = (await request(app).post('/api/v1/sos/mine').set({ Authorization: `Bearer ${token}` }).send({}).expect(200)).body;
    await as(owner).post(`/sos/${sos.id}/resolve`, { note: 'Called, all fine' }).expect(200);
    expect((await as(owner).post(`/sos/${sos.id}/resolve`, { note: 'Again' }).expect(409)).body.error.code).toBe('ALREADY_RESOLVED');
    await q('UPDATE users SET is_active = false WHERE id = $1', [emp.id]);
    expect((await as(owner).post('/tasks', { assigneeIds: [emp.id], title: 'Count stock' }).expect(400)).body.error.code).toBe('INACTIVE_EMPLOYEE');
    const { config } = await import('../src/config.js');
    config.payrollEnabled = false; // as in a release; tests turn it on for the payroll suites
    try {
      const r = await owner.agent.get(`/api/v1/payroll/pay/${emp.id}`).expect(403);
      expect(r.body.error.code).toBe('PAYROLL_DISABLED');
    } finally {
      config.payrollEnabled = true;
    }
  });

  it('L5: a supervisor does not see their own pending entries in their approval queue; the owner does', async () => {
    const emp = await rostered();
    const rec = (await as(sup).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-1), recordedAt: `${day(-1)}T08:00:00Z`, workedMinutes: 300, reason: 'Phone was broken' }).expect(201)).body;
    const ids = (body: any) => JSON.stringify(body);
    expect(ids((await sup.agent.get('/api/v1/approvals').expect(200)).body)).not.toContain(rec.id);
    expect(ids((await owner.agent.get('/api/v1/approvals').expect(200)).body)).toContain(rec.id);
  });

  it('L6: worked time is checked against the shift as it was on that date', async () => {
    const shift = await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'Long','08:00','18:00','UTC','{1,2,3,4,5,6,7}',30) RETURNING id`, [base.workplaceId]);
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3)`, [emp.id, shift.id, day(-20)]);
    await owner.agent.patch(`/api/v1/shifts/${shift.id}`).set('X-CSRF-Token', owner.csrf).send({ endTime: '12:00', reason: 'Shorter from now on' }).expect(200);
    // Ten hours on a past day, when the shift was still ten hours long.
    await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: shift.id, shiftDate: day(-5), recordedAt: `${day(-5)}T08:00:00Z`, workedMinutes: 600, reason: 'Phone was broken' }).expect(201);
  });

  it('L8: an owner resets supervisors, not another owner', async () => {
    const email = `owner2-${crypto.randomUUID()}@qa.test`;
    const other = (await as(owner).post('/team', { fullName: 'Olive Owner', email, access: 'OWNER' }).expect(201)).body;
    expect((await as(owner).post(`/team/${other.admin.id}/reset-password`).expect(400)).body.error.code).toBe('OWNER_ACCOUNT');
  });

  it('L7: the dashboard employee filter narrows pending overtime and corrections', async () => {
    const emp = await rostered();
    const d = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${day(-3)}&to=${day(0)}&employeeId=${emp.id}`).expect(200)).body;
    expect(d.attention.overtimePending).toBe(0);
    expect(d.attention.pendingCorrections).toBe(0);
  });
});

describe('a refresh whose answer was lost (D1)', () => {
  const login = async () => {
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId });
    const body = (await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD, client: 'mobile' }).expect(200)).body;
    return { emp, token: body.refreshToken as string };
  };
  const refresh = (refreshToken: string, requestId?: string) => request(app).post('/api/v1/auth/refresh').send({ refreshToken, requestId });
  const later = (userId: string) => q(`UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE user_id = $1 AND revoked_at IS NOT NULL`, [userId]);
  const id = () => crypto.randomBytes(16).toString('hex');

  it('answers a retry of the same refresh with the same new token, long after the grace period', async () => {
    const { emp, token } = await login();
    const rid = id();
    const lost = (await refresh(token, rid).expect(200)).body.refreshToken;
    await later(emp.id);
    const again = (await refresh(token, rid).expect(200)).body;
    expect(again.refreshToken).toBe(lost); // no second live token
    await refresh(again.refreshToken, id()).expect(200);
    expect(await one(`SELECT 1 FROM audit_logs WHERE action = 'auth.refresh_reuse' AND resource_id = $1`, [emp.id])).toBeNull();
  });

  it('still treats the old token as stolen without the same request id, and revokes the family', async () => {
    const { emp, token } = await login();
    const next = (await refresh(token, id()).expect(200)).body.refreshToken;
    await later(emp.id);
    await refresh(token, id()).expect(401);
    await refresh(next).expect(401);
    expect(await one(`SELECT 1 FROM audit_logs WHERE action = 'auth.refresh_reuse' AND resource_id = $1`, [emp.id])).not.toBeNull();
  });

  it('refuses the retry once the new token has been used, and revokes the family', async () => {
    const { emp, token } = await login();
    const rid = id();
    const next = (await refresh(token, rid).expect(200)).body.refreshToken;
    const newest = (await refresh(next, id()).expect(200)).body.refreshToken;
    await later(emp.id);
    await refresh(token, rid).expect(401);
    await refresh(newest).expect(401);
  });

  it('stops answering a lost refresh after a day', async () => {
    const { emp, token } = await login();
    const rid = id();
    await refresh(token, rid).expect(200);
    await q(`UPDATE refresh_tokens SET revoked_at = now() - interval '25 hours' WHERE user_id = $1 AND revoked_at IS NOT NULL`, [emp.id]);
    await refresh(token, rid).expect(401);
  });

  it('refuses the retry after sign-out or deactivation', async () => {
    const a = await login();
    const ra = id();
    await refresh(a.token, ra).expect(200);
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: a.token }).expect(200);
    await refresh(a.token, ra).expect(401);
    const b = await login();
    const rb = id();
    await refresh(b.token, rb).expect(200);
    await q('UPDATE users SET is_active = false WHERE id = $1', [b.emp.id]);
    await refresh(b.token, rb).expect(401);
  });

  it('keeps nothing in the database that could be used without the old token', async () => {
    const { emp, token } = await login();
    const fresh = (await refresh(token, id()).expect(200)).body.refreshToken;
    const rows = await q('SELECT token_hash, successor_box, rotation_key_hash FROM refresh_tokens WHERE user_id = $1', [emp.id]);
    expect(JSON.stringify(rows)).not.toContain(fresh);
    expect(rows.some((r: any) => r.successor_box)).toBe(true);
  });
});

describe('a phone that is no longer approved', () => {
  it('cannot keep a shift alive: locations, permission reports and ending are refused', async () => {
    await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, faceEnrollment: 'OFF', deviceBinding: 'ENFORCE' }, null);
    const emp = await createEmployee({ supervisorId: sup.id, workplaceId: base.workplaceId, shiftId: base.shiftId });
    const phone = `qa-${crypto.randomUUID()}`;
    const login = () => request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD, client: 'mobile', deviceId: phone, platform: 'android', model: 'QA phone' });
    await login().expect(403);
    const d = await one('SELECT id FROM device_registrations WHERE user_id = $1', [emp.id]);
    await as(owner).post(`/devices/${d.id}/approve`).expect(200);
    const token = (await login().expect(200)).body.accessToken;
    const bearer = { Authorization: `Bearer ${token}` };
    const s = (await request(app).post('/api/v1/tracking/sessions').set(bearer).send({ shiftId: base.shiftId }).expect(201)).body;
    const sessionId = s.session?.id ?? s.id;
    await as(owner).post(`/devices/${d.id}/revoke`, { note: 'Handed to someone else' }).expect(200);
    const fix = { clientEventId: crypto.randomUUID(), latitude: 12.9716, longitude: 77.5946, accuracyM: 5, clientTime: new Date().toISOString() };
    const loc = await request(app).post('/api/v1/tracking/locations').set(bearer).send({ sessionId, readings: [fix] });
    expect([loc.status, loc.body.error?.code]).toEqual([403, 'DEVICE_NOT_APPROVED']);
    const perm = await request(app).post(`/api/v1/tracking/sessions/${sessionId}/permissions`).set(bearer).send({ foreground: 'granted', background: 'granted', locationServicesEnabled: true });
    expect(perm.status).toBe(403);
    const end = await request(app).post(`/api/v1/tracking/sessions/${sessionId}/end`).set(bearer).send({});
    expect(end.status).toBe(403);
    expect(await one('SELECT count(*)::int AS n FROM location_updates WHERE session_id = $1', [sessionId])).toEqual({ n: 0 });
  });
});
