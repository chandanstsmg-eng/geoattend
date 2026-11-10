/**
 * Dashboard analytics for owners and supervisors, aggregated on the server.
 *
 * Every number comes from stored records and is limited to the caller's scope: a supervisor sees
 * their workplaces only, and the optional workplace / supervisor filters narrow every section
 * together (KPIs, charts and tables answer the same question). Definitions:
 *
 *   totalWorkers       active workers whose home workplace is in scope
 *   allWorkers         the same with deactivated workers included (history stays, so they still exist)
 *   checkedIn          open shift sessions with attendance recorded (checked in, not yet out)
 *   liveLocated        open sessions whose newest location is fresher than Settings › tracking ›
 *                      staleAfterSec — a stale position never counts as live
 *   outsideGeofence    live-located sessions whose newest reading is clearly OUTSIDE the
 *                      workplace area (declared breaks excluded; overtime may be worked off-site
 *                      and is counted, so the number is "where they are", not a violation)
 *   notCheckedIn       rostered today, no attendance yet, not on leave or a holiday
 *   hours / overtime   reports/hours.ts — the same figures as the CSV exports
 *   incomplete         sessions closed by the system without a check-out (or still open after
 *                      their scheduled end)
 *   expected           rostered shifts on past days and today, excluding approved leave and holidays
 *                      (today: only shifts with an outcome — checked in, no-show or over)
 *   attendanceRate     shifts with attendance ÷ expected shifts (null when nothing was expected)
 *   pending            records waiting for verification: left out of present, expected, hours and
 *                      overtime alike, and shown on their own until a person decides
 *   previous           the same summary for the equally long period just before `from`
 *                      (only with compare=true; never estimated)
 *   todayStatus        each employee rostered today counted once: on time, late, not checked in yet,
 *                      absent (no-show or shift over), on leave/holiday. "Location unavailable" is a
 *                      separate overlapping count — a missing location is not an absence.
 */
import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { one, q } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { isoDate, mount, route } from '../../lib/http.js';
import { employeeSite, overtimeCounts, siteFilter, SUPERVISOR_SITES } from '../../lib/tenancy.js';
import type { AuthUser } from '../../lib/auth.js';
import { getSettings } from '../settings/settings.service.js';
import { attended, defaultDate, isPending, roster, withLeaveAndNoShow } from './reports.routes.js';
import { computeHours, loadPendingHours, loadWorkRecords, splitRecords } from './hours.js';
import { dayEndSql } from '../../lib/dates.js';
import { DAY_LOOKUPS_AT_ONCE, mapLimit } from '../../lib/concurrency.js';

/** Longest range the dashboard answers. Attendance and hours always cover the same days; longer asks are refused. */
export const MAX_RANGE_DAYS = 366;
const MAX_TREND_DAYS = MAX_RANGE_DAYS;
const ACTIVITY_TYPES = [
  'ATTENDANCE_MARKED', 'SHIFT_COMPLETED', 'LATE_ARRIVAL', 'NO_SHOW', 'PERMISSION_REVOKED', 'BACKGROUND_UNAVAILABLE',
  'TRACKING_INTERRUPTED', 'ATTENDANCE_SUBMISSION_FAILED', 'MOCK_LOCATION_FLAGGED', 'MANUAL_REVIEW_REQUESTED', 'TECHNICAL_ISSUE_REPORTED', 'TRACKING_TERMINATED',
];
const CHECKED_IN_STATES = new Set(['PRESENT', 'ON_BREAK', 'ON_OVERTIME', 'TEMPORARILY_AWAY', 'PROLONGED_ABSENCE', 'TRACKING_INTERRUPTED', 'TRACKING_PERMISSION_REQUIRED', 'MANUAL_REVIEW_REQUIRED']);

export const dashboardQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  workplaceId: z.uuid().optional(),
  supervisorId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
  includeSimulated: z.enum(['true', 'false']).default('true'),
  compare: z.enum(['true', 'false']).default('false'),
});

type DayOutcome = { date: string; scheduled: number; expected: number; present: number; pending: number; late: number; absent: number; leave: number; incomplete: number };

