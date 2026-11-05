/**
 * Attendance and time zones, end to end: what is stored, what is shown, and what happens at the edges.
 * Original times and history must survive every one of these.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { currentInstance, instanceFor } from '../src/lib/shift-window.js';
import { adminAgent, createEmployee, createTestDatabase, seedBase } from './helpers.js';

const IST = 'Asia/Kolkata';
let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
let owner: Awaited<ReturnType<typeof adminAgent>>;
let night: string;
let day: string;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  await q(`UPDATE workplaces SET timezone = $1 WHERE id = $2`, [IST, base.workplaceId]);
  const mk = async (name: string, s: string, e: string) => (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,$2,$3,$4,$5,$6,30) RETURNING id`, [base.workplaceId, name, s, e, IST, [1, 2, 3, 4, 5, 6, 7]])).id as string;
  night = await mk('Night', '22:00', '06:00');
  day = await mk('Day', '09:00', '17:00');
  app = createApp();
  owner = await adminAgent(app);
});
afterAll(async () => {
  await db.drop();
});

async function worked(shiftId: string, date: string, startUtc: string, endUtc: string, status = 'VERIFIED', extra: { clientTime?: string; employeeId?: string; flags?: string[] } = {}) {
  const emp = extra.employeeId ? { id: extra.employeeId } : await createEmployee({ workplaceId: base.workplaceId });
  await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, effective_to) VALUES ($1,$2,$3,$3) ON CONFLICT DO NOTHING`, [emp.id, shiftId, date]);
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, ended_at, authorization_status)
     VALUES ($1,$2,$3,$4,$5,$6,'SHIFT_COMPLETED',$5,$6,'ENDED') RETURNING id`,
    [emp.id, shiftId, base.workplaceId, date, startUtc, endUtc],
  );
  const r = await one(
    `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, recorded_at, evidence_client_time, risk_flags, device_meta)
     VALUES ($1,$2,$3,$4,$5,$6,30,$7,$8,$9,$10,$11) RETURNING id`,
    [emp.id, base.workplaceId, shiftId, s.id, date, `k-${crypto.randomUUID()}`, status, startUtc, extra.clientTime ?? startUtc, extra.flags ?? [], JSON.stringify({ receivedAt: '2026-04-01T04:00:00.000Z' })],
  );
  return { emp, id: r.id as string, sessionId: s.id as string };
}
const hours = async (id: string, from: string, to: string) => (await owner.agent.get(`/api/v1/reports/hours?from=${from}&to=${to}&employeeId=${id}`).expect(200)).body.rows[0];
const monthly = async (id: string, m: string) => (await owner.agent.get(`/api/v1/reports/monthly?month=${m}`).expect(200)).body.rows.find((r: any) => r.employee_id === id);
const verify = (id: string, decision = 'APPROVE') => owner.agent.post(`/api/v1/attendance/${id}/verification`).set('X-CSRF-Token', owner.csrf).send({ decision, note: 'Checked against the gate register' });

describe('stored in UTC, shown in local time', () => {
  it('the same instant comes back whatever zone it was sent in', async () => {
    const a = await worked(day, '2026-03-10', '2026-03-10T09:00:00+05:30', '2026-03-10T17:00:00+05:30');
    const r = (await owner.agent.get(`/api/v1/attendance/${a.id}`).expect(200)).body.record;
    expect(r.recorded_at).toBe('2026-03-10T03:30:00.000Z');
  });

  it('every timestamp column in the database has a zone', async () => {
    const bad = await q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`);
    expect(bad).toEqual([]);
  });

  it('a CSV gives both, and they agree', async () => {
    const a = await worked(day, '2026-03-11', '2026-03-11T03:30:00Z', '2026-03-11T11:30:00Z');
    const csv = (await owner.agent.get(`/api/v1/reports/attendance.csv?from=2026-03-11&to=2026-03-11&employeeId=${a.emp.id}`).expect(200)).text;
    expect(csv).toContain('2026-03-11 09:00'); // on the wall in India
    expect(csv).toContain('2026-03-11 17:00');
    expect(csv).toMatch(/2026-03-11T03:30:00\.000Z/);
  });

  it('a CSV of a workplace in a daylight-saving zone reads as it did on the wall that day', async () => {
    await q(`UPDATE shifts SET timezone = 'America/New_York' WHERE id = $1`, [day]);
    try {
      const summer = await worked(day, '2026-07-01', '2026-07-01T13:00:00Z', '2026-07-01T21:00:00Z');
      const winter = await worked(day, '2026-12-01', '2026-12-01T14:00:00Z', '2026-12-01T22:00:00Z');
      const text = async (id: string, d: string) => (await owner.agent.get(`/api/v1/reports/attendance.csv?from=${d}&to=${d}&employeeId=${id}`).expect(200)).text;
      expect(await text(summer.emp.id, '2026-07-01')).toContain('2026-07-01 09:00');
      expect(await text(winter.emp.id, '2026-12-01')).toContain('2026-12-01 09:00');
    } finally {
      await q(`UPDATE shifts SET timezone = $2 WHERE id = $1`, [day, IST]);
    }
  });
});

describe('daylight-saving zones', () => {
  const ny = { start_time: '22:00', end_time: '06:00', timezone: 'America/New_York', days_of_week: [1, 2, 3, 4, 5, 6, 7] };
  const local = (d: string) => DateTime.fromISO(d, { zone: 'America/New_York' });
  const length = (d: string) => { const i = instanceFor(ny, local(d), 0, 0); return (i.endsAt.getTime() - i.startsAt.getTime()) / 3600_000; };

  it('a night is seven hours when clocks go forward, nine when they go back, eight otherwise', () => {
    expect(length('2026-03-07')).toBe(7);
    expect(length('2026-10-31')).toBe(9);
    expect(length('2026-06-01')).toBe(8);
  });

  it('a shift starting in the hour that does not exist still resolves', () => {
    const i = instanceFor({ ...ny, start_time: '02:30', end_time: '10:00' }, local('2026-03-08'), 0, 0);
    expect(Number.isFinite(i.startsAt.getTime())).toBe(true);
    expect(i.shiftDate).toBe('2026-03-08');
  });

  it('the repeated hour belongs to one shift, once', () => {
    expect(currentInstance(ny, new Date('2026-11-01T05:30:00Z'), 0, 0)?.shiftDate).toBe('2026-10-31'); // 01:30, first time
    expect(currentInstance(ny, new Date('2026-11-01T06:30:00Z'), 0, 0)?.shiftDate).toBe('2026-10-31'); // 01:30, second time
  });

  it('India has no such change: every night is eight hours', () => {
    for (const d of ['2026-03-08', '2026-11-01']) {
      const i = instanceFor({ ...ny, timezone: IST }, DateTime.fromISO(d, { zone: IST }), 0, 0);
      expect((i.endsAt.getTime() - i.startsAt.getTime()) / 3600_000).toBe(8);
    }
  });
});

describe('month and year ends', () => {
  it('a night shift that crosses the new year counts in December', async () => {
    const a = await worked(night, '2026-12-31', '2026-12-31T16:30:00Z', '2027-01-01T00:30:00Z');
    expect(await hours(a.emp.id, '2026-12-01', '2026-12-31')).toMatchObject({ days: 1, total_minutes: 480 });
    expect(await hours(a.emp.id, '2027-01-01', '2027-01-31')).toBeUndefined();
  });

  it('two nights either side of a month end count one in each month', async () => {
    const a = await worked(night, '2026-02-28', '2026-02-28T16:30:00Z', '2026-03-01T00:30:00Z');
    await worked(night, '2026-03-01', '2026-03-01T16:30:00Z', '2026-03-02T00:30:00Z', 'VERIFIED', { employeeId: a.emp.id });
    expect((await hours(a.emp.id, '2026-02-01', '2026-02-28')).days).toBe(1);
    expect((await hours(a.emp.id, '2026-03-01', '2026-03-31')).days).toBe(1);
    expect((await hours(a.emp.id, '2026-02-01', '2026-03-31')).total_minutes).toBe(960);
  });

  it('a leap day is an ordinary day', async () => {
    const a = await worked(day, '2028-02-29', '2028-02-29T03:30:00Z', '2028-02-29T11:30:00Z');
    expect((await hours(a.emp.id, '2028-02-01', '2028-02-29')).days).toBe(1);
  });

  it('a week that spans the new year is one week for the weekly rule', async () => {
    const r = (await import('../src/modules/reports/hours.js')).splitRecords(
      [{ employee_id: 'e', full_name: 'E', shift_date: '2026-12-31', workplace_id: 'w', worked_minutes: 480, overtime_minutes: 0, in_progress: false, incomplete: false }, { employee_id: 'e', full_name: 'E', shift_date: '2027-01-01', workplace_id: 'w', worked_minutes: 480, overtime_minutes: 0, in_progress: false, incomplete: false }],
      { roundingMinutes: 0, weeklyRegularHours: 8 }, '2026-12-28', '2027-01-03',
    );
    expect(r.map((x) => x.overtime)).toEqual([0, 480]);
  });
});

describe('delayed offline attendance', () => {
  const phone = '2026-03-31T18:20:00.000Z'; // 23:50 IST on 31 March

  it('sent after midnight keeps its day and the time on the phone', async () => {
    const a = await worked(night, '2026-03-31', phone, '2026-04-01T00:30:00.000Z', 'PENDING_VERIFICATION', { clientTime: phone, flags: ['OFFLINE_CAPTURE'] });
    const r = await one(`SELECT shift_date, evidence_client_time, recorded_at, device_meta FROM attendance_records WHERE id = $1`, [a.id]);
    expect(r.shift_date).toBe('2026-03-31');
    expect(new Date(r.evidence_client_time).toISOString()).toBe(phone);
    expect(r.device_meta.receivedAt).toBe('2026-04-01T04:00:00.000Z');
  });

  it('approved in the next month, it counts in the month it was worked, and only then', async () => {
    const a = await worked(night, '2026-03-30', '2026-03-30T16:30:00.000Z', '2026-03-31T00:30:00.000Z', 'PENDING_VERIFICATION', { flags: ['OFFLINE_CAPTURE'] });
    expect(await monthly(a.emp.id, '2026-03')).toMatchObject({ present: 0, pending_days: 1, pending_minutes: 480 });
    await verify(a.id).expect(200);
    expect(await monthly(a.emp.id, '2026-03')).toMatchObject({ present: 1, pending_days: 0, worked_minutes: 480 });
    expect(await hours(a.emp.id, '2026-04-01', '2026-04-30')).toBeUndefined();
  });

  it('approval changes the status and nothing the phone reported', async () => {
    const a = await worked(night, '2026-03-29', '2026-03-29T16:30:00.000Z', '2026-03-30T00:30:00.000Z', 'PENDING_VERIFICATION', { clientTime: '2026-03-29T16:31:00.000Z', flags: ['OFFLINE_CAPTURE'] });
    const cols = `shift_date, recorded_at, evidence_client_time, risk_flags, device_meta`;
    const before = await one(`SELECT ${cols} FROM attendance_records WHERE id = $1`, [a.id]);
    await verify(a.id).expect(200);
    expect(await one(`SELECT ${cols} FROM attendance_records WHERE id = $1`, [a.id])).toEqual(before);
    expect((await one(`SELECT verification_status FROM attendance_records WHERE id = $1`, [a.id])).verification_status).toBe('MANUAL_APPROVED');
  });
});

describe('historical shift changes', () => {
  it('editing a shift leaves past days as they were', async () => {
    const shift = (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'Editable','09:00','17:00',$2,$3,10) RETURNING id`, [base.workplaceId, IST, [1, 2, 3, 4, 5, 6, 7]])).id;
    const a = await worked(shift, '2026-02-10', '2026-02-10T03:30:00Z', '2026-02-10T11:30:00Z');
    const before = await hours(a.emp.id, '2026-02-10', '2026-02-10');
    const overview = async () => (await owner.agent.get('/api/v1/reports/overview?date=2026-02-10').expect(200)).body.roster.find((r: any) => r.employee_id === a.emp.id);
    const row = await overview();
    await owner.agent.patch(`/api/v1/shifts/${shift}`).set('X-CSRF-Token', owner.csrf).send({ startTime: '11:00', endTime: '19:00', reason: 'New timings' }).expect(200);
    expect(await hours(a.emp.id, '2026-02-10', '2026-02-10')).toEqual(before);
    expect(String((await overview()).start_time).slice(0, 5)).toBe(String(row.start_time).slice(0, 5));
    expect(String(row.start_time).slice(0, 5)).toBe('09:00');
  });

  it('moving someone to another shift leaves their past days on the old one', async () => {
    const a = await worked(day, '2026-02-11', '2026-02-11T03:30:00Z', '2026-02-11T11:30:00Z');
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2026-02-12')`, [a.emp.id, night]);
    const rec = await one(`SELECT shift_id, shift_date, recorded_at FROM attendance_records WHERE id = $1`, [a.id]);
    expect(rec.shift_id).toBe(day);
    expect((await hours(a.emp.id, '2026-02-11', '2026-02-11')).total_minutes).toBe(480);
  });
});
