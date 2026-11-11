/**
 * Owner → Supervisor → Worker hierarchy, bulk roster, the hours / overtime engine, the simplified
 * CSV exports, announcements and the dashboard analytics — including what a supervisor must
 * never see.
 *
 * Layout: site A (seedBase) with worker A; site B with workers B1, B2 and a supervisor of B only.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { DEFAULT_SETTINGS, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { computeHours, splitRecords, type WorkRecord } from '../src/modules/reports/hours.js';
import { adminAgent, assignTeam, createEmployee, createTestDatabase, mobileLogin, seedBase, WP } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
type Agent = { agent: ReturnType<typeof request.agent>; csrf: string };
let owner: Agent;
let sup: Agent & { id: string };
let siteB: string;
let shiftB: string;
let empA: { id: string; email: string };
let empB1: { id: string; email: string };
let empB2: { id: string; email: string };

const D = (iso: string, hhmm: string) => `${iso}T${hhmm}:00Z`;
const daysAgo = (n: number) => DateTime.utc().minus({ days: n }).toISODate()!;

/** A finished, tracked shift with attendance: scheduled start–end, attendance at `recorded`, ended at `ended`. */
async function work(o: {
  emp: string; shift: string; wp: string; date: string; start?: string; end?: string; recorded?: string; ended?: string;
  overnight?: boolean; unpaidBreakMin?: number; approvedOtMin?: number; expired?: boolean; simulated?: boolean;
}) {
  const start = D(o.date, o.start ?? '09:00');
  const endDate = o.overnight ? DateTime.fromISO(o.date).plus({ days: 1 }).toISODate()! : o.date;
  const end = D(endDate, o.end ?? '17:00');
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, ended_at, authorization_status, is_simulated)
     VALUES ($1,$2,$3,$4,$5,$6,'SHIFT_COMPLETED',$5,$7,$8,$9) RETURNING id`,
    [o.emp, o.shift, o.wp, o.date, start, end, o.ended ?? end, o.expired ? 'EXPIRED' : 'ENDED', !!o.simulated],
  );
  const ar = await one(
    `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, recorded_at, is_simulated)
     VALUES ($1,$2,$3,$4,$5,$6,30,'VERIFIED',$7,$8) RETURNING id`,
    [o.emp, o.wp, o.shift, s.id, o.date, crypto.randomUUID(), o.recorded ?? start, !!o.simulated],
  );
  if (o.unpaidBreakMin) {
    const bs = DateTime.fromISO(start).plus({ hours: 3 });
    await q(
      `INSERT INTO session_breaks (session_id, employee_id, workplace_id, type_key, type_label, paid, max_minutes, started_at, ended_at, end_reason, start_latitude, start_longitude, start_accuracy_m, start_distance_m)
       VALUES ($1,$2,$3,'LUNCH','Lunch',false,60,$4,$5,'EMPLOYEE',0,0,5,0)`,
      [s.id, o.emp, o.wp, bs.toISO(), bs.plus({ minutes: o.unpaidBreakMin }).toISO()],
    );
  }
  if (o.approvedOtMin) {
    await q(
      `INSERT INTO overtime_entries (session_id, attendance_id, employee_id, workplace_id, shift_date, started_at, ended_at, end_reason, start_latitude, start_longitude, start_accuracy_m, start_distance_m, status, approved_minutes, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'EMPLOYEE',0,0,5,0,'APPROVED',$8,now())`,
      [s.id, ar.id, o.emp, o.wp, o.date, end, DateTime.fromISO(end).plus({ minutes: o.approvedOtMin }).toISO(), o.approvedOtMin],
    );
  }
  return { sessionId: s.id as string, attendanceId: ar.id as string };
}

const csvRows = (text: string) => text.replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(','));

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp();
  base = await seedBase();
  owner = await adminAgent(app);
  const b = (await owner.agent.post('/api/v1/workplaces').set('X-CSRF-Token', owner.csrf).send({ name: 'Site B', latitude: WP.lat + 0.2, longitude: WP.lng, radiusM: 50, timezone: 'UTC', minStaff: 3 }).expect(201)).body;
  siteB = b.id;
  expect(b.min_staff).toBe(3);
  shiftB = (await owner.agent.post('/api/v1/shifts').set('X-CSRF-Token', owner.csrf).send({ workplaceId: siteB, name: 'B day', startTime: '09:00', endTime: '17:00', timezone: 'UTC', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], arrivalGraceMinutes: 10 }).expect(201)).body.id;
  empA = await createEmployee({ workplaceId: base.workplaceId });
  empB1 = await createEmployee({ workplaceId: siteB });
  empB2 = await createEmployee({ workplaceId: siteB });
  await q(`UPDATE users SET full_name = 'Alice A' WHERE id = $1`, [empA.id]);
  await q(`UPDATE users SET full_name = 'Bob B1' WHERE id = $1`, [empB1.id]);
  await q(`UPDATE users SET full_name = 'Cara B2' WHERE id = $1`, [empB2.id]);
  const email = `sup-${crypto.randomUUID()}@w.test`;
  const added = (await owner.agent.post('/api/v1/team').set('X-CSRF-Token', owner.csrf).send({ fullName: 'Sam Supervisor', email, access: 'SUPERVISOR', siteIds: [siteB] }).expect(201)).body;
  const agent = request.agent(app);
  await q('UPDATE users SET must_change_password = false WHERE email = $1', [email]); // the temporary-password rule has its own test
  const login = await agent.post('/api/v1/auth/login').send({ email, password: added.temporaryPassword, client: 'web' }).expect(200);
  sup = { agent, csrf: login.body.csrfToken, id: added.admin.id };
});
// Phase I visibility policy: a supervisor sees only their own team at their sites. The hierarchy tests below put
// Bob B1 in Sam's team; tests where Sam acts on Cara B2 too put her in it first (assigning twice changes nothing).
const bothInSamsTeam = () => assignTeam(sup.id, empB1.id, empB2.id);
afterAll(async () => {
  await db.drop();
});

describe('hours engine (pure)', () => {
  const rec = (date: string, worked: number | null, ot = 0, extra: Partial<WorkRecord> = {}): WorkRecord => ({
    employee_id: 'e1', full_name: 'E', shift_date: date, workplace_id: 'w', worked_minutes: worked, overtime_minutes: ot, in_progress: false, incomplete: false, ...extra,
  });
  const exact = { roundingMinutes: 0, weeklyRegularHours: 0 };

  it('counts distinct work dates, sums net time and keeps overtime inside the total', () => {
    const [e] = computeHours([rec('2026-03-02', 240), rec('2026-03-02', 200), rec('2026-03-03', 480, 60)], exact, '2026-03-01', '2026-03-31');
    expect(e!.days).toBe(2); // two sessions on the same date are one day
    expect(e!.total_minutes).toBe(240 + 200 + 480 + 60);
    expect(e!.overtime_minutes).toBe(60);
    expect(e!.regular_minutes + e!.overtime_minutes).toBe(e!.total_minutes);
  });

  it('rounds each record to the configured step', () => {
    const [e] = computeHours([rec('2026-03-02', 52), rec('2026-03-03', 38)], { roundingMinutes: 15, weeklyRegularHours: 0 }, '2026-03-01', '2026-03-31');
    expect(e!.total_minutes).toBe(45 + 45);
  });

  it('moves regular time beyond the weekly limit to overtime, using the whole week even if the range starts mid-week', () => {
    // Mon..Fri 9 h each = 45 h; limit 40 h → 5 h overtime, all on Friday.
    const recs = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'].map((d) => rec(d, 540));
    const policy = { roundingMinutes: 0, weeklyRegularHours: 40 };
    const [full] = computeHours(recs, policy, '2026-03-02', '2026-03-08');
    expect(full!.overtime_minutes).toBe(300);
    expect(full!.total_minutes).toBe(2700);
    // Only Friday in range: the week's earlier days still count toward the limit.
    const [fri] = computeHours(recs, policy, '2026-03-06', '2026-03-06');
    expect(fri!.days).toBe(1);
    expect(fri!.total_minutes).toBe(540);
    expect(fri!.overtime_minutes).toBe(300);
    expect(splitRecords(recs, policy, '2026-03-02', '2026-03-08').reduce((n, r) => n + r.overtime, 0)).toBe(300);
  });

  it('counts a manual record (no session) as a day with unknown hours', () => {
    const [e] = computeHours([rec('2026-03-02', null)], exact, '2026-03-01', '2026-03-31');
    expect(e!.days).toBe(1);
    expect(e!.total_minutes).toBe(0);
    expect(e!.unmeasured).toBe(1);
  });
});

describe('hierarchy: worker → supervisor', () => {
  it('lets the owner assign a supervisor of the worker’s workplace only', async () => {
    const r = await owner.agent.put(`/api/v1/employees/${empB1.id}/supervisor`).set('X-CSRF-Token', owner.csrf).send({ supervisorId: sup.id }).expect(200);
    expect(r.body.supervisor_name).toBe('Sam Supervisor');
    const bad = await owner.agent.put(`/api/v1/employees/${empA.id}/supervisor`).set('X-CSRF-Token', owner.csrf).send({ supervisorId: sup.id }).expect(400);
    expect(bad.body.error.code).toBe('BAD_SUPERVISOR');
    // A supervisor cannot reassign workers, nor reach workers of other sites.
    await sup.agent.put(`/api/v1/employees/${empB2.id}/supervisor`).set('X-CSRF-Token', sup.csrf).send({ supervisorId: sup.id }).expect(403);
    await sup.agent.get(`/api/v1/employees/${empA.id}`).expect(404);
  });

  it('filters employees by supervisor and shows the worker who supervises them', async () => {
    const mine = (await owner.agent.get(`/api/v1/employees?supervisorId=${sup.id}`).expect(200)).body;
    expect(mine.map((e: any) => e.id)).toEqual([empB1.id]);
    const none = (await owner.agent.get('/api/v1/employees?supervisorId=none').expect(200)).body.map((e: any) => e.id);
    expect(none).toContain(empA.id);
    expect(none).not.toContain(empB1.id);
    const token = await mobileLogin(app, empB1.email);
    const a = (await request(app).get('/api/v1/me/assignment').set({ Authorization: `Bearer ${token}` }).expect(200)).body;
    expect(a.supervisor.fullName).toBe('Sam Supervisor');
    // Workers cannot change their own supervisor.
    await request(app).put(`/api/v1/employees/${empB1.id}/supervisor`).set({ Authorization: `Bearer ${token}` }).send({ supervisorId: null }).expect(403);
  });

  it('shows supervisors per workspace, and team sizes', async () => {
    const w = (await owner.agent.get(`/api/v1/workplaces/${siteB}`).expect(200)).body;
    expect(w.supervisors.map((s: any) => s.id)).toEqual([sup.id]);
    const team = (await owner.agent.get('/api/v1/team').expect(200)).body.find((t: any) => t.id === sup.id);
    expect(team.reports_count).toBe(1);
    expect(team.site_workers_count).toBe(2);
  });
});

describe('roster: bulk assignment, scope and clashes', () => {
  const from = DateTime.utc().plus({ days: 30 }).toISODate()!;
  const to = DateTime.utc().plus({ days: 36 }).toISODate()!;

  it('rosters several workers at once and warns about workers away from their home workplace', async () => {
    const r = (await owner.agent.post('/api/v1/roster/bulk').set('X-CSRF-Token', owner.csrf).send({ employeeIds: [empB1.id, empB2.id, empA.id], shiftId: shiftB, effectiveFrom: from, effectiveTo: to, managerId: sup.id, notes: 'Unload the delivery bay' }).expect(200)).body;
    expect(r.created).toBe(3);
    expect(r.results.find((x: any) => x.employeeId === empA.id).warning).toBe('OUTSIDE_HOME_WORKPLACE');
    expect(r.results.find((x: any) => x.employeeId === empB1.id).warning).toBeUndefined();
  });

  it('refuses overlapping entries per worker', async () => {
    const r = (await owner.agent.post('/api/v1/roster/bulk').set('X-CSRF-Token', owner.csrf).send({ employeeIds: [empB1.id], shiftId: shiftB, effectiveFrom: to, effectiveTo: to }).expect(200)).body;
    expect(r.created).toBe(0);
    expect(r.results[0].code).toBe('ROSTER_CLASH');
  });

  it('limits supervisors to their own workers and workplaces', async () => {
    await bothInSamsTeam();
    const later = DateTime.utc().plus({ days: 60 }).toISODate()!;
    const r = (await sup.agent.post('/api/v1/roster/bulk').set('X-CSRF-Token', sup.csrf).send({ employeeIds: [empA.id, empB2.id], shiftId: shiftB, effectiveFrom: later, effectiveTo: later }).expect(200)).body;
    expect(r.results.find((x: any) => x.employeeId === empA.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(r.results.find((x: any) => x.employeeId === empB2.id)).toMatchObject({ ok: true });
    // A shift at a workplace they do not manage is refused.
    const other = (await sup.agent.post('/api/v1/roster/bulk').set('X-CSRF-Token', sup.csrf).send({ employeeIds: [empB2.id], shiftId: base.shiftId, effectiveFrom: later, effectiveTo: later }).expect(200)).body;
    expect(other.results[0]).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    // Single entries follow the same rule.
    await sup.agent.post(`/api/v1/employees/${empB2.id}/shifts`).set('X-CSRF-Token', sup.csrf).send({ shiftId: base.shiftId, effectiveFrom: later, effectiveTo: later }).expect(404);
  });

  it('shows staffing against the workspace target and the worker’s assignment notes', async () => {
    const s = (await owner.agent.get(`/api/v1/roster/staffing?from=${from}&to=${from}`).expect(200)).body;
    const b = s.workplaces.find((w: any) => w.id === siteB);
    expect(b.days[0]).toMatchObject({ rostered: 3, shortage: 0 });
    const nextWeek = DateTime.fromISO(to).plus({ days: 1 }).toISODate()!;
    const later = (await owner.agent.get(`/api/v1/roster/staffing?from=${nextWeek}&to=${nextWeek}`).expect(200)).body;
    expect(later.workplaces.find((w: any) => w.id === siteB).days[0]).toMatchObject({ rostered: 0, shortage: 3 });
    expect(later.unassigned.map((u: any) => u.id)).toEqual(expect.arrayContaining([empA.id, empB1.id]));
    const supView = (await sup.agent.get(`/api/v1/roster/staffing?from=${from}&to=${from}`).expect(200)).body;
    expect(supView.workplaces.map((w: any) => w.id)).toEqual([siteB]);

    const roster = (await owner.agent.get(`/api/v1/roster?from=${from}&to=${to}&workplaceId=${siteB}`).expect(200)).body;
    expect(roster.find((r: any) => r.employee_id === empB1.id).notes).toBe('Unload the delivery bay');
  });
});

describe('attendance totals, CSV exports and scope', () => {
  const d1 = daysAgo(3);
  const d2 = daysAgo(2);
  const d3 = daysAgo(1);

  beforeAll(async () => {
    // B1: two shifts on d1 at site B? (one tracked session per shift and day) — 8 h with a 30 min unpaid break,
    //     plus 1 h approved overtime on d2.
    await work({ emp: empB1.id, shift: shiftB, wp: siteB, date: d1, unpaidBreakMin: 30 });
    await work({ emp: empB1.id, shift: shiftB, wp: siteB, date: d2, approvedOtMin: 60 });
    // B1 also worked a second shift on d2 at site A: still one day.
    await work({ emp: empB1.id, shift: base.shiftId, wp: base.workplaceId, date: d2, start: '18:00', end: '20:00' });
    // B2: overnight 22:00 → 06:00 on d1 (one work date), and a shift on d3 closed by the system without check-out.
    await work({ emp: empB2.id, shift: shiftB, wp: siteB, date: d1, start: '22:00', end: '06:00', overnight: true });
    await work({ emp: empB2.id, shift: shiftB, wp: siteB, date: d3, expired: true });
    // A: one day at site A, arriving 1 h late.
    await work({ emp: empA.id, shift: base.shiftId, wp: base.workplaceId, date: d1, recorded: D(d1, '10:00') });
  });

  it('exports exactly Employee Name, Total Days Worked, Total Hours Worked', async () => {
    const r = await owner.agent.get(`/api/v1/reports/hours.csv?from=${d1}&to=${d3}`).expect(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const rows = csvRows(r.text);
    expect(rows[0]).toEqual(['Employee Name', 'Total Days Worked', 'Total Hours Worked']);
    const by = Object.fromEntries(rows.slice(1).map(([n, d, h]) => [n, [Number(d), h]]));
    expect(by['Bob B1']).toEqual([2, (7.5 + 8 + 1 + 2).toFixed(2)]); // break deducted, overtime included once, 2 sessions on d2 = 1 day
    expect(by['Cara B2']).toEqual([2, '16.00']); // overnight counts as one day of 8 h
    expect(by['Alice A']).toEqual([1, '7.00']); // counted from attendance (late arrival)
    expect(rows.every((row) => row.length === 3)).toBe(true);
  });

  it('exports overtime separately, consistent with total hours', async () => {
    const rows = csvRows((await owner.agent.get(`/api/v1/reports/overtime.csv?from=${d1}&to=${d3}`).expect(200)).text);
    expect(rows[0]).toEqual(['Employee Name', 'Total Overtime Hours']);
    expect(Object.fromEntries(rows.slice(1))).toMatchObject({ 'Bob B1': '1.00', 'Cara B2': '0.00', 'Alice A': '0.00' });
    const preview = (await owner.agent.get(`/api/v1/reports/hours?from=${d1}&to=${d3}`).expect(200)).body.rows;
    for (const e of preview) expect(e.regular_minutes + e.overtime_minutes).toBe(e.total_minutes);
    expect(preview.find((e: any) => e.full_name === 'Cara B2').incomplete).toBe(1);
  });

  it('lists check-out, worked time and overtime per attendance record, matching the hours report', async () => {
    const list = (await owner.agent.get(`/api/v1/attendance?from=${d1}&to=${d3}&limit=50`).expect(200)).body.items;
    const of = (name: string, date: string) => list.filter((r: any) => r.full_name === name && String(r.shift_date).slice(0, 10) === date);
    const [b1d1] = of('Bob B1', d1);
    expect(b1d1).toMatchObject({ worked_minutes: 450, overtime_minutes: 0, incomplete: false }); // 8 h − 30 min unpaid break
    expect(b1d1.checked_out_at).toBeTruthy();
    expect(of('Bob B1', d2).map((r: any) => r.overtime_minutes)).toContain(60);
    const [b2d3] = of('Cara B2', d3);
    expect(b2d3.incomplete).toBe(true); // closed by the system without a check-out
    // Supervisors still see their own sites only.
    const supList = (await sup.agent.get(`/api/v1/attendance?from=${d1}&to=${d3}&limit=50`).expect(200)).body.items;
    expect(supList.some((r: any) => r.full_name === 'Alice A')).toBe(false);
  });

  it('filters by date range', async () => {
    const rows = csvRows((await owner.agent.get(`/api/v1/reports/hours.csv?from=${d3}&to=${d3}`).expect(200)).text);
    expect(rows.slice(1)).toEqual([['Cara B2', '1', '8.00']]);
    const empty = csvRows((await owner.agent.get(`/api/v1/reports/hours.csv?from=2001-01-01&to=2001-01-31`).expect(200)).text);
    expect(empty).toEqual([['Employee Name', 'Total Days Worked', 'Total Hours Worked']]);
    await owner.agent.get(`/api/v1/reports/hours.csv?from=${d3}&to=${d1}`).expect(400);
  });

  it('gives supervisors their workplaces only — work at other sites never appears', async () => {
    const rows = csvRows((await sup.agent.get(`/api/v1/reports/hours.csv?from=${d1}&to=${d3}`).expect(200)).text);
    const by = Object.fromEntries(rows.slice(1).map(([n, d, h]) => [n, [Number(d), h]]));
    expect(by['Alice A']).toBeUndefined();
    expect(by['Bob B1']).toEqual([2, '16.50']); // B1's 2 h at site A are not site B's
    // Filtering for another site's employee or workplace returns nothing instead of leaking it.
    expect(csvRows((await sup.agent.get(`/api/v1/reports/hours.csv?from=${d1}&to=${d3}&employeeId=${empA.id}`).expect(200)).text)).toHaveLength(1);
    expect(csvRows((await sup.agent.get(`/api/v1/reports/overtime.csv?from=${d1}&to=${d3}&workplaceId=${base.workplaceId}`).expect(200)).text)).toHaveLength(1);
    const exports = await q(`SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = $1 AND action = 'report.export'`, [sup.id]);
    expect(exports[0]!.n).toBeGreaterThanOrEqual(3);
  });

  it('applies the configured rounding and weekly overtime to the exports', async () => {
    const before = (await owner.agent.get('/api/v1/settings').expect(200)).body.settings.workforce;
    await owner.agent.put('/api/v1/settings/workforce').set('X-CSRF-Token', owner.csrf).send({ value: { ...before, weeklyRegularHours: 8 } }).expect(200);
    try {
      const preview = (await owner.agent.get(`/api/v1/reports/hours?from=${d1}&to=${d3}`).expect(200)).body.rows;
      for (const e of preview) expect(e.regular_minutes + e.overtime_minutes).toBe(e.total_minutes);
      // Total hours never change with the overtime rule; only the split does.
      expect(preview.find((e: any) => e.full_name === 'Cara B2').total_minutes).toBe(960);
    } finally {
      await owner.agent.put('/api/v1/settings/workforce').set('X-CSRF-Token', owner.csrf).send({ value: before }).expect(200);
    }
  });

  it('counts deactivated employees in the total only, within the caller\'s scope', async () => {
    const url = `/api/v1/analytics/dashboard?from=${d1}&to=${d3}&includeSimulated=false`;
    const before = (await owner.agent.get(url).expect(200)).body.kpis;
    expect(before.allWorkers).toBe(before.totalWorkers);
    await q(`UPDATE users SET is_active = false WHERE id = $1`, [empB1.id]);
    try {
      const o = (await owner.agent.get(url).expect(200)).body.kpis;
      expect(o.totalWorkers).toBe(before.totalWorkers - 1);
      expect(o.allWorkers).toBe(before.allWorkers);
      const s = (await sup.agent.get(url).expect(200)).body.kpis;
      expect(s.allWorkers).toBeLessThan(o.allWorkers); // the other site's people are not theirs to count
    } finally {
      await q(`UPDATE users SET is_active = true WHERE id = $1`, [empB1.id]);
    }
  });

  it('does not report a workplace as short of staff when the view is one employee', async () => {
    const one = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${d1}&to=${d3}&includeSimulated=false&employeeId=${empB1.id}`).expect(200)).body;
    expect(one.byWorkspace.find((w: any) => w.id === siteB)).toMatchObject({ minStaff: 3, shortage: 0 });
    expect(one.byWorkspace.some((w: any) => w.status === 'SHORT')).toBe(false);
    const all = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${d1}&to=${d3}&includeSimulated=false`).expect(200)).body;
    expect(all.byWorkspace.find((w: any) => w.id === siteB).shortage).toBe(Math.max(0, 3 - all.byWorkspace.find((w: any) => w.id === siteB).assignedToday));
  });

  it('builds the dashboard from the same figures, scoped per role', async () => {
    await bothInSamsTeam();
    const o = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${d1}&to=${d3}&includeSimulated=false`).expect(200)).body;
    const hours = (await owner.agent.get(`/api/v1/reports/hours?from=${d1}&to=${d3}`).expect(200)).body.rows;
    expect(o.kpis.totalMinutes).toBe(hours.reduce((n: number, e: any) => n + e.total_minutes, 0));
    expect(o.kpis.overtimeMinutes).toBe(hours.reduce((n: number, e: any) => n + e.overtime_minutes, 0));
    expect(o.kpis.totalWorkers).toBe(3);
    expect(o.kpis.activeWorkspaces).toBe(2);
    expect(o.hoursByDay.reduce((n: number, d: any) => n + d.worked, 0)).toBe(o.kpis.totalMinutes);
    expect(o.byWorkspace.reduce((n: number, w: any) => n + w.totalMinutes, 0)).toBe(o.kpis.totalMinutes);
    expect(o.byWorkspace.reduce((n: number, w: any) => n + w.expected, 0)).toBe(o.summary.expected);
    expect(o.kpis.incomplete).toBe(1);
    expect(o.attention.missingCheckout[0]).toMatchObject({ name: 'Cara B2', date: d3 });
    expect(o.supervisors.map((s: any) => s.name)).toEqual(['Sam Supervisor']);
    expect(o.overtimeByEmployee[0]).toMatchObject({ name: 'Bob B1', overtimeMinutes: 60 });

    const s = (await sup.agent.get(`/api/v1/analytics/dashboard?from=${d1}&to=${d3}&includeSimulated=false`).expect(200)).body;
    expect(s.supervisors).toBeNull();
    expect(s.byWorkspace.map((w: any) => w.id)).toEqual([siteB]);
    expect(s.kpis.totalWorkers).toBe(2);
    expect(JSON.stringify(s)).not.toContain('Alice A');
    // "Filter by supervisor" shows the owner exactly what that supervisor sees.
    const filtered = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${d1}&to=${d3}&includeSimulated=false&supervisorId=${sup.id}`).expect(200)).body;
    expect(filtered.kpis).toEqual(s.kpis);
  });

  it('summarises the period with consistent definitions, compares with the previous period and filters by employee', async () => {
    const o = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${d1}&to=${d3}&includeSimulated=false&compare=true`).expect(200)).body;
    const hours = (await owner.agent.get(`/api/v1/reports/hours?from=${d1}&to=${d3}`).expect(200)).body.rows;
    // Hours and overtime agree with the export; completion adds up to the work records.
    expect(o.summary.totalMinutes).toBe(hours.reduce((n: number, e: any) => n + e.total_minutes, 0));
    expect(o.summary.overtimeMinutes).toBe(60);
    expect(o.summary.incomplete).toBe(1);
    expect(o.summary.completed + o.summary.incomplete + o.summary.inProgress).toBeGreaterThanOrEqual(6);
    // Rate = attended ÷ expected, over the same per-day outcomes the trend shows.
    const expected = o.trend.reduce((n: number, t: any) => n + t.expected, 0);
    const present = o.trend.reduce((n: number, t: any) => n + t.present, 0);
    expect(o.summary).toMatchObject({ expected, present });
    expect(o.summary.attendanceRate).toBe(expected ? Math.min(1, present / expected) : null);
    expect(o.summary.late).toBe(o.trend.reduce((n: number, t: any) => n + t.late, 0));
    // The previous period has the same length and ends the day before.
    const len = o.trend.length;
    expect(DateTime.fromISO(o.previous.to).plus({ days: 1 }).toISODate()).toBe(o.trend[0].date);
    expect(DateTime.fromISO(o.previous.to).diff(DateTime.fromISO(o.previous.from), 'days').days + 1).toBe(len);
    // Without compare=true nothing extra is computed.
    expect((await owner.agent.get(`/api/v1/analytics/dashboard?from=${d1}&to=${d3}&includeSimulated=false`).expect(200)).body.previous).toBeNull();
    // An employee filter narrows the figures to that person.
    const b1 = (await owner.agent.get(`/api/v1/analytics/dashboard?from=${d1}&to=${d3}&includeSimulated=false&employeeId=${empB1.id}`).expect(200)).body;
    expect(b1.kpis.totalWorkers).toBe(1);
    expect(b1.hoursByEmployee.map((e: any) => e.name)).toEqual(['Bob B1']);
    expect(b1.summary.totalMinutes).toBe(hours.find((e: any) => e.full_name === 'Bob B1').total_minutes);
    // Today's breakdown counts each rostered employee once.
    const t = o.todayStatus.breakdown;
    expect(t.onTime + t.late + t.notCheckedIn + t.absent + t.onLeave).toBe(o.kpis.scheduledToday);
  });

  it('summarises attendance exceptions over all filtered records', async () => {
    const r = (await owner.agent.get(`/api/v1/attendance?from=${d1}&to=${d3}&limit=1`).expect(200)).body;
    expect(r.items).toHaveLength(1);
    expect(r.summary.total).toBe(r.total);
    expect(r.summary.total).toBeGreaterThan(1); // counts every match, not just the page
    expect(r.summary.missing_checkout).toBe(1);
    // Exactly the late records the list itself reports (the fixtures insert attendance directly).
    const late = (await owner.agent.get(`/api/v1/attendance?from=${d1}&to=${d3}&late=true&limit=200`).expect(200)).body;
    expect(r.summary.late).toBe(late.total);
    expect(late.summary.total).toBe(late.summary.late);
  });

  it('counts only fresh positions as live, and fresh OUTSIDE readings as outside the geofence', async () => {
    await bothInSamsTeam();
    const today = DateTime.utc().toISODate()!;
    await q(
      `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, last_location_at, last_latitude, last_longitude, last_accuracy_m, last_classification)
       VALUES ($1,$2,$3,$4, now() - interval '1 hour', now() + interval '6 hours', 'TEMPORARILY_AWAY', now() - interval '1 hour', now() - interval '10 seconds', 1, 1, 8, 'OUTSIDE'),
              ($5,$2,$3,$4, now() - interval '1 hour', now() + interval '6 hours', 'PRESENT', now() - interval '1 hour', now() - interval '2 hours', 1, 1, 8, 'INSIDE')`,
      [empB1.id, shiftB, siteB, today, empB2.id],
    );
    const s = (await sup.agent.get(`/api/v1/analytics/dashboard?includeSimulated=false`).expect(200)).body;
    expect(s.kpis.liveLocated).toBe(1); // the 2-hour-old position is stale, not live
    expect(s.kpis.outsideGeofence).toBe(1);
    // The live feed also lists shifts that ended in the last 12 hours (a fixture shift from yesterday
    // can be one, depending on the time of day), so compare the open ones.
    const live = (await owner.agent.get(`/api/v1/tracking/live?supervisorId=${sup.id}`).expect(200)).body.sessions.filter((x: any) => !x.ended_at);
    expect(live.map((x: any) => x.employee_id).sort()).toEqual([empB1.id, empB2.id].sort());
    expect(live.find((x: any) => x.employee_id === empB2.id).is_stale).toBe(true);
    expect(live.find((x: any) => x.employee_id === empB1.id).supervisor_name).toBe('Sam Supervisor');
  });
});

