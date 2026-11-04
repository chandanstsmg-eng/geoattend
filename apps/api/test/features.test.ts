/**
 * Leave, no-show alerts, device status in interruption alerts, and bulk employee import.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { sweepStale } from '../src/modules/jobs/sweeper.js';
import { sweepNoShows } from '../src/modules/jobs/no-show.js';
import { DEFAULT_SETTINGS, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { adminAgent, createEmployee, createTestDatabase, deviceClock, fakeJpeg, mobileLogin, PASSWORD, reading, seedBase } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
});
afterAll(async () => {
  await db.drop();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const today = () => DateTime.utc().toISODate()!; // the test workplace runs on UTC
const plusDays = (n: number) => DateTime.utc().plus({ days: n }).toISODate()!;

describe('leave requests', () => {
  it('lets an employee apply, blocks overlaps, and an admin approve', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const token = await mobileLogin(app, emp.email);
    const created = await request(app)
      .post('/api/v1/leave/mine')
      .set(bearer(token))
      .send({ leaveType: 'SICK', startDate: today(), endDate: plusDays(1), reason: 'Fever' })
      .expect(201);
    expect(created.body.status).toBe('PENDING');
    expect(created.body.days).toBe(2);

    const overlap = await request(app).post('/api/v1/leave/mine').set(bearer(token)).send({ leaveType: 'CASUAL', startDate: plusDays(1), endDate: plusDays(1), reason: 'Errand' }).expect(409);
    expect(overlap.body.error.code).toBe('LEAVE_OVERLAP');

    const notice = await q(`SELECT 1 FROM notifications WHERE type = 'LEAVE_REQUESTED' AND employee_id = $1`, [emp.id]);
    expect(notice).toHaveLength(1);

    const { agent, csrf } = await adminAgent(app);
    await agent.post(`/api/v1/leave/${created.body.id}/decide`).set('X-CSRF-Token', csrf).send({ decision: 'REJECTED' }).expect(400); // reason required
    const approved = await agent.post(`/api/v1/leave/${created.body.id}/decide`).set('X-CSRF-Token', csrf).send({ decision: 'APPROVED' }).expect(200);
    expect(approved.body.status).toBe('APPROVED');
    await agent.post(`/api/v1/leave/${created.body.id}/decide`).set('X-CSRF-Token', csrf).send({ decision: 'APPROVED' }).expect(409);

    const me = await request(app).get('/api/v1/me/assignment').set(bearer(token)).expect(200);
    expect(me.body.leaveToday?.id).toBe(created.body.id);

    const overview = await agent.get(`/api/v1/reports/overview?date=${today()}`).expect(200);
    const row = overview.body.roster.find((r: any) => r.employee_id === emp.id);
    expect(row.on_leave.leave_type).toBe('SICK');
    expect(row.no_show).toBe(false);

    // Approved leave that has already started can only be changed by an admin.
    const cancel = await request(app).post(`/api/v1/leave/mine/${created.body.id}/cancel`).set(bearer(token)).expect(409);
    expect(cancel.body.error.code).toBe('LEAVE_STARTED');
  });

  it('lets an employee withdraw a pending request and keeps requests private', async () => {
    const a = await createEmployee({ workplaceId: base.workplaceId });
    const b = await createEmployee({ workplaceId: base.workplaceId });
    const ta = await mobileLogin(app, a.email);
    const tb = await mobileLogin(app, b.email);
    const r = await request(app).post('/api/v1/leave/mine').set(bearer(ta)).send({ leaveType: 'CASUAL', startDate: plusDays(5), endDate: plusDays(5), halfDay: true, reason: 'Bank visit' }).expect(201);
    await request(app).post(`/api/v1/leave/mine/${r.body.id}/cancel`).set(bearer(tb)).expect(404);
    expect((await request(app).get('/api/v1/leave/mine').set(bearer(tb)).expect(200)).body).toHaveLength(0);
    await request(app).get('/api/v1/leave').set(bearer(ta)).expect(403);
    const c = await request(app).post(`/api/v1/leave/mine/${r.body.id}/cancel`).set(bearer(ta)).expect(200);
    expect(c.body.status).toBe('CANCELLED');
  });

  it('rejects impossible ranges', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await mobileLogin(app, emp.email);
    await request(app).post('/api/v1/leave/mine').set(bearer(token)).send({ leaveType: 'CASUAL', startDate: plusDays(3), endDate: plusDays(2), reason: 'Backwards' }).expect(400);
    await request(app).post('/api/v1/leave/mine').set(bearer(token)).send({ leaveType: 'CASUAL', startDate: plusDays(1), endDate: plusDays(2), halfDay: true, reason: 'Half of two days' }).expect(400);
    await request(app).post('/api/v1/leave/mine').set(bearer(token)).send({ leaveType: 'CASUAL', startDate: plusDays(-30), endDate: plusDays(-30), reason: 'Too old' }).expect(400);
  });
});

describe('no-show alerts', () => {
  it('alerts once for a scheduled employee who has not started, skipping leave and started shifts', async () => {
    const missing = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const onLeave = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const started = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const { agent, csrf } = await adminAgent(app);
    await agent.post('/api/v1/leave').set('X-CSRF-Token', csrf).send({ employeeId: onLeave.id, leaveType: 'EARNED', startDate: today(), endDate: today(), reason: 'Planned' }).expect(201);
    const token = await mobileLogin(app, started.email);
    await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: base.shiftId }).expect(201);

    // The test shift runs 00:00–23:59 UTC every day; noon is well past the 15-minute threshold.
    const noon = DateTime.utc().set({ hour: 12, minute: 0, second: 0 }).toJSDate();
    await sweepNoShows(noon);
    await sweepNoShows(noon); // idempotent

    const alerts = await q(`SELECT employee_id, audience FROM notifications WHERE type = 'NO_SHOW' AND employee_id = ANY($1::uuid[])`, [[missing.id, onLeave.id, started.id]]);
    expect(alerts.filter((a) => a.employee_id === missing.id).map((a) => a.audience).sort()).toEqual(['ADMIN', 'EMPLOYEE']);
    expect(alerts.filter((a) => a.employee_id !== missing.id)).toHaveLength(0);

    // Before the threshold nothing fires.
    const early = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    await sweepNoShows(DateTime.utc().set({ hour: 0, minute: 5 }).toJSDate());
    expect(await q(`SELECT 1 FROM notifications WHERE type = 'NO_SHOW' AND employee_id = $1`, [early.id])).toHaveLength(0);
  });
});

describe('device status', () => {
  it('names a flat battery as the likely cause when tracking stops', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const token = await mobileLogin(app, emp.email);
    const start = await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: base.shiftId }).expect(201);
    const sessionId = start.body.session.id;
    await request(app).post(`/api/v1/tracking/sessions/${sessionId}/permissions`).set(bearer(token)).send({ foreground: 'granted', background: 'granted', locationServicesEnabled: true }).expect(200);
    const clock = deviceClock();
    await request(app)
      .post('/api/v1/tracking/locations')
      .set(bearer(token))
      .send({ sessionId, readings: [reading(5, 6, clock(0))], device: { batteryLevel: 0.04, charging: false, network: 'cellular' } })
      .expect(200);
    const { agent } = await adminAgent(app);
    const live = await agent.get('/api/v1/tracking/live').expect(200);
    expect(live.body.sessions.find((s: any) => s.id === sessionId).last_battery_level).toBeCloseTo(0.04);

    await q(`UPDATE tracking_sessions SET last_location_at = now() - interval '10 minutes' WHERE id = $1`, [sessionId]);
    await sweepStale();
    const n = await q(`SELECT body FROM notifications WHERE type = 'TRACKING_INTERRUPTED' AND session_id = $1`, [sessionId]);
    expect(n[0].body).toContain('battery was almost empty (4%)');
  });
});

describe('bulk employee import', () => {
  it('creates valid rows, reports bad ones, and returns one-time passwords that work', async () => {
    const { agent, csrf } = await adminAgent(app);
    const stamp = Date.now();
    const res = await agent
      .post('/api/v1/employees/import')
      .set('X-CSRF-Token', csrf)
      .send({
        workplaceId: base.workplaceId,
        shiftId: base.shiftId,
        rows: [
          { fullName: 'Ravi Kumar', email: `ravi${stamp}@test.local`, employeeCode: `IMP-${stamp}-1`, phone: '9800000001' },
          { fullName: 'Ravi Again', email: `ravi${stamp}@test.local`, employeeCode: `IMP-${stamp}-2` },
          { fullName: 'No Email', email: 'not-an-email', employeeCode: `IMP-${stamp}-3` },
        ],
      })
      .expect(200);
    expect(res.body.created).toBe(1);
    expect(res.body.failed).toBe(2);
    expect(res.body.results[1].error).toMatch(/already exists/);
    expect(res.body.results[2].error).toMatch(/email/);
    const ok = res.body.results[0];
    const emp = (await agent.get(`/api/v1/employees/${ok.id}`).expect(200)).body;
    expect(emp.workplace_id).toBe(base.workplaceId);
    expect(emp.shifts).toHaveLength(1);
    await request(app).post('/api/v1/auth/login').send({ email: ok.email, password: ok.temporaryPassword, client: 'mobile' }).expect(200);
  });

  it('refuses a shift from another workplace', async () => {
    const { agent, csrf } = await adminAgent(app);
    const r = await agent.post('/api/v1/employees/import').set('X-CSRF-Token', csrf).send({ shiftId: base.shiftId, rows: [{ fullName: 'X', email: 'x@test.local', employeeCode: 'X-1' }] }).expect(400);
    expect(r.body.error.code).toBe('WRONG_WORKPLACE');
  });
});

describe('one phone per employee', () => {
  const login = (email: string, deviceId: string) => request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD, client: 'mobile', deviceId, platform: 'android', model: 'Test phone' });

  it('approves the first phone, holds a new one for approval, and blocks shared phones', async () => {
    await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, faceEnrollment: 'OFF', deviceBinding: 'ENFORCE' }, null);
    try {
      const a = await createEmployee({ workplaceId: base.workplaceId });
      const b = await createEmployee({ workplaceId: base.workplaceId });
      const phoneA = `phone-a-${crypto.randomUUID()}`;
      const phoneB = `phone-b-${crypto.randomUUID()}`;

      await login(a.email, phoneA).expect(200); // first phone: approved automatically
      await login(a.email, phoneA).expect(200);
      expect((await login(a.email, phoneB).expect(403)).body.error.code).toBe('DEVICE_PENDING');
      expect(await q(`SELECT 1 FROM notifications WHERE type = 'NEW_DEVICE' AND employee_id = $1`, [a.id])).toHaveLength(1);

      // B tries A's phone: refused and flagged.
      expect((await login(b.email, phoneA).expect(403)).body.error.code).toBe('DEVICE_IN_USE');
      expect(await q(`SELECT 1 FROM notifications WHERE type = 'SHARED_DEVICE' AND employee_id = $1`, [b.id])).toHaveLength(1);

      const { agent, csrf } = await adminAgent(app);
      const inbox = (await agent.get('/api/v1/approvals').expect(200)).body;
      const pending = inbox.devices.find((d: any) => d.user_id === a.id);
      expect(pending.current_phone.platform).toBe('android');
      expect(inbox.counts.devices).toBeGreaterThanOrEqual(1);

      // Approving the new phone retires the old one.
      await agent.post(`/api/v1/devices/${pending.id}/approve`).set('X-CSRF-Token', csrf).send({}).expect(200);
      await login(a.email, phoneB).expect(200);
      expect((await login(a.email, phoneA).expect(403)).body.error.code).toBe('DEVICE_REVOKED');

      // The old phone is now free for B (their first phone).
      await login(b.email, phoneA).expect(200);
    } finally {
      await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, faceEnrollment: 'OFF', deviceBinding: 'OFF' }, null);
    }
  });

  it('lets demo accounts share a test phone', async () => {
    await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, faceEnrollment: 'OFF', deviceBinding: 'ENFORCE' }, null);
    try {
      const a = await createEmployee({ workplaceId: base.workplaceId });
      const b = await createEmployee({ workplaceId: base.workplaceId });
      await q('UPDATE users SET is_demo = true WHERE id = ANY($1::uuid[])', [[a.id, b.id]]);
      const phone = `demo-phone-${crypto.randomUUID()}`;
      await login(a.email, phone).expect(200);
      await login(b.email, phone).expect(200);
    } finally {
      await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, faceEnrollment: 'OFF', deviceBinding: 'OFF' }, null);
    }
  });
});

describe('hours worked, overtime and the monthly summary', () => {
  it('counts worked time from shift start to its end, only approved overtime, and leaving early', async () => {
    const shift = await q(
      `INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week) VALUES ($1, 'Day 9-5', '09:00', '17:00', 'UTC', '{1,2,3,4,5,6,7}') RETURNING id`,
      [base.workplaceId],
    );
    const shiftId = shift[0].id;
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const d1 = DateTime.utc().minus({ days: 3 }).toISODate()!;
    const d2 = DateTime.utc().minus({ days: 2 }).toISODate()!;
    await q('INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1, $2, $3)', [emp.id, shiftId, d1]);
    const work = async (date: string, marked: string, ended: string) => {
      const s = await q(
        `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, authorization_status, started_at, ended_at)
         VALUES ($1,$2,$3,$4,$4::date + time '09:00', $4::date + time '17:00','SHIFT_COMPLETED','ENDED',$4::date + time '08:40',$4::date + $5::time) RETURNING id`,
        [emp.id, shiftId, base.workplaceId, date, ended],
      );
      const a = await q(
        `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, recorded_at, idempotency_key, radius_m_at_record, verification_status)
         VALUES ($1,$2,$3,$4,$5,$5::date + $6::time,$7,30,'VERIFIED') RETURNING id`,
        [emp.id, base.workplaceId, shiftId, s[0].id, date, marked, `t-${crypto.randomUUID()}`],
      );
      return { sessionId: s[0].id, attendanceId: a[0].id };
    };
    const day1 = await work(d1, '08:50', '17:45'); // 9:00–17:00 = 480 min regular; 17:00–17:45 overtime
    await work(d2, '09:05', '16:00'); // 9:05–16:00 = 415 min, left 60 min early
    const ot = await q(
      `INSERT INTO overtime_entries (session_id, attendance_id, employee_id, workplace_id, shift_date, started_at, ended_at, end_reason, start_latitude, start_longitude, start_accuracy_m, start_distance_m)
       VALUES ($1,$2,$3,$4,$5,$5::date + time '17:00',$5::date + time '17:45','EMPLOYEE',12.97,77.59,10,0) RETURNING id`,
      [day1.sessionId, day1.attendanceId, emp.id, base.workplaceId, d1],
    );

    const { agent, csrf } = await adminAgent(app);
    const roster1 = async () => (await agent.get(`/api/v1/reports/overview?date=${d1}`).expect(200)).body.roster.find((r: any) => r.employee_id === emp.id && r.shift_id === shiftId);
    let r1 = await roster1();
    expect(r1.worked_minutes).toBe(480);
    expect(r1).toMatchObject({ overtime_minutes: 0, overtime_status: 'PENDING', overtime_claimed_minutes: 45 }); // not approved yet
    await agent.post(`/api/v1/overtime/${ot[0].id}/decision`).set('X-CSRF-Token', csrf).send({ decision: 'APPROVE' }).expect(200);
    r1 = await roster1();
    expect(r1.overtime_minutes).toBe(45);
    expect(r1.left_early).toBe(false);
    const r2 = (await agent.get(`/api/v1/reports/overview?date=${d2}`).expect(200)).body.roster.find((r: any) => r.employee_id === emp.id && r.shift_id === shiftId);
    expect(r2.worked_minutes).toBe(415);
    expect(r2.overtime_minutes).toBe(0);
    expect(r2.left_early).toBe(true);

    const month = d1.slice(0, 7);
    const m = (await agent.get(`/api/v1/reports/monthly?month=${month}`).expect(200)).body;
    const row = m.rows.find((r: any) => r.employee_id === emp.id);
    const inMonth = [d1, d2].filter((d) => d.startsWith(month));
    expect(row.present).toBe(inMonth.length);
    expect(row.overtime_minutes).toBe(45);
    const csv = await agent.get(`/api/v1/reports/monthly.csv?month=${month}`).expect(200);
    expect(csv.text).toContain('Overtime (hours)');

    const token = await mobileLogin(app, emp.email);
    const mine = (await request(app).get('/api/v1/me/attendance').set(bearer(token)).expect(200)).body.attendance;
    expect(mine.find((a: any) => a.shift_date === d1).overtime_minutes).toBe(45);
  });
});

describe('payroll', () => {
  it('calculates from attendance, locks on approval, and shows the employee their payslip', async () => {
    const { agent, csrf } = await adminAgent(app);
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const month = DateTime.utc().minus({ months: 1 }).toFormat('yyyy-MM'); // only a finished month can be approved
    const pay = await agent.put(`/api/v1/payroll/pay/${emp.id}`).set('X-CSRF-Token', csrf).send({ payType: 'MONTHLY', amount: 15000, otMultiplier: 2 }).expect(200);
    expect(pay.body.amount).toBe(15000);
    await agent.post('/api/v1/payroll/adjustments').set('X-CSRF-Token', csrf).send({ employeeId: emp.id, month, kind: 'ADVANCE', amount: 2000, note: 'Festival advance' }).expect(201);
    await agent.post('/api/v1/payroll/adjustments').set('X-CSRF-Token', csrf).send({ employeeId: emp.id, month, kind: 'BONUS', amount: 500 }).expect(201);

    const live = (await agent.get(`/api/v1/payroll/${month}`).expect(200)).body;
    expect(live.run).toBeNull();
    const row = live.rows.find((r: any) => r.employee.id === emp.id);
    // No shifts assigned → nothing scheduled, nothing absent: full salary − advance + bonus.
    expect(row.result.net).toBe(13500);

    await q(`INSERT INTO day_closes (org_id, close_date, closed_by, summary) SELECT $1, d::date, (SELECT id FROM users WHERE role = 'ADMIN' AND org_id = $1 LIMIT 1), '{}'
             FROM generate_series($2::date, ($2::date + interval '1 month' - interval '1 day'), interval '1 day') d ON CONFLICT DO NOTHING`, [DEFAULT_ORG_ID, `${month}-01`]);
    const approved = await agent.post(`/api/v1/payroll/${month}/approve`).set('X-CSRF-Token', csrf).send({}).expect(200);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'payroll.approve' AND resource_id = $1`, [approved.body.id])).toHaveLength(1);
    await q(`DELETE FROM day_closes WHERE org_id = $1 AND summary = '{}'::jsonb`, [DEFAULT_ORG_ID]); // leave Daily close as other tests expect
    expect(approved.body.status).toBe('APPROVED');
    await agent.post(`/api/v1/payroll/${month}/approve`).set('X-CSRF-Token', csrf).send({}).expect(409);
    // Locked: no new adjustments, and the numbers are frozen.
    expect((await agent.post('/api/v1/payroll/adjustments').set('X-CSRF-Token', csrf).send({ employeeId: emp.id, month, kind: 'BONUS', amount: 1 }).expect(409)).body.error.code).toBe('MONTH_LOCKED');
    await agent.put(`/api/v1/payroll/pay/${emp.id}`).set('X-CSRF-Token', csrf).send({ payType: 'MONTHLY', amount: 99999 }).expect(200);
    const frozen = (await agent.get(`/api/v1/payroll/${month}`).expect(200)).body;
    expect(frozen.rows.find((r: any) => r.employee.id === emp.id).result.net).toBe(13500);
    const csv = await agent.get(`/api/v1/payroll/${month}/salary.csv`).expect(200);
    expect(csv.text).toContain('13500');

    const token = await mobileLogin(app, emp.email);
    const mine = (await request(app).get('/api/v1/me/earnings').set(bearer(token)).expect(200)).body;
    expect(mine.payslips[0].net_amount).toBe(13500);
    const slip = (await request(app).get(`/api/v1/me/payslips/${mine.payslips[0].id}`).set(bearer(token)).expect(200)).body;
    expect(slip.data.adjustments.map((a: any) => a.kind).sort()).toEqual(['ADVANCE', 'BONUS']);
    const other = await createEmployee({ workplaceId: base.workplaceId });
    await request(app).get(`/api/v1/me/payslips/${mine.payslips[0].id}`).set(bearer(await mobileLogin(app, other.email))).expect(404);

    await agent.post(`/api/v1/payroll/${month}/paid`).set('X-CSRF-Token', csrf).send({}).expect(200);
    await agent.post(`/api/v1/payroll/${month}/reopen`).set('X-CSRF-Token', csrf).send({ reason: 'Fix salary' }).expect(200);
    const reopened = (await agent.get(`/api/v1/payroll/${month}`).expect(200)).body;
    expect(reopened.run).toBeNull();
    expect(reopened.rows.find((r: any) => r.employee.id === emp.id).result.net).toBe(99999 - 2000 + 500);
  });
});

describe('daily close and patterns', () => {
  it('lists what needs a decision, confirms the day once, and can reopen it', async () => {
    const { agent, csrf } = await adminAgent(app);
    const missing = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    await q(`UPDATE employee_shift_assignments SET effective_from = CURRENT_DATE - 3 WHERE employee_id = $1`, [missing.id]);
    const yesterday = DateTime.utc().minus({ days: 1 }).toISODate()!;
    const day = (await agent.get(`/api/v1/insights/day?date=${yesterday}`).expect(200)).body;
    expect(day.closed).toBeNull();
    expect(day.toDecide.some((t: any) => t.type === 'ABSENT' && t.employeeId === missing.id)).toBe(true);
    expect((await agent.get(`/api/v1/insights/unconfirmed?month=${yesterday.slice(0, 7)}`).expect(200)).body.days).toContain(yesterday);

    await agent.post('/api/v1/insights/day/close').set('X-CSRF-Token', csrf).send({ date: yesterday, note: 'Checked' }).expect(200);
    await agent.post('/api/v1/insights/day/close').set('X-CSRF-Token', csrf).send({ date: yesterday }).expect(409);
    expect((await agent.get(`/api/v1/insights/day?date=${yesterday}`).expect(200)).body.closed.note).toBe('Checked');
    expect((await agent.get(`/api/v1/insights/unconfirmed?month=${yesterday.slice(0, 7)}`).expect(200)).body.days).not.toContain(yesterday);
    await agent.post('/api/v1/insights/day/close').set('X-CSRF-Token', csrf).send({ date: DateTime.utc().plus({ days: 2 }).toISODate() }).expect(400);
    await agent.post('/api/v1/insights/day/reopen').set('X-CSRF-Token', csrf).send({ date: yesterday, reason: 'Late correction' }).expect(200);
  });

  it('spots repeated lateness on the same weekday', async () => {
    const { agent } = await adminAgent(app);
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    // Three late Mondays and one late Tuesday in the last month.
    const lastMonday = DateTime.utc().startOf('week');
    const dates = [1, 2, 3].map((w) => lastMonday.minus({ weeks: w }).toISODate()!).concat(lastMonday.minus({ weeks: 1 }).plus({ days: 1 }).toISODate()!);
    for (const d of dates) {
      await q(
        `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, shift_date, idempotency_key, radius_m_at_record, verification_status, is_late, late_by_minutes)
         VALUES ($1,$2,$3,$4,$5,30,'VERIFIED',true,20)`,
        [emp.id, base.workplaceId, base.shiftId, d, `late-${crypto.randomUUID()}`],
      );
    }
    const items = (await agent.get('/api/v1/insights/attention?days=30').expect(200)).body.items;
    const me = items.find((i: any) => i.employeeId === emp.id);
    expect(me.notes.find((n: any) => n.kind === 'late').text).toBe('late 4 times, mostly on Mondays');
  });
});

describe('daily summaries', () => {
  it('sends each slot once, at the right local time, and the monthly report on the 1st', async () => {
    const { senders, sweepDigests } = await import('../src/modules/digest/digest.js');
    const sent: Array<{ ch: string; to: unknown; body: string; files?: number }> = [];
    const original = { ...senders };
    senders.whatsapp = async (to, d) => (sent.push({ ch: 'wa', to, body: d.line }), 'sent');
    senders.email = async (to, subject, text, files = []) => (sent.push({ ch: 'mail', to, body: `${subject}\n${text}`, files: files.length }), 'sent');
    try {
      await saveSettingsSection(DEFAULT_ORG_ID, 'digest', { times: ['10:00'], whatsappNumbers: ['919800000001'], emailRecipients: ['accounts@test.local'], monthlyReport: true }, null);
      const day = DateTime.utc().set({ hour: 10, minute: 20, second: 0, millisecond: 0 });
      await sweepDigests(day.minus({ minutes: 30 }).toJSDate()); // before 10:00 — nothing
      expect(sent).toHaveLength(0);
      await sweepDigests(day.toJSDate());
      await sweepDigests(day.plus({ minutes: 5 }).toJSDate()); // same slot again — not resent
      expect(sent.filter((s) => s.ch === 'wa')).toHaveLength(1);
      expect(sent.find((s) => s.ch === 'wa')!.body).toMatch(/^Present \d+\/\d+/);
      expect(sent.find((s) => s.ch === 'mail')!.body).toContain('Open the dashboard');

      // Too late (server down all day): skipped rather than sent hours afterwards.
      sent.length = 0;
      await sweepDigests(day.plus({ days: 1, hours: 6 }).toJSDate());
      expect(sent).toHaveLength(0);

      // Monthly report e-mail with the CSV attached, once.
      const first = DateTime.utc().plus({ months: 1 }).startOf('month').set({ hour: 9, minute: 30 });
      await sweepDigests(first.toJSDate());
      await sweepDigests(first.plus({ minutes: 10 }).toJSDate());
      const monthly = sent.filter((s) => s.ch === 'mail' && s.body.includes('attendance for'));
      expect(monthly).toHaveLength(1);
      expect(monthly[0]!.files).toBe(1);

      const { agent, csrf } = await adminAgent(app);
      const preview = (await agent.get('/api/v1/digest').expect(200)).body;
      expect(preview.preview.line).toMatch(/Present|No shifts/);
      const test = (await agent.post('/api/v1/digest/test').set('X-CSRF-Token', csrf).send({}).expect(200)).body;
      expect(test.results['whatsapp:919800000001']).toBe('sent');
    } finally {
      Object.assign(senders, original);
      await saveSettingsSection(DEFAULT_ORG_ID, 'digest', { times: ['10:00', '19:00'], whatsappNumbers: [], emailRecipients: [], monthlyReport: true }, null);
    }
  });
});

describe('face check', () => {
  // A stand-in for the model: byte 4 of the JPEG is "who" is in it, byte 5 how many faces.
  const faceJpeg = (person: number, faces = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, person, faces]), crypto.randomBytes(2048)]);
  async function withFakeEngine<T>(fn: () => Promise<T>) {
    const { faceEngine } = await import('../src/modules/faces/engine.js');
    const original = { ...faceEngine };
    faceEngine.enabled = () => true;
    faceEngine.read = async (b: Buffer) => ({ faces: b[5]!, embedding: b[5] === 1 ? [b[4]!, 1] : null, score: 0.99, real: null, live: null });
    faceEngine.similarity = async (a: number[], b: number[]) => (a[0] === b[0] ? 0.9 : 0.1);
    try {
      return await fn();
    } finally {
      Object.assign(faceEngine, original);
    }
  }
  async function enroll(token: string, person: number, overrides: Record<number, Buffer> = {}) {
    const photos = [];
    for (const [i, pose] of ['FRONT', 'LEFT', 'RIGHT', 'UP', 'DOWN'].entries()) {
      const img = overrides[i] ?? faceJpeg(person);
      const slot = await request(app).post('/api/v1/faces/me/photos').set(bearer(token)).send({ pose, contentType: 'image/jpeg', sizeBytes: img.length });
      if (slot.status !== 201) return slot; // e.g. 409 once already enrolled
      const u = new URL(slot.body.upload.url);
      await request(app).put(u.pathname + u.search).set('Content-Type', 'image/jpeg').send(img).expect(201);
      photos.push({ pose, photoId: slot.body.photoId });
    }
    return request(app).post('/api/v1/faces/me/enroll').set(bearer(token)).send({ photos });
  }

  it('enrolls five photos of one person once, and requires it before the first shift', async () => {
    await withFakeEngine(async () => {
      const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
      const token = await mobileLogin(app, emp.email);
      await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, deviceBinding: 'OFF', faceEnrollment: 'REQUIRED' }, null);
      try {
        const blocked = await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: base.shiftId }).expect(412);
        expect(blocked.body.error.code).toBe('FACE_ENROLLMENT_REQUIRED');
        expect((await request(app).get('/api/v1/me/assignment').set(bearer(token)).expect(200)).body.faceEnrollment).toEqual({ required: true, enrolled: false });

        const other = await enroll(token, 7, { 3: faceJpeg(8) });
        expect(other.status).toBe(422);
        expect(other.body.error).toMatchObject({ code: 'NOT_SAME_PERSON', details: { pose: 'UP' } });
        const none = await enroll(token, 7, { 0: faceJpeg(7, 0) });
        expect(none.body.error.code).toBe('NO_FACE');
        const two = await enroll(token, 7, { 1: faceJpeg(7, 2) });
        expect(two.body.error.code).toBe('MORE_THAN_ONE_FACE');

        const ok = await enroll(token, 7);
        expect(ok.status).toBe(200);
        expect(ok.body.enrolled).toBe(true);
        expect((await enroll(token, 7)).status).toBe(409); // already enrolled: an admin must reset first
        const profile = (await q('SELECT photo_ids, embeddings FROM employee_face_profiles WHERE employee_id = $1', [emp.id]))[0];
        expect(profile.photo_ids).toHaveLength(5);
        expect(profile.embeddings).toHaveLength(5);
        expect((await q(`SELECT DISTINCT status, retention_until FROM attendance_photos WHERE id = ANY($1::uuid[])`, [profile.photo_ids]))).toEqual([{ status: 'ATTACHED', retention_until: null }]);

        await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: base.shiftId }).expect(201);

        const { agent, csrf } = await adminAgent(app);
        const view = await agent.get(`/api/v1/faces/employees/${emp.id}`).expect(200);
        expect(view.body.photos.map((p: any) => p.pose)).toEqual(['FRONT', 'LEFT', 'RIGHT', 'UP', 'DOWN']);
        await agent.post(`/api/v1/faces/employees/${emp.id}/reset`).set('X-CSRF-Token', csrf).send({ reason: 'Photos were blurry' }).expect(200);
        expect((await request(app).get('/api/v1/faces/me').set(bearer(token)).expect(200)).body.enrolled).toBe(false);
      } finally {
        await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, deviceBinding: 'OFF', faceEnrollment: 'OFF' }, null);
      }
    });
  });

  it('keeps matching shift photos, holds a mismatch for review, and a rejection marks absent', async () => {
    await withFakeEngine(async () => {
      const faces = await import('../src/modules/faces/faces.js');
      const { writeLocalObject } = await import('../src/lib/storage.js');
      const { config } = await import('../src/config.js');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const emp = await createEmployee({ workplaceId: base.workplaceId });
      const token = await mobileLogin(app, emp.email);
      expect((await enroll(token, 3)).status).toBe(200);

      const session = (
        await q(
          `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, ended_at)
           VALUES ($1,$2,$3,CURRENT_DATE - 1, now() - interval '1 day', now() - interval '16 hours','SHIFT_COMPLETED', now() - interval '16 hours') RETURNING id`,
          [emp.id, base.shiftId, base.workplaceId],
        )
      )[0].id;
      const photo = async (img: Buffer, purpose: string) => {
        const key = `faces/${crypto.randomUUID()}.jpg`;
        await writeLocalObject(key, img);
        return {
          key,
          id: (await q(`INSERT INTO attendance_photos (employee_id, session_id, object_key, content_type, declared_bytes, idempotency_key, upload_expires_at, status, purpose)
                        VALUES ($1, $3, $2, 'image/jpeg', 100, $2, now(), 'ATTACHED', $4) RETURNING id`, [emp.id, key, session, purpose]))[0].id as string,
        };
      };
      const start = await photo(faceJpeg(3), 'ATTENDANCE'); // the enrolled person
      const end = await photo(faceJpeg(9), 'SHIFT_END'); // someone else
      const rec = (await q(`INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, photo_id, end_photo_id)
                            VALUES ($1,$2,$3,$4,CURRENT_DATE - 1,$5,30,'VERIFIED',$6,$7) RETURNING id`, [emp.id, base.workplaceId, base.shiftId, session, `f-${crypto.randomUUID()}`, start.id, end.id]))[0].id;

      await faces.sweepFaceChecks(50);
      const r = (await q('SELECT face_status, face_score, end_face_status, end_face_score, face_review, risk_flags FROM attendance_records WHERE id = $1', [rec]))[0];
      expect(r).toMatchObject({ face_status: 'MATCH', face_score: 90, end_face_status: 'MISMATCH', end_face_score: 10, face_review: 'PENDING' });
      expect(r.risk_flags).toContain('FACE_MISMATCH');
      // Both photos are kept as evidence by default (until the retention period ends).
      expect((await q('SELECT status FROM attendance_photos WHERE id = $1', [start.id]))[0].status).toBe('ATTACHED');
      expect(fs.existsSync(path.join(config.storage.localDir, start.key))).toBe(true);
      expect(fs.existsSync(path.join(config.storage.localDir, end.key))).toBe(true);
      expect(await q(`SELECT 1 FROM notifications WHERE type = 'FACE_MISMATCH' AND employee_id = $1`, [emp.id])).toHaveLength(1);

      const { agent, csrf } = await adminAgent(app);
      const list = await agent.get('/api/v1/faces/reviews').expect(200);
      expect(list.body.find((x: any) => x.id === rec)).toMatchObject({ has_start_photo: true, has_end_photo: true });
      const links = await agent.post(`/api/v1/faces/reviews/${rec}/photos`).set('X-CSRF-Token', csrf).send({}).expect(200);
      expect(links.body.end).toBeTruthy();
      expect(links.body.enrolled).toBeTruthy();
      await agent.post(`/api/v1/faces/reviews/${rec}`).set('X-CSRF-Token', csrf).send({ decision: 'REJECT' }).expect(400); // a reason is required
      await agent.post(`/api/v1/faces/reviews/${rec}`).set('X-CSRF-Token', csrf).send({ decision: 'REJECT', note: 'Different person at shift end' }).expect(200);
      const after = (await q('SELECT verification_status, face_review FROM attendance_records WHERE id = $1', [rec]))[0];
      expect(after).toEqual({ verification_status: 'VOIDED', face_review: 'REJECTED' });
      await agent.post(`/api/v1/faces/reviews/${rec}`).set('X-CSRF-Token', csrf).send({ decision: 'APPROVE' }).expect(409);
    });
  });

  it('shows a liveness instruction only once attendance unlocks, and keeps it with the record', async () => {
    const { challengeFor, CHALLENGES } = await import('../src/modules/faces/faces.js');
    const c = challengeFor(crypto.randomUUID());
    expect(CHALLENGES).toContainEqual(c);
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const token = await mobileLogin(app, emp.email);
    const start = await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: base.shiftId }).expect(201);
    expect(start.body.attendanceChallenge).toBeNull();
  });
});

describe('tasks with photo proof', () => {
  it('assigns, completes with a photo and location, sends back, and approves', async () => {
    const { agent, csrf } = await adminAgent(app);
    const a = await createEmployee({ workplaceId: base.workplaceId });
    const b = await createEmployee({ workplaceId: base.workplaceId });
    const created = (await agent.post('/api/v1/tasks').set('X-CSRF-Token', csrf).send({ assigneeIds: [a.id, b.id], title: 'Clean floor 2', dueDate: today() }).expect(201)).body;
    expect(created.created).toBe(2);
    expect(await q(`SELECT 1 FROM notifications WHERE type = 'TASK_ASSIGNED' AND employee_id = ANY($1::uuid[])`, [[a.id, b.id]])).toHaveLength(2);

    const token = await mobileLogin(app, a.email);
    const mine = (await request(app).get('/api/v1/tasks/mine').set(bearer(token)).expect(200)).body;
    const task = mine[0];
    expect(task.title).toBe('Clean floor 2');
    // A photo is required.
    expect((await request(app).post(`/api/v1/tasks/mine/${task.id}/done`).set(bearer(token)).send({ note: 'Done' }).expect(400)).body.error.code).toBe('PHOTO_REQUIRED');
    // Someone else cannot complete it.
    await request(app).post(`/api/v1/tasks/mine/${task.id}/done`).set(bearer(await mobileLogin(app, b.email))).send({}).expect(404);

    const img = fakeJpeg();
    const slot = (await request(app).post(`/api/v1/tasks/mine/${task.id}/photo`).set(bearer(token)).send({ contentType: 'image/jpeg', sizeBytes: img.length }).expect(200)).body;
    const u = new URL(slot.upload.url);
    await request(app).put(u.pathname + u.search).set('Content-Type', 'image/jpeg').send(img).expect(201);
    const done = (await request(app).post(`/api/v1/tasks/mine/${task.id}/done`).set(bearer(token)).send({ note: 'All clean', photoId: slot.photoId, location: { latitude: 12.97, longitude: 77.59, accuracyM: 8 } }).expect(200)).body;
    expect(done.status).toBe('SUBMITTED');
    expect(done.photo_id).toBe(slot.photoId);

    const url = (await agent.post(`/api/v1/tasks/${task.id}/photo-url`).set('X-CSRF-Token', csrf).send({}).expect(200)).body.url;
    expect(url).toContain('token=');
    await agent.post(`/api/v1/tasks/${task.id}/review`).set('X-CSRF-Token', csrf).send({ decision: 'REOPENED' }).expect(400); // needs a note
    const back = (await agent.post(`/api/v1/tasks/${task.id}/review`).set('X-CSRF-Token', csrf).send({ decision: 'REOPENED', note: 'Corner missed' }).expect(200)).body;
    expect(back.status).toBe('REOPENED');
    const slot2 = (await request(app).post(`/api/v1/tasks/mine/${task.id}/photo`).set(bearer(token)).send({ contentType: 'image/jpeg', sizeBytes: img.length }).expect(200)).body;
    const u2 = new URL(slot2.upload.url);
    await request(app).put(u2.pathname + u2.search).set('Content-Type', 'image/jpeg').send(fakeJpeg()).expect(201);
    await request(app).post(`/api/v1/tasks/mine/${task.id}/done`).set(bearer(token)).send({ photoId: slot2.photoId }).expect(200);
    expect((await agent.post(`/api/v1/tasks/${task.id}/review`).set('X-CSRF-Token', csrf).send({ decision: 'APPROVED' }).expect(200)).body.status).toBe('APPROVED');
    await request(app).post(`/api/v1/tasks/mine/${task.id}/done`).set(bearer(token)).send({}).expect(409); // closed
  });
});

describe('SOS and broadcasts', () => {
  it('raises a critical alert with the location, updates it on a second press, and lets an admin acknowledge and close it', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await mobileLogin(app, emp.email);
    const first = (await request(app).post('/api/v1/sos/mine').set(bearer(token)).send({ location: { latitude: 12.97, longitude: 77.59, accuracyM: 12 }, message: 'Car broke down' }).expect(200)).body;
    const again = (await request(app).post('/api/v1/sos/mine').set(bearer(token)).send({ location: { latitude: 12.98, longitude: 77.6, accuracyM: 9 } }).expect(200)).body;
    expect(again.id).toBe(first.id); // updated, not duplicated
    const n = await q(`SELECT severity, body FROM notifications WHERE type = 'SOS' AND employee_id = $1 AND audience = 'ADMIN'`, [emp.id]);
    expect(n).toHaveLength(1);
    expect(n[0].severity).toBe('CRITICAL');
    expect(n[0].body).toContain('google.com/maps?q=12.97,77.59');

    const { agent, csrf } = await adminAgent(app);
    const open = (await agent.get('/api/v1/sos?open=true').expect(200)).body;
    expect(open.find((s: any) => s.id === first.id).latitude).toBe(12.98);
    await agent.post(`/api/v1/sos/${first.id}/acknowledge`).set('X-CSRF-Token', csrf).send({}).expect(200);
    expect((await request(app).get('/api/v1/sos/mine').set(bearer(token)).expect(200)).body.status).toBe('ACKNOWLEDGED');
    await agent.post(`/api/v1/sos/${first.id}/resolve`).set('X-CSRF-Token', csrf).send({ note: 'Sent the van' }).expect(200);
    expect((await request(app).get('/api/v1/sos/mine').set(bearer(token)).expect(200)).body).toBeNull();
  });

  it('sends a message to one workplace and tracks who read it', async () => {
    const { agent, csrf } = await adminAgent(app);
    const a = await createEmployee({ workplaceId: base.workplaceId });
    const b = await createEmployee({ workplaceId: base.workplaceId });
    const sent = (await agent.post('/api/v1/broadcasts').set('X-CSRF-Token', csrf).send({ title: 'Closed tomorrow', body: 'The site is closed for maintenance.', workplaceId: base.workplaceId }).expect(201)).body;
    expect(sent.recipients).toBeGreaterThanOrEqual(2);
    const ta = await mobileLogin(app, a.email);
    const inbox = (await request(app).get('/api/v1/broadcasts/mine').set(bearer(ta)).expect(200)).body;
    expect(inbox[0].title).toBe('Closed tomorrow');
    await request(app).post(`/api/v1/broadcasts/mine/${sent.id}/read`).set(bearer(ta)).expect(200);
    const reads = (await agent.get(`/api/v1/broadcasts/${sent.id}/reads`).expect(200)).body;
    expect(reads.find((r: any) => r.employee_id === a.id).read_at).not.toBeNull();
    expect(reads.find((r: any) => r.employee_id === b.id).read_at).toBeNull();
    expect((await agent.get('/api/v1/broadcasts').expect(200)).body.find((x: any) => x.id === sent.id).read_count).toBe(1);
  });
});

describe('holidays', () => {
  it('marks the roster, skips no-show alerts, and shows employees upcoming holidays', async () => {
    const { agent, csrf } = await adminAgent(app);
    const h = await agent.post('/api/v1/holidays').set('X-CSRF-Token', csrf).send({ date: today(), name: 'Test Festival', workplaceId: base.workplaceId }).expect(201);
    await agent.post('/api/v1/holidays').set('X-CSRF-Token', csrf).send({ date: today(), name: 'Again', workplaceId: base.workplaceId }).expect(409);
    try {
      const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
      await sweepNoShows(DateTime.utc().set({ hour: 12 }).toJSDate());
      expect(await q(`SELECT 1 FROM notifications WHERE type = 'NO_SHOW' AND employee_id = $1`, [emp.id])).toHaveLength(0);
      const row = (await agent.get(`/api/v1/reports/overview?date=${today()}`).expect(200)).body.roster.find((r: any) => r.employee_id === emp.id);
      expect(row.holiday).toBe('Test Festival');
      expect(row.no_show).toBe(false);
      const token = await mobileLogin(app, emp.email);
      const me = (await request(app).get('/api/v1/me/assignment').set(bearer(token)).expect(200)).body;
      expect(me.holidays[0].name).toBe('Test Festival');
      expect((await agent.post('/api/v1/holidays/national').set('X-CSRF-Token', csrf).send({ year: 2031 }).expect(200)).body.added).toBe(3);
    } finally {
      await agent.delete(`/api/v1/holidays/${h.body.id}`).set('X-CSRF-Token', csrf).expect(204);
    }
  });
});
