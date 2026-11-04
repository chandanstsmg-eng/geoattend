/**
 * Regression tests for the Phase 1 audit's payroll and attendance findings: each reproduces a defect
 * through the API. Payroll is on here (vitest.config.ts) except in the block that switches it off.
 */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { config } from '../src/config.js';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { endSession } from '../src/modules/tracking/tracking.service.js';
import { calculatePay } from '../src/modules/payroll/calc.js';
import { DEFAULT_SETTINGS, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { adminAgent, createEmployee, createTestDatabase, mobileLogin, seedBase } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
let owner: Awaited<ReturnType<typeof adminAgent>>;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
  owner = await adminAgent(app);
});
afterAll(async () => {
  await db.drop();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const post = (path: string, body: object = {}) => owner.agent.post(`/api/v1${path}`).set('X-CSRF-Token', owner.csrf).send(body);
const patch = (path: string, body: object) => owner.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', owner.csrf).send(body);
const put = (path: string, body: object) => owner.agent.put(`/api/v1${path}`).set('X-CSRF-Token', owner.csrf).send(body);
const get = (path: string) => owner.agent.get(`/api/v1${path}`);

const monthsAgo = (n: number) => DateTime.utc().startOf('month').minus({ months: n });
const ym = (d: DateTime) => d.toFormat('yyyy-MM');

async function newShift(days = [1, 2, 3, 4, 5, 6, 7], start = '09:00', end = '17:00') {
  const s = await one(
    `INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1, $2, $3, $4, 'UTC', $5, 10) RETURNING id`,
    [base.workplaceId, `Shift ${crypto.randomUUID().slice(0, 6)}`, start, end, days],
  );
  return s.id as string;
}
/** Rostered on the shift from `from` to `to`. */
async function assign(employeeId: string, shiftId: string, from: string, to: string | null = null) {
  await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, effective_to) VALUES ($1,$2,$3,$4)`, [employeeId, shiftId, from, to]);
}
/** A finished shift with attendance. */
async function attended(employeeId: string, shiftId: string, date: string, arrived = '09:00', ended = '17:00') {
  const at = (t: string) => `${date}T${t}:00Z`;
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, ended_at, authorization_status)
     VALUES ($1,$2,$3,$4,$5,$6,'SHIFT_COMPLETED',$5,$7,'ENDED') RETURNING id`,
    [employeeId, shiftId, base.workplaceId, date, at('09:00'), at('17:00'), at(ended)],
  );
  const r = await one(
    `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,30,'VERIFIED',$7) RETURNING id`,
    [employeeId, base.workplaceId, shiftId, s.id, date, crypto.randomUUID(), at(arrived)],
  );
  return { sessionId: s.id as string, attendanceId: r.id as string };
}
async function closeDays(month: DateTime) {
  await q(
    `INSERT INTO day_closes (org_id, close_date, closed_by, summary) SELECT $1, d::date, $2, '{"test":true}' FROM generate_series($3::date, $4::date, interval '1 day') d ON CONFLICT DO NOTHING`,
    [DEFAULT_ORG_ID, base.adminId, month.toISODate(), month.endOf('month').toISODate()],
  );
}
const monthRow = async (month: DateTime, employeeId: string) => (await get(`/reports/monthly?month=${ym(month)}`).expect(200)).body.rows.find((r: any) => r.employee_id === employeeId);
const payRow = async (month: DateTime, employeeId: string) => (await get(`/payroll/${ym(month)}`).expect(200)).body.rows.find((r: any) => r.employee.id === employeeId);