describe('announcements', () => {
  it('lets a supervisor publish to their workplace; only its workers see it', async () => {
    const a = (await sup.agent.post('/api/v1/broadcasts').set('X-CSRF-Token', sup.csrf).send({ title: 'Gate 2 closed', body: 'Use gate 1 today.', workplaceId: siteB }).expect(201)).body;
    await sup.agent.post('/api/v1/broadcasts').set('X-CSRF-Token', sup.csrf).send({ title: 'All', body: 'x' }).expect(409); // company-wide is owners only
    const tB = await mobileLogin(app, empB2.email);
    const tA = await mobileLogin(app, empA.email);
    expect((await request(app).get('/api/v1/broadcasts/mine').set({ Authorization: `Bearer ${tB}` }).expect(200)).body.map((x: any) => x.id)).toContain(a.id);
    expect((await request(app).get('/api/v1/broadcasts/mine').set({ Authorization: `Bearer ${tA}` }).expect(200)).body.map((x: any) => x.id)).not.toContain(a.id);

    // Pin, then archive: archived announcements disappear for workers but are kept.
    const pinned = (await sup.agent.patch(`/api/v1/broadcasts/${a.id}`).set('X-CSRF-Token', sup.csrf).send({ pinned: true, body: 'Use gate 1 until noon.' }).expect(200)).body;
    expect(pinned).toMatchObject({ pinned: true, body: 'Use gate 1 until noon.', updated_by_name: 'Sam Supervisor' });
    await sup.agent.post(`/api/v1/broadcasts/${a.id}/archive`).set('X-CSRF-Token', sup.csrf).send({ archived: true }).expect(200);
    expect((await request(app).get('/api/v1/broadcasts/mine').set({ Authorization: `Bearer ${tB}` }).expect(200)).body.map((x: any) => x.id)).not.toContain(a.id);
    expect((await owner.agent.get('/api/v1/broadcasts?status=archived').expect(200)).body.map((x: any) => x.id)).toContain(a.id);
    expect((await one('SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1', [a.id])).n).toBe(2);
  });

  it('keeps company-wide announcements out of supervisors’ reach and honours the owner’s switch', async () => {
    const all = (await owner.agent.post('/api/v1/broadcasts').set('X-CSRF-Token', owner.csrf).send({ title: 'Holiday', body: 'Closed on Monday.', pinned: true }).expect(201)).body;
    await sup.agent.patch(`/api/v1/broadcasts/${all.id}`).set('X-CSRF-Token', sup.csrf).send({ pinned: false }).expect(404);
    const tB = await mobileLogin(app, empB1.email);
    expect((await request(app).get('/api/v1/broadcasts/mine').set({ Authorization: `Bearer ${tB}` }).expect(200)).body[0]).toMatchObject({ id: all.id, pinned: true });

    await saveSettingsSection(base.orgId, 'workforce', { ...DEFAULT_SETTINGS.workforce, deviceBinding: 'OFF', faceEnrollment: 'OFF', supervisorAnnouncements: false }, null);
    const r = await sup.agent.post('/api/v1/broadcasts').set('X-CSRF-Token', sup.csrf).send({ title: 'x', body: 'y', workplaceId: siteB }).expect(403);
    expect(r.body.error.message).toMatch(/turned off/);
    await saveSettingsSection(base.orgId, 'workforce', { ...DEFAULT_SETTINGS.workforce, deviceBinding: 'OFF', faceEnrollment: 'OFF' }, null);
  });
});

