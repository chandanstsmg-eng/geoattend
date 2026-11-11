import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { asSupervisor, one, q, qPrepared } from '../../db/pool.js';
import { DAY_LOOKUPS_AT_ONCE, mapLimit } from '../../lib/concurrency.js';
import { dayEndSql, dayStartSql, orgTimezoneSql, orgToday } from '../../lib/dates.js';
import { isoDate, mount, route } from '../../lib/http.js';
import { dateChunks, streamCsv, toCsv } from '../../lib/csv.js';
import { audit } from '../../lib/audit.js';
import { getSettings } from '../settings/settings.service.js';
import { approvedLeaveOn } from '../leave/leave.routes.js';
import { holidaysOn } from '../holidays/holidays.routes.js';
import { attendanceCounts, employeeSite, overtimeCounts, pendingMinutes, siteFilter, SUPERVISOR_SITES, supervisorTeam, workJoinForDays } from '../../lib/tenancy.js';
import { badRequest } from '../../lib/errors.js';
import type { AuthUser } from '../../lib/auth.js';
import { computeHours, hoursText, loadPendingHours, loadWorkRecords, withPendingHours } from './hours.js';

/** Default "today": the business date of the workplace, or of the company (lib/dates.ts). */
export const defaultDate = (orgId: string, workplaceId?: string | null) => orgToday(orgId, workplaceId ?? null);

/** A roster row whose attendance is waiting for verification: not present, not absent, not yet official. */
export const isPending = (r: { verification_status?: string | null }) => r.verification_status === 'PENDING_VERIFICATION';
/** A roster row with attendance that counts. */
export const attended = (r: { attendance_id?: string | null; verification_status?: string | null }) => !!r.attendance_id && !isPending(r);

/**
 * Every (employee, shift) pair of the company scheduled on `date`, with attendance and session outcome.
 * Past days use the facts of that day, not today's: the shift as it was then (shift_revisions), people
 * employed then (joined_on, left_on) and workspaces not yet disabled.
 */
export async function roster(orgId: string, date: string, workplaceId: string | null, includeSimulated = true, sites: string[] | null = null) {
  // Prepared because a 30-day report runs this up to 60 times, and planning it took longer than running it.
  return qPrepared(
    'roster',
    `SELECT u.id AS employee_id, u.full_name, ep.employee_code, u.is_demo,
            w.id AS workplace_id, w.name AS workplace_name, sh.id AS shift_id, sh.name AS shift_name,
            COALESCE(rev.start_time, sh.start_time) AS start_time, COALESCE(rev.end_time, sh.end_time) AS end_time, COALESCE(rev.timezone, sh.timezone) AS timezone,
            ar.id AS attendance_id, ar.recorded_at, ar.late_by_minutes, ar.verification_status, ar.evidence_distance_m, ar.evidence_accuracy_m, ar.risk_flags,
            -- Lateness is an official finding too, so a record still waiting for verification is not counted late.
            (ar.is_late AND ar.verification_status <> 'PENDING_VERIFICATION') AS is_late, ${pendingMinutes()} AS pending_minutes,
            s.id AS session_id, s.state, s.started_at, s.ended_at, s.last_location_at, s.termination_reason,
            aw.worked_minutes, aw.scheduled_minutes, aw.ended_early_minutes, aw.in_progress,
            aw.overtime_id, aw.overtime_status, aw.overtime_claimed_minutes, aw.overtime_minutes AS overtime_approved_minutes,
            (SELECT count(*)::int FROM absence_intervals a WHERE a.session_id = s.id) AS absence_count,
            (SELECT count(*)::int FROM absence_intervals a WHERE a.session_id = s.id AND a.prolonged_at IS NOT NULL) AS prolonged_count,
            (SELECT COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, now()) - a.started_at))) / 60), 0)::int FROM absence_intervals a WHERE a.session_id = s.id) AS away_minutes
     FROM employee_shift_assignments esa
     JOIN users u ON u.id = esa.employee_id AND u.role = 'EMPLOYEE'
     JOIN employee_profiles ep ON ep.user_id = u.id
     JOIN shifts sh ON sh.id = esa.shift_id
     LEFT JOIN LATERAL (
       SELECT r.* FROM shift_revisions r WHERE r.shift_id = sh.id AND $1::date <= r.valid_to AND (r.valid_from IS NULL OR $1::date >= r.valid_from) ORDER BY r.valid_to LIMIT 1
     ) rev ON true
     JOIN workplaces w ON w.id = sh.workplace_id AND (w.is_active OR $1::date < w.deactivated_on)
     LEFT JOIN attendance_records ar ON ar.employee_id = u.id AND ar.shift_id = sh.id AND ar.shift_date = $1 AND ar.verification_status <> 'VOIDED'
     LEFT JOIN tracking_sessions s ON s.employee_id = u.id AND s.shift_id = sh.id AND s.shift_date = $1
     LEFT JOIN ${workJoinForDays('$1::date', '$1::date')}
     WHERE esa.effective_from <= $1 AND (esa.effective_to IS NULL OR esa.effective_to >= $1)
       AND COALESCE(rev.is_active, sh.is_active)
       AND (ep.joined_on IS NULL OR $1::date >= ep.joined_on)
       AND (CASE WHEN ep.left_on IS NOT NULL THEN $1::date <= ep.left_on ELSE u.is_active END)
       AND EXTRACT(ISODOW FROM $1::date)::smallint = ANY (COALESCE(rev.days_of_week, sh.days_of_week))
       AND ($2::uuid IS NULL OR w.id = $2) AND ($3 OR NOT u.is_demo) AND u.org_id = $4 AND ${siteFilter('w.id', '$5', 'u.id')}
     ORDER BY w.name, start_time, u.full_name`,
    [date, workplaceId, includeSimulated, orgId, sites],
  );
}

