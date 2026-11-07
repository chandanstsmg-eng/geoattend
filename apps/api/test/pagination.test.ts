/** Large reports: paged and streamed, without losing, repeating or changing a single record. */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { dateChunks, streamCsv } from '../src/lib/csv.js';
import { sweepNoShows } from '../src/modules/jobs/no-show.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { DEFAULT_SETTINGS, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { adminAgent, createEmployee, createTestDatabase, seedBase } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
let owner: Awaited<ReturnType<typeof adminAgent>>;
const DAYS = 45;
const start = DateTime.fromISO('2026-01-01', { zone: 'utc' });
const employees: Array<{ id: string }> = [];
const dates = Array.from({ length: DAYS }, (_, i) => start.plus({ days: i }).toISODate()!);
const from = dates[0]!;
const to = dates.at(-1)!;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
  owner = await adminAgent(app);
  for (let i = 0; i < 3; i++) employees.push(await createEmployee({ workplaceId: base.workplaceId }));
  for (const e of employees) {
    for (const d of dates) {
      const s = await one(
        `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, ended_at, authorization_status)
         VALUES ($1,$2,$3,$4,$4::date + time '09:00',$4::date + time '17:00','SHIFT_COMPLETED',$4::date + time '09:00',$4::date + time '17:00','ENDED') RETURNING id`,
        [e.id, base.shiftId, base.workplaceId, d],
      );
      // Every record of a day has exactly the same time: ties are the hard case for paging.
      await q(
        `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,30,'VERIFIED',$5::date + time '09:00')`,
        [e.id, base.workplaceId, base.shiftId, s.id, d, crypto.randomUUID()],
      );
      await q(`INSERT INTO absence_intervals (session_id, employee_id, workplace_id, started_at, ended_at, status, threshold_minutes) VALUES ($1,$2,$3,$4::date + time '12:00',$4::date + time '12:10','RETURNED',15)`, [s.id, e.id, base.workplaceId, d]);
    }
  }
});
afterAll(async () => {
  await db.drop();
});

const total = () => employees.length * DAYS;

describe('the attendance list', () => {
  it('in pages, shows every record exactly once, even when times are identical', async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < total() + 20; offset += 20) {
      const body = (await owner.agent.get(`/api/v1/attendance?from=${from}&to=${to}&limit=20&offset=${offset}`).expect(200)).body;
      expect(body.total).toBe(total());
      seen.push(...body.items.map((r: any) => r.id));
    }
    expect(seen).toHaveLength(total());
    expect(new Set(seen).size).toBe(total());
  });

  it('keeps its order, newest first, and its worked time', async () => {
    const items = (await owner.agent.get(`/api/v1/attendance?from=${from}&to=${to}&limit=50`).expect(200)).body.items;
    const days = items.map((r: any) => r.shift_date);
    expect(days).toEqual([...days].sort().reverse());
    expect(items.every((r: any) => r.worked_minutes === 470)).toBe(true); // eight hours less ten minutes away
  });
});