describe('payroll switched off', () => {
  const month = ym(monthsAgo(9));
  let emp: { id: string; email: string };
  let slipId: string;
  beforeAll(async () => {
    emp = await createEmployee({ workplaceId: base.workplaceId });
    const run = await one(`INSERT INTO payroll_runs (org_id, month, status, total_net, employees) VALUES ($1,$2,'PAID',10000,1) RETURNING id`, [DEFAULT_ORG_ID, month]);
    const slip = await one(`INSERT INTO payslips (run_id, employee_id, month, net_amount, data) VALUES ($1,$2,$3,10000,'{"employee":{"fullName":"X"}}') RETURNING id`, [run.id, emp.id, month]);
    slipId = slip.id;
    config.payrollEnabled = false;
  });
  afterAll(() => {
    config.payrollEnabled = true;
  });

  it('refuses every action that approves, calculates or exports pay, on the server', async () => {
    const live = ym(monthsAgo(10));
    const calls = [
      post(`/payroll/${live}/approve`), post(`/payroll/${month}/paid`), post(`/payroll/${month}/reopen`, { reason: 'Not allowed now' }),
      get(`/payroll/${live}`), get(`/payroll/${month}/salary.csv`),
      put(`/payroll/pay/${emp.id}`, { payType: 'MONTHLY', amount: 1000 }), post('/payroll/adjustments', { employeeId: emp.id, month: live, kind: 'BONUS', amount: 1 }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PAYROLL_DISABLED');
    }
  });

  it('shows employees no pay figures, and tells the interface it is off', async () => {
    const token = await mobileLogin(app, emp.email);
    const mine = (await request(app).get('/api/v1/me/earnings').set(bearer(token)).expect(200)).body;
    expect(mine.estimate).toBeNull();
    expect(mine.payslips).toEqual([]);
    await request(app).get(`/api/v1/me/payslips/${slipId}`).set(bearer(token)).expect(403);
    expect((await get('/auth/me').expect(200)).body.features.payroll).toBe(false);
  });

  it('keeps existing payroll records, and leaves attendance and hours reports working', async () => {
    expect(await q(`SELECT 1 FROM payslips WHERE id = $1`, [slipId])).toHaveLength(1);
    expect((await get(`/payroll/${month}`).expect(200)).body.run.status).toBe('PAID');
    await get(`/reports/monthly?month=${month}`).expect(200);
    await get(`/reports/hours.csv?from=${monthsAgo(1).toISODate()}&to=${monthsAgo(1).endOf('month').toISODate()}`).expect(200);
  });
});

describe('approving a month', () => {
  it('refuses a month that has not ended', async () => {
    const res = await post(`/payroll/${ym(DateTime.utc())}/approve`).expect(409);
    expect(res.body.error.code).toBe('MONTH_NOT_ENDED');
  });

  it('still refuses while rostered days are unconfirmed', async () => {
    const month = monthsAgo(8);
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    await assign(emp.id, await newShift(), month.toISODate()!, month.plus({ days: 2 }).toISODate()!);
    await put(`/payroll/pay/${emp.id}`, { payType: 'MONTHLY', amount: 30000 }).expect(200);
    expect((await post(`/payroll/${ym(month)}/approve`).expect(409)).body.error.code).toBe('DAYS_UNCONFIRMED');
  });
});

describe('employment dates', () => {
  it('prorates someone joining mid-month and ignores days before they joined', async () => {
    const month = monthsAgo(1);
    const joined = month.plus({ days: 15 });
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    await patch(`/employees/${emp.id}`, { joinedOn: joined.toISODate() }).expect(200);
    await assign(emp.id, await newShift(), month.toISODate()!); // rostered from the 1st by mistake
    await put(`/payroll/pay/${emp.id}`, { payType: 'MONTHLY', amount: 31000 }).expect(200);
    for (let d = joined; d <= month.endOf('month'); d = d.plus({ days: 1 })) await attended(emp.id, (await q(`SELECT shift_id FROM employee_shift_assignments WHERE employee_id = $1`, [emp.id]))[0].shift_id, d.toISODate()!);
    const row = await payRow(month, emp.id);
    const employed = month.daysInMonth! - 15;
    expect(row.attendance.employedDays).toBe(employed);
    expect(row.attendance.absent).toBe(0);
    expect(row.result.basic).toBeCloseTo((31000 / month.daysInMonth!) * employed, 1);
  });

  it('keeps a leaver in the months they worked, after deactivation', async () => {
    const month = monthsAgo(2);
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const shift = await newShift();
    await assign(emp.id, shift, month.toISODate()!);
    await put(`/payroll/pay/${emp.id}`, { payType: 'MONTHLY', amount: 30000 }).expect(200);
    const lastDay = month.plus({ days: 9 });
    for (let d = month; d <= lastDay; d = d.plus({ days: 1 })) await attended(emp.id, shift, d.toISODate()!);
    await post(`/employees/${emp.id}/deactivate`, { reason: 'Resigned', lastWorkingDay: lastDay.toISODate() }).expect(200);

    const row = await monthRow(month, emp.id);
    expect(row.present).toBe(10);
    expect(row.absent).toBe(0); // the days after leaving are not absences
    const pay = await payRow(month, emp.id);
    expect(pay.attendance.employedDays).toBe(10);
    expect(pay.result.basic).toBeCloseTo((30000 / month.daysInMonth!) * 10, 1);
    expect(await monthRow(monthsAgo(0), emp.id)).toBeUndefined();
  });

  it('does not turn the day of leaving into a no-show, and clears the date on reactivation', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    await post(`/employees/${emp.id}/deactivate`, { reason: 'Left today' }).expect(200);
    const left = await one(`SELECT left_on FROM employee_profiles WHERE user_id = $1`, [emp.id]);
    expect(left.left_on).toBe(DateTime.utc().minus({ days: 1 }).toISODate());
    await post(`/employees/${emp.id}/reactivate`).expect(200);
    expect((await one(`SELECT left_on FROM employee_profiles WHERE user_id = $1`, [emp.id])).left_on).toBeNull();
  });

  it('rejects a last working day before the joining date', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    expect((await patch(`/employees/${emp.id}`, { joinedOn: '2026-02-10', leftOn: '2026-02-01' }).expect(400)).body.error.code).toBe('BAD_DATES');
  });

  it('calculates a partial month', () => {
    const a = { daysInMonth: 30, employedDays: 15, scheduled: 0, present: 0, paidLeave: 0, unpaidLeave: 0, holidays: 0, absent: 2, workedMinutes: 0, overtimeMinutes: 0 };
    const r = calculatePay({ payType: 'MONTHLY', amount: 30000, otMultiplier: 1, hoursPerDay: 8 }, a, { advance: 0, bonus: 0, allowance: 0, deduction: 0 });
    expect(r).toMatchObject({ basic: 15000, lossOfPay: 2000, payableDays: 13, net: 13000 });
  });
});