/**
 * Adds to roster rows: `holiday` (name), `on_leave` (approved leave covering the date),
 * `no_show` (shift began more than the no-show threshold ago with no session, attendance,
 * leave or holiday), `overtime_minutes` (approved overtime) and `left_early` (Settings › workforce threshold).
 */
export async function withLeaveAndNoShow(orgId: string, date: string, rows: any[], now = new Date()) {
  const { alerts, workforce } = await getSettings(orgId);
  const leave = await approvedLeaveOn(date, [...new Set(rows.map((r) => r.employee_id as string))]);
  const holidays = await holidaysOn(date, [...new Set(rows.map((r) => r.workplace_id as string))]);
  // When each shift's no-show threshold passes, worked out once per (start time, zone): rows share a few
  // shifts, and parsing a zoned time for every row took ~150 ms per day for a 1,000-person company.
  const noShowAt = new Map<string, number>();
  const thresholdFor = (start: string, zone: string) => {
    const key = `${start}|${zone}`;
    let at = noShowAt.get(key);
    if (at === undefined) {
      at = DateTime.fromISO(`${date}T${start}`, { zone }).plus({ minutes: alerts.noShowAfterMinutes }).toMillis();
      noShowAt.set(key, at);
    }
    return at;
  };
  return rows.map((r) => {
    const onLeave = leave.get(r.employee_id) ?? null;
    const holiday = holidays.get(r.workplace_id) ?? null;
    const noShow = !onLeave && !holiday && !r.attendance_id && !r.session_id && alerts.noShowAfterMinutes > 0 && now.getTime() >= thresholdFor(r.start_time, r.timezone);
    return { ...r, holiday, on_leave: onLeave, no_show: noShow, ...workFlags(r, workforce) };
  });
}

/** A roster row reduced to what the dashboard's daily counts read (see rosterDayCounts). */
export interface DayCountRow {
  employee_id: string;
  workplace_id: string;
  start_time: string;
  timezone: string;
  attendance_id: string | null;
  verification_status: string | null;
  is_late: boolean | null;
  session_id: string | null;
  ended_at: Date | null;
  holiday: string | null;
  on_leave: { id: string; leave_type: string; half_day: boolean } | null;
  no_show: boolean;
}

/** Days per roster query in rosterDayCounts: bounds the rows held at once for a year-long range. */
const DAY_COUNT_CHUNK_DAYS = 31;

/**
 * For every date in [from, to]: the rows of roster(orgId, date, …) after withLeaveAndNoShow, with only the
 * columns the dashboard's daily counts read (attendance, lateness, verification, session end, leave,
 * holiday, no-show). One query per 31 days and one leave and one holiday lookup for the whole range,
 * instead of three or four queries per day. The rows, filters and rules are the roster's own:
 * test/report-speed.test.ts checks that both give the same rows for every date.
 */