describe('streamed exports', () => {
  const rowsOf = (text: string) => text.replace(/^﻿/, '').trim().split('\r\n');

  it('the attendance export spans many pieces with every record once, in date order', async () => {
    const res = await owner.agent.get(`/api/v1/reports/attendance.csv?from=${from}&to=${to}`).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const rows = rowsOf(res.text);
    expect(rows[0]!.startsWith('Date,')).toBe(true);
    expect(rows.filter((r) => r.startsWith('Date,'))).toHaveLength(1);
    expect(rows).toHaveLength(total() + 1);
    const days = rows.slice(1).map((r) => r.slice(0, 10));
    expect(days).toEqual([...days].sort());
    expect(new Set(days).size).toBe(DAYS);
  });

  it('a range far wider than the data costs nothing and changes nothing', async () => {
    const wide = await owner.agent.get(`/api/v1/reports/attendance.csv?from=1990-01-01&to=2099-12-31`).expect(200);
    expect(rowsOf(wide.text)).toHaveLength(total() + 1);
  });

  it('an empty period is a file with just the header', async () => {
    const res = await owner.agent.get(`/api/v1/reports/attendance.csv?from=1990-01-01&to=1990-01-31`).expect(200);
    expect(rowsOf(res.text)).toHaveLength(1);
  });

  it('the absences export matches the list, across piece boundaries', async () => {
    const rows = rowsOf((await owner.agent.get(`/api/v1/reports/absences.csv?from=${from}&to=${to}`).expect(200)).text);
    expect(rows).toHaveLength(total() + 1);
    expect((await owner.agent.get(`/api/v1/absence-intervals?from=${from}&to=${to}&limit=1`).expect(200)).body.total).toBe(total());
  });

  it('records how many rows went out', async () => {
    await owner.agent.get(`/api/v1/reports/attendance.csv?from=${from}&to=${to}`).expect(200);
    const a = await one(`SELECT after_data FROM audit_logs WHERE resource_type = 'attendance_csv' ORDER BY id DESC LIMIT 1`);
    expect(a.after_data.rows).toBe(total());
  });

  it('the record is written before the download ends, and failing to write it cuts the download', async () => {
    const order: string[] = [];
    const res = { write: () => true, once: () => undefined, end: () => { order.push('end'); } };
    await streamCsv(res, ['A'], [async () => [['1'], ['2']]], async (rows) => { order.push(`record ${rows}`); });
    expect(order).toEqual(['record 2', 'end']);
    order.length = 0;
    await expect(streamCsv(res, ['A'], [async () => [['1']]], async () => { throw new Error('audit failed'); })).rejects.toThrow('audit failed');
    expect(order).toEqual([]);
  });

  it('a failure part way through cuts the connection instead of passing as a complete file', async () => {
    const chunks: string[] = [];
    const res = { write: (s: string) => (chunks.push(s), true), once: () => undefined, end: () => { throw new Error('must not end normally'); } };
    await expect(streamCsv(res, ['A'], [async () => [['1']], async () => { throw new Error('database lost'); }])).rejects.toThrow('database lost');
    expect(chunks.join('')).toContain('1');
  });

  it('date ranges are split with no gap and no overlap', () => {
    const c = dateChunks('2026-12-20', '2027-02-05', 14);
    expect(c[0]).toEqual({ from: '2026-12-20', to: '2027-01-02' });
    expect(c.at(-1)!.to).toBe('2027-02-05');
    for (let i = 1; i < c.length; i++) expect(DateTime.fromISO(c[i]!.from).diff(DateTime.fromISO(c[i - 1]!.to), 'days').days).toBe(1);
    expect(dateChunks('2026-01-01', '2026-01-01')).toEqual([{ from: '2026-01-01', to: '2026-01-01' }]);
  });
});

describe('reports in pages', () => {
  it('hours: a page of the people, with figures identical to the full list', async () => {
    const all = (await owner.agent.get(`/api/v1/reports/hours?from=${from}&to=${to}`).expect(200)).body;
    expect(all.total).toBe(employees.length);
    const page = (await owner.agent.get(`/api/v1/reports/hours?from=${from}&to=${to}&limit=2&offset=1`).expect(200)).body;
    expect(page.total).toBe(employees.length);
    expect(page.rows).toEqual(all.rows.slice(1, 3));
  });

  it('the employee list honours a limit, and still returns everyone without one', async () => {
    const all = (await owner.agent.get('/api/v1/employees').expect(200)).body;
    expect(all).toHaveLength(employees.length);
    const page = (await owner.agent.get('/api/v1/employees?limit=2&offset=1').expect(200)).body;
    expect(page.map((e: any) => e.id)).toEqual(all.slice(1, 3).map((e: any) => e.id));
  });

  it('a limit that is too large is refused', async () => {
    await owner.agent.get('/api/v1/employees?limit=100000').expect(400);
    await owner.agent.get(`/api/v1/reports/hours?from=${from}&to=${to}&limit=100000`).expect(400);
  });
});

describe('no-show alerts', () => {
  it('finds alerts already sent, and still completes one that was half sent', async () => {
    await saveSettingsSection(DEFAULT_ORG_ID, 'alerts', { ...DEFAULT_SETTINGS.alerts, noShowAfterMinutes: 30 }, null);
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const noon = DateTime.utc().set({ hour: 12, minute: 0, second: 0 }).toJSDate();
    await sweepNoShows(noon);
    const list = () => q(`SELECT audience FROM notifications WHERE employee_id = $1 AND type = 'NO_SHOW' ORDER BY audience`, [emp.id]);
    expect((await list()).map((n) => n.audience)).toEqual(['ADMIN', 'EMPLOYEE']);
    await q(`DELETE FROM notifications WHERE employee_id = $1 AND audience = 'EMPLOYEE'`, [emp.id]); // as if the server stopped between the two
    await sweepNoShows(noon);
    await sweepNoShows(noon);
    expect((await list()).map((n) => n.audience)).toEqual(['ADMIN', 'EMPLOYEE']);
  });
});