describe('editing shifts and workspaces', () => {
  it('does not change past days when a shift is edited or disabled', async () => {
    const month = monthsAgo(1);
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const shift = await newShift();
    await assign(emp.id, shift, month.toISODate()!, month.endOf('month').toISODate()!);
    const { attendanceId } = await attended(emp.id, shift, month.toISODate()!);
    const before = await monthRow(month, emp.id);
    const record = await one(`SELECT recorded_at, is_late FROM attendance_records WHERE id = $1`, [attendanceId]);

    await patch(`/shifts/${shift}`, { daysOfWeek: [1], startTime: '13:00', endTime: '21:00' }).expect(200);
    expect(await monthRow(month, emp.id)).toEqual(before);
    await patch(`/shifts/${shift}`, { isActive: false }).expect(200); // second edit the same day: one revision
    expect(await monthRow(month, emp.id)).toEqual(before);

    expect(await one(`SELECT recorded_at, is_late FROM attendance_records WHERE id = $1`, [attendanceId])).toEqual(record);
    expect((await one(`SELECT scheduled_minutes FROM attendance_work WHERE attendance_id = $1`, [attendanceId])).scheduled_minutes).toBe(480);
    expect(await q(`SELECT 1 FROM shift_revisions WHERE shift_id = $1`, [shift])).toHaveLength(1);
  });

  it('keeps a successive revision chain', async () => {
    const shift = await newShift([1, 2, 3, 4, 5]);
    await q(`INSERT INTO shift_revisions (shift_id, valid_to, start_time, end_time, timezone, days_of_week, arrival_grace_minutes, is_active) SELECT id, $2::date, start_time, end_time, timezone, days_of_week, arrival_grace_minutes, is_active FROM shifts WHERE id = $1`, [shift, monthsAgo(3).toISODate()]);
    await patch(`/shifts/${shift}`, { startTime: '10:00' }).expect(200);
    const rows = await q(`SELECT to_char(valid_from, 'YYYY-MM-DD') AS valid_from FROM shift_revisions WHERE shift_id = $1 ORDER BY valid_to`, [shift]);
    expect(rows[1].valid_from).toBe(monthsAgo(3).plus({ days: 1 }).toISODate());
  });

  it('does not change past days when a workspace is disabled', async () => {
    const month = monthsAgo(1);
    const wp = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, absence_threshold_minutes, org_id) VALUES ('Closing', 12.9, 77.5, 100, 'UTC', 5, $1) RETURNING id`, [DEFAULT_ORG_ID]);
    const shift = await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week) VALUES ($1,'S','09:00','17:00','UTC','{1,2,3,4,5,6,7}') RETURNING id`, [wp.id]);
    const emp = await createEmployee({ workplaceId: wp.id });
    await assign(emp.id, shift.id, month.toISODate()!, month.endOf('month').toISODate()!);
    const before = await monthRow(month, emp.id);
    expect(before.scheduled).toBe(month.daysInMonth);
    await q(`UPDATE workplaces SET is_active = false, deactivated_on = CURRENT_DATE WHERE id = $1`, [wp.id]);
    expect(await monthRow(month, emp.id)).toEqual(before);
  });
});

