/**
 * Business dates around 00:00 UTC and 00:00 IST, overnight shifts, and independence from the time
 * zone of the server (this file is also run with TZ set to other zones: see docs/TIME-AND-DATES.md).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { closePool, getPool, initPool, one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { canonicalTimezone, currentInstance, instanceFor, todayIn } from '../src/lib/shift-window.js';
import { DEFAULT_TIMEZONE, orgTimezone, orgToday } from '../src/lib/dates.js';
import { computeHours, splitRecords } from '../src/modules/reports/hours.js';
import { sweepNoShows } from '../src/modules/jobs/no-show.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { DEFAULT_SETTINGS, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { adminAgent, createEmployee, createTestDatabase, mobileLogin, seedBase } from './helpers.js';

const IST = 'Asia/Kolkata';
const NIGHT = { start_time: '22:00', end_time: '06:00', timezone: IST, days_of_week: [1, 2, 3, 4, 5, 6, 7] };
const at = (iso: string) => new Date(iso);

describe('today in India', () => {
  it.each([
    ['2026-03-31T18:29:59Z', '2026-03-31'], // 23:59:59 IST
    ['2026-03-31T18:30:00Z', '2026-04-01'], // 00:00 IST: the date turns over here, not at 00:00 UTC
    ['2026-03-31T23:59:59Z', '2026-04-01'], // 05:29:59 IST: UTC still says 31 March
    ['2026-04-01T00:00:00Z', '2026-04-01'], // 00:00 UTC: nothing happens in India
    ['2026-12-31T18:30:00Z', '2027-01-01'],
    ['2028-02-28T18:30:00Z', '2028-02-29'], // leap day
  ])('%s is %s', (utc, local) => {
    expect(todayIn(IST, at(utc))).toBe(local);
  });
});

describe('an overnight shift belongs to the day it started', () => {
  it.each([
    ['2026-03-31T16:30:00Z', '22:00 IST, it starts', '2026-03-31'],
    ['2026-03-31T18:29:00Z', '23:59 IST', '2026-03-31'],
    ['2026-03-31T18:30:00Z', '00:00 IST, the new month', '2026-03-31'],
    ['2026-03-31T23:59:00Z', '05:29 IST', '2026-03-31'],
    ['2026-04-01T00:00:00Z', '05:30 IST, 00:00 UTC', '2026-03-31'],
    ['2026-04-01T00:29:00Z', '05:59 IST', '2026-03-31'],
  ])('%s (%s)', (utc, _label, date) => {
    expect(currentInstance(NIGHT, at(utc), 30, 15)?.shiftDate).toBe(date);
  });

  it('lasts eight hours in UTC terms and ends on the next date', () => {
    const inst = instanceFor(NIGHT, DateTime.fromISO('2026-12-31', { zone: IST }), 0, 0);
    expect(inst.shiftDate).toBe('2026-12-31');
    expect(inst.startsAt.toISOString()).toBe('2026-12-31T16:30:00.000Z');
    expect(inst.endsAt.toISOString()).toBe('2027-01-01T00:30:00.000Z');
  });

  it('that runs only on Sunday night is still open on Monday morning, and does not start on Monday night', () => {
    const sundays = { ...NIGHT, days_of_week: [7] };
    expect(currentInstance(sundays, at('2026-11-08T22:00:00Z'), 0, 0)?.shiftDate).toBe('2026-11-08'); // Monday 03:30 IST
    expect(currentInstance(sundays, at('2026-11-09T17:00:00Z'), 0, 0)).toBeNull(); // Monday 22:30 IST
  });

  it('ending exactly at midnight ends on the next date', () => {
    const inst = instanceFor({ ...NIGHT, start_time: '16:00', end_time: '00:00' }, DateTime.fromISO('2026-11-05', { zone: IST }), 0, 0);
    expect(inst.endsAt.toISOString()).toBe('2026-11-05T18:30:00.000Z');
  });

  it('respects a roster that ended the day it started', () => {
    const ranges = [{ from: '2026-01-01', to: '2026-03-31' }];
    expect(currentInstance(NIGHT, at('2026-03-31T20:00:00Z'), 0, 0, ranges)?.shiftDate).toBe('2026-03-31'); // 01:30 on 1 April
    expect(currentInstance(NIGHT, at('2026-04-01T17:00:00Z'), 0, 0, ranges)).toBeNull(); // the night of 1 April
  });

  it('keeps its real length across a daylight-saving change elsewhere', () => {
    const ny = instanceFor({ ...NIGHT, timezone: 'America/New_York' }, DateTime.fromISO('2026-10-31', { zone: 'America/New_York' }), 0, 0);
    expect((ny.endsAt.getTime() - ny.startsAt.getTime()) / 3600_000).toBe(9); // clocks go back that night
  });
});

describe('weekly totals', () => {
  const record = (shift_date: string, worked_minutes: number) => ({ employee_id: 'e', full_name: 'E', shift_date, workplace_id: 'w', worked_minutes, overtime_minutes: 0, in_progress: false, incomplete: false });

  it('count a Sunday night shift in the week it started, whatever the zone of the server', () => {
    const rows = splitRecords([record('2026-11-08', 480), record('2026-11-09', 480)], { roundingMinutes: 0, weeklyRegularHours: 8 }, '2026-11-02', '2026-11-15');
    expect(rows.map((r) => [r.shift_date, r.overtime])).toEqual([['2026-11-08', 0], ['2026-11-09', 0]]); // Sunday and Monday: different weeks
  });

  it('count one overnight shift as one day', () => {
    expect(computeHours([record('2026-03-31', 480)], { roundingMinutes: 0, weeklyRegularHours: 0 }, '2026-03-01', '2026-03-31')[0]).toMatchObject({ days: 1, total_minutes: 480 });
    expect(computeHours([record('2026-03-31', 480)], { roundingMinutes: 0, weeklyRegularHours: 0 }, '2026-04-01', '2026-04-30')).toEqual([]);
  });
});

describe('against the real API and database', () => {
  let app: Express;
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let base: Awaited<ReturnType<typeof seedBase>>;
  let owner: Awaited<ReturnType<typeof adminAgent>>;
  let night: string;

  /** Runs `fn` with the application's clock at `iso`. The database clock is not moved. */
  const frozen = (iso: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });

  beforeAll(async () => {
    db = await createTestDatabase();
    base = await seedBase();
    await q(`UPDATE workplaces SET timezone = $1 WHERE id = $2`, [IST, base.workplaceId]);
    await q(`UPDATE shifts SET timezone = $1 WHERE id = $2`, [IST, base.shiftId]);
    night = (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'Night','22:00','06:00',$2,$3,30) RETURNING id`, [base.workplaceId, IST, [1, 2, 3, 4, 5, 6, 7]])).id;
    app = createApp();
    owner = await adminAgent(app);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('database sessions are UTC even if the database is configured otherwise', async () => {
    expect((await one(`SHOW TimeZone`)).TimeZone).toBe('UTC');
    const name = (await one(`SELECT current_database() AS d`)).d;
    const url = (getPool() as any).options.connectionString as string;
    await q(`ALTER DATABASE "${name}" SET TimeZone = 'Asia/Tokyo'`);
    await closePool();
    initPool(url);
    expect((await one(`SHOW TimeZone`)).TimeZone).toBe('UTC');
    await q(`ALTER DATABASE "${name}" RESET TimeZone`);
  });

  it('a company with no workplace yet is on Indian time, not UTC', async () => {
    const org = (await one(`INSERT INTO organizations (name) VALUES ('Empty') RETURNING id`)).id;
    expect(await orgTimezone(org)).toBe(DEFAULT_TIMEZONE);
    expect(await orgToday(org, null, at('2026-03-31T19:00:00Z'))).toBe('2026-04-01');
  });

  it.each([
    ['2026-03-31T18:29:00Z', '2026-03-31'],
    ['2026-03-31T18:30:00Z', '2026-04-01'],
    ['2026-03-31T23:59:00Z', '2026-04-01'],
    ['2026-04-01T00:00:00Z', '2026-04-01'],
  ])('the overview opened at %s shows %s', async (now, date) => {
    const { agent } = await adminAgent(app);
    frozen(now);
    expect((await agent.get('/api/v1/reports/overview').set('Cookie', await freshCookie()).expect(200)).body.date).toBe(date);
  });

  /** An access token that is valid at the frozen time. */
  async function freshCookie() {
    const { signAccessToken } = await import('../src/lib/auth.js');
    return `ga_at=${await signAccessToken({ id: base.adminId, role: 'ADMIN' })}`;
  }

  it('the default year and month turn over at midnight in India, not in UTC', async () => {
    await q(`INSERT INTO holidays (org_id, holiday_date, name) VALUES ($1,'2027-01-26','Republic Day'), ($1,'2026-12-25','Christmas')`, [base.orgId]);
    frozen('2026-12-31T19:00:00Z'); // 00:30 on 1 January in India
    const cookie = await freshCookie();
    const days = (await owner.agent.get('/api/v1/holidays').set('Cookie', cookie).expect(200)).body.map((h: any) => h.name);
    expect(days).toEqual(['Republic Day']);
  });

  it('leave cannot be cancelled once it has started in India, though it is still the day before in UTC', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await mobileLogin(app, emp.email);
    const l = await one(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, status, requested_by) VALUES ($1,'SICK','2026-04-01','2026-04-02','Fever','APPROVED',$1) RETURNING id`, [emp.id]);
    frozen('2026-03-31T19:00:00Z');
    const { signAccessToken } = await import('../src/lib/auth.js');
    const fresh = await signAccessToken({ id: emp.id, role: 'EMPLOYEE' });
    void token;
    const res = await request(app).post(`/api/v1/leave/mine/${l.id}/cancel`).set({ Authorization: `Bearer ${fresh}` }).send({});
    expect(res.body.error?.code).toBe('LEAVE_STARTED');
  });

  it('confirming a day: today in India is allowed, tomorrow in India is not', async () => {
    frozen('2026-03-31T19:00:00Z');
    const cookie = await freshCookie();
    const post = (date: string) => owner.agent.post('/api/v1/insights/day/close').set('Cookie', cookie).set('X-CSRF-Token', owner.csrf).send({ date });
    expect((await post('2026-04-02')).body.error?.code).toBe('FUTURE_DAY');
    expect((await post('2026-04-01')).status).toBeLessThan(300);
  });

  describe('date filters on stored times use the business day', () => {
    const ins = (createdAt: string, marker: string) => q(`INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, org_id, created_at) VALUES ($1,'ADMIN',$2,'test',$3,$4)`, [base.adminId, marker, base.orgId, createdAt]);

    it('a moment after midnight in India belongs to the new day; a moment before, to the old one', async () => {
      await ins('2026-03-31T18:29:59Z', 'edge.before');
      await ins('2026-03-31T18:30:00Z', 'edge.after');
      await ins('2026-04-01T18:29:59Z', 'edge.lastmoment');
      await ins('2026-04-01T18:30:00Z', 'edge.nextday');
      const actions = async (day: string) => (await owner.agent.get(`/api/v1/audit-logs?action=edge&from=${day}&to=${day}`).expect(200)).body.items.map((x: any) => x.action).sort();
      expect(await actions('2026-03-31')).toEqual(['edge.before']);
      expect(await actions('2026-04-01')).toEqual(['edge.after', 'edge.lastmoment']);
      expect(await actions('2026-04-02')).toEqual(['edge.nextday']);
    });

    it('absences in the list and the export follow the same day', async () => {
      const emp = await createEmployee({ workplaceId: base.workplaceId });
      const s = await session(emp.id, base.shiftId, '2026-03-31');
      await q(`INSERT INTO absence_intervals (session_id, employee_id, workplace_id, started_at, threshold_minutes) VALUES ($1,$2,$3,'2026-03-31T18:45:00Z',15)`, [s, emp.id, base.workplaceId]);
      const list = async (day: string) => (await owner.agent.get(`/api/v1/absence-intervals?from=${day}&to=${day}&employeeId=${emp.id}`).expect(200)).body.total;
      expect(await list('2026-03-31')).toBe(0);
      expect(await list('2026-04-01')).toBe(1);
      const csv = (await owner.agent.get(`/api/v1/reports/absences.csv?from=2026-04-01&to=2026-04-01&employeeId=${emp.id}`).expect(200)).text;
      expect(csv).toContain('2026-04-01 00:15'); // the local column, as read on the wall
    });
  });

  async function session(employeeId: string, shiftId: string, date: string, startUtc = `${date}T03:30:00Z`, endUtc = `${date}T12:30:00Z`) {
    return (await one(
      `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, ended_at, authorization_status)
       VALUES ($1,$2,$3,$4,$5,$6,'SHIFT_COMPLETED',$5,$6,'ENDED') RETURNING id`,
      [employeeId, shiftId, base.workplaceId, date, startUtc, endUtc],
    )).id as string;
  }

  describe('zones far from UTC, where the database clock itself shows the difference', () => {
    // At any moment, one of these two is on a different date from UTC.
    const farZone = () => ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((z) => todayIn(z) !== todayIn('UTC'))!;

    it('a roster entry starting today, and one that ended yesterday, are judged by the shift\'s own date', async () => {
      const zone = farZone();
      const today = todayIn(zone);
      const yesterday = DateTime.fromISO(today).minus({ days: 1 }).toISODate()!;
      const shift = (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'Far','09:00','17:00',$2,$3,30) RETURNING id`, [base.workplaceId, zone, [1, 2, 3, 4, 5, 6, 7]])).id;
      const starting = await createEmployee({ workplaceId: base.workplaceId });
      const ended = await createEmployee({ workplaceId: base.workplaceId });
      await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3)`, [starting.id, shift, today]);
      await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, effective_to) VALUES ($1,$2,'2020-01-01',$3)`, [ended.id, shift, yesterday]);
      const list = (await owner.agent.get('/api/v1/shifts').expect(200)).body;
      expect((list.items ?? list).find((s: any) => s.id === shift).employee_count).toBe(1);
    });

    it('a new roster entry with no start date begins on the shift\'s local today', async () => {
      const zone = farZone();
      const shift = (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'Far2','09:00','17:00',$2,$3,30) RETURNING id`, [base.workplaceId, zone, [1, 2, 3, 4, 5, 6, 7]])).id;
      const emp = await createEmployee({ workplaceId: base.workplaceId });
      await owner.agent.post(`/api/v1/employees/${emp.id}/shifts`).set('X-CSRF-Token', owner.csrf).send({ shiftId: shift }).expect((r) => { expect(r.status).toBeLessThan(300); });
      expect((await one(`SELECT effective_from FROM employee_shift_assignments WHERE employee_id = $1`, [emp.id])).effective_from).toBe(todayIn(zone));
    });
  });

  describe('an overnight shift through the application', () => {
    it('started after midnight belongs to the previous date, including at a month end', async () => {
      const emp = await createEmployee({ workplaceId: base.workplaceId });
      await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2020-01-01')`, [emp.id, night]);
      await q(`INSERT INTO notice_acknowledgements (user_id, notice_version) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [emp.id, DEFAULT_SETTINGS.privacy.version]);
      frozen('2026-03-31T19:00:00Z'); // 00:30 on 1 April in India
      const { signAccessToken } = await import('../src/lib/auth.js');
      const t = await signAccessToken({ id: emp.id, role: 'EMPLOYEE' });
      const res = await request(app).post('/api/v1/tracking/sessions').set({ Authorization: `Bearer ${t}` }).send({ shiftId: night });
      expect(res.status).toBeLessThan(300);
      const s = await one(`SELECT shift_date, scheduled_start_at, scheduled_end_at FROM tracking_sessions WHERE employee_id = $1`, [emp.id]);
      expect(s.shift_date).toBe('2026-03-31');
      expect(new Date(s.scheduled_start_at).toISOString()).toBe('2026-03-31T16:30:00.000Z');
      expect(new Date(s.scheduled_end_at).toISOString()).toBe('2026-04-01T00:30:00.000Z');
    });

    it('counts once, in the month and on the day it started', async () => {
      const emp = await createEmployee({ workplaceId: base.workplaceId });
      await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2020-01-01')`, [emp.id, night]);
      const s = await session(emp.id, night, '2026-01-31', '2026-01-31T16:30:00Z', '2026-02-01T00:30:00Z');
      await q(
        `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, recorded_at)
         VALUES ($1,$2,$3,$4,'2026-01-31',$5,30,'VERIFIED','2026-01-31T16:30:00Z')`,
        [emp.id, base.workplaceId, night, s, `k-${crypto.randomUUID()}`],
      );
      const hours = async (from: string, to: string) => (await owner.agent.get(`/api/v1/reports/hours?from=${from}&to=${to}&employeeId=${emp.id}`).expect(200)).body.rows[0];
      expect(await hours('2026-01-01', '2026-01-31')).toMatchObject({ days: 1, total_minutes: 480 });
      expect(await hours('2026-02-01', '2026-02-28')).toBeUndefined();
      const jan = (await owner.agent.get('/api/v1/reports/monthly?month=2026-01').expect(200)).body.rows.find((r: any) => r.employee_id === emp.id);
      expect(jan).toMatchObject({ present: 1, worked_minutes: 480 });
    });

    it('a no-show alert after midnight is for the night that started, and is sent once', async () => {
      await saveSettingsSection(DEFAULT_ORG_ID, 'alerts', { ...DEFAULT_SETTINGS.alerts, noShowAfterMinutes: 30 }, null);
      const emp = await createEmployee({ workplaceId: base.workplaceId });
      await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2026-03-30')`, [emp.id, night]);
      const now = at('2026-03-31T19:00:00Z');
      await sweepNoShows(now);
      await sweepNoShows(now);
      const n = await q(`SELECT dedupe_key FROM notifications WHERE employee_id = $1 AND type = 'NO_SHOW' AND audience = 'ADMIN'`, [emp.id]);
      expect(n).toHaveLength(1);
      expect(n[0].dedupe_key).toContain('2026-03-31');
    });

    it('a day off that begins at midnight does not cancel the night before', async () => {
      const emp = await createEmployee({ workplaceId: base.workplaceId });
      await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2020-01-01')`, [emp.id, night]);
      await q(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, status, requested_by) VALUES ($1,'SICK','2026-05-02','2026-05-02','Fever','APPROVED',$1)`, [emp.id]);
      const row = async (date: string) => (await owner.agent.get(`/api/v1/reports/overview?date=${date}`).expect(200)).body.roster.find((r: any) => r.employee_id === emp.id && r.shift_id === night);
      expect((await row('2026-05-01')).on_leave).toBeNull();
      expect((await row('2026-05-02')).on_leave).toBeTruthy();
    });
  });
});

describe('the code base', () => {
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const offenders = (pattern: RegExp, except: string[] = []) => sources(src).filter((f) => !except.some((x) => f.replaceAll('\\', '/').endsWith(x)) && pattern.test(fs.readFileSync(f, 'utf8')));

  it('never asks the database for its own idea of today', () => {
    expect(offenders(/CURRENT_DATE|CURRENT_TIME\b|LOCALTIMESTAMP/, ['lib/dates.ts'])).toEqual([]);
  });

  it('never takes a calendar date from a UTC string or from the server\'s zone', () => {
    expect(offenders(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)|DateTime\.now\(\)\.to(ISODate|Format)|new Date\(\)\.get(FullYear|Month|Date)\(\)/)).toEqual([]);
  });

  it('never joins the attendance views directly, which is slow under row-level security', () => {
    expect(offenders(/JOIN attendance_work(_all)? /)).toEqual([]);
  });

  it('never queries the pool directly, which would skip the company setting', () => {
    expect(offenders(/getPool\(\)\.query\(/, ['/app.ts', '/server.ts', '/db/pool.ts'])).toEqual([]); // health checks, and setting up the login
  });
});

it('this file is running under the zone it was asked to', () => {
  if (process.env.EXPECT_TZ) expect(canonicalTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(process.env.EXPECT_TZ);
});

void crypto;
