/**
 * Phase I performance changes must not change any figure: day lookups run a few at a time but keep their
 * order, and the no-show threshold worked out once per (start time, zone) gives the same answer as per row.
 */
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapLimit } from '../src/lib/concurrency.js';
import { createTestDatabase } from './helpers.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { withLeaveAndNoShow } from '../src/modules/reports/reports.routes.js';
import { getSettings } from '../src/modules/settings/settings.service.js';

describe('mapLimit', () => {
  it('keeps the order of the input and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([50, 10, 30, 0, 20, 40, 5], 3, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:50', '1:10', '2:30', '3:0', '4:20', '5:40', '6:5']);
    expect(peak).toBe(3);
  });

  it('handles no items and a limit larger than the list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit([1, 2], 10, async (x) => x * 2)).toEqual([2, 4]);
  });

  it('passes a failure on', async () => {
    await expect(mapLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('boom'); return x; })).rejects.toThrow('boom');
  });
});

describe('hours: faster code, same figures', () => {
  const ids = Array.from({ length: 60 }, () => crypto.randomUUID());
  const dates = Array.from({ length: 120 }, (_, i) => DateTime.fromISO('2025-12-20').plus({ days: i }).toISODate()!);
  const records = Array.from({ length: 3000 }, (_, i) => ({
    employee_id: ids[i % ids.length]!, full_name: `Name ${i % ids.length}`, shift_date: dates[(i * 7) % dates.length]!, workplace_id: 'w',
    worked_minutes: (i * 37) % 600, overtime_minutes: i % 5 === 0 ? 30 : 0, scheduled_minutes: 480, in_progress: false, incomplete: i % 11 === 0,
  }));

  it('orders dates and employee ids exactly as localeCompare did', async () => {
    const { byDateThenEmployee } = await import('../src/modules/reports/hours.js');
    const old = [...records].sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.employee_id.localeCompare(b.employee_id));
    expect([...records].sort(byDateThenEmployee)).toEqual(old);
  });

  it('the remembered week is the ISO week Luxon gives, across a year end', async () => {
    const { weekOf } = await import('../src/modules/reports/hours.js');
    for (const d of dates) expect(weekOf(d)).toBe(DateTime.fromISO(d).startOf('week').toISODate());
    expect(weekOf('2026-01-01')).toBe('2025-12-29');
  });

  it('totals from an existing split equal computeHours', async () => {
    const { computeHours, hoursFromSplit, splitRecords } = await import('../src/modules/reports/hours.js');
    for (const policy of [{ roundingMinutes: 0, weeklyRegularHours: 0 }, { roundingMinutes: 15, weeklyRegularHours: 48 }]) {
      expect(hoursFromSplit(splitRecords(records, policy, dates[7]!, dates[100]!))).toEqual(computeHours(records, policy, dates[7]!, dates[100]!));
    }
  });
});