describe('two shifts on one date', () => {
  it('counts one absent day, and pays a day once', async () => {
    const month = monthsAgo(1);
    const day = month.toISODate()!;
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const [a, b] = [await newShift(), await newShift()];
    await assign(emp.id, a, day, day);
    await assign(emp.id, b, day, day);
    const row = await monthRow(month, emp.id);
    expect(row).toMatchObject({ scheduled: 1, absent: 1, present: 0 });
  });

  it('is present, not half-absent, when one of the two was attended', async () => {
    const month = monthsAgo(1);
    const day = month.plus({ days: 1 }).toISODate()!;
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const [a, b] = [await newShift(), await newShift()];
    await assign(emp.id, a, day, day);
    await assign(emp.id, b, day, day);
    await attended(emp.id, a, day);
    await put(`/payroll/pay/${emp.id}`, { payType: 'DAILY', amount: 800 }).expect(200);
    expect(await monthRow(month, emp.id)).toMatchObject({ scheduled: 1, present: 1, absent: 0, missed_shifts: 1 });
    expect((await payRow(month, emp.id)).result.basic).toBe(800);
  });
});

describe('payroll revisions', () => {
  const month = monthsAgo(5);
  it('keeps a reopened run and its payslips, and numbers the next approval', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    await put(`/payroll/pay/${emp.id}`, { payType: 'MONTHLY', amount: 20000 }).expect(200);
    await closeDays(month);
    const first = (await post(`/payroll/${ym(month)}/approve`).expect(200)).body;
    await post(`/payroll/${ym(month)}/paid`).expect(200);
    expect((await post(`/payroll/${ym(month)}/paid`).expect(409)).body.error.code).toBe('ALREADY_PAID');
    const slips = await q(`SELECT id, net_amount FROM payslips WHERE run_id = $1`, [first.id]);
    expect(slips.length).toBeGreaterThan(0);

    await post(`/payroll/${ym(month)}/reopen`, { reason: 'Salary entered wrongly' }).expect(200);
    expect(await q(`SELECT id, net_amount FROM payslips WHERE run_id = $1`, [first.id])).toEqual(slips);
    expect((await get(`/payroll/${ym(month)}`).expect(200)).body.run).toBeNull();

    const second = (await post(`/payroll/${ym(month)}/approve`).expect(200)).body;
    expect(second.revision).toBe(2);
    const history = (await get(`/payroll/${ym(month)}/history`).expect(200)).body;
    expect(history.map((h: any) => [h.revision, h.status, h.supersede_reason])).toEqual([[2, 'APPROVED', null], [1, 'PAID', 'Salary entered wrongly']]);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'payroll.reopen' AND resource_id = $1`, [first.id])).toHaveLength(1);
  });

  it('shows the employee only the current revision', async () => {
    const emp = await one(`SELECT u.email, u.id FROM payslips p JOIN users u ON u.id = p.employee_id JOIN payroll_runs r ON r.id = p.run_id WHERE r.month = $1 AND r.revision = 2 LIMIT 1`, [ym(month)]);
    const mine = (await request(app).get('/api/v1/me/earnings').set(bearer(await mobileLogin(app, emp.email))).expect(200)).body;
    expect(mine.payslips.filter((p: any) => p.month === ym(month))).toHaveLength(1);
  });

  it('cannot be deleted, even directly in the database', async () => {
    await expect(q(`DELETE FROM payslips WHERE month = $1`, [ym(month)])).rejects.toThrow(/cannot be deleted/);
    await expect(q(`DELETE FROM payroll_runs WHERE month = $1`, [ym(month)])).rejects.toThrow(/cannot be deleted/);
  });

  it('allows only one current run per month', async () => {
    await expect(q(`INSERT INTO payroll_runs (org_id, month, status, total_net, employees, revision) VALUES ($1,$2,'APPROVED',1,1,9)`, [DEFAULT_ORG_ID, ym(month)])).rejects.toThrow(/payroll_runs_current_key/);
  });

  it('leaves simulated employees out of pay', async () => {
    const m = monthsAgo(1);
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    await q(`UPDATE users SET is_demo = true WHERE id = $1`, [emp.id]);
    await q(`INSERT INTO employee_pay (employee_id, pay_type, amount) VALUES ($1,'MONTHLY',5000)`, [emp.id]);
    expect(await payRow(m, emp.id)).toBeUndefined();
  });
});

describe('frozen months', () => {
  const month = monthsAgo(6);
  let attendanceId: string;
  let otId: string;
  let leaveId: string;
  beforeAll(async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const shift = await newShift();
    const day = month.plus({ days: 3 }).toISODate()!;
    const a = await attended(emp.id, shift, day);
    attendanceId = a.attendanceId;
    otId = (await one(
      `INSERT INTO overtime_entries (session_id, attendance_id, employee_id, workplace_id, shift_date, started_at, ended_at, end_reason, start_latitude, start_longitude, start_accuracy_m, start_distance_m)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'EMPLOYEE',0,0,5,0) RETURNING id`,
      [a.sessionId, a.attendanceId, emp.id, base.workplaceId, day, `${day}T17:00:00Z`, `${day}T18:00:00Z`],
    )).id;
    leaveId = (await one(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, requested_by) VALUES ($1,'CASUAL',$2,$2,'Family',$1) RETURNING id`, [emp.id, month.plus({ days: 5 }).toISODate()])).id;
    await q(`INSERT INTO payroll_runs (org_id, month, status, total_net, employees) VALUES ($1,$2,'APPROVED',0,0)`, [DEFAULT_ORG_ID, ym(month)]);
  });

  it('refuses attendance, overtime and leave changes behind approved payslips', async () => {
    for (const res of [
      await post(`/attendance/${attendanceId}/corrections`, { reason: 'Wrong time', recordedAt: `${month.plus({ days: 3 }).toISODate()}T09:30:00Z` }),
      await post(`/overtime/${otId}/decision`, { decision: 'APPROVE' }),
      await post(`/leave/${leaveId}/decide`, { decision: 'APPROVED' }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MONTH_LOCKED');
    }
  });

  it('does not block corrections while payroll is off, as a month could not then be reopened', async () => {
    config.payrollEnabled = false;
    try {
      await post(`/attendance/${attendanceId}/corrections`, { reason: 'Wrong time', isLate: false }).expect(200);
    } finally {
      config.payrollEnabled = true;
    }
  });
});