export async function rosterDayCounts(orgId: string, from: string, to: string, workplaceId: string | null, includeSimulated = true, sites: string[] | null = null, now = new Date()) {
  const byDate = new Map<string, DayCountRow[]>();
  if (to < from) return byDate;
  const chunks: [string, string][] = [];
  for (let d = DateTime.fromISO(from); d.toISODate()! <= to; d = d.plus({ days: DAY_COUNT_CHUNK_DAYS })) {
    const end = d.plus({ days: DAY_COUNT_CHUNK_DAYS - 1 }).toISODate()!;
    chunks.push([d.toISODate()!, end < to ? end : to]);
  }
  const rows: (Omit<DayCountRow, 'holiday' | 'on_leave' | 'no_show'> & { date: string })[] = [];
  for (const [a, b] of chunks) {
    rows.push(
      ...(await q(
        // The roster query (above) with the date taken from the series instead of one parameter. The range's
        // attendance and sessions are read once by date and joined on (employee, shift, date): joined per row,
        // the planner fetched each person's every record of the shift and checked company isolation on each.
        `WITH ar AS MATERIALIZED (
           SELECT id, employee_id, shift_id, shift_date, verification_status, is_late FROM attendance_records
           WHERE shift_date BETWEEN $1::date AND $2::date AND verification_status <> 'VOIDED'
         ), s AS MATERIALIZED (
           SELECT id, employee_id, shift_id, shift_date, ended_at FROM tracking_sessions WHERE shift_date BETWEEN $1::date AND $2::date
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS date, u.id AS employee_id, w.id AS workplace_id,
                COALESCE(rev.start_time, sh.start_time) AS start_time, COALESCE(rev.timezone, sh.timezone) AS timezone,
                ar.id AS attendance_id, ar.verification_status,
                (ar.is_late AND ar.verification_status <> 'PENDING_VERIFICATION') AS is_late,
                s.id AS session_id, s.ended_at
         FROM (SELECT g::date AS day FROM generate_series($1::date, $2::date, interval '1 day') g) d
         JOIN employee_shift_assignments esa ON esa.effective_from <= d.day AND (esa.effective_to IS NULL OR esa.effective_to >= d.day)
         JOIN users u ON u.id = esa.employee_id AND u.role = 'EMPLOYEE'
         JOIN employee_profiles ep ON ep.user_id = u.id
         JOIN shifts sh ON sh.id = esa.shift_id
         LEFT JOIN LATERAL (
           SELECT r.* FROM shift_revisions r WHERE r.shift_id = sh.id AND d.day <= r.valid_to AND (r.valid_from IS NULL OR d.day >= r.valid_from) ORDER BY r.valid_to LIMIT 1
         ) rev ON true
         JOIN workplaces w ON w.id = sh.workplace_id AND (w.is_active OR d.day < w.deactivated_on)
         LEFT JOIN ar ON ar.employee_id = u.id AND ar.shift_id = sh.id AND ar.shift_date = d.day
         LEFT JOIN s ON s.employee_id = u.id AND s.shift_id = sh.id AND s.shift_date = d.day
         WHERE COALESCE(rev.is_active, sh.is_active)
           AND (ep.joined_on IS NULL OR d.day >= ep.joined_on)
           AND (CASE WHEN ep.left_on IS NOT NULL THEN d.day <= ep.left_on ELSE u.is_active END)
           AND EXTRACT(ISODOW FROM d.day)::smallint = ANY (COALESCE(rev.days_of_week, sh.days_of_week))
           AND ($3::uuid IS NULL OR w.id = $3) AND ($4 OR NOT u.is_demo) AND u.org_id = $5 AND ${siteFilter('w.id', '$6', 'u.id')}`,
        [a, b, workplaceId, includeSimulated, orgId, sites],
      )),
    );
  }
  const { alerts } = await getSettings(orgId);
  // Approved leave and holidays for the whole range, applied per date exactly as approvedLeaveOn and holidaysOn do.
  const employees = [...new Set(rows.map((r) => r.employee_id))];
  const workplaces = [...new Set(rows.map((r) => r.workplace_id))];
  const leave = employees.length
    ? await q(
        `SELECT employee_id, id, leave_type, half_day, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date FROM leave_requests
         WHERE status = 'APPROVED' AND employee_id = ANY($1::uuid[]) AND start_date <= $3 AND end_date >= $2
         ORDER BY employee_id, half_day`, // as approvedLeaveOn: a full-day leave wins over a half day
        [employees, from, to],
      )
    : [];
  const leaveOf = new Map<string, typeof leave>();
  for (const l of leave) leaveOf.set(l.employee_id, [...(leaveOf.get(l.employee_id) ?? []), l]);
  const holidays = workplaces.length
    ? await q(
        `SELECT DISTINCT ON (w.id, h.holiday_date) w.id AS workplace_id, to_char(h.holiday_date, 'YYYY-MM-DD') AS date, h.name FROM workplaces w
         JOIN holidays h ON h.org_id = w.org_id AND h.holiday_date BETWEEN $1 AND $2 AND (h.workplace_id IS NULL OR h.workplace_id = w.id)
         WHERE w.id = ANY($3::uuid[]) ORDER BY w.id, h.holiday_date, h.workplace_id NULLS LAST`, // a workplace's own holiday wins
        [from, to, workplaces],
      )
    : [];
  const holidayOf = new Map<string, string>(holidays.map((h) => [`${h.workplace_id}|${h.date}`, h.name as string]));
  const noShowAt = new Map<string, number>();
  const thresholdFor = (date: string, start: string, zone: string) => {
    const key = `${date}|${start}|${zone}`;
    let at = noShowAt.get(key);
    if (at === undefined) {
      at = DateTime.fromISO(`${date}T${start}`, { zone }).plus({ minutes: alerts.noShowAfterMinutes }).toMillis();
      noShowAt.set(key, at);
    }
    return at;
  };
  for (const { date, ...r } of rows) {
    const l = leaveOf.get(r.employee_id)?.find((x) => x.start_date <= date && x.end_date >= date);
    const onLeave = l ? { id: l.id as string, leave_type: l.leave_type as string, half_day: l.half_day as boolean } : null;
    const holiday = holidayOf.get(`${r.workplace_id}|${date}`) ?? null;
    const noShow = !onLeave && !holiday && !r.attendance_id && !r.session_id && alerts.noShowAfterMinutes > 0 && now.getTime() >= thresholdFor(date, r.start_time, r.timezone);
    let day = byDate.get(date);
    if (!day) byDate.set(date, (day = []));
    day.push({ ...r, holiday, on_leave: onLeave, no_show: noShow });
  }
  return byDate;
}

/**
 * Overtime and leaving early from an attendance_work row. Overtime is only what an administrator
 * approved (worked time itself stops at the scheduled end), so pending or rejected overtime is 0.
 */
export function workFlags(
  w: { overtime_minutes?: number | null; overtime_approved_minutes?: number | null; ended_early_minutes?: number | null },
  t: { leftEarlyMinutes: number },
) {
  return {
    overtime_minutes: w.overtime_approved_minutes ?? w.overtime_minutes ?? 0,
    left_early: t.leftEarlyMinutes > 0 && w.ended_early_minutes != null && w.ended_early_minutes >= t.leftEarlyMinutes,
  };
}

/**
 * Per-employee totals for a calendar month, built from the daily roster so leave, holidays
 * and no-shows are judged exactly as on the overview. Days after today are not counted.
 * Days are counted per person, not per shift: two shifts on one date are one day, so a single
 * absence is never counted twice (`missed_shifts` keeps the shifts missed on days worked).
 * Hours come from the same engine as the hours report, so the two always agree.
 */
export async function monthlySummary(orgId: string, month: string, workplaceId: string | null, includeSimulated: boolean, scope: SummaryScope = {}) {
  const first = DateTime.fromISO(`${month}-01`);
  return { month, ...(await periodSummary(orgId, first.toISODate()!, first.endOf('month').toISODate()!, workplaceId, includeSimulated, scope)) };
}