describe('dashboard daily counts: one range lookup gives the per-day roster rows', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { db = await createTestDatabase(); });
  afterAll(async () => { await db.drop(); });

  it('for every date, filter and scope, including the roster\'s edge cases, with company isolation on', async () => {
    const { one, q, withOrg } = await import('../src/db/pool.js');
    const { seedBase, createEmployee } = await import('./helpers.js');
    const { roster, rosterDayCounts, withLeaveAndNoShow } = await import('../src/modules/reports/reports.routes.js');
    const base = await seedBase();
    const org = base.orgId;
    const from = '2026-03-01', to = '2026-03-21';
    const shift = async (wp: string, start: string, zone: string, days: number[]) =>
      (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'S',$2,'17:00',$3,$4,15) RETURNING id`, [wp, start, zone, days])).id as string;
    const wp2 = (await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Closed site', 12.9, 77.6, 50, 'Asia/Kolkata', $1) RETURNING id`, [org])).id as string;
    const weekday = await shift(base.workplaceId, '09:00', 'Asia/Kolkata', [1, 2, 3, 4, 5]);
    const closedShift = await shift(wp2, '08:00', 'Asia/Kolkata', [1, 2, 3, 4, 5, 6, 7]);
    // The weekday shift ran Mon–Wed from 10:00 until 10 March, and was off before 3 March.
    await q(`INSERT INTO shift_revisions (shift_id, valid_from, valid_to, start_time, end_time, timezone, days_of_week, arrival_grace_minutes, is_active) VALUES
             ($1, NULL, '2026-03-02', '10:00', '17:00', 'Asia/Kolkata', '{1,2,3}', 15, false), ($1, '2026-03-03', '2026-03-10', '10:00', '17:00', 'Asia/Kolkata', '{1,2,3}', 15, true)`, [weekday]);
    await q(`UPDATE workplaces SET is_active = false, deactivated_on = '2026-03-12' WHERE id = $1`, [wp2]);
    const emp = async (shiftId: string, set: { from?: string; to?: string | null; joined?: string; left?: string; demo?: boolean } = {}) => {
      const e = await createEmployee({ workplaceId: base.workplaceId });
      await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, effective_to) VALUES ($1,$2,$3,$4)`, [e.id, shiftId, set.from ?? '2026-01-01', set.to ?? null]);
      if (set.joined || set.left) await q(`UPDATE employee_profiles SET joined_on = $2, left_on = $3 WHERE user_id = $1`, [e.id, set.joined ?? null, set.left ?? null]);
      if (set.left) await q(`UPDATE users SET is_active = false WHERE id = $1`, [e.id]);
      if (set.demo) await q(`UPDATE users SET is_demo = true WHERE id = $1`, [e.id]);
      return e.id;
    };
    const a = await emp(base.shiftId), b = await emp(weekday), c = await emp(base.shiftId, { joined: '2026-03-08' }), d = await emp(weekday, { left: '2026-03-13' });
    const e = await emp(base.shiftId, { to: '2026-03-09' }), f = await emp(base.shiftId, { demo: true }), g = await emp(closedShift);
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2026-03-10')`, [e, weekday]); // moved shift
    const att = async (who: string, sh: string, wp: string, date: string, status: string, late = false, withSession = false) => {
      const sid = withSession
        ? (await one(`INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, ended_at, authorization_status)
                      VALUES ($1,$2,$3,$4,$5,$6,'SHIFT_COMPLETED',$5,$6,'ENDED') RETURNING id`, [who, sh, wp, date, `${date}T03:30:00Z`, `${date}T11:30:00Z`])).id
        : null;
      await q(`INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, recorded_at, is_late, late_by_minutes)
               VALUES ($1,$2,$3,$4,$5,$6,30,$7,$8,$9,$10)`, [who, wp, sh, sid, date, `k-${crypto.randomUUID()}`, status, `${date}T04:00:00Z`, late, late ? 20 : 0]);
    };
    for (const [i, day] of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-09', '2026-03-16'].entries()) {
      await att(a, base.shiftId, base.workplaceId, day, i === 1 ? 'PENDING_VERIFICATION' : i === 2 ? 'VOIDED' : 'VERIFIED', i === 3 || i === 1, i % 2 === 0);
      await att(b, weekday, base.workplaceId, day, i === 4 ? 'MANUAL_APPROVED' : 'VERIFIED', i === 0, true);
    }
    await att(g, closedShift, wp2, '2026-03-11', 'VERIFIED', true, true);
    await att(f, base.shiftId, base.workplaceId, '2026-03-04', 'VERIFIED');
    // A session without attendance (no-show rule), leave of each kind, and holidays (a workplace's own wins).
    await q(`INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, authorization_status, started_at, ended_at)
             VALUES ($1,$2,$3,'2026-03-06','2026-03-06T03:30:00Z','2026-03-06T11:30:00Z','SHIFT_COMPLETED','ENDED','2026-03-06T03:30:00Z','2026-03-06T05:00:00Z')`, [c, base.shiftId, base.workplaceId]);
    const leave = (who: string, s: string, t: string, status: string, half = false) =>
      q(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, status, requested_by, half_day) VALUES ($1,'SICK',$2,$3,'Fever',$4,$1,$5)`, [who, s, t, status, half]);
    await leave(a, '2026-03-10', '2026-03-12', 'APPROVED');
    await leave(a, '2026-03-11', '2026-03-11', 'APPROVED', true);
    await leave(b, '2026-03-04', '2026-03-04', 'APPROVED', true);
    await leave(b, '2026-03-17', '2026-03-18', 'PENDING');
    await leave(d, '2026-02-25', '2026-03-03', 'APPROVED');
    await q(`INSERT INTO holidays (org_id, holiday_date, name) VALUES ($1,'2026-03-14','Company day'), ($1,'2026-03-19','Company day 2')`, [org]);
    await q(`INSERT INTO holidays (org_id, holiday_date, name, workplace_id) VALUES ($1,'2026-03-19','Site day',$2)`, [org, base.workplaceId]);
    // Another company on the same dates: must never appear.
    const other = (await one(`INSERT INTO organizations (name) VALUES ('Other') RETURNING id`)).id as string;
    const ob = await seedBase(other, 'admin@other.test');
    const stranger = await createEmployee({ workplaceId: ob.workplaceId, orgId: other });
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2026-01-01')`, [stranger.id, ob.shiftId]);
    await att(stranger.id, ob.shiftId, ob.workplaceId, '2026-03-05', 'VERIFIED', true, true);

    const now = new Date('2026-03-21T06:00:00Z');
    const keys = ['employee_id', 'workplace_id', 'start_time', 'timezone', 'attendance_id', 'verification_status', 'is_late', 'session_id', 'ended_at', 'holiday', 'on_leave', 'no_show'] as const;
    const pick = (r: any) => JSON.stringify(keys.map((k) => r[k]));
    let compared = 0;
    for (const [wp, sim, sites] of [[null, true, null], [null, false, null], [base.workplaceId, true, null], [null, true, [wp2]], [wp2, true, [base.workplaceId]]] as const) {
      const ranged = await withOrg(org, () => rosterDayCounts(org, from, to, wp, sim, sites as string[] | null, now));
      for (let day = DateTime.fromISO(from); day.toISODate()! <= to; day = day.plus({ days: 1 })) {
        const date = day.toISODate()!;
        const old = await withOrg(org, async () => withLeaveAndNoShow(org, date, await roster(org, date, wp, sim, sites as string[] | null), now));
        const got = ranged.get(date) ?? [];
        expect(got.map(pick).sort(), `${date} wp=${wp} sim=${sim} sites=${sites}`).toEqual(old.map(pick).sort());
        expect(got.some((r) => r.employee_id === stranger.id)).toBe(false);
        compared += old.length;
      }
    }
    expect(compared).toBeGreaterThan(150); // the fixture really produced rows
    // The edge cases are present in the range answer, not only equal to an empty one.
    const all = await withOrg(org, () => rosterDayCounts(org, from, to, null, true, null, now));
    const rows = [...all.values()].flat();
    expect(rows.some((r) => r.verification_status === 'PENDING_VERIFICATION')).toBe(true);
    expect(rows.some((r) => r.on_leave && r.on_leave.half_day === false && r.employee_id === a)).toBe(true);
    expect(all.get('2026-03-19')!.every((r) => r.holiday === (r.workplace_id === base.workplaceId ? 'Site day' : 'Company day 2'))).toBe(true);
    expect(all.get('2026-03-11')!.some((r) => r.workplace_id === wp2)).toBe(true);
    expect(all.get('2026-03-12')!.some((r) => r.workplace_id === wp2)).toBe(false);
    expect(rows.some((r) => r.no_show)).toBe(true);
    // Longer than one 31-day chunk: the same rows as two lookups split elsewhere by hand.
    const norm = (m: Map<string, any[]>) => Object.fromEntries([...m].map(([k, v]) => [k, v.map(pick).sort()]).sort());
    const long = await withOrg(org, () => rosterDayCounts(org, '2026-01-20', to, null, true, null, now));
    const p1 = await withOrg(org, () => rosterDayCounts(org, '2026-01-20', '2026-02-10', null, true, null, now));
    const p2 = await withOrg(org, () => rosterDayCounts(org, '2026-02-11', to, null, true, null, now));
    expect(norm(new Map([...p1, ...p2]))).toEqual(norm(long));
    expect(long.size).toBe(61);
  });
});

