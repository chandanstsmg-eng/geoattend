import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { one, q } from '../../db/pool.js';
import { isoDate, mount, route } from '../../lib/http.js';
import { toCsv } from '../../lib/csv.js';
import { audit } from '../../lib/audit.js';
import { getSettings } from '../settings/settings.service.js';
import { approvedLeaveOn } from '../leave/leave.routes.js';
import { holidaysOn } from '../holidays/holidays.routes.js';
import { employeeSite, siteFilter } from '../../lib/tenancy.js';
import { badRequest } from '../../lib/errors.js';
import type { AuthUser } from '../../lib/auth.js';
import { computeHours, hoursText, loadWorkRecords } from './hours.js';

/** Default "today" = today in the company's first active workplace's time zone (UTC if none). */
export async function defaultDate(orgId: string, workplaceId?: string | null) {
  const w = await one(`SELECT timezone FROM workplaces WHERE org_id = $2 AND ($1::uuid IS NULL OR id = $1) ORDER BY is_active DESC, created_at LIMIT 1`, [workplaceId ?? null, orgId]);
  return DateTime.now().setZone(w?.timezone ?? 'UTC').toISODate()!;
}

/** Every (employee, shift) pair of the company scheduled on `date`, with attendance and session outcome. */
export async function roster(orgId: string, date: string, workplaceId: string | null, includeSimulated = true, sites: string[] | null = null) {
  return q(
    `SELECT u.id AS employee_id, u.full_name, ep.employee_code, u.is_demo,
            w.id AS workplace_id, w.name AS workplace_name, sh.id AS shift_id, sh.name AS shift_name, sh.start_time, sh.end_time, sh.timezone,
            ar.id AS attendance_id, ar.recorded_at, ar.is_late, ar.late_by_minutes, ar.verification_status, ar.evidence_distance_m, ar.evidence_accuracy_m, ar.risk_flags,
            s.id AS session_id, s.state, s.started_at, s.ended_at, s.last_location_at, s.termination_reason,
            aw.worked_minutes, aw.scheduled_minutes, aw.ended_early_minutes, aw.in_progress,
            aw.overtime_id, aw.overtime_status, aw.overtime_claimed_minutes, aw.overtime_minutes AS overtime_approved_minutes,
            (SELECT count(*)::int FROM absence_intervals a WHERE a.session_id = s.id) AS absence_count,
            (SELECT count(*)::int FROM absence_intervals a WHERE a.session_id = s.id AND a.prolonged_at IS NOT NULL) AS prolonged_count,
            (SELECT COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, now()) - a.started_at))) / 60), 0)::int FROM absence_intervals a WHERE a.session_id = s.id) AS away_minutes
     FROM employee_shift_assignments esa
     JOIN users u ON u.id = esa.employee_id AND u.role = 'EMPLOYEE' AND u.is_active
     JOIN employee_profiles ep ON ep.user_id = u.id
     JOIN shifts sh ON sh.id = esa.shift_id AND sh.is_active
     JOIN workplaces w ON w.id = sh.workplace_id AND w.is_active
     LEFT JOIN attendance_records ar ON ar.employee_id = u.id AND ar.shift_id = sh.id AND ar.shift_date = $1 AND ar.verification_status <> 'VOIDED'
     LEFT JOIN tracking_sessions s ON s.employee_id = u.id AND s.shift_id = sh.id AND s.shift_date = $1
     LEFT JOIN attendance_work aw ON aw.attendance_id = ar.id
     WHERE esa.effective_from <= $1 AND (esa.effective_to IS NULL OR esa.effective_to >= $1)
       AND EXTRACT(ISODOW FROM $1::date)::smallint = ANY (sh.days_of_week)
       AND ($2::uuid IS NULL OR w.id = $2) AND ($3 OR NOT u.is_demo) AND u.org_id = $4 AND ${siteFilter('w.id', '$5')}
     ORDER BY w.name, sh.start_time, u.full_name`,
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
  return rows.map((r) => {
    const onLeave = leave.get(r.employee_id) ?? null;
    const holiday = holidays.get(r.workplace_id) ?? null;
    const startsAt = DateTime.fromISO(`${date}T${r.start_time}`, { zone: r.timezone });
    const noShow = !onLeave && !holiday && !r.attendance_id && !r.session_id && alerts.noShowAfterMinutes > 0 && now.getTime() >= startsAt.plus({ minutes: alerts.noShowAfterMinutes }).toMillis();
    return { ...r, holiday, on_leave: onLeave, no_show: noShow, ...workFlags(r, workforce) };
  });
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
 */
export async function monthlySummary(orgId: string, month: string, workplaceId: string | null, includeSimulated: boolean) {
  const first = DateTime.fromISO(`${month}-01`);
  const today = DateTime.fromISO(await defaultDate(orgId, workplaceId));
  const last = DateTime.min(first.endOf('month').startOf('day'), today);
  const totals = new Map<string, any>();
  for (let d = first; d <= last; d = d.plus({ days: 1 })) {
    const date = d.toISODate()!;
    const isToday = date === today.toISODate();
    for (const r of await withLeaveAndNoShow(orgId, date, await roster(orgId, date, workplaceId, includeSimulated))) {
      let t = totals.get(r.employee_id);
      if (!t) {
        t = { employee_id: r.employee_id, full_name: r.full_name, employee_code: r.employee_code, workplace_name: r.workplace_name, is_demo: r.is_demo, scheduled: 0, present: 0, late: 0, leave: 0, paid_leave: 0, unpaid_leave: 0, holidays: 0, absent: 0, worked_minutes: 0, overtime_minutes: 0, left_early: 0 };
        totals.set(r.employee_id, t);
      }
      t.scheduled++;
      const half = r.on_leave?.half_day ? 0.5 : 1;
      const addLeave = (days: number) => {
        t.leave += days;
        if (r.on_leave.leave_type === 'UNPAID') t.unpaid_leave += days;
        else t.paid_leave += days;
      };
      if (r.attendance_id) {
        // Working on a half-day leave counts as half a day present and half a day on leave.
        t.present += r.on_leave?.half_day ? 0.5 : 1;
        if (r.on_leave?.half_day) addLeave(0.5);
        if (r.is_late) t.late++;
        t.worked_minutes += r.worked_minutes ?? 0;
        t.overtime_minutes += r.overtime_minutes;
        if (r.left_early) t.left_early++;
      } else if (r.holiday) t.holidays++;
      else if (r.on_leave) {
        addLeave(half);
        if (half < 1 && (!isToday || r.no_show || r.ended_at)) t.absent += 0.5;
      } else if (!isToday || r.no_show || r.ended_at) t.absent++;
    }
  }
  return { month, from: first.toISODate(), to: last >= first ? last.toISODate() : null, rows: [...totals.values()].sort((a, b) => a.full_name.localeCompare(b.full_name)) };
}

function sendCsv(res: any, name: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
}

const rangeQuery = z.object({
  from: isoDate,
  to: isoDate,
  workplaceId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
  includeSimulated: z.enum(['true', 'false']).default('false'),
});

const hoursQuery = z.object({
  from: isoDate,
  to: isoDate,
  workplaceId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
  supervisorId: z.uuid().optional(),
  includeSimulated: z.enum(['true', 'false']).default('false'),
});

/** Per-employee days, hours and overtime for the caller's scope (supervisors: their workplaces). */
async function hoursFor(user: AuthUser, query: z.infer<typeof hoursQuery>) {
  if (query.to < query.from) throw badRequest('BAD_RANGE', 'The end date is before the start date.');
  const { workforce } = await getSettings(user.orgId);
  const records = await loadWorkRecords(user, { ...query, includeSimulated: query.includeSimulated === 'true' });
  return { rows: computeHours(records, workforce, query.from, query.to), policy: { roundingMinutes: workforce.roundingMinutes, weeklyRegularHours: workforce.weeklyRegularHours } };
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
      return { from: query.from, to: query.to, policy, rows };
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
      sendCsv(res, `attendance_summary_${query.from}_${query.to}.csv`, toCsv(['Employee Name', 'Total Days Worked', 'Total Hours Worked'], rows.map((r) => [r.full_name, r.days, hoursText(r.total_minutes)])));
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
      sendCsv(res, `overtime_${query.from}_${query.to}.csv`, toCsv(['Employee Name', 'Total Overtime Hours'], rows.map((r) => [r.full_name, hoursText(r.overtime_minutes)])));
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
      const inOrg = (p: string, s: string) => `employee_id IN (SELECT id FROM users WHERE org_id = ${p}) AND ${siteFilter(employeeSite('employee_id'), s)}`;
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
         FROM tracking_sessions WHERE ended_at IS NULL AND ($1::uuid IS NULL OR workplace_id = $1) AND ${orgOnly('$2')} AND ${siteFilter('workplace_id', '$3')}`,
        [wp, org, user.sites],
      );
      const late = await one(
        `SELECT count(*)::int AS n FROM attendance_records WHERE shift_date = $1 AND is_late AND verification_status <> 'VOIDED' AND ($2::uuid IS NULL OR workplace_id = $2) AND ${orgOnly('$3')} AND ${siteFilter('workplace_id', '$4')}`,
        [date, wp, org, user.sites],
      );
      const openReviews = await one(`SELECT count(*)::int AS n FROM review_requests WHERE status = 'OPEN' AND kind IN ('MANUAL_REVIEW', 'DISPUTE', 'TECHNICAL_ISSUE') AND ${inOrg('$1', '$2')}`, [org, user.sites]);
      const pendingLeave = await one(`SELECT count(*)::int AS n FROM leave_requests WHERE status = 'PENDING' AND ${inOrg('$1', '$2')}`, [org, user.sites]);
      // Overtime follows the workplace where it was worked, like sessions.
      const overtime = await one(
        `SELECT COALESCE(SUM(ROUND(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)) / 60)) FILTER (WHERE shift_date = $1), 0)::int AS today_minutes,
                COALESCE(SUM(approved_minutes) FILTER (WHERE shift_date = $1 AND status = 'APPROVED'), 0)::int AS today_approved_minutes,
                count(*) FILTER (WHERE status = 'PENDING' AND ended_at IS NOT NULL)::int AS pending
         FROM overtime_entries WHERE ($2::uuid IS NULL OR workplace_id = $2) AND ${orgOnly('$3')} AND ${siteFilter('workplace_id', '$4')}`,
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
    query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM'), workplaceId: z.uuid().optional(), includeSimulated: z.enum(['true', 'false']).default('true') }),
    handler: async ({ query, user }) => monthlySummary(user.orgId, query.month, query.workplaceId ?? null, query.includeSimulated === 'true'),
  }),
  route({
    method: 'get',
    path: '/monthly.csv',
    summary: 'Monthly totals per employee (CSV, ready for payroll)',
    access: 'admin',
    ownerOnly: true,
    raw: true,
    query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM'), workplaceId: z.uuid().optional(), includeSimulated: z.enum(['true', 'false']).default('false') }),
    handler: async ({ query, res, user, req }) => {
      const s = await monthlySummary(user.orgId, query.month, query.workplaceId ?? null, query.includeSimulated === 'true');
      await audit({ actor: user, action: 'report.export', resourceType: 'monthly_csv', after: { ...query, rows: s.rows.length }, req });
      sendCsv(
        res,
        `monthly_${query.month}.csv`,
        toCsv(
          ['Month', 'Employee ID', 'Employee', 'Workplace', 'Shifts scheduled', 'Present', 'Late', 'Leave (days)', 'Holidays', 'Absent', 'Hours worked', 'Overtime (hours)', 'Left early'],
          s.rows.map((r) => [query.month, r.employee_code, r.full_name, r.workplace_name, r.scheduled, r.present, r.late, r.leave, r.holidays, r.absent, (r.worked_minutes / 60).toFixed(2), (r.overtime_minutes / 60).toFixed(2), r.left_early]),
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
        `SELECT ar.shift_date, w.name AS workplace_name, count(*)::int AS attended, count(*) FILTER (WHERE ar.is_late)::int AS late,
                count(*) FILTER (WHERE ar.verification_status = 'MANUAL_APPROVED')::int AS manual
         FROM attendance_records ar JOIN workplaces w ON w.id = ar.workplace_id
         WHERE w.org_id = $5 AND ar.shift_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR ar.workplace_id = $3) AND ($4 OR NOT ar.is_simulated) AND ar.verification_status <> 'VOIDED'
         GROUP BY ar.shift_date, w.name ORDER BY ar.shift_date DESC, w.name`,
        [query.from, query.to, query.workplaceId ?? null, query.includeSimulated === 'true', user.orgId],
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
      const rows = await q(
        `SELECT ar.shift_date, ep.employee_code, u.full_name, w.name AS workplace, sh.name AS shift, ar.recorded_at, ar.verification_status,
                ar.is_late, ar.late_by_minutes, ROUND(ar.evidence_distance_m::numeric, 1) AS distance_m, ROUND(ar.evidence_accuracy_m::numeric, 1) AS accuracy_m,
                ar.radius_m_at_record, array_to_string(ar.risk_flags, ' ') AS risk_flags,
                (SELECT COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, now()) - a.started_at))) / 60), 0)::int FROM absence_intervals a WHERE a.session_id = ar.session_id) AS away_minutes,
                (SELECT count(*)::int FROM absence_intervals a WHERE a.session_id = ar.session_id AND a.prolonged_at IS NOT NULL) AS prolonged_absences,
                s.ended_at AS shift_ended_at, ar.is_simulated, aw.worked_minutes, aw.scheduled_minutes, aw.ended_early_minutes,
                aw.overtime_minutes, aw.overtime_claimed_minutes, aw.overtime_status
         FROM attendance_records ar JOIN users u ON u.id = ar.employee_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id
         JOIN workplaces w ON w.id = ar.workplace_id JOIN shifts sh ON sh.id = ar.shift_id LEFT JOIN tracking_sessions s ON s.id = ar.session_id
         LEFT JOIN attendance_work aw ON aw.attendance_id = ar.id
         WHERE u.org_id = $6 AND ar.shift_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR ar.workplace_id = $3) AND ($4::uuid IS NULL OR ar.employee_id = $4) AND ($5 OR NOT ar.is_simulated)
         ORDER BY ar.shift_date, w.name, sh.name, u.full_name`,
        [query.from, query.to, query.workplaceId ?? null, query.employeeId ?? null, query.includeSimulated === 'true', user.orgId],
      );
      await audit({ actor: user, action: 'report.export', resourceType: 'attendance_csv', after: { ...query, rows: rows.length }, req });
      const { workforce } = await getSettings(user.orgId);
      sendCsv(
        res,
        `attendance_${query.from}_${query.to}.csv`,
        toCsv(
          ['Date', 'Employee ID', 'Employee', 'Workplace', 'Shift', 'Recorded at (UTC, server)', 'Verification', 'Late', 'Late by (min)', 'Distance (m)', 'GPS accuracy (m)', 'Radius (m)', 'Risk flags', 'Away (min)', 'Prolonged absences', 'Shift ended at (UTC)', 'Worked (min)', 'Overtime worked (min)', 'Overtime status', 'Overtime approved (min)', 'Left early', 'Simulated'],
          rows.map((r) => {
            const f = workFlags(r, workforce);
            return [r.shift_date, r.employee_code, r.full_name, r.workplace, r.shift, r.recorded_at, r.verification_status, r.is_late ? 'yes' : 'no', r.late_by_minutes, r.distance_m, r.accuracy_m, r.radius_m_at_record, r.risk_flags, r.away_minutes, r.prolonged_absences, r.shift_ended_at, r.worked_minutes ?? '', r.overtime_claimed_minutes || '', r.overtime_status ?? '', f.overtime_minutes || '', f.left_early ? 'yes' : '', r.is_simulated ? 'SIMULATED' : ''];
          }),
        ),
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
      const rows = await q(
        `SELECT a.started_at, a.ended_at, a.status, a.threshold_minutes, a.prolonged_at, a.tracking_gap, ep.employee_code, u.full_name, w.name AS workplace,
                ROUND(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, now()) - a.started_at)) / 60)::int AS minutes, a.is_simulated
         FROM absence_intervals a JOIN users u ON u.id = a.employee_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id JOIN workplaces w ON w.id = a.workplace_id
         WHERE u.org_id = $6 AND a.started_at >= $1::date AND a.started_at < $2::date + 1 AND ($3::uuid IS NULL OR a.workplace_id = $3) AND ($4::uuid IS NULL OR a.employee_id = $4) AND ($5 OR NOT a.is_simulated)
         ORDER BY a.started_at`,
        [query.from, query.to, query.workplaceId ?? null, query.employeeId ?? null, query.includeSimulated === 'true', user.orgId],
      );
      await audit({ actor: user, action: 'report.export', resourceType: 'absences_csv', after: { ...query, rows: rows.length }, req });
      sendCsv(
        res,
        `absences_${query.from}_${query.to}.csv`,
        toCsv(
          ['Employee ID', 'Employee', 'Workplace', 'Departed (UTC)', 'Returned / closed (UTC)', 'Status', 'Duration (min)', 'Threshold (min)', 'Prolonged at (UTC)', 'Tracking gap during absence', 'Simulated'],
          rows.map((r) => [r.employee_code, r.full_name, r.workplace, r.started_at, r.ended_at, r.status, r.minutes, r.threshold_minutes, r.prolonged_at, r.tracking_gap ? 'yes' : 'no', r.is_simulated ? 'SIMULATED' : '']),
        ),
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
          ['Date', 'Workplace', 'Shift', 'Start', 'End', 'Time zone', 'Employee ID', 'Employee', 'Attendance', 'Recorded at (UTC)', 'Late', 'Late by (min)', 'Session state', 'Away (min)', 'Prolonged absences', 'Worked (min)', 'Overtime (min)', 'Left early'],
          rows.map((r) => [query.date, r.workplace_name, r.shift_name, r.start_time?.slice(0, 5), r.end_time?.slice(0, 5), r.timezone, r.employee_code, r.full_name,r.attendance_id ? r.verification_status : r.holiday ? `HOLIDAY (${r.holiday})` : r.on_leave ? `ON LEAVE (${r.on_leave.leave_type}${r.on_leave.half_day ? ', half day' : ''})` : 'NOT RECORDED', r.recorded_at, r.is_late ? 'yes' : '', r.late_by_minutes ?? '', r.state ?? 'NOT STARTED', r.away_minutes ?? 0, r.prolonged_count ?? 0, r.worked_minutes ?? '', r.overtime_minutes || '', r.left_early ? 'yes' : '']),
        ),
      );
    },
  }),
]);