/** One day's roster outcome. Past days: no attendance = absent; today: only no-shows and finished shifts. */
function dayOutcome(rows: any[], date: string, today: string): DayOutcome {
  return {
    date,
    scheduled: rows.length,
    // Today, a shift only counts once it has an outcome — one that has not started yet is not missed.
    expected: rows.filter((r) => !isPending(r) && !r.on_leave && !r.holiday && (date < today || r.attendance_id || r.no_show || r.ended_at)).length,
    // Work on a holiday or a leave day is not part of the rate: those days are not expected either.
    present: rows.filter((r) => attended(r) && !r.on_leave && !r.holiday).length,
    pending: rows.filter(isPending).length,
    late: rows.filter((r) => r.is_late).length,
    absent: rows.filter((r) => !r.attendance_id && !r.on_leave && !r.holiday && (date < today || r.no_show || r.ended_at)).length,
    leave: rows.filter((r) => r.on_leave && !r.attendance_id).length,
    incomplete: 0,
  };
}

/** Period totals from day outcomes and split work records — the same definitions for any period. */
function summarize(days: DayOutcome[], split: Array<{ total: number; overtime: number; incomplete: boolean; in_progress: boolean; employee_id: string }>) {
  const sum = (k: keyof DayOutcome) => days.reduce((n, d) => n + (d[k] as number), 0);
  const expected = sum('expected');
  const present = sum('present');
  const employees = new Set(split.map((r) => r.employee_id)).size;
  const totalMinutes = split.reduce((n, r) => n + r.total, 0);
  return {
    expected,
    present,
    late: sum('late'),
    onTime: present - sum('late'),
    absent: sum('absent'),
    pending: sum('pending'),
    attendanceRate: expected ? Math.min(1, present / expected) : null,
    punctualityRate: present ? (present - sum('late')) / present : null,
    totalMinutes,
    overtimeMinutes: split.reduce((n, r) => n + r.overtime, 0),
    employeesWorked: employees,
    avgMinutesPerEmployee: employees ? Math.round(totalMinutes / employees) : null,
    completed: split.filter((r) => !r.incomplete && !r.in_progress).length,
    incomplete: split.filter((r) => r.incomplete).length,
    inProgress: split.filter((r) => r.in_progress && !r.incomplete).length,
  };
}

const isoDays = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = DateTime.fromISO(from); d.toISODate()! <= to; d = d.plus({ days: 1 })) out.push(d.toISODate()!);
  return out;
};

/** The later of `from` and the first of the last MAX_TREND_DAYS days ending `to`. */
const lastDays = (from: string, to: string) => {
  const start = DateTime.fromISO(to).minus({ days: MAX_TREND_DAYS - 1 }).toISODate()!;
  return start > from ? start : from;
};

const inc = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

