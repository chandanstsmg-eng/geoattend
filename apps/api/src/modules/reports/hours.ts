/**
 * Worked days, hours and overtime per employee over a date range — one calculation for the
 * dashboards and the CSV exports, so the numbers always agree.
 *
 * Per attendance record (one shift on one work date; duplicates are impossible, see
 * attendance_records' unique keys) the `attendance_work` view gives:
 *   worked_minutes   net regular time: from attendance (or shift start, if later) to the shift's
 *                    scheduled end or the actual end, minus time away and unpaid breaks
 *   overtime_minutes overtime an administrator approved (worked after the shift; pending /
 *                    rejected overtime is 0)
 *
 * Policy (Settings › workforce):
 *   roundingMinutes     each record's net regular time is rounded to the nearest N minutes
 *   weeklyRegularHours  regular time beyond this per Monday–Sunday week becomes overtime
 *
 * Totals are consistent by construction:
 *   total    = regular time + approved overtime   (all time worked; overtime is part of it)
 *   overtime = approved overtime + weekly excess
 *   regular  = total − overtime
 * Days = distinct work dates (the shift's local start date, so an overnight shift is one day).
 *
 * A record waiting for verification is not in any of these figures. Its time is reported apart as
 * pending_minutes until a person approves the record, which moves it into the totals.
 */
import { DateTime } from 'luxon';
import { q } from '../../db/pool.js';
import type { AuthUser } from '../../lib/auth.js';
import { SUPERVISOR_SITES, siteFilter, workJoinForDays } from '../../lib/tenancy.js';

export interface WorkRecord {
  employee_id: string;
  full_name: string;
  employee_code?: string | null;
  shift_date: string;
  workplace_id: string;
  workplace_name?: string;
  /** null: no tracked session (manual attendance) — the day counts, the hours are unknown. */
  worked_minutes: number | null;
  overtime_minutes: number;
  scheduled_minutes?: number | null;
  in_progress: boolean;
  /** Session ended by the system at window close (no check-out) or still open after its end. */
  incomplete: boolean;
}

export interface HoursPolicy {
  roundingMinutes: number;
  weeklyRegularHours: number;
}

export interface EmployeeHours {
  employee_id: string;
  full_name: string;
  employee_code: string | null;
  days: number;
  total_minutes: number;
  regular_minutes: number;
  overtime_minutes: number;
  scheduled_minutes: number;
  incomplete: number;
  unmeasured: number;
  /** Time on records waiting for verification. Not part of any total above. */
  pending_minutes: number;
  pending_records: number;
}

export const roundTo = (m: number, step: number) => (step > 0 ? Math.round(m / step) * step : m);
// A 90-day report of a 1,000-person company asks this ~65,000 times for ~90 dates: parsed once per date.
const weeks = new Map<string, string>();
/** Monday of the ISO week of a YYYY-MM-DD date. */
export const weekOf = (iso: string) => {
  let w = weeks.get(iso);
  if (w === undefined) {
    w = DateTime.fromISO(iso).startOf('week').toISODate()!; // ISO weeks start on Monday
    if (weeks.size > 20_000) weeks.clear();
    weeks.set(iso, w);
  }
  return w;
};
/**
 * Order of YYYY-MM-DD dates, then employee ids (lower-case UUIDs): plain character order, which for these
 * fixed-format strings is the order localeCompare gave, without its per-call collation cost.
 */
export const byDateThenEmployee = (a: { shift_date: string; employee_id: string }, b: { shift_date: string; employee_id: string }) =>
  a.shift_date < b.shift_date ? -1 : a.shift_date > b.shift_date ? 1 : a.employee_id < b.employee_id ? -1 : a.employee_id > b.employee_id ? 1 : 0;

/**
 * Per-record split into regular and overtime minutes, applying rounding and the weekly rule in
 * date order. `records` may start before `from` (the rest of the first week) so the weekly rule
 * sees the whole week; only records dated within [from, to] are returned.
 */