describe('manual attendance approval', () => {
  /** An open shift today in manual review, requested `requestedMinAgo` minutes ago. */
  async function reviewed(requestedMinAgo: number, startedMinAgo: number, hasLocation = true) {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const shift = await newShift();
    const now = DateTime.utc();
    const start = now.minus({ minutes: startedMinAgo });
    const s = await one(
      `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,'MANUAL_REVIEW_REQUIRED',$5) RETURNING id`,
      [emp.id, shift, base.workplaceId, start.toISODate(), start.toISO(), start.plus({ hours: 8 }).toISO()],
    );
    const r = await one(
      `INSERT INTO review_requests (kind, employee_id, session_id, reason, requested_by, before_data, created_at) VALUES ('MANUAL_REVIEW',$1,$2,'GPS will not settle',$1,$3,$4) RETURNING id, created_at`,
      [emp.id, s.id, JSON.stringify({ lastDistanceM: hasLocation ? 22 : null, lastAccuracyM: 40 }), now.minus({ minutes: requestedMinAgo }).toISO()],
    );
    return { sessionId: s.id as string, reviewId: r.id as string, requestedAt: new Date(r.created_at) };
  }

  it('uses the time of the request, and records the approval separately', async () => {
    // Arrived 5 minutes after the start (within grace); approved five hours later.
    const { reviewId, requestedAt } = await reviewed(295, 300);
    const res = await post(`/attendance/reviews/${reviewId}/resolve`, { decision: 'APPROVE', note: 'Seen on site' }).expect(200);
    const rec = await one(`SELECT * FROM attendance_records WHERE id = $1`, [res.body.attendanceId]);
    expect(new Date(rec.recorded_at)).toEqual(requestedAt);
    expect(rec.is_late).toBe(false);
    expect(rec.late_by_minutes).toBe(0);
    expect(rec.approved_by).toBe(base.adminId);
    expect(Date.now() - new Date(rec.approved_at).getTime()).toBeLessThan(10_000);
    expect(rec.risk_flags).toEqual(['MANUAL_REVIEW']);
    const log = await one(`SELECT after_data FROM audit_logs WHERE action = 'review.approve' AND resource_id = $1`, [reviewId]);
    expect(new Date(log.after_data.arrivalAt)).toEqual(requestedAt);
    expect(log.after_data.approvedAt).toBeTruthy();
    const work = await one(`SELECT worked_minutes FROM attendance_work WHERE attendance_id = $1`, [rec.id]);
    expect(work.worked_minutes).toBeGreaterThan(280); // not cut to the five minutes since approval
  });

  it('is late by the time of the request, not the approval', async () => {
    const { reviewId } = await reviewed(270, 300);
    const res = await post(`/attendance/reviews/${reviewId}/resolve`, { decision: 'APPROVE', note: 'Seen on site' }).expect(200);
    expect(await one(`SELECT is_late, late_by_minutes FROM attendance_records WHERE id = $1`, [res.body.attendanceId])).toEqual({ is_late: true, late_by_minutes: 30 });
  });

  it('flags a request with no location behind it', async () => {
    const { reviewId } = await reviewed(100, 120, false);
    const res = await post(`/attendance/reviews/${reviewId}/resolve`, { decision: 'APPROVE', note: 'Confirmed by phone' }).expect(200);
    expect((await one(`SELECT risk_flags FROM attendance_records WHERE id = $1`, [res.body.attendanceId])).risk_flags).toContain('ARRIVAL_TIME_UNVERIFIED');
  });

  it('survives the end of the shift, so an unanswered request is not an absence', async () => {
    const { reviewId, sessionId } = await reviewed(100, 120);
    await endSession(sessionId, { id: base.adminId, role: 'ADMIN', orgId: DEFAULT_ORG_ID } as any, 'ADMIN', 'test');
    expect((await one(`SELECT status FROM review_requests WHERE id = $1`, [reviewId])).status).toBe('OPEN');
    const res = await post(`/attendance/reviews/${reviewId}/resolve`, { decision: 'APPROVE', note: 'Late answer' }).expect(200);
    expect(res.body.attendanceId).toBeTruthy();
  });

  it('cannot be approved twice', async () => {
    const { reviewId } = await reviewed(30, 60);
    await post(`/attendance/reviews/${reviewId}/resolve`, { decision: 'APPROVE', note: 'Seen on site' }).expect(200);
    expect((await post(`/attendance/reviews/${reviewId}/resolve`, { decision: 'APPROVE', note: 'Again' }).expect(409)).body.error.code).toBe('REVIEW_CLOSED');
  });
});

