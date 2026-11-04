/**
 * Company and site isolation, checked against every registered admin route (not a
 * hand-picked list). For another company's administrator and for a supervisor limited
 * to other sites:
 *  - every admin route with an `:id` declares what the id is (`scope`),
 *  - foreign ids answer 404 (owner-only routes answer 403 to supervisors first),
 *  - no list / report / export contains the hidden records.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { registry } from '../src/lib/http.js';
import type { Scope } from '../src/lib/tenancy.js';
import { adminAgent, createEmployee, createTestDatabase, mobileLogin, PASSWORD, seedBase, testSettings, WP } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
const ids = {} as Record<Scope, string>;
let secretMarkers: string[] = [];
type Agent = { agent: ReturnType<typeof request.agent>; csrf: string };
let orgB: Agent & { orgId: string };
let supervisor: Agent & { visibleEmployeeId: string };

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp();

  // ── Company A, site A1: a full set of records, with names nobody else should ever see. ──
  const a = await seedBase();
  const tag = crypto.randomBytes(4).toString('hex');
  await q('UPDATE workplaces SET name = $2 WHERE id = $1', [a.workplaceId, `ORG-A-SITE-${tag}`]);
  const emp = await createEmployee({ workplaceId: a.workplaceId, shiftId: a.shiftId });
  await q('UPDATE users SET full_name = $2 WHERE id = $1', [emp.id, `ORG-A-EMPLOYEE-${tag}`]);
  await q(`UPDATE employee_profiles SET employee_code = 'EMP-1' WHERE user_id = $1`, [emp.id]); // company B will reuse this code
  const today = DateTime.utc().toISODate()!;
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, last_latitude, last_longitude)
     VALUES ($1,$2,$3,$4,$4::date,$4::date + time '23:59','PRESENT',now(),12.97,77.59) RETURNING id`,
    [emp.id, a.shiftId, a.workplaceId, today],
  );
  const att = await one(
    `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, is_late)
     VALUES ($1,$2,$3,$4,$5,$6,30,'VERIFIED',true) RETURNING id`,
    [emp.id, a.workplaceId, a.shiftId, s.id, today, `t-${tag}`],
  );
  await q(`INSERT INTO absence_intervals (session_id, employee_id, workplace_id, started_at, threshold_minutes) VALUES ($1,$2,$3,now(),15)`, [s.id, emp.id, a.workplaceId]);
  await q(`INSERT INTO geofence_events (employee_id, workplace_id, session_id, event_type, event_time) VALUES ($1,$2,$3,'ENTRY_VERIFIED',now())`, [emp.id, a.workplaceId, s.id]);
  const review = await one(`INSERT INTO review_requests (kind, employee_id, attendance_id, reason, requested_by) VALUES ('DISPUTE',$1,$2,'ORG-A dispute',$1) RETURNING id`, [emp.id, att.id]);
  const device = await one(`INSERT INTO device_registrations (user_id, device_id, platform, status) VALUES ($1,$2,'android','PENDING') RETURNING id`, [emp.id, `dev-${tag}-xxxx`]);
  const holiday = await one(`INSERT INTO holidays (org_id, workplace_id, holiday_date, name) VALUES ($1,$2,$3,$4) RETURNING id`, [a.orgId, a.workplaceId, today, `ORG-A-HOLIDAY-${tag}`]);
  const token = await mobileLogin(app, emp.email);
  const leave = (await request(app).post('/api/v1/leave/mine').set({ Authorization: `Bearer ${token}` }).send({ leaveType: 'SICK', startDate: DateTime.utc().plus({ days: 3 }).toISODate(), endDate: DateTime.utc().plus({ days: 3 }).toISODate(), reason: 'ORG-A leave' }).expect(201)).body;
  const notification = await one(`SELECT id FROM notifications WHERE employee_id = $1 LIMIT 1`, [emp.id]);
  await q(`INSERT INTO employee_pay (employee_id, pay_type, amount) VALUES ($1, 'MONTHLY', 12345)`, [emp.id]);
  const adjustment = await one(`INSERT INTO pay_adjustments (employee_id, month, kind, amount, note) VALUES ($1, $2, 'ADVANCE', 500, 'ORG-A advance') RETURNING id`, [emp.id, '2020-01']);
  const run = await one(`INSERT INTO payroll_runs (org_id, month, status, total_net, employees) VALUES ($1, '2020-01', 'APPROVED', 12345, 1) RETURNING id`, [a.orgId]);
  const payslip = await one(`INSERT INTO payslips (run_id, employee_id, month, net_amount, data) VALUES ($1, $2, '2020-01', 12345, '{}') RETURNING id`, [run.id, emp.id]);
  const task = await one(`INSERT INTO tasks (org_id, assignee_id, workplace_id, title, status) VALUES ($1, $2, $3, $4, 'SUBMITTED') RETURNING id`, [a.orgId, emp.id, a.workplaceId, `ORG-A-TASK-${tag}`]);
  const sos = await one(`INSERT INTO sos_alerts (org_id, employee_id, workplace_id, message) VALUES ($1, $2, $3, $4) RETURNING id`, [a.orgId, emp.id, a.workplaceId, `ORG-A-SOS-${tag}`]);
  const broadcast = await one(`INSERT INTO broadcasts (org_id, workplace_id, title, body, recipients) VALUES ($1, $2, $3, 'x', 1) RETURNING id`, [a.orgId, a.workplaceId, `ORG-A-MSG-${tag}`]);
  await q(`INSERT INTO broadcast_recipients (broadcast_id, employee_id) VALUES ($1, $2)`, [broadcast.id, emp.id]);
  const overtime = await one(
    `INSERT INTO overtime_entries (session_id, attendance_id, employee_id, workplace_id, shift_date, note, started_at, ended_at, end_reason, start_latitude, start_longitude, start_accuracy_m, start_distance_m)
     VALUES ($1,$2,$3,$4,$5,$6, now() - interval '1 hour', now(), 'EMPLOYEE', 12.97, 77.59, 10, 0) RETURNING id`,
    [s.id, att.id, emp.id, a.workplaceId, today, `ORG-A-OT-${tag}`],
  );
  Object.assign(ids, {
    employee: emp.id, workplace: a.workplaceId, shift: a.shiftId, session: s.id, attendance: att.id, review: review.id,
    leave: leave.id, device: device.id, holiday: holiday.id, notification: notification.id, payslip: payslip.id, adjustment: adjustment.id, admin: a.adminId, task: task.id, sos: sos.id, broadcast: broadcast.id,
    overtime: overtime.id,
  } satisfies Record<Scope, string>);
  secretMarkers = [tag, emp.id, emp.email, a.workplaceId, a.shiftId, s.id, att.id];

  // ── Company A, site A2, run by a supervisor who must not see site A1. ──
  const owner = await adminAgent(app);
  const a2 = (await owner.agent.post('/api/v1/workplaces').set('X-CSRF-Token', owner.csrf).send({ name: 'Second shop', latitude: WP.lat + 0.1, longitude: WP.lng, radiusM: 50, timezone: 'UTC' }).expect(201)).body;
  const a2shift = (await owner.agent.post('/api/v1/shifts').set('X-CSRF-Token', owner.csrf).send({ workplaceId: a2.id, name: 'A2 day', startTime: '00:00', endTime: '23:59', timezone: 'UTC', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], arrivalGraceMinutes: 10, confirmLongShift: true }).expect(201)).body;
  const visible = await createEmployee({ workplaceId: a2.id, shiftId: a2shift.id });
  const supEmail = `sup-${crypto.randomUUID()}@a.test`;
  const added = await owner.agent.post('/api/v1/team').set('X-CSRF-Token', owner.csrf).send({ fullName: 'Site Supervisor', email: supEmail, access: 'SUPERVISOR', siteIds: [a2.id] }).expect(201);
  const supAgent = request.agent(app);
  const supLogin = await supAgent.post('/api/v1/auth/login').send({ email: supEmail, password: added.body.temporaryPassword, client: 'web' }).expect(200);
  supervisor = { agent: supAgent, csrf: supLogin.body.csrfToken, visibleEmployeeId: visible.id };

  // ── Company B signs up through the public endpoint. ──
  // (B's own details must not contain A's marker, or B's own records would look like a leak.)
  const agent = request.agent(app);
  const signup = await agent.post('/api/v1/auth/signup').send({ companyName: 'Company B', fullName: 'B Owner', email: `owner-${crypto.randomUUID()}@b.test`, password: PASSWORD }).expect(201);
  const me = await agent.get('/api/v1/auth/me').expect(200);
  orgB = { agent, csrf: signup.body.csrfToken, orgId: me.body.organization.id };
  await testSettings(orgB.orgId);
});
afterAll(async () => {
  await db.drop();
});

const adminRoutes = () => registry.filter((r) => r.def.access === 'admin');
const urlFor = (path: string, id: string) => path.replace(':id', id).replace(/:(\w+)/g, () => crypto.randomUUID());
const today = () => DateTime.utc().toISODate()!;

/** Calls every scoped admin route with the hidden ids; returns anything that did not refuse. */
async function probeIds(who: Agent, ownerOnlyIs403: boolean) {
  const leaks: string[] = [];
  for (const r of adminRoutes().filter((r) => r.def.scope)) {
    const url = urlFor(r.fullPath, ids[r.def.scope!]);
    const req = (who.agent as any)[r.def.method](url).set('X-CSRF-Token', who.csrf);
    const res = r.def.method === 'get' ? await req : await req.send({});
    const expected = ownerOnlyIs403 && r.def.ownerOnly ? 403 : 404;
    if (res.status !== expected) leaks.push(`${r.def.method.toUpperCase()} ${r.fullPath} → ${res.status} (expected ${expected})`);
  }
  const shared = await who.agent.get(`/api/v1/tracking/sessions/${ids.session}`);
  if (shared.status !== 404) leaks.push(`GET /api/v1/tracking/sessions/:id → ${shared.status}`);
  return leaks;
}