export function splitRecords(records: WorkRecord[], policy: HoursPolicy, from: string, to: string) {
  const limit = policy.weeklyRegularHours > 0 ? policy.weeklyRegularHours * 60 : Infinity;
  const sorted = [...records].sort(byDateThenEmployee);
  const used = new Map<string, number>(); // employee|week → regular minutes so far
  const out: Array<WorkRecord & { regular: number; overtime: number; total: number }> = [];
  for (const r of sorted) {
    const regular = roundTo(Math.max(0, r.worked_minutes ?? 0), policy.roundingMinutes);
    const key = `${r.employee_id}|${weekOf(r.shift_date)}`;
    const before = used.get(key) ?? 0;
    const excess = Math.max(0, before + regular - limit) - Math.max(0, before - limit);
    used.set(key, before + regular);
    const approved = Math.max(0, r.overtime_minutes ?? 0);
    if (r.shift_date < from || r.shift_date > to) continue;
    out.push({ ...r, regular: regular - excess, overtime: approved + excess, total: regular + approved });
  }
  return out;
}

/** Per-employee totals for [from, to], sorted by name. */
export function computeHours(records: WorkRecord[], policy: HoursPolicy, from: string, to: string): EmployeeHours[] {
  return hoursFromSplit(splitRecords(records, policy, from, to));
}

/** The same totals from records already split (the dashboard has them, and splitting twice cost ~1 s). */
export function hoursFromSplit(split: ReturnType<typeof splitRecords>): EmployeeHours[] {
  const by = new Map<string, EmployeeHours & { dates: Set<string> }>();
  for (const r of split) {
    let t = by.get(r.employee_id);
    if (!t) {
      t = { employee_id: r.employee_id, full_name: r.full_name, employee_code: r.employee_code ?? null, days: 0, total_minutes: 0, regular_minutes: 0, overtime_minutes: 0, scheduled_minutes: 0, incomplete: 0, unmeasured: 0, pending_minutes: 0, pending_records: 0, dates: new Set() };
      by.set(r.employee_id, t);
    }
    t.dates.add(r.shift_date);
    t.total_minutes += r.total;
    t.regular_minutes += r.regular;
    t.overtime_minutes += r.overtime;
    t.scheduled_minutes += r.scheduled_minutes ?? 0;
    if (r.incomplete) t.incomplete++;
    if (r.worked_minutes == null) t.unmeasured++;
  }
  return [...by.values()]
    .map(({ dates, ...t }) => ({ ...t, days: dates.size }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name) || a.employee_id.localeCompare(b.employee_id));
}

export interface PendingHours {
  employee_id: string;
  full_name: string;
  employee_code: string | null;
  minutes: number;
  records: number;
}

/** Adds pending time to per-employee totals; someone with only pending records appears with official figures of 0. */
export function withPendingHours(rows: EmployeeHours[], pending: PendingHours[]): EmployeeHours[] {
  const by = new Map(rows.map((r) => [r.employee_id, { ...r }]));
  for (const p of pending) {
    const row = by.get(p.employee_id) ?? { employee_id: p.employee_id, full_name: p.full_name, employee_code: p.employee_code, days: 0, total_minutes: 0, regular_minutes: 0, overtime_minutes: 0, scheduled_minutes: 0, incomplete: 0, unmeasured: 0, pending_minutes: 0, pending_records: 0 };
    row.pending_minutes = p.minutes;
    row.pending_records = p.records;
    by.set(p.employee_id, row);
  }
  return [...by.values()].sort((a, b) => a.full_name.localeCompare(b.full_name) || a.employee_id.localeCompare(b.employee_id));
}

/** Hours with two decimals, from minutes (for CSV and tables). */
export const hoursText = (minutes: number) => (Math.round((minutes / 60) * 100) / 100).toFixed(2);