export async function dashboard(user: AuthUser, query: z.infer<typeof dashboardQuery>) {
  const settings = await getSettings(user.orgId);
  const today = await defaultDate(user.orgId, query.workplaceId);
  const to = query.to ?? today;
  const askedFrom = query.from ?? DateTime.fromISO(to).minus({ days: 13 }).toISODate()!;
  if (to < askedFrom) throw badRequest('BAD_RANGE', 'The end date is before the start date.');
  // At most a year, ending at the last day that has happened. Hours and attendance always cover these same days;
  // a longer request is answered for its latest year, and `limited` says so.
  const lastReal = to < today ? to : today;
  const earliest = DateTime.fromISO(lastReal).minus({ days: MAX_RANGE_DAYS - 1 }).toISODate()!;
  const from = askedFrom < earliest ? earliest : askedFrom;
  const limited = from !== askedFrom;
  const includeSim = query.includeSimulated === 'true';
  const wp = query.workplaceId ?? null;
  const sup = query.supervisorId ?? null;
  const emp = query.employeeId ?? null;
  // $1 company, $2 caller's sites (null = owner), $3 workplace filter, $4 supervisor filter, $5 include simulated
  const P = [user.orgId, user.sites, wp, sup, includeSim];
  const inScope = (expr: string) => `${siteFilter(expr, '$2')} AND ($3::uuid IS NULL OR ${expr} = $3) AND ($4::uuid IS NULL OR ${expr} = ANY(${SUPERVISOR_SITES('$4')}))`;
  const supSites = sup ? new Set<string>((await one(`SELECT ${SUPERVISOR_SITES('$1')} AS s`, [sup])).s) : null;
  const keep = (wpId: string) => !supSites || supSites.has(wpId);
  const keepRow = (r: { workplace_id: string; employee_id: string }) => keep(r.workplace_id) && (!emp || r.employee_id === emp);
  const dayRows = async (date: string) => (await withLeaveAndNoShow(user.orgId, date, await roster(user.orgId, date, wp, includeSim, user.sites))).filter(keepRow);
  const workFor = (f: string, t: string) => loadWorkRecords(user, { from: f, to: t, workplaceId: wp, supervisorId: sup, employeeId: emp, includeSimulated: includeSim });

  // ── workplaces and workers in scope ──
  const workplaces = await q(
    `SELECT w.id, w.name, w.min_staff, w.latitude, w.longitude, w.radius_m::float AS radius_m,
            (SELECT count(*)::int FROM workplace_assignments wa JOIN users u ON u.id = wa.employee_id
              WHERE wa.workplace_id = w.id AND wa.effective_to IS NULL AND u.is_active AND u.role = 'EMPLOYEE' AND ($5 OR NOT u.is_demo)) AS home_workers
     FROM workplaces w WHERE w.org_id = $1 AND w.is_active AND ${inScope('w.id')} ORDER BY w.name`,
    P,
  );
  const workers = await one(
    `SELECT count(*) FILTER (WHERE u.is_active)::int AS n, count(*)::int AS all_workers FROM users u LEFT JOIN workplace_assignments wa ON wa.employee_id = u.id AND wa.effective_to IS NULL
     WHERE u.org_id = $1 AND u.role = 'EMPLOYEE' AND ($5 OR NOT u.is_demo) AND ($6::uuid IS NULL OR u.id = $6)
       AND (($2::uuid[] IS NULL AND $3::uuid IS NULL AND $4::uuid IS NULL) OR (wa.workplace_id IS NOT NULL AND ${inScope('wa.workplace_id')}))`,
    [...P, emp],
  );

  // ── live, right now ──
  const open = await q(
    `SELECT s.id, s.employee_id, u.full_name, s.state, s.workplace_id, s.last_location_at, s.last_classification, s.sim_clock_offset_sec, (ar.id IS NOT NULL) AS checked_in
     FROM tracking_sessions s JOIN users u ON u.id = s.employee_id
     LEFT JOIN attendance_records ar ON ar.session_id = s.id AND ar.verification_status <> 'VOIDED'
     WHERE s.ended_at IS NULL AND u.org_id = $1 AND ${inScope('s.workplace_id')} AND ($5 OR NOT s.is_simulated) AND ($6::uuid IS NULL OR s.employee_id = $6)`,
    [...P, emp],
  );
  const nowMs = Date.now();
  const fresh = (s: any) => !!s.last_location_at && nowMs + s.sim_clock_offset_sec * 1000 - new Date(s.last_location_at).getTime() <= settings.tracking.staleAfterSec * 1000;
  const checkedIn = open.filter((s) => s.checked_in && CHECKED_IN_STATES.has(s.state));
  const located = open.filter(fresh);
  const outside = located.filter((s) => s.last_classification === 'OUTSIDE' && s.state !== 'ON_BREAK');

  // ── daily roster outcomes (same rules as the overview and monthly summary) ──
  // Days after today have no outcome yet.
  const trendTo = to < today ? to : today;
  const days = trendTo >= from ? isoDays(lastDays(from, trendTo), trendTo) : [];
  const expectedByWp = new Map<string, number>();
  const presentByWp = new Map<string, number>();
  const lateByWp = new Map<string, number>();
  const trend: DayOutcome[] = [];
  let todayRows: any[] = [];
  // Looked up a few days at a time, then processed in date order exactly as before.
  const rowsByDay = await mapLimit(days, DAY_LOOKUPS_AT_ONCE, (date) => dayRows(date));
  for (const [i, date] of days.entries()) {
    const rows = rowsByDay[i]!;
    if (date === today) todayRows = rows;
    for (const r of rows) {
      if (r.on_leave || r.holiday || isPending(r)) continue;
      // As in dayOutcome: today, a shift that has not started has no outcome yet, so it is not missed.
      if (date >= today && !r.attendance_id && !r.no_show && !r.ended_at) continue;
      inc(expectedByWp, r.workplace_id);
      if (r.attendance_id) inc(presentByWp, r.workplace_id);
      if (r.is_late) inc(lateByWp, r.workplace_id);
    }
    trend.push(dayOutcome(rows, date, today));
  }
  if (!days.includes(today)) todayRows = await dayRows(today);
  const waitingToday = todayRows.filter((r) => !r.attendance_id && !r.on_leave && !r.holiday);
  const absentToday = todayRows.filter((r) => !r.attendance_id && !r.on_leave && !r.holiday && (r.no_show || r.ended_at));

  // ── hours, overtime and worksite time over the period ──
  const records = await workFor(from, to);
  const split = splitRecords(records, settings.workforce, from, to);
  const perEmployee = computeHours(records, settings.workforce, from, to);
  const byDay = new Map<string, { worked: number; scheduled: number; overtime: number }>();
  const byWpHours = new Map<string, { total: number; overtime: number; employees: Map<string, { name: string; minutes: number }> }>();
  const byWeek = new Map<string, number>();
  for (const r of split) {
    const d = byDay.get(r.shift_date) ?? { worked: 0, scheduled: 0, overtime: 0 };
    d.worked += r.total;
    d.scheduled += r.scheduled_minutes ?? 0;
    d.overtime += r.overtime;
    byDay.set(r.shift_date, d);
    const w = byWpHours.get(r.workplace_id) ?? { total: 0, overtime: 0, employees: new Map() };
    w.total += r.total;
    w.overtime += r.overtime;
    const e = w.employees.get(r.employee_id) ?? { name: r.full_name, minutes: 0 };
    e.minutes += r.total;
    w.employees.set(r.employee_id, e);
    byWpHours.set(r.workplace_id, w);
    inc(byWeek, DateTime.fromISO(r.shift_date).startOf('week').toISODate()!, r.overtime);
    if (r.incomplete) {
      const t = trend.find((x) => x.date === r.shift_date);
      if (t) t.incomplete++;
    }
  }
  // Time without location evidence (tracking interrupted / permission missing) per workplace: worked
  // time is attendance duration, not proof of continuous presence; this shows how much is uncertain.
  const gaps = new Map<string, number>(
    (
      await q(
        `WITH t AS (
           SELECT s.workplace_id, x.to_state, x.at, LEAD(x.at) OVER (PARTITION BY x.session_id ORDER BY x.at, x.id) AS next_at, s.ended_at
           FROM session_state_transitions x JOIN tracking_sessions s ON s.id = x.session_id JOIN users u ON u.id = s.employee_id
           WHERE u.org_id = $1 AND ${inScope('s.workplace_id')} AND ($5 OR NOT s.is_simulated) AND s.shift_date BETWEEN $6::date AND $7::date)
         SELECT workplace_id, COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(next_at, ended_at, now()) - at))) / 60), 0)::int AS minutes
         FROM t WHERE to_state IN ('TRACKING_INTERRUPTED', 'TRACKING_PERMISSION_REQUIRED') GROUP BY workplace_id`,
        [...P, from, to],
      )
    ).map((r) => [r.workplace_id, r.minutes]),
  );

  const totalMinutes = split.reduce((n, r) => n + r.total, 0);
  const overtimeMinutes = split.reduce((n, r) => n + r.overtime, 0);
  const pendingMinutes = (await loadPendingHours(user, { from, to, workplaceId: wp, supervisorId: sup, employeeId: emp, includeSimulated: includeSim })).reduce((n, p) => n + p.minutes, 0);
  const summary = { from: days[0] ?? from, to: trendTo, ...summarize(trend, split), pendingMinutes };

  // The equally long period just before, judged by exactly the same rules (opt-in: it doubles the work).
  let previous: (typeof summary) | null = null;
  if (query.compare === 'true' && days.length) {
    const len = days.length;
    const pTo = DateTime.fromISO(days[0]!).minus({ days: 1 }).toISODate()!;
    const pFrom = DateTime.fromISO(pTo).minus({ days: len - 1 }).toISODate()!;
    const pDates = isoDays(pFrom, pTo);
    const pDays: DayOutcome[] = (await mapLimit(pDates, DAY_LOOKUPS_AT_ONCE, (date) => dayRows(date))).map((rows, i) => dayOutcome(rows, pDates[i]!, today));
    const pPending = (await loadPendingHours(user, { from: pFrom, to: pTo, workplaceId: wp, supervisorId: sup, employeeId: emp, includeSimulated: includeSim })).reduce((n, p) => n + p.minutes, 0);
    previous = { from: pFrom, to: pTo, ...summarize(pDays, splitRecords(await workFor(pFrom, pTo), settings.workforce, pFrom, pTo)), pendingMinutes: pPending };
  }

  // Each employee rostered today counted once, in the most advanced state of their shifts.
  const byEmpToday = new Map<string, any[]>();
  for (const r of todayRows) byEmpToday.set(r.employee_id, [...(byEmpToday.get(r.employee_id) ?? []), r]);
  const breakdown = { onTime: 0, late: 0, notCheckedIn: 0, absent: 0, onLeave: 0, pendingVerification: 0 };
  for (const rows of byEmpToday.values()) {
    const att = rows.filter(attended);
    if (att.length) att.some((r) => r.is_late) ? breakdown.late++ : breakdown.onTime++;
    else if (rows.some(isPending)) breakdown.pendingVerification++;
    else if (rows.every((r) => r.on_leave || r.holiday)) breakdown.onLeave++;
    else if (rows.some((r) => !r.on_leave && !r.holiday && (r.no_show || r.ended_at))) breakdown.absent++;
    else breakdown.notCheckedIn++;
  }
  const locationUnavailable = new Set(checkedIn.filter((s) => s.state === 'TRACKING_INTERRUPTED' || s.state === 'TRACKING_PERMISSION_REQUIRED' || !fresh(s)).map((s) => s.employee_id)).size;

  // Overtime claims of shifts in the period, by decision (pending/rejected never count as hours).
  const otStatus = await q(
    `SELECT CASE WHEN o.ended_at IS NULL THEN 'RUNNING' ELSE o.status END AS status, count(*)::int AS n,
            COALESCE(SUM(ROUND(EXTRACT(EPOCH FROM (COALESCE(o.ended_at, now()) - o.started_at)) / 60)), 0)::int AS claimed,
            COALESCE(SUM(o.approved_minutes) FILTER (WHERE o.status = 'APPROVED'), 0)::int AS approved
     FROM overtime_entries o JOIN users u ON u.id = o.employee_id JOIN tracking_sessions s ON s.id = o.session_id
     WHERE u.org_id = $1 AND ${inScope('o.workplace_id')} AND ($5 OR NOT o.is_simulated) AND ($6::uuid IS NULL OR o.employee_id = $6)
       AND s.shift_date BETWEEN $7::date AND $8::date AND ${overtimeCounts()}
     GROUP BY 1`,
    [...P, emp, from, to],
  );
  const otOf = (k: string) => {
    const r = otStatus.find((x) => x.status === k);
    return { count: r?.n ?? 0, claimedMinutes: r?.claimed ?? 0, approvedMinutes: r?.approved ?? 0 };
  };
  const overtimeStatus = { pending: otOf('PENDING'), approved: otOf('APPROVED'), rejected: otOf('REJECTED'), running: otOf('RUNNING') };
  const withOt = perEmployee.filter((e) => e.overtime_minutes > 0);
  const mean = withOt.length ? withOt.reduce((n, e) => n + e.overtime_minutes, 0) / withOt.length : 0;
  const sd = withOt.length ? Math.sqrt(withOt.reduce((n, e) => n + (e.overtime_minutes - mean) ** 2, 0) / withOt.length) : 0;
  const unusual = (e: (typeof perEmployee)[number]) => e.overtime_minutes > 0 && ((withOt.length >= 3 && e.overtime_minutes > mean + 2 * sd) || e.overtime_minutes > 0.25 * e.total_minutes);

  // ── per workplace ──
  const assignedToday = new Map<string, Set<string>>();
  for (const r of todayRows) assignedToday.set(r.workplace_id, (assignedToday.get(r.workplace_id) ?? new Set()).add(r.employee_id));
  const checkedInByWp = new Map<string, number>();
  for (const s of checkedIn) inc(checkedInByWp, s.workplace_id);
  const byWorkspace = workplaces.map((w) => {
    const assigned = assignedToday.get(w.id)?.size ?? 0;
    const absent = new Set(absentToday.filter((r) => r.workplace_id === w.id).map((r) => r.employee_id)).size;
    const h = byWpHours.get(w.id);
    // With one employee selected, `assigned` counts that person only, which says nothing about staffing.
    const shortage = w.min_staff != null && !emp ? Math.max(0, w.min_staff - assigned) : 0;
    return {
      id: w.id,
      name: w.name,
      latitude: w.latitude,
      longitude: w.longitude,
      radiusM: w.radius_m,
      homeWorkers: w.home_workers,
      assignedToday: assigned,
      presentNow: checkedInByWp.get(w.id) ?? 0,
      absentToday: absent,
      minStaff: w.min_staff,
      shortage,
      status: shortage > 0 ? 'SHORT' : absent > 0 ? 'ATTENTION' : 'OK',
      totalMinutes: h?.total ?? 0,
      overtimeMinutes: h?.overtime ?? 0,
      noEvidenceMinutes: gaps.get(w.id) ?? 0,
      completionRate: expectedByWp.get(w.id) ? (presentByWp.get(w.id) ?? 0) / expectedByWp.get(w.id)! : null,
      expected: expectedByWp.get(w.id) ?? 0,
      present: presentByWp.get(w.id) ?? 0,
      late: lateByWp.get(w.id) ?? 0,
      employees: [...(h?.employees.entries() ?? [])].map(([id, e]) => ({ id, name: e.name, minutes: e.minutes })).sort((a, b) => b.minutes - a.minutes).slice(0, 10),
    };
  });

  // ── supervisors (owners only) ──
  let supervisors: any[] | null = null;
  if (!user.sites) {
    const sups = await q(
      `SELECT u.id, u.full_name, ap.site_ids,
              (SELECT count(*)::int FROM employee_profiles ep JOIN users e ON e.id = ep.user_id WHERE ep.supervisor_id = u.id AND e.is_active) AS reports
       FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id
       WHERE u.org_id = $1 AND u.role = 'ADMIN' AND u.is_active AND ap.access = 'SUPERVISOR' AND ($2::uuid IS NULL OR u.id = $2) ORDER BY u.full_name`,
      [user.orgId, sup],
    );
    supervisors = sups.map((s) => {
      const sites = byWorkspace.filter((w) => s.site_ids.includes(w.id));
      const expected = sites.reduce((n, w) => n + (expectedByWp.get(w.id) ?? 0), 0);
      const present = sites.reduce((n, w) => n + (presentByWp.get(w.id) ?? 0), 0);
      return {
        id: s.id,
        name: s.full_name,
        workers: sites.reduce((n, w) => n + w.homeWorkers, 0),
        reports: s.reports,
        checkedIn: sites.reduce((n, w) => n + w.presentNow, 0),
        workspaces: sites.length,
        totalMinutes: sites.reduce((n, w) => n + w.totalMinutes, 0),
        overtimeMinutes: sites.reduce((n, w) => n + w.overtimeMinutes, 0),
        completionRate: expected ? present / expected : null,
      };
    });
  }

  // ── what needs attention, and recent activity ──
  const pendingCorrections = await one(
    `SELECT count(*)::int AS n FROM review_requests r JOIN users u ON u.id = r.employee_id
     WHERE r.status = 'OPEN' AND (r.kind IN ('MANUAL_REVIEW', 'DISPUTE', 'TECHNICAL_ISSUE') OR (r.kind = 'ADMIN_CORRECTION' AND $2::uuid[] IS NULL))
       AND u.org_id = $1 AND ${inScope(employeeSite('u.id'))} AND ($5::uuid IS NULL OR r.employee_id = $5)`, // supervisors' corrections wait for an owner, as in Approvals
    [...P.slice(0, 4), emp],
  );
  const overtimePending = await one(
    `SELECT count(*)::int AS n FROM overtime_entries o JOIN users u ON u.id = o.employee_id
     WHERE o.status = 'PENDING' AND o.ended_at IS NOT NULL AND u.org_id = $1 AND ${inScope('o.workplace_id')} AND ($5 OR NOT o.is_simulated) AND ${overtimeCounts()}
       AND ($6::uuid IS NULL OR o.employee_id = $6)`,
    [...P, emp],
  );
  const activity = await q(
    `SELECT n.id, n.type, n.severity, n.title, n.body, n.created_at, n.employee_id, u.full_name AS employee_name, w.name AS workplace_name, n.is_simulated
     FROM notifications n LEFT JOIN users u ON u.id = n.employee_id LEFT JOIN workplaces w ON w.id = n.workplace_id
     WHERE n.audience = 'ADMIN' AND n.org_id = $1 AND n.type = ANY($6::text[]) AND ${inScope(`COALESCE(n.workplace_id, ${employeeSite('n.employee_id')})`)}
       AND ($5 OR NOT n.is_simulated) AND n.created_at < ${dayEndSql('$7', '$1')} AND ($8::uuid IS NULL OR n.employee_id = $8)
     ORDER BY n.created_at DESC LIMIT 25`,
    [...P, ACTIVITY_TYPES, to, emp],
  );
  const name = (id: string) => records.find((r) => r.employee_id === id)?.full_name ?? open.find((s) => s.employee_id === id)?.full_name ?? '';
  const incompleteList = split.filter((r) => r.incomplete).map((r) => ({ employeeId: r.employee_id, name: r.full_name, date: r.shift_date, workplace: r.workplace_name }));
  const attention = {
    missingCheckout: incompleteList.slice(-20).reverse(),
    locationErrors: open.filter((s) => s.state === 'TRACKING_INTERRUPTED' || s.state === 'TRACKING_PERMISSION_REQUIRED').map((s) => ({ employeeId: s.employee_id, name: s.full_name || name(s.employee_id), state: s.state, since: s.last_location_at })),
    lateToday: todayRows.filter((r) => r.is_late).map((r) => ({ employeeId: r.employee_id, name: r.full_name, minutes: r.late_by_minutes, workplace: r.workplace_name, at: r.recorded_at })),
    noShowToday: todayRows.filter((r) => r.no_show).map((r) => ({ employeeId: r.employee_id, name: r.full_name, workplace: r.workplace_name, shift: r.shift_name, start: String(r.start_time).slice(0, 5) })),
    pendingCorrections: pendingCorrections.n,
    overtimePending: overtimePending.n,
  };

  return {
    from,
    to,
    requestedFrom: askedFrom,
    limited,
    today,
    serverTime: new Date(nowMs),
    staleAfterSec: settings.tracking.staleAfterSec,
    policy: { roundingMinutes: settings.workforce.roundingMinutes, weeklyRegularHours: settings.workforce.weeklyRegularHours },
    kpis: {
      totalWorkers: workers.n,
      allWorkers: workers.all_workers,
      checkedIn: checkedIn.length,
      liveLocated: located.length,
      notCheckedIn: new Set(waitingToday.map((r) => r.employee_id)).size,
      outsideGeofence: outside.length,
      activeWorkspaces: workplaces.length,
      totalMinutes,
      overtimeMinutes,
      incomplete: incompleteList.length,
      scheduledToday: new Set(todayRows.map((r) => r.employee_id)).size,
      absentToday: new Set(absentToday.map((r) => r.employee_id)).size,
    },
    summary,
    previous,
    todayStatus: { breakdown, locationUnavailable },
    overtimeStatus,
    hoursByEmployee: [...perEmployee]
      .sort((a, b) => b.total_minutes - a.total_minutes)
      .slice(0, 15)
      .map((e) => ({ employeeId: e.employee_id, name: e.full_name, days: e.days, totalMinutes: e.total_minutes, overtimeMinutes: e.overtime_minutes, incomplete: e.incomplete })),
    trend,
    hoursByDay: isoDays(from, to).map((date) => ({ date, ...(byDay.get(date) ?? { worked: 0, scheduled: 0, overtime: 0 }) })),
    overtimeByWeek: [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, minutes]) => ({ week, minutes })),
    overtimeByEmployee: perEmployee
      .filter((e) => e.overtime_minutes > 0)
      .sort((a, b) => b.overtime_minutes - a.overtime_minutes)
      .slice(0, 10)
      .map((e) => ({ employeeId: e.employee_id, name: e.full_name, code: e.employee_code, overtimeMinutes: e.overtime_minutes, totalMinutes: e.total_minutes, unusual: unusual(e) })),
    byWorkspace,
    supervisors,
    attention,
    activity,
  };
}

export const analyticsRouter = Router();
mount(analyticsRouter, '/api/v1/analytics', 'analytics', [
  route({
    method: 'get',
    path: '/dashboard',
    summary: 'Owner / supervisor dashboard: KPIs, attendance trend, hours, overtime, workspaces, supervisors, attention items, activity',
    access: 'admin',
    query: dashboardQuery,
    handler: ({ query, user }) => dashboard(user, query),
  }),
]);