/** Narrows a summary to one supervisor's workplaces and/or one employee, as the other reports do. */
type SummaryScope = { supervisorId?: string | null; employeeId?: string | null };

/** The same summary for any run of days. */
export async function periodSummary(orgId: string, from: string, until: string, workplaceId: string | null, includeSimulated: boolean, scope: SummaryScope = {}) {
  const sites: string[] | null = scope.supervisorId ? (await one(`SELECT ${SUPERVISOR_SITES('$1')} AS s`, [scope.supervisorId])).s : null;
  const first = DateTime.fromISO(from);
  const today = DateTime.fromISO(await defaultDate(orgId, workplaceId));
  const last = DateTime.min(DateTime.fromISO(until), today);
  const totals = new Map<string, any>();
  const dates: string[] = [];
  for (let d = first; d <= last; d = d.plus({ days: 1 })) dates.push(d.toISODate()!);
  // Looked up a few days at a time, then counted in date order exactly as before.
  // Filtered by a supervisor: their workplaces and, as they see it, only their own team (approved policy, Phase I).
  const asThem = <T,>(fn: () => Promise<T>) => (scope.supervisorId ? asSupervisor(scope.supervisorId, fn) : fn());
  const rowsByDay = await mapLimit(dates, DAY_LOOKUPS_AT_ONCE, async (date) => asThem(async () => withLeaveAndNoShow(orgId, date, await roster(orgId, date, workplaceId, includeSimulated, sites))));
  for (const [i, date] of dates.entries()) {
    const isToday = date === today.toISODate();
    const byEmployee = new Map<string, any[]>();
    for (const r of rowsByDay[i]!) {
      if (scope.employeeId && r.employee_id !== scope.employeeId) continue;
      byEmployee.set(r.employee_id, [...(byEmployee.get(r.employee_id) ?? []), r]);
    }
    for (const [employeeId, shifts] of byEmployee) {
      const r = shifts[0];
      let t = totals.get(employeeId);
      if (!t) {
        t = { employee_id: r.employee_id, full_name: r.full_name, employee_code: r.employee_code, workplace_id: r.workplace_id, workplace_name: r.workplace_name, is_demo: r.is_demo, scheduled: 0, present: 0, late: 0, leave: 0, paid_leave: 0, unpaid_leave: 0, holidays: 0, absent: 0, missed_shifts: 0, worked_minutes: 0, overtime_minutes: 0, left_early: 0, pending_days: 0, pending_minutes: 0 };
        totals.set(employeeId, t);
      }
      t.scheduled++;
      const counted = shifts.filter(attended);
      const waiting = shifts.filter(isPending);
      const decided = !isToday || shifts.some((s) => s.no_show || s.ended_at);
      const half = r.on_leave?.half_day ? 0.5 : 1;
      const addLeave = (days: number) => {
        t.leave += days;
        if (r.on_leave.leave_type === 'UNPAID') t.unpaid_leave += days;
        else t.paid_leave += days;
      };
      t.pending_minutes += waiting.reduce((n, s) => n + (s.pending_minutes ?? 0), 0);
      if (counted.length) {
        // Working on a half-day leave counts as half a day present and half a day on leave.
        t.present += r.on_leave?.half_day ? 0.5 : 1;
        if (r.on_leave?.half_day) addLeave(0.5);
        if (counted.some((s) => s.is_late)) t.late++;
        if (counted.some((s) => s.left_early)) t.left_early++;
        t.missed_shifts += shifts.filter((s) => !s.attendance_id && !s.holiday && !s.on_leave && (!isToday || s.no_show || s.ended_at)).length;
      } else if (waiting.length) t.pending_days++; // neither present nor absent until someone decides
      else if (shifts.some((s) => s.holiday)) t.holidays++;
      else if (r.on_leave) {
        addLeave(half);
        if (half < 1 && decided) t.absent += 0.5;
      } else if (decided) t.absent++;
    }
  }
  const to = last >= first ? last.toISODate()! : null;
  if (to) {
    const { workforce } = await getSettings(orgId);
    const records = await loadWorkRecords({ orgId, sites: null }, { from: first.toISODate()!, to, workplaceId, includeSimulated, supervisorId: scope.supervisorId ?? null, employeeId: scope.employeeId ?? null });
    for (const h of computeHours(records, workforce, first.toISODate()!, to)) {
      const t = totals.get(h.employee_id);
      if (t) {
        t.worked_minutes = h.regular_minutes;
        t.overtime_minutes = h.overtime_minutes;
      }
    }
  }
  return { from: first.toISODate(), to, rows: [...totals.values()].sort((a, b) => a.full_name.localeCompare(b.full_name)) };
}

/** A stored time as it read on the wall at the workplace, for people reading an export. */
const wallClock = (v: Date | string | null | undefined, zone: string) => (v ? DateTime.fromJSDate(new Date(v), { zone }).toFormat('yyyy-MM-dd HH:mm') : '');

function csvHeaders(res: any, name: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
}

function sendCsv(res: any, name: string, csv: string) {
  csvHeaders(res, name);
  res.send(csv);
}

/** Only the period that holds records is read, however wide the range asked for. */
async function narrowedRange(sql: string, params: unknown[], from: string, to: string) {
  const r = await one(sql, params);
  if (!r?.first) return null;
  return { from: r.first > from ? r.first as string : from, to: r.last < to ? r.last as string : to };
}

const rangeQuery = z.object({
  from: isoDate,
  to: isoDate,
  workplaceId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
  /** The workplaces of this supervisor, as everywhere else. */
  supervisorId: z.uuid().optional(),
  includeSimulated: z.enum(['true', 'false']).default('false'),
});