/** Calls every list-like admin GET; returns routes that leaked or could not be checked. */
async function probeLists(who: Agent, skipOwnerOnly: boolean) {
  const qs = `?from=2000-01-01&to=2100-01-01&date=${today()}&month=${today().slice(0, 7)}&includeSimulated=true&limit=500`;
  // Lists, plus per-month pages (":month" is not a record id).
  const listLike = (p: string) => !p.replace(':month', '').includes(':') && !p.endsWith('/stream');
  const leaks: string[] = [];
  for (const r of adminRoutes().filter((r) => r.def.method === 'get' && listLike(r.fullPath))) {
    const res = await who.agent.get(r.fullPath.replace(':month', today().slice(0, 7)) + qs);
    if (skipOwnerOnly && r.def.ownerOnly) {
      if (res.status !== 403) leaks.push(`GET ${r.fullPath} answered ${res.status} to a supervisor (owner only)`);
      continue;
    }
    if (res.status !== 200) leaks.push(`GET ${r.fullPath} answered ${res.status}, so it was not checked`);
    const found = secretMarkers.filter((m) => (res.text ?? '').includes(m));
    if (found.length) leaks.push(`GET ${r.fullPath} contains ${found.join(', ')}`);
  }
  return leaks;
}

describe('company isolation', () => {
  it('every admin route with an id declares what the id refers to', () => {
    const missing = adminRoutes().filter((r) => r.fullPath.includes(':id') && !r.def.scope).map((r) => `${r.def.method.toUpperCase()} ${r.fullPath}`);
    expect(missing).toEqual([]);
  });

  it("answers 404 for another company's ids on every admin route", async () => {
    expect(await probeIds(orgB, false)).toEqual([]);
  });

  it("never returns another company's data from lists, reports or exports", async () => {
    expect(await probeLists(orgB, false)).toEqual([]);
  });

  it('keeps settings, employees and workplaces per company', async () => {
    const { agent, csrf } = await adminAgent(app);
    const alerts = (await agent.get('/api/v1/settings').expect(200)).body.settings.alerts;
    await agent.put('/api/v1/settings/alerts').set('X-CSRF-Token', csrf).send({ value: { ...alerts, noShowAfterMinutes: 42 } }).expect(200);
    expect((await agent.get('/api/v1/settings')).body.settings.alerts.noShowAfterMinutes).toBe(42);
    expect((await orgB.agent.get('/api/v1/settings')).body.settings.alerts.noShowAfterMinutes).toBe(15);

    const wp = await orgB.agent.post('/api/v1/workplaces').set('X-CSRF-Token', orgB.csrf).send({ name: 'B Shop', latitude: 13, longitude: 77, radiusM: 50, timezone: 'Asia/Kolkata' }).expect(201);
    const created = await orgB.agent
      .post('/api/v1/employees')
      .set('X-CSRF-Token', orgB.csrf)
      .send({ fullName: 'B Worker', email: `worker-${crypto.randomUUID()}@b.test`, employeeCode: 'EMP-1', workplaceId: wp.body.id })
      .expect(201);
    expect((await one('SELECT org_id FROM users WHERE id = $1', [created.body.employee.id])).org_id).toBe(orgB.orgId);
    // Assigning company A's workplace is refused.
    await orgB.agent.put(`/api/v1/employees/${created.body.employee.id}/workplace`).set('X-CSRF-Token', orgB.csrf).send({ workplaceId: ids.workplace }).expect(404);
    // Employee IDs are unique per company: B's EMP-1 exists alongside A's EMP-1.
    expect((await orgB.agent.get('/api/v1/employees')).body.map((e: any) => [e.full_name, e.employee_code])).toEqual([['B Worker', 'EMP-1']]);
  });

  it('refuses a duplicate sign-up email and weak passwords', async () => {
    const r = await request(app).post('/api/v1/auth/signup').send({ companyName: 'Again', fullName: 'X', email: 'admin@test.local', password: PASSWORD }).expect(409);
    expect(r.body.error.code).toBe('EMAIL_TAKEN');
    await request(app).post('/api/v1/auth/signup').send({ companyName: 'Weak', fullName: 'X', email: `weak-${crypto.randomUUID()}@x.test`, password: 'short' }).expect(400);
  });
});

