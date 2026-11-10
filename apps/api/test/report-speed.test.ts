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