describe('no-show threshold', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { db = await createTestDatabase(); });
  afterAll(async () => { await db.drop(); });

  it('is the same per row as computed row by row, across shifts and time zones', async () => {
    const { alerts } = await getSettings(DEFAULT_ORG_ID);
    const date = '2026-03-15';
    const shifts = [
      ['09:00:00', 'Asia/Kolkata'], ['09:00:00', 'Asia/Dubai'], ['22:30:00', 'Asia/Kolkata'], ['06:15:00', 'America/New_York'],
    ] as const;
    const rows = Array.from({ length: 400 }, (_, i) => {
      const [start_time, timezone] = shifts[i % shifts.length]!;
      return { employee_id: crypto.randomUUID(), workplace_id: crypto.randomUUID(), start_time, timezone, attendance_id: null, session_id: null };
    });
    // A moment between two shifts' thresholds, so both answers occur.
    const now = DateTime.fromISO(`${date}T09:00:00`, { zone: 'Asia/Kolkata' }).plus({ minutes: alerts.noShowAfterMinutes + 1 }).toJSDate();
    const got = await withLeaveAndNoShow(DEFAULT_ORG_ID, date, rows, now);
    for (const [i, r] of rows.entries()) {
      const threshold = DateTime.fromISO(`${date}T${r.start_time}`, { zone: r.timezone }).plus({ minutes: alerts.noShowAfterMinutes }).toMillis();
      expect(got[i]!.no_show).toBe(alerts.noShowAfterMinutes > 0 && now.getTime() >= threshold);
    }
    expect(new Set(got.map((r) => r.no_show)).size).toBe(alerts.noShowAfterMinutes > 0 ? 2 : 1);
  });
});