export interface RecordFilter {
  from: string;
  to: string;
  workplaceId?: string | null;
  employeeId?: string | null;
  supervisorId?: string | null;
  includeSimulated?: boolean;
}

/**
 * Attendance records visible to `user` in [from − rest of first week, to]. Records are scoped by
 * where the work happened (the attendance workplace), like sessions on the overview: a worker
 * rostered at another site counts for that site's supervisor.
 */
export async function loadPendingHours(user: Pick<AuthUser, 'orgId' | 'sites'>, f: RecordFilter): Promise<PendingHours[]> {
  return q(
    `SELECT ar.employee_id, u.full_name, ep.employee_code, COALESCE(SUM(aw.worked_minutes), 0)::int AS minutes, count(*)::int AS records
     FROM attendance_records ar
     JOIN ${workJoinForDays('$3::date', '$4::date', 'ar', 'aw', 'attendance_work_all')}
     JOIN users u ON u.id = ar.employee_id
     LEFT JOIN employee_profiles ep ON ep.user_id = u.id
     WHERE ar.verification_status = 'PENDING_VERIFICATION' AND u.org_id = $1 AND ${siteFilter('ar.workplace_id', '$2')}
       AND ar.shift_date BETWEEN $3::date AND $4::date
       AND ($5::uuid IS NULL OR ar.workplace_id = $5) AND ($6::uuid IS NULL OR ar.employee_id = $6)
       AND ($7::uuid IS NULL OR ar.workplace_id = ANY(${SUPERVISOR_SITES('$7')}))
       AND ($8 OR (NOT ar.is_simulated AND NOT u.is_demo))
     GROUP BY ar.employee_id, u.full_name, ep.employee_code`,
    [user.orgId, user.sites, f.from, f.to, f.workplaceId ?? null, f.employeeId ?? null, f.supervisorId ?? null, !!f.includeSimulated],
  );
}

export async function loadWorkRecords(user: Pick<AuthUser, 'orgId' | 'sites'>, f: RecordFilter): Promise<WorkRecord[]> {
  const start = weekOf(f.from);
  const rows = await q(
    `SELECT ar.employee_id, u.full_name, ep.employee_code, to_char(ar.shift_date, 'YYYY-MM-DD') AS shift_date, ar.workplace_id, w.name AS workplace_name,
            aw.worked_minutes, aw.overtime_minutes, aw.scheduled_minutes, aw.in_progress,
            (s.authorization_status = 'EXPIRED' OR (s.ended_at IS NULL AND s.state <> 'ON_OVERTIME' AND s.scheduled_end_at < now())) AS incomplete
     FROM attendance_records ar
     JOIN ${workJoinForDays('$3::date', '$4::date')}
     JOIN users u ON u.id = ar.employee_id
     LEFT JOIN employee_profiles ep ON ep.user_id = u.id
     JOIN workplaces w ON w.id = ar.workplace_id
     LEFT JOIN tracking_sessions s ON s.id = ar.session_id
     WHERE u.org_id = $1 AND ${siteFilter('ar.workplace_id', '$2')}
       AND ar.shift_date BETWEEN $3::date AND $4::date
       AND ($5::uuid IS NULL OR ar.workplace_id = $5) AND ($6::uuid IS NULL OR ar.employee_id = $6)
       AND ($7::uuid IS NULL OR ar.workplace_id = ANY(${SUPERVISOR_SITES('$7')}))
       -- Without simulated data, fictional demo employees are left out too — the same rule as the
       -- roster, so attendance rates and hours always describe the same people.
       AND ($8 OR (NOT ar.is_simulated AND NOT u.is_demo))`,
    [user.orgId, user.sites, start, f.to, f.workplaceId ?? null, f.employeeId ?? null, f.supervisorId ?? null, !!f.includeSimulated],
  );
  return rows.map((r) => ({ ...r, incomplete: !!r.incomplete, in_progress: !!r.in_progress, overtime_minutes: r.overtime_minutes ?? 0 }));
}