const hoursQuery = z.object({
  from: isoDate,
  to: isoDate,
  workplaceId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
  supervisorId: z.uuid().optional(),
  includeSimulated: z.enum(['true', 'false']).default('false'),
  /** Optional: a page of the list. Totals are always worked out over the whole period first. */
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

const pageOf = <T>(rows: T[], q0: { limit?: number; offset?: number }) => (q0.limit ? rows.slice(q0.offset ?? 0, (q0.offset ?? 0) + q0.limit) : rows);

/** Someone listed only for pending time has no official figures, so is left out of the two official exports. */
const official = (r: { days: number }) => r.days > 0;

/** Per-employee days, hours and overtime for the caller's scope (supervisors: their workplaces). */
async function hoursFor(user: AuthUser, query: z.infer<typeof hoursQuery>) {
  if (query.to < query.from) throw badRequest('BAD_RANGE', 'The end date is before the start date.');
  const { workforce } = await getSettings(user.orgId);
  const filter = { ...query, includeSimulated: query.includeSimulated === 'true' };
  const records = await loadWorkRecords(user, filter);
  const rows = withPendingHours(computeHours(records, workforce, query.from, query.to), await loadPendingHours(user, filter));
  return { rows, policy: { roundingMinutes: workforce.roundingMinutes, weeklyRegularHours: workforce.weeklyRegularHours } };
}

export const reportsRouter = Router();
mount(reportsRouter, '/api/v1/reports', 'reports', [
  route({
    method: 'get',
    path: '/hours',
    summary: 'Days worked, total hours and overtime per employee for a date range (preview of the CSV exports)',
    access: 'admin',
    query: hoursQuery,
    handler: async ({ query, user }) => {
      const { rows, policy } = await hoursFor(user, query);
      return { from: query.from, to: query.to, policy, total: rows.length, rows: pageOf(rows, query) };
    },
  }),
  route({
    method: 'get',
    path: '/hours.csv',
    summary: 'Attendance summary CSV: Employee Name, Total Days Worked, Total Hours Worked',
    access: 'admin',
    raw: true,
    query: hoursQuery,
    handler: async ({ query, res, user, req }) => {
      const { rows } = await hoursFor(user, query);
      await audit({ actor: user, action: 'report.export', resourceType: 'hours_csv', after: { ...query, rows: rows.length }, req });
      sendCsv(res, `attendance_summary_${query.from}_${query.to}.csv`, toCsv(['Employee Name', 'Total Days Worked', 'Total Hours Worked'], rows.filter(official).map((r) => [r.full_name, r.days, hoursText(r.total_minutes)])));
    },
  }),
  route({
    method: 'get',
    path: '/overtime.csv',
    summary: 'Overtime CSV: Employee Name, Total Overtime Hours (overtime is part of total hours, not extra)',
    access: 'admin',
    raw: true,
    query: hoursQuery,
    handler: async ({ query, res, user, req }) => {
      const { rows } = await hoursFor(user, query);
      await audit({ actor: user, action: 'report.export', resourceType: 'overtime_csv', after: { ...query, rows: rows.length }, req });
      sendCsv(res, `overtime_${query.from}_${query.to}.csv`, toCsv(['Employee Name', 'Total Overtime Hours'], rows.filter(official).map((r) => [r.full_name, hoursText(r.overtime_minutes)])));
    },
  }),
  route({
    method: 'get',
    path: '/overview',
    summary: 'Overview cards and roster for a date',
    access: 'admin',
    query: z.object({ date: isoDate.optional(), workplaceId: z.uuid().optional() }),
    handler: async ({ query, user }) => {
      const org = user.orgId;
      const date = query.date ?? (await defaultDate(org, query.workplaceId));
      const wp = query.workplaceId ?? null;
      const rows = await withLeaveAndNoShow(org, date, await roster(org, date, wp, true, user.sites));
      // p = placeholder of the company id, s = of the supervisor's sites (null for owners)
      const inOrg = (p: string, s: string) => `employee_id IN (SELECT id FROM users WHERE org_id = ${p}) AND ${siteFilter(employeeSite('employee_id'), s, 'employee_id')}`;
      // Sessions and attendance carry the rostered workplace, so they are scoped by where the work happens
      // (an employee rostered away from their home workplace still counts for that site's supervisor).
      const orgOnly = (p: string) => `employee_id IN (SELECT id FROM users WHERE org_id = ${p})`;
      const live = await one(
        `SELECT count(*) FILTER (WHERE state = 'PRESENT')::int AS present,
                count(*) FILTER (WHERE state = 'ON_BREAK')::int AS on_break,
                count(*) FILTER (WHERE state = 'ON_OVERTIME')::int AS on_overtime,
                count(*) FILTER (WHERE state = 'TEMPORARILY_AWAY')::int AS away,
                count(*) FILTER (WHERE state = 'PROLONGED_ABSENCE')::int AS prolonged,
                count(*) FILTER (WHERE state IN ('TRACKING_INTERRUPTED', 'TRACKING_PERMISSION_REQUIRED'))::int AS interrupted,
                count(*) FILTER (WHERE state = 'MANUAL_REVIEW_REQUIRED')::int AS review,
                count(*)::int AS open
         FROM tracking_sessions WHERE ended_at IS NULL AND ($1::uuid IS NULL OR workplace_id = $1) AND ${orgOnly('$2')} AND ${siteFilter('workplace_id', '$3', 'employee_id')}`,
        [wp, org, user.sites],
      );
      const late = await one(
        `SELECT count(*)::int AS n FROM attendance_records ar WHERE shift_date = $1 AND is_late AND ${attendanceCounts()} AND ($2::uuid IS NULL OR workplace_id = $2) AND ${orgOnly('$3')} AND ${siteFilter('workplace_id', '$4', 'ar.employee_id')}`,
        [date, wp, org, user.sites],
      );
      const openReviews = await one(`SELECT count(*)::int AS n FROM review_requests WHERE status = 'OPEN' AND kind IN ('MANUAL_REVIEW', 'DISPUTE', 'TECHNICAL_ISSUE') AND ${inOrg('$1', '$2')}`, [org, user.sites]);
      const pendingLeave = await one(`SELECT count(*)::int AS n FROM leave_requests WHERE status = 'PENDING' AND ${inOrg('$1', '$2')}`, [org, user.sites]);
      // Overtime follows the workplace where it was worked, like sessions.
      const overtime = await one(
        `SELECT COALESCE(SUM(ROUND(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)) / 60)) FILTER (WHERE shift_date = $1), 0)::int AS today_minutes,
                COALESCE(SUM(approved_minutes) FILTER (WHERE shift_date = $1 AND status = 'APPROVED'), 0)::int AS today_approved_minutes,
                count(*) FILTER (WHERE status = 'PENDING' AND ended_at IS NOT NULL)::int AS pending
         FROM overtime_entries WHERE ($2::uuid IS NULL OR workplace_id = $2) AND ${orgOnly('$3')} AND ${siteFilter('workplace_id', '$4', 'employee_id')} AND ${overtimeCounts('overtime_entries')}`,
        [date, wp, org, user.sites],
      );
      const employees = new Set(rows.map((r) => r.employee_id));
      return {
        date,
        cards: {
          assigned: employees.size,
          present: live.present,
          yetToArrive: rows.filter((r) => !r.attendance_id && !r.ended_at && !r.on_leave && !r.no_show && !r.holiday).length,
          noShow: rows.filter((r) => r.no_show).length,
          onLeave: new Set(rows.filter((r) => r.on_leave).map((r) => r.employee_id)).size,
          pendingLeave: pendingLeave.n,
          onBreak: live.on_break,
          onOvertime: live.on_overtime,
          overtimeTodayMinutes: overtime.today_minutes,
          overtimeApprovedTodayMinutes: overtime.today_approved_minutes,
          overtimePending: overtime.pending,
          away: live.away,
          prolonged: live.prolonged,
          interrupted: live.interrupted,
          late: late.n,
          pendingVerification: rows.filter(isPending).length,
          pendingMinutes: rows.reduce((n, r) => n + (r.pending_minutes ?? 0), 0),
          manualReview: live.review,
          openReviews: openReviews.n,
          openSessions: live.open,
        },
        holidays: [...new Set(rows.map((r) => r.holiday).filter(Boolean))],
        roster: rows,
      };
    },
  }),
  route({
    method: 'get',
    path: '/monthly',
    summary: 'Per-employee month totals: present, late, leave, holidays, absent, hours, overtime',
    access: 'admin',
    ownerOnly: true,
    query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM'), workplaceId: z.uuid().optional(), supervisorId: z.uuid().optional(), employeeId: z.uuid().optional(), includeSimulated: z.enum(['true', 'false']).default('true'), limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).default(0) }),
    handler: async ({ query, user }) => {
      const s = await monthlySummary(user.orgId, query.month, query.workplaceId ?? null, query.includeSimulated === 'true', query);
      return { ...s, total: s.rows.length, rows: pageOf(s.rows, query) };
    },
  }),
  route({
    method: 'get',
    path: '/monthly.csv',
    summary: 'Monthly totals per employee (CSV)',
    access: 'admin',
    ownerOnly: true,
    raw: true,
    query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM'), workplaceId: z.uuid().optional(), supervisorId: z.uuid().optional(), employeeId: z.uuid().optional(), includeSimulated: z.enum(['true', 'false']).default('false') }),
    handler: async ({ query, res, user, req }) => {
      const s = await monthlySummary(user.orgId, query.month, query.workplaceId ?? null, query.includeSimulated === 'true', query);
      await audit({ actor: user, action: 'report.export', resourceType: 'monthly_csv', after: { ...query, rows: s.rows.length }, req });
      sendCsv(
        res,
        `monthly_${query.month}.csv`,
        toCsv(
          ['Month', 'Employee ID', 'Employee', 'Workplace', 'Shifts scheduled', 'Present', 'Late', 'Leave (days)', 'Holidays', 'Absent', 'Hours worked', 'Overtime (hours)', 'Left early', 'Pending days (not counted)', 'Pending hours (not counted)'],
          s.rows.map((r) => [query.month, r.employee_code, r.full_name, r.workplace_name, r.scheduled, r.present, r.late, r.leave, r.holidays, r.absent, (r.worked_minutes / 60).toFixed(2), (r.overtime_minutes / 60).toFixed(2), r.left_early, r.pending_days, (r.pending_minutes / 60).toFixed(2)]),
        ),
      );
    },
  }),
  route({
    method: 'get',
    path: '/daily-summary',
    summary: 'Attendance counts per day and workplace for a date range',
    access: 'admin',
    ownerOnly: true,
    query: rangeQuery.omit({ employeeId: true }),
    handler: async ({ query, user }) =>
      q(
        `SELECT ar.shift_date, w.name AS workplace_name, count(*) FILTER (WHERE ${attendanceCounts()})::int AS attended,
                count(*) FILTER (WHERE ar.is_late AND ${attendanceCounts()})::int AS late,
                count(*) FILTER (WHERE ar.verification_status = 'MANUAL_APPROVED')::int AS manual,
                count(*) FILTER (WHERE ar.verification_status = 'PENDING_VERIFICATION')::int AS pending_verification
         FROM attendance_records ar JOIN workplaces w ON w.id = ar.workplace_id
         WHERE w.org_id = $5 AND ar.shift_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR ar.workplace_id = $3) AND ($4 OR NOT ar.is_simulated) AND ar.verification_status <> 'VOIDED'
           AND ($6::uuid IS NULL OR ar.workplace_id = ANY(${SUPERVISOR_SITES('$6')})) AND ${supervisorTeam('$6', 'ar.employee_id')}
         GROUP BY ar.shift_date, w.name ORDER BY ar.shift_date DESC, w.name`,
        [query.from, query.to, query.workplaceId ?? null, query.includeSimulated === 'true', user.orgId, query.supervisorId ?? null],
      ),
  }),
  route({
    method: 'get',
    path: '/attendance.csv',
    summary: 'Attendance export (CSV)',
    access: 'admin',
    ownerOnly: true,
    raw: true,
    query: rangeQuery,
    handler: async ({ query, res, user, req }) => {
      const { workforce } = await getSettings(user.orgId);
      const rowsFor = (from: string, to: string) => q(
        `SELECT ar.shift_date, ep.employee_code, u.full_name, w.name AS workplace, sh.name AS shift, ar.recorded_at, ar.verification_status,
                ar.is_late, ar.late_by_minutes, ROUND(ar.evidence_distance_m::numeric, 1) AS distance_m, ROUND(ar.evidence_accuracy_m::numeric, 1) AS accuracy_m,
                ar.radius_m_at_record, array_to_string(ar.risk_flags, ' ') AS risk_flags,
                (SELECT COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, now()) - a.started_at))) / 60), 0)::int FROM absence_intervals a WHERE a.session_id = ar.session_id) AS away_minutes,
                (SELECT count(*)::int FROM absence_intervals a WHERE a.session_id = ar.session_id AND a.prolonged_at IS NOT NULL) AS prolonged_absences,
                s.ended_at AS shift_ended_at, ar.is_simulated, aw.worked_minutes, aw.scheduled_minutes, aw.ended_early_minutes,
                aw.overtime_minutes, aw.overtime_claimed_minutes, aw.overtime_status, ${pendingMinutes()} AS pending_minutes,
                -- local times in the shift's time zone of that day, not today's (a later edit must not rewrite history)
                COALESCE((SELECT r.timezone FROM shift_revisions r WHERE r.shift_id = sh.id AND ar.shift_date <= r.valid_to AND (r.valid_from IS NULL OR ar.shift_date >= r.valid_from) ORDER BY r.valid_to LIMIT 1), sh.timezone) AS timezone
         FROM attendance_records ar JOIN users u ON u.id = ar.employee_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id
         JOIN workplaces w ON w.id = ar.workplace_id JOIN shifts sh ON sh.id = ar.shift_id LEFT JOIN tracking_sessions s ON s.id = ar.session_id
         LEFT JOIN ${workJoinForDays('$1::date', '$2::date')}
         WHERE u.org_id = $6 AND ar.shift_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR ar.workplace_id = $3) AND ($4::uuid IS NULL OR ar.employee_id = $4) AND ($5 OR NOT ar.is_simulated)
           AND ($7::uuid IS NULL OR ar.workplace_id = ANY(${SUPERVISOR_SITES('$7')})) AND ${supervisorTeam('$7', 'ar.employee_id')}
         ORDER BY ar.shift_date, w.name, sh.name, u.full_name, ar.id`,
        [from, to, query.workplaceId ?? null, query.employeeId ?? null, query.includeSimulated === 'true', user.orgId, query.supervisorId ?? null],
      );
      const range = await narrowedRange(
        `SELECT min(ar.shift_date) AS first, max(ar.shift_date) AS last FROM attendance_records ar JOIN users u ON u.id = ar.employee_id WHERE u.org_id = $3 AND ar.shift_date BETWEEN $1 AND $2`,
        [query.from, query.to, user.orgId], query.from, query.to,
      );
      csvHeaders(res, `attendance_${query.from}_${query.to}.csv`);
      await streamCsv(
        res,
          ['Date', 'Employee ID', 'Employee', 'Workplace', 'Shift', 'Recorded at (UTC, server)', 'Verification', 'Late', 'Late by (min)', 'Distance (m)', 'GPS accuracy (m)', 'Radius (m)', 'Risk flags', 'Away (min)', 'Prolonged absences', 'Shift ended at (UTC)', 'Worked (min)', 'Overtime worked (min)', 'Overtime status', 'Overtime approved (min)', 'Left early', 'Simulated', 'Recorded at (local)', 'Shift ended at (local)', 'Pending worked (min, not counted)'],
        (range ? dateChunks(range.from, range.to) : []).map((c) => async () => (await rowsFor(c.from, c.to)).map((r) => {
            const f = workFlags(r, workforce);
            return [r.shift_date, r.employee_code, r.full_name, r.workplace, r.shift, r.recorded_at, r.verification_status, r.is_late ? 'yes' : 'no', r.late_by_minutes, r.distance_m, r.accuracy_m, r.radius_m_at_record, r.risk_flags, r.away_minutes, r.prolonged_absences, r.shift_ended_at, r.worked_minutes ?? '', r.overtime_claimed_minutes || '', r.overtime_status ?? '', f.overtime_minutes || '', f.left_early ? 'yes' : '', r.is_simulated ? 'SIMULATED' : '', wallClock(r.recorded_at, r.timezone), wallClock(r.shift_ended_at, r.timezone), r.pending_minutes ?? ''];
          })),
        (rows) => audit({ actor: user, action: 'report.export', resourceType: 'attendance_csv', after: { ...query, rows }, req }),
      );
    },
  }),
  route({
    method: 'get',
    path: '/absences.csv',
    summary: 'Absence intervals export (CSV)',
    access: 'admin',
    ownerOnly: true,
    raw: true,
    query: rangeQuery,
    handler: async ({ query, res, user, req }) => {
      const rowsFor = (from: string, to: string) => q(
        `SELECT a.started_at, a.ended_at, a.status, a.threshold_minutes, a.prolonged_at, a.tracking_gap, ep.employee_code, u.full_name, w.name AS workplace,
                ROUND(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, now()) - a.started_at)) / 60)::int AS minutes, a.is_simulated, w.timezone
         FROM absence_intervals a JOIN users u ON u.id = a.employee_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id JOIN workplaces w ON w.id = a.workplace_id
         WHERE u.org_id = $6 AND a.started_at >= ${dayStartSql('$1', '$6')} AND a.started_at < ${dayEndSql('$2', '$6')} AND ($3::uuid IS NULL OR a.workplace_id = $3) AND ($4::uuid IS NULL OR a.employee_id = $4) AND ($5 OR NOT a.is_simulated)
           AND ($7::uuid IS NULL OR a.workplace_id = ANY(${SUPERVISOR_SITES('$7')})) AND ${supervisorTeam('$7', 'a.employee_id')}
         ORDER BY a.started_at, a.id`,
        [from, to, query.workplaceId ?? null, query.employeeId ?? null, query.includeSimulated === 'true', user.orgId, query.supervisorId ?? null],
      );
      const range = await narrowedRange(
        `SELECT (min(a.started_at) AT TIME ZONE ${orgTimezoneSql('$3')})::date AS first, (max(a.started_at) AT TIME ZONE ${orgTimezoneSql('$3')})::date AS last
         FROM absence_intervals a JOIN users u ON u.id = a.employee_id WHERE u.org_id = $3 AND a.started_at >= ${dayStartSql('$1', '$3')} AND a.started_at < ${dayEndSql('$2', '$3')}`,
        [query.from, query.to, user.orgId], query.from, query.to,
      );
      csvHeaders(res, `absences_${query.from}_${query.to}.csv`);
      await streamCsv(
        res,
          ['Employee ID', 'Employee', 'Workplace', 'Departed (UTC)', 'Returned / closed (UTC)', 'Status', 'Duration (min)', 'Threshold (min)', 'Prolonged at (UTC)', 'Tracking gap during absence', 'Simulated', 'Departed (local)', 'Returned / closed (local)'],
        (range ? dateChunks(range.from, range.to) : []).map((c) => async () => (await rowsFor(c.from, c.to)).map((r) => [r.employee_code, r.full_name, r.workplace, r.started_at, r.ended_at, r.status, r.minutes, r.threshold_minutes, r.prolonged_at, r.tracking_gap ? 'yes' : 'no', r.is_simulated ? 'SIMULATED' : '', wallClock(r.started_at, r.timezone), wallClock(r.ended_at, r.timezone)])),
        (rows) => audit({ actor: user, action: 'report.export', resourceType: 'absences_csv', after: { ...query, rows }, req }),
      );
    },
  }),
  route({
    method: 'get',
    path: '/shift.csv',
    summary: 'Shift roster for a date, including absentees (CSV)',
    access: 'admin',
    ownerOnly: true,
    raw: true,
    query: z.object({ date: isoDate, workplaceId: z.uuid().optional(), includeSimulated: z.enum(['true', 'false']).default('false') }),
    handler: async ({ query, res, user, req }) => {
      const rows = await withLeaveAndNoShow(user.orgId, query.date, await roster(user.orgId, query.date, query.workplaceId ?? null, query.includeSimulated === 'true'));
      await audit({ actor: user, action: 'report.export', resourceType: 'shift_csv', after: { ...query, rows: rows.length }, req });
      sendCsv(
        res,
        `shift_roster_${query.date}.csv`,
        toCsv(
          ['Date', 'Workplace', 'Shift', 'Start', 'End', 'Time zone', 'Employee ID', 'Employee', 'Attendance', 'Recorded at (UTC)', 'Late', 'Late by (min)', 'Session state', 'Away (min)', 'Prolonged absences', 'Worked (min)', 'Overtime (min)', 'Left early', 'Recorded at (local)', 'Pending worked (min, not counted)'],
          rows.map((r) => [query.date, r.workplace_name, r.shift_name, r.start_time?.slice(0, 5), r.end_time?.slice(0, 5), r.timezone, r.employee_code, r.full_name,r.attendance_id ? r.verification_status : r.holiday ? `HOLIDAY (${r.holiday})` : r.on_leave ? `ON LEAVE (${r.on_leave.leave_type}${r.on_leave.half_day ? ', half day' : ''})` : 'NOT RECORDED', r.recorded_at, r.is_late ? 'yes' : '', r.late_by_minutes ?? '', r.state ?? 'NOT STARTED', r.away_minutes ?? 0, r.prolonged_count ?? 0, r.worked_minutes ?? '', r.overtime_minutes || '', r.left_early ? 'yes' : '', wallClock(r.recorded_at, r.timezone), r.pending_minutes ?? '']),
        ),
      );
    },
  }),
]);
