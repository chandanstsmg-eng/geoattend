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

describe('ending a roster entry keeps the days already rostered', () => {
  it('ends a started entry yesterday even when the employee only has manual attendance', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const a = await one(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3) RETURNING id`, [emp.id, base.shiftId, day(-30)]);
    await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-10), recordedAt: `${day(-10)}T09:00:00Z`, workedMinutes: 480, reason: 'Phone was broken' }).expect(201);
    expect(await one('SELECT 1 FROM tracking_sessions WHERE employee_id = $1', [emp.id])).toBeNull();
    await as(owner).del(`/employees/${emp.id}/shifts/${a.id}`).expect(200);
    const after = await one('SELECT effective_from::text AS f, effective_to::text AS t FROM employee_shift_assignments WHERE id = $1', [a.id]);
    expect(after).toEqual({ f: day(-30), t: day(-1) });
  });

  it('still removes an entry that has not started', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const a = await one(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3) RETURNING id`, [emp.id, base.shiftId, day(3)]);
    await as(owner).del(`/employees/${emp.id}/shifts/${a.id}`).expect(200);
    expect(await one('SELECT 1 FROM employee_shift_assignments WHERE id = $1', [a.id])).toBeNull();
  });
});

describe('manual attendance', () => {
  const entry = (empId: string, over: object = {}) => ({ employeeId: empId, shiftId: base.shiftId, shiftDate: day(0), recordedAt: new Date(Date.now() - 3600_000).toISOString(), workedMinutes: 60, reason: 'Phone was broken', ...over });

  it('refuses a day that has not happened yet', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const r = await as(owner).post('/attendance/manual', entry(emp.id, { shiftDate: day(2), recordedAt: `${day(2)}T09:00:00Z` })).expect(400);
    expect(r.body.error.code).toBe('FUTURE_DATE');
    expect((await as(owner).post('/attendance/manual', entry(emp.id, { recordedAt: new Date(Date.now() + 3 * 3600_000).toISOString() })).expect(400)).body.error.code).toBe('FUTURE_TIME');
  });

  it('refuses more worked time than the shift is long', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    // The base shift runs 00:00–23:59, so 1440 minutes is one minute too many.
    expect((await as(owner).post('/attendance/manual', entry(emp.id, { workedMinutes: 1440 })).expect(400)).body.error.code).toBe('TOO_MANY_MINUTES');
    await as(owner).post('/attendance/manual', entry(emp.id, { workedMinutes: 1439 })).expect(201);
  });

  it('keeps a supervisor’s entry pending and uncounted until the owner decides', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
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
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
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
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: shiftB.id });
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
    const emp = await createEmployee({ workplaceId: base.workplaceId });
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
    const emp = await createEmployee({ workplaceId: base.workplaceId });
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
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3)`, [emp.id, base.shiftId, day(-5)]);
    const rec = (await as(owner).post('/attendance/manual', { employeeId: emp.id, shiftId: base.shiftId, shiftDate: day(-1), recordedAt: `${day(-1)}T08:00:00Z`, workedMinutes: 480, reason: 'Phone was broken' }).expect(201)).body;
    const count = async () => (await owner.agent.get(`/api/v1/analytics/dashboard?from=${day(-1)}&to=${day(0)}`).expect(200)).body.attention.pendingCorrections;
    const before = await count();
    await as(sup).post(`/attendance/${rec.id}/corrections`, { verificationStatus: 'CORRECTED', reason: 'Arrived earlier than recorded', recordedAt: `${day(-1)}T07:30:00Z` }).expect(202);
    expect(await count()).toBe(before + 1);
  });
});

describe('a phone that is no longer approved', () => {
  it('cannot keep a shift alive: locations, permission reports and ending are refused', async () => {
    await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, faceEnrollment: 'OFF', deviceBinding: 'ENFORCE' }, null);
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
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
