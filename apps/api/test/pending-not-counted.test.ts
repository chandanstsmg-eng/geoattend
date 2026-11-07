/**
 * A record sent late from a phone is history, not attendance, until a person approves it: it is shown
 * with its label and its hours apart, and it is in no official total, overtime or payroll input.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { monthlySummary } from '../src/modules/reports/reports.routes.js';
import { adminAgent, createEmployee, createTestDatabase, mobileLogin, seedBase, WP } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
let owner: Awaited<ReturnType<typeof adminAgent>>;
let shiftId: string;

const date = DateTime.utc().minus({ days: 2 }).toISODate()!;
const month = date.slice(0, 7);
const range = `from=${date}&to=${date}`;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
  owner = await adminAgent(app);
  shiftId = (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'Day','09:00','17:00','UTC',$2,10) RETURNING id`, [base.workplaceId, [1, 2, 3, 4, 5, 6, 7]])).id;
});
afterAll(async () => {
  await db.drop();
});

/** An eight-hour finished shift on `date`, in the given status, with overtime after it. */
async function shiftRecord(status: string, opts: { overtimeApproved?: boolean; late?: boolean } = {}) {
  const emp = await createEmployee({ workplaceId: base.workplaceId });
  await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, effective_to) VALUES ($1,$2,$3,$3)`, [emp.id, shiftId, date]); // this one day only
  const start = `${date}T09:00:00Z`;
  const end = `${date}T17:00:00Z`;
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, ended_at, authorization_status)
     VALUES ($1,$2,$3,$4,$5,$6,'SHIFT_COMPLETED',$5,$6,'ENDED') RETURNING id`,
    [emp.id, shiftId, base.workplaceId, date, start, end],
  );
  const ar = await one(
    `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, is_late, late_by_minutes, recorded_at,
       evidence_latitude, evidence_longitude, evidence_accuracy_m, evidence_client_time, risk_flags)
     VALUES ($1,$2,$3,$4,$5,$6,30,$7,$8,$9,$10,$11,$12,8,$10,'{OFFLINE_CAPTURE}') RETURNING id`,
    [emp.id, base.workplaceId, shiftId, s.id, date, `k-${crypto.randomUUID()}`, status, !!opts.late, opts.late ? 20 : 0, start, WP.lat, WP.lng],
  );
  const ot = await one(
    `INSERT INTO overtime_entries (session_id, attendance_id, employee_id, workplace_id, shift_date, note, started_at, ended_at, end_reason, start_latitude, start_longitude, start_accuracy_m, start_distance_m, status, approved_minutes, decided_at)
     VALUES ($1,$2,$3,$4,$5,'late finish',$6::timestamptz,$6::timestamptz + interval '1 hour','EMPLOYEE',12.97,77.59,10,0,$7,$8,CASE WHEN $7 = 'APPROVED' THEN now() END) RETURNING id`,
    [s.id, ar.id, emp.id, base.workplaceId, date, end, opts.overtimeApproved ? 'APPROVED' : 'PENDING', opts.overtimeApproved ? 60 : null],
  );
  return { emp, sessionId: s.id as string, id: ar.id as string, overtimeId: ot.id as string };
}

const hoursRow = async (id: string) => (await owner.agent.get(`/api/v1/reports/hours?${range}`).expect(200)).body.rows.find((r: any) => r.employee_id === id);
const monthRow = async (id: string) => (await owner.agent.get(`/api/v1/reports/monthly?month=${month}`).expect(200)).body.rows.find((r: any) => r.employee_id === id);
const decide = (id: string, body: object) => owner.agent.post(`/api/v1/attendance/${id}/verification`).set('X-CSRF-Token', owner.csrf).send(body);