describe('attendance corrections', () => {
  it('keeps the first recorded time and every step, and re-judges lateness', async () => {
    const day = monthsAgo(1).plus({ days: 6 }).toISODate()!;
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const shift = await newShift();
    await assign(emp.id, shift, day, day);
    const { attendanceId } = await attended(emp.id, shift, day, '09:05');
    await post(`/attendance/${attendanceId}/corrections`, { reason: 'Gate log says later', recordedAt: `${day}T09:40:00Z` }).expect(200);
    const once = await one(`SELECT * FROM attendance_records WHERE id = $1`, [attendanceId]);
    expect(once).toMatchObject({ is_late: true, late_by_minutes: 40 });
    expect(new Date(once.original_recorded_at).toISOString()).toBe(`${day}T09:05:00.000Z`);

    await post(`/attendance/${attendanceId}/corrections`, { reason: 'Second look at gate log', recordedAt: `${day}T09:08:00Z` }).expect(200);
    const twice = await one(`SELECT * FROM attendance_records WHERE id = $1`, [attendanceId]);
    expect(twice).toMatchObject({ is_late: false, late_by_minutes: 0 });
    expect(new Date(twice.original_recorded_at).toISOString()).toBe(`${day}T09:05:00.000Z`);

    const history = await q(`SELECT before_data, after_data FROM review_requests WHERE attendance_id = $1 AND kind = 'ADMIN_CORRECTION' ORDER BY created_at`, [attendanceId]);
    expect(history).toHaveLength(2);
    expect(new Date(history[0].before_data.recorded_at).toISOString()).toBe(`${day}T09:05:00.000Z`);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'attendance.correct' AND resource_id = $1`, [attendanceId])).toHaveLength(2);
  });

  it('respects a lateness set explicitly by the administrator', async () => {
    const day = monthsAgo(1).plus({ days: 7 }).toISODate()!;
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const shift = await newShift();
    const { attendanceId } = await attended(emp.id, shift, day);
    await post(`/attendance/${attendanceId}/corrections`, { reason: 'Excused delay', recordedAt: `${day}T10:00:00Z`, isLate: false, lateByMinutes: 0 }).expect(200);
    expect(await one(`SELECT is_late FROM attendance_records WHERE id = $1`, [attendanceId])).toEqual({ is_late: false });
  });
});

describe('manual attendance', () => {
  it('judges lateness and counts the hours entered', async () => {
    const month = monthsAgo(1);
    const day = month.plus({ days: 8 }).toISODate()!;
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const shift = await newShift();
    await assign(emp.id, shift, day, day);
    const rec = (await post('/attendance/manual', { employeeId: emp.id, shiftId: shift, shiftDate: day, recordedAt: `${day}T09:45:00Z`, workedMinutes: 420, reason: 'Phone was broken' }).expect(201)).body;
    expect(rec).toMatchObject({ is_late: true, late_by_minutes: 45, approved_by: base.adminId });
    expect((await monthRow(month, emp.id)).worked_minutes).toBe(420);
  });
});

describe('hours and overtime reporting', () => {
  afterEach(async () => {
    await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, deviceBinding: 'OFF', faceEnrollment: 'OFF' }, null);
  });

  it('gives the same hours in the monthly summary as in the hours report', async () => {
    const month = monthsAgo(1);
    await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, deviceBinding: 'OFF', faceEnrollment: 'OFF', roundingMinutes: 15, weeklyRegularHours: 16 }, null);
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const shift = await newShift();
    const monday = month.plus({ days: 7 }).startOf('week');
    for (let i = 0; i < 3; i++) {
      const d = monday.plus({ days: i }).toISODate()!;
      await assign(emp.id, shift, d, d);
      await attended(emp.id, shift, d, '09:07');
    }
    const from = monday.toISODate();
    const to = monday.plus({ days: 2 }).toISODate();
    const hours = (await get(`/reports/hours?from=${from}&to=${to}`).expect(200)).body.rows.find((r: any) => r.employee_id === emp.id);
    const row = await monthRow(monday, emp.id);
    expect(row.worked_minutes).toBe(hours.regular_minutes);
    expect(row.overtime_minutes).toBe(hours.overtime_minutes);
    expect(row.overtime_minutes).toBeGreaterThan(0); // the weekly rule applied
  });

  it('does not subtract time away before arrival', async () => {
    const day = monthsAgo(1).plus({ days: 10 }).toISODate()!;
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const shift = await newShift();
    const { sessionId, attendanceId } = await attended(emp.id, shift, day, '10:00');
    await q(
      `INSERT INTO absence_intervals (session_id, employee_id, workplace_id, started_at, ended_at, threshold_minutes, status) VALUES ($1,$2,$3,$4,$5,5,'RETURNED')`,
      [sessionId, emp.id, base.workplaceId, `${day}T09:10:00Z`, `${day}T09:40:00Z`],
    );
    expect((await one(`SELECT worked_minutes FROM attendance_work WHERE attendance_id = $1`, [attendanceId])).worked_minutes).toBe(420);
  });

  it('uses the company overtime rate as the default, with no statutory rate assumed', async () => {
    await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, deviceBinding: 'OFF', faceEnrollment: 'OFF', overtimeMultiplier: 1.5 }, null);
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    expect((await put(`/payroll/pay/${emp.id}`, { payType: 'MONTHLY', amount: 20000 }).expect(200)).body.ot_multiplier).toBe(1.5);
    expect((await put(`/payroll/pay/${emp.id}`, { payType: 'MONTHLY', amount: 20000, otMultiplier: 1.25 }).expect(200)).body.ot_multiplier).toBe(1.25);
    expect(DEFAULT_SETTINGS.workforce.overtimeMultiplier).toBe(1);
  });
});