describe('keeping links consistent', () => {
  it('unlinks workers when their supervisor no longer manages their workplace', async () => {
    await owner.agent.put(`/api/v1/workplaces/${siteB}/supervisors`).set('X-CSRF-Token', owner.csrf).send({ supervisorIds: [] }).expect(409); // would leave Sam with no site
    await owner.agent.patch(`/api/v1/team/${sup.id}`).set('X-CSRF-Token', owner.csrf).send({ siteIds: [siteB, base.workplaceId] }).expect(200);
    await owner.agent.put(`/api/v1/workplaces/${siteB}/supervisors`).set('X-CSRF-Token', owner.csrf).send({ supervisorIds: [] }).expect(200);
    expect((await one('SELECT supervisor_id FROM employee_profiles WHERE user_id = $1', [empB1.id])).supervisor_id).toBeNull();
    const audit = await one(`SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('employee.assign_supervisor', 'workplace.supervisors', 'roster.bulk_assign')`);
    expect(audit.n).toBeGreaterThanOrEqual(3);
  });
});

describe('pre-launch hardening', () => {
  it('stores a 09:00 India shift start as 03:30 UTC and canonicalises the legacy zone name', async () => {
    const { instanceFor } = await import('../src/lib/shift-window.js');
    const inst = instanceFor({ start_time: '09:00', end_time: '18:00', timezone: 'Asia/Kolkata', days_of_week: [1, 2, 3, 4, 5, 6, 7] }, DateTime.fromISO('2026-11-03', { zone: 'Asia/Kolkata' }), 60, 30);
    expect(inst.startsAt.toISOString()).toBe('2026-11-03T03:30:00.000Z');
    expect(inst.endsAt.toISOString()).toBe('2026-11-03T12:30:00.000Z');
    const night = instanceFor({ start_time: '22:00', end_time: '06:00', timezone: 'Asia/Kolkata', days_of_week: [1, 2, 3, 4, 5, 6, 7] }, DateTime.fromISO('2026-11-03', { zone: 'Asia/Kolkata' }), 0, 0);
    expect(night.endsAt.toISOString()).toBe('2026-11-04T00:30:00.000Z'); // overnight: ends the next morning

    const wp = (await owner.agent.post('/api/v1/workplaces').set('X-CSRF-Token', owner.csrf).send({ name: 'Kolkata alias', latitude: WP.lat + 0.3, longitude: WP.lng, radiusM: 100, timezone: 'Asia/Calcutta' }).expect(201)).body;
    expect(wp.timezone).toBe('Asia/Kolkata');
    const sh = (await owner.agent.post('/api/v1/shifts').set('X-CSRF-Token', owner.csrf).send({ workplaceId: wp.id, name: 'Day', startTime: '09:00', endTime: '18:00', timezone: 'Asia/Calcutta', daysOfWeek: [1, 2, 3, 4, 5] }).expect(201)).body;
    expect(sh.timezone).toBe('Asia/Kolkata');
  });

  it('refuses a shift over 16 hours unless it is confirmed, and geofences under 50 m', async () => {
    const send = (body: object) => owner.agent.post('/api/v1/shifts').set('X-CSRF-Token', owner.csrf).send({ workplaceId: siteB, name: 'All day', startTime: '00:00', endTime: '23:59', timezone: 'UTC', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], ...body });
    expect((await send({}).expect(400)).body.error.code).toBe('LONG_SHIFT_UNCONFIRMED');
    const ok = (await send({ confirmLongShift: true }).expect(201)).body;
    // Shortening needs no confirmation; lengthening an existing shift again does.
    await owner.agent.patch(`/api/v1/shifts/${ok.id}`).set('X-CSRF-Token', owner.csrf).send({ startTime: '09:00', endTime: '18:00' }).expect(200);
    expect((await owner.agent.patch(`/api/v1/shifts/${ok.id}`).set('X-CSRF-Token', owner.csrf).send({ endTime: '08:00' }).expect(400)).body.error.code).toBe('LONG_SHIFT_UNCONFIRMED');
    // A 20:00–06:00 overnight shift is 10 hours: fine without confirmation.
    await send({ startTime: '20:00', endTime: '06:00', name: 'Night' }).expect(201);

    const small = await owner.agent.post('/api/v1/workplaces').set('X-CSRF-Token', owner.csrf).send({ name: 'Tiny', latitude: WP.lat + 0.4, longitude: WP.lng, radiusM: 20, timezone: 'UTC' }).expect(400);
    expect(small.body.error.code).toBe('RADIUS_NOT_PERMITTED');
    const settings = await owner.agent.put('/api/v1/settings/geofence').set('X-CSRF-Token', owner.csrf).send({ value: { presetsM: [20, 100], minRadiusM: 20, maxRadiusM: 1000 } }).expect(400);
    expect(settings.body.error.code).toBe('RADIUS_TOO_SMALL');
  });

  it('gives thumbnail links only for records the administrator may see, in one audit entry', async () => {
    // A record at a site the supervisor does not manage (earlier tests move their sites around).
    const sites: string[] = (await one('SELECT site_ids FROM administrator_profiles WHERE user_id = $1', [sup.id])).site_ids;
    const [emp, wp, shift] = sites.includes(base.workplaceId) ? [empB1.id, siteB, shiftB] : [empA.id, base.workplaceId, base.shiftId];
    const key = `test/${crypto.randomUUID()}.jpg`;
    const photo = await one(
      `INSERT INTO attendance_photos (employee_id, object_key, content_type, declared_bytes, idempotency_key, upload_expires_at, status, purpose)
       VALUES ($1, $2, 'image/jpeg', 100, $2, now(), 'ATTACHED', 'ENROLLMENT') RETURNING id`, // no session needed; the endpoint goes by the record
      [emp, key],
    );
    const rec = await one(
      `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, shift_date, idempotency_key, radius_m_at_record, verification_status, photo_id)
       VALUES ($1, $2, $3, CURRENT_DATE - 40, $4, 100, 'VERIFIED', $5) RETURNING id`,
      [emp, wp, shift, `t-${crypto.randomUUID()}`, photo.id],
    );
    const mine = (await owner.agent.post('/api/v1/attendance/photo-thumbnails').set('X-CSRF-Token', owner.csrf).send({ ids: [rec.id] }).expect(200)).body;
    expect(Object.keys(mine.urls)).toEqual([rec.id]);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'attendance_photo.view_list' AND after_data->'photos' ? $1`, [photo.id])).toHaveLength(1);
    // Changing the id in the request does not reach another workspace: the record is left out.
    const theirs = (await sup.agent.post('/api/v1/attendance/photo-thumbnails').set('X-CSRF-Token', sup.csrf).send({ ids: [rec.id] }).expect(200)).body;
    expect(theirs.urls).toEqual({});
    await sup.agent.get(`/api/v1/attendance/${rec.id}`).expect(404);
  });
});