describe('while a record waits for verification', () => {
  it('is in the attendance history with its label and its hours apart', async () => {
    const a = await shiftRecord('PENDING_VERIFICATION');
    const list = (await owner.agent.get(`/api/v1/attendance?from=${date}&to=${date}&employeeId=${a.emp.id}`).expect(200)).body;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ verification_status: 'PENDING_VERIFICATION', pending_minutes: 480, worked_minutes: null });
    expect(list.summary).toMatchObject({ pending_verification: 1, pending_minutes: 480 });

    const token = await mobileLogin(app, a.emp.email);
    const mine = (await request(app).get('/api/v1/me/attendance').set({ Authorization: `Bearer ${token}` }).expect(200)).body.attendance;
    expect(mine[0]).toMatchObject({ verification_status: 'PENDING_VERIFICATION', pending_minutes: 480, worked_minutes: null });
  });

  it('adds nothing to hours, days or overtime, and shows pending time separately', async () => {
    const a = await shiftRecord('PENDING_VERIFICATION', { overtimeApproved: true });
    expect(await hoursRow(a.emp.id)).toMatchObject({ days: 0, total_minutes: 0, regular_minutes: 0, overtime_minutes: 0, pending_minutes: 480, pending_records: 1 });
  });

  it('counts as neither present nor absent, nor late, in the monthly figures payroll is built from', async () => {
    const a = await shiftRecord('PENDING_VERIFICATION', { late: true, overtimeApproved: true });
    expect(await monthRow(a.emp.id)).toMatchObject({ present: 0, absent: 0, late: 0, worked_minutes: 0, overtime_minutes: 0, pending_days: 1, pending_minutes: 480 });
    const summary = await monthlySummary(base.orgId, month, null, false);
    expect(summary.rows.find((r: any) => r.employee_id === a.emp.id)).toMatchObject({ present: 0, worked_minutes: 0, overtime_minutes: 0 });
  });

  it('is not a no-show on the overview, and is its own count', async () => {
    const a = await shiftRecord('PENDING_VERIFICATION', { late: true });
    const o = (await owner.agent.get(`/api/v1/reports/overview?date=${date}`).expect(200)).body;
    const row = o.roster.find((r: any) => r.employee_id === a.emp.id);
    expect(row).toMatchObject({ no_show: false, verification_status: 'PENDING_VERIFICATION', pending_minutes: 480, is_late: false });
    expect(o.cards.pendingVerification).toBeGreaterThanOrEqual(1);
    expect(o.cards.pendingMinutes).toBeGreaterThanOrEqual(480);
  });

  it('stays out of the daily summary, the day close and the analytics dashboard', async () => {
    const a = await shiftRecord('PENDING_VERIFICATION');
    const before = await q(`SELECT 1 FROM attendance_records WHERE shift_date = $1 AND verification_status NOT IN ('VOIDED','PENDING_VERIFICATION')`, [date]);
    const daily = (await owner.agent.get(`/api/v1/reports/daily-summary?${range}&includeSimulated=true`).expect(200)).body;
    expect(daily.reduce((n: number, d: any) => n + d.attended, 0)).toBe(before.length);
    expect(daily.reduce((n: number, d: any) => n + d.pending_verification, 0)).toBeGreaterThanOrEqual(1);
    const day = (await owner.agent.get(`/api/v1/insights/day?date=${date}`).expect(200)).body;
    expect(day.counts.pendingVerification).toBeGreaterThanOrEqual(1);
    expect(day.toDecide.some((t: any) => t.type === 'PENDING_VERIFICATION' && t.employeeId === a.emp.id)).toBe(true);
    expect(day.toDecide.some((t: any) => t.type === 'ABSENT' && t.employeeId === a.emp.id)).toBe(false);
    const dash = (await owner.agent.get(`/api/v1/analytics/dashboard?${range}&employeeId=${a.emp.id}`).expect(200)).body;
    expect(dash.summary).toMatchObject({ present: 0, expected: 0, absent: 0, pending: 1, totalMinutes: 0, pendingMinutes: 480 });
  });

  it('its overtime cannot be approved, and says why', async () => {
    const a = await shiftRecord('PENDING_VERIFICATION');
    const res = await owner.agent.post(`/api/v1/overtime/${a.overtimeId}/decision`).set('X-CSRF-Token', owner.csrf).send({ decision: 'APPROVE', note: 'Looks right' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTENDANCE_PENDING');
  });

  it('is in the detailed exports as pending, and in neither official export', async () => {
    const a = await shiftRecord('PENDING_VERIFICATION');
    const name = (await one(`SELECT full_name FROM users WHERE id = $1`, [a.emp.id])).full_name;
    const detail = (await owner.agent.get(`/api/v1/reports/attendance.csv?${range}&employeeId=${a.emp.id}`).expect(200)).text;
    expect(detail).toContain('PENDING_VERIFICATION');
    expect(detail.split('\n')[0]).toContain('Pending worked (min, not counted)');
    expect(detail.split('\n')[1]?.trim().endsWith('480')).toBe(true);
    expect((await owner.agent.get(`/api/v1/reports/monthly.csv?month=${month}`).expect(200)).text.split('\n')[0]).toContain('Pending hours (not counted)');
    expect((await owner.agent.get(`/api/v1/reports/hours.csv?${range}`).expect(200)).text).not.toContain(name);
    expect((await owner.agent.get(`/api/v1/reports/overtime.csv?${range}`).expect(200)).text).not.toContain(name);
  });
});