describe('supervisors', () => {
  it('refuses owner-only routes and records of other sites on every admin route', async () => {
    expect(await probeIds(supervisor, true)).toEqual([]);
  });

  it("never shows other sites' data in lists", async () => {
    expect(await probeLists(supervisor, true)).toEqual([]);
  });

  it('sees and acts on their own site', async () => {
    const list = (await supervisor.agent.get('/api/v1/employees').expect(200)).body;
    expect(list.map((e: any) => e.id)).toEqual([supervisor.visibleEmployeeId]);
    await supervisor.agent.get(`/api/v1/employees/${supervisor.visibleEmployeeId}`).expect(200);
    const rec = await supervisor.agent
      .post('/api/v1/leave')
      .set('X-CSRF-Token', supervisor.csrf)
      .send({ employeeId: supervisor.visibleEmployeeId, leaveType: 'CASUAL', startDate: today(), endDate: today(), reason: 'Phoned in' })
      .expect(201);
    expect(rec.body.status).toBe('APPROVED');
    const me = (await supervisor.agent.get('/api/v1/auth/me').expect(200)).body;
    expect(me.access.role).toBe('SUPERVISOR');
    await supervisor.agent.put('/api/v1/team/me/away').set('X-CSRF-Token', supervisor.csrf).send({ awayUntil: DateTime.utc().plus({ days: 2 }).toISODate() }).expect(200);
  });

  it('keeps at least one owner', async () => {
    const owner = await adminAgent(app);
    const me = (await owner.agent.get('/api/v1/auth/me').expect(200)).body;
    const r = await owner.agent.patch(`/api/v1/team/${me.user.id}`).set('X-CSRF-Token', owner.csrf).send({ access: 'SUPERVISOR', siteIds: [ids.workplace] }).expect(409);
    expect(r.body.error.code).toBe('LAST_OWNER');
  });
});