describe('when a person decides', () => {
  it('approval moves the hours and overtime into the official figures, and keeps the evidence', async () => {
    const a = await shiftRecord('PENDING_VERIFICATION', { overtimeApproved: true });
    const before = await one(`SELECT recorded_at, evidence_client_time, evidence_latitude, evidence_longitude, evidence_accuracy_m, risk_flags FROM attendance_records WHERE id = $1`, [a.id]);
    await decide(a.id, { decision: 'APPROVE', note: 'Gate register agrees' }).expect(200);

    expect(await hoursRow(a.emp.id)).toMatchObject({ days: 1, total_minutes: 540, overtime_minutes: 60, pending_minutes: 0, pending_records: 0 });
    expect(await monthRow(a.emp.id)).toMatchObject({ present: 1, pending_days: 0, pending_minutes: 0, worked_minutes: 480, overtime_minutes: 60 });
    expect(await one(`SELECT recorded_at, evidence_client_time, evidence_latitude, evidence_longitude, evidence_accuracy_m, risk_flags FROM attendance_records WHERE id = $1`, [a.id])).toEqual(before);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'attendance.verify' AND resource_id = $1`, [a.id])).toHaveLength(1);
  });

  it('after approval, overtime still waiting can be decided', async () => {
    const a = await shiftRecord('PENDING_VERIFICATION');
    await decide(a.id, { decision: 'APPROVE', note: 'Gate register agrees' }).expect(200);
    await owner.agent.post(`/api/v1/overtime/${a.overtimeId}/decision`).set('X-CSRF-Token', owner.csrf).send({ decision: 'APPROVE', note: 'Looks right' }).expect(200);
    expect(await hoursRow(a.emp.id)).toMatchObject({ overtime_minutes: 60, total_minutes: 540 });
  });

  it('rejection leaves nothing counted and nothing pending', async () => {
    const a = await shiftRecord('PENDING_VERIFICATION');
    await decide(a.id, { decision: 'REJECT', note: 'Was not on site' }).expect(200);
    expect(await hoursRow(a.emp.id)).toBeUndefined();
    expect((await owner.agent.get(`/api/v1/attendance?from=${date}&to=${date}&employeeId=${a.emp.id}`).expect(200)).body.items[0]).toMatchObject({ verification_status: 'VOIDED', pending_minutes: null });
  });
});

it('a verified record is unaffected', async () => {
  const a = await shiftRecord('VERIFIED', { overtimeApproved: true });
  expect(await hoursRow(a.emp.id)).toMatchObject({ days: 1, total_minutes: 540, pending_minutes: 0 });
  expect(await monthRow(a.emp.id)).toMatchObject({ present: 1, pending_days: 0 });
});
