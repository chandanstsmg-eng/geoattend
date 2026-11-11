/**
 * Company (organization) and site isolation.
 *
 * Every admin route whose path has `:id` declares `scope` — what kind of record the id
 * is — and `mount()` refuses ids that belong to another company, or (for supervisors)
 * to a workplace outside their sites, before the handler runs: 404, so such ids are not
 * even confirmed to exist. List queries filter with `orgId` and `siteFilter()` themselves;
 * test/tenancy.test.ts checks both for every registered admin route.
 */
import { asSystem, one } from '../db/pool.js';
import { notFound } from './errors.js';

export const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

/** SQL for an employee's current workplace. */
export const employeeSite = (employeeCol: string) => `(SELECT wa.workplace_id FROM workplace_assignments wa WHERE wa.employee_id = ${employeeCol} AND wa.effective_to IS NULL LIMIT 1)`;

/**
 * Supervisor visibility (approved policy, Phase I): a supervisor sees only the employees assigned to them
 * (employee_profiles.supervisor_id) at their own workplaces; owners see the whole company. The signed-in
 * supervisor's id is set on the database connection (app.supervisor_id, lib/http.ts → db/pool.ts), so this
 * condition needs no extra parameter and is true for owners, background jobs and system work.
 */
export const CALLER_SUPERVISOR = `NULLIF(current_setting('app.supervisor_id', true), '')::uuid`;

/**
 * SQL: the employee in `employeeExpr` is visible to the caller. Rows about no employee (a workplace-wide
 * notification or task) are left to the workplace condition.
 */
export const teamFilter = (employeeExpr: string) =>
  `(${CALLER_SUPERVISOR} IS NULL OR ${employeeExpr} IS NULL OR EXISTS (SELECT 1 FROM employee_profiles tp WHERE tp.user_id = ${employeeExpr} AND tp.supervisor_id = ${CALLER_SUPERVISOR}))`;

// Each query returns the record's workplace (`wp`) if it belongs to the company ($2), and whether its employee
// (if it concerns one) is in the calling supervisor's team (`in_team`, always true for owners).
const t = teamFilter;
const OWNERSHIP = {
  employee: ['Employee', `SELECT ${employeeSite('u.id')} AS wp, ${t('u.id')} AS in_team FROM users u WHERE u.id = $1 AND u.org_id = $2`],
  workplace: ['Workplace', `SELECT id AS wp, true AS in_team FROM workplaces WHERE id = $1 AND org_id = $2`],
  shift: ['Shift', `SELECT s.workplace_id AS wp, true AS in_team FROM shifts s JOIN workplaces w ON w.id = s.workplace_id WHERE s.id = $1 AND w.org_id = $2`],
  session: ['Session', `SELECT s.workplace_id AS wp, ${t('s.employee_id')} AS in_team FROM tracking_sessions s JOIN users u ON u.id = s.employee_id WHERE s.id = $1 AND u.org_id = $2`],
  attendance: ['Attendance record', `SELECT a.workplace_id AS wp, ${t('a.employee_id')} AS in_team FROM attendance_records a JOIN users u ON u.id = a.employee_id WHERE a.id = $1 AND u.org_id = $2`],
  review: ['Review request', `SELECT ${employeeSite('u.id')} AS wp, ${t('u.id')} AS in_team FROM review_requests r JOIN users u ON u.id = r.employee_id WHERE r.id = $1 AND u.org_id = $2`],
  leave: ['Leave request', `SELECT ${employeeSite('u.id')} AS wp, ${t('u.id')} AS in_team FROM leave_requests l JOIN users u ON u.id = l.employee_id WHERE l.id = $1 AND u.org_id = $2`],
  device: ['Phone', `SELECT ${employeeSite('u.id')} AS wp, (u.role <> 'EMPLOYEE' OR ${t('u.id')}) AS in_team FROM device_registrations d JOIN users u ON u.id = d.user_id WHERE d.id = $1 AND u.org_id = $2`],
  holiday: ['Holiday', `SELECT workplace_id AS wp, true AS in_team FROM holidays WHERE id = $1 AND org_id = $2`],
  notification: ['Notification', `SELECT COALESCE(workplace_id, ${employeeSite('employee_id')}) AS wp, ${t('employee_id')} AS in_team FROM notifications WHERE id = $1 AND org_id = $2`],
  payslip: ['Payslip', `SELECT ${employeeSite('p.employee_id')} AS wp, ${t('p.employee_id')} AS in_team FROM payslips p JOIN payroll_runs r ON r.id = p.run_id WHERE p.id = $1 AND r.org_id = $2`],
  adjustment: ['Adjustment', `SELECT ${employeeSite('u.id')} AS wp, ${t('u.id')} AS in_team FROM pay_adjustments a JOIN users u ON u.id = a.employee_id WHERE a.id = $1 AND u.org_id = $2`],
  task: ['Task', `SELECT COALESCE(t.workplace_id, ${employeeSite('t.assignee_id')}) AS wp, ${t('t.assignee_id')} AS in_team FROM tasks t WHERE t.id = $1 AND t.org_id = $2`],
  sos: ['SOS', `SELECT COALESCE(s.workplace_id, ${employeeSite('s.employee_id')}) AS wp, ${t('s.employee_id')} AS in_team FROM sos_alerts s WHERE s.id = $1 AND s.org_id = $2`],
  broadcast: ['Announcement', `SELECT b.workplace_id AS wp, true AS in_team FROM broadcasts b WHERE b.id = $1 AND b.org_id = $2`],
  overtime: ['Overtime', `SELECT o.workplace_id AS wp, ${t('o.employee_id')} AS in_team FROM overtime_entries o JOIN users u ON u.id = o.employee_id WHERE o.id = $1 AND u.org_id = $2`],
  admin: ['Administrator', `SELECT NULL::uuid AS wp, true AS in_team FROM users WHERE id = $1 AND org_id = $2 AND role = 'ADMIN'`],
} as const;

export type Scope = keyof typeof OWNERSHIP;

/**
 * Refuses (404) a record of another company, or — when `sites` is given (a supervisor) —
 * a record whose workplace is not one of their sites, or whose employee is not in their team.
 */
export async function assertInOrg(scope: Scope, id: string, orgId: string, sites: string[] | null = null) {
  const [what, sql] = OWNERSHIP[scope];
  const row = await one(sql, [id, orgId]);
  if (!row || (sites && !sites.includes(row.wp)) || row.in_team === false) throw notFound(what);
}

/**
 * The calling supervisor's team as a set of employee ids, or null when there is no supervisor (owners, jobs).
 * For large range queries that filter their rows afterwards: inside such a query the team condition made the
 * planner expect a handful of rows and choose a join that was 5 times slower (11 Nov 2026, 1,032 employees).
 */
export async function callerTeam(): Promise<Set<string> | null> {
  const r = await one(`SELECT ${CALLER_SUPERVISOR} AS sup, ARRAY(SELECT tp.user_id FROM employee_profiles tp WHERE tp.supervisor_id = ${CALLER_SUPERVISOR}) AS team`);
  return r?.sup ? new Set<string>(r.team) : null;
}

/** Whether the calling supervisor may see this employee (always true for owners and system work). */
export async function inCallerTeam(employeeId: string) {
  return !!(await one(`SELECT ${teamFilter('$1::uuid')} AS ok`, [employeeId]))?.ok;
}

/**
 * Whether an account anywhere already uses this address. Sign-in is by address alone, so it must stay
 * unique across companies. This is the one check that must look past the caller's company; it answers
 * yes or no and returns nothing else.
 */
export const emailTaken = (email: string, exceptUserId: string | null = null) =>
  asSystem(async () => !!(await one('SELECT 1 FROM users WHERE lower(email) = lower($1) AND ($2::uuid IS NULL OR id <> $2)', [email, exceptUserId])));

/**
 * SQL condition limiting rows to a supervisor's sites; always true for owners.
 * `param` is the placeholder that will hold `user.sites` (null for owners).
 */
/** SQL: this overtime entry counts, i.e. its shift's attendance was neither voided nor still waiting for verification. The entry itself stays as history. */
export const overtimeCounts = (o = 'o') => `NOT EXISTS (SELECT 1 FROM attendance_records uncounted WHERE uncounted.id = ${o}.attendance_id AND uncounted.verification_status IN ('VOIDED', 'PENDING_VERIFICATION'))`;

/** SQL: this attendance record counts towards official figures. Voided and pending records stay in history only. */
export const attendanceCounts = (ar = 'ar') => `${ar}.verification_status NOT IN ('VOIDED', 'PENDING_VERIFICATION')`;

/**
 * SQL join to a record's worked time, one record at a time. A plain join to the view lets the planner
 * compute the view for the whole company first: under row-level security it did so for about 20,000
 * records, taking 424 ms instead of 5 for a page of 100. OFFSET 0 keeps the lookup per record.
 */
export const workJoin = (ar = 'ar', alias = 'aw', view = 'attendance_work') => `LATERAL (SELECT * FROM ${view} wj WHERE wj.attendance_id = ${ar}.id OFFSET 0) ${alias} ON true`;

/**
 * The same worked time for queries over a run of days (hours, the dashboard, the roster). One record at a
 * time cost about 0.05 ms each, 3 s for 90 days of a 1,000-person company; joined as a set, with the view
 * bounded to the same days so it is never computed for the rest of the company's history, it takes a
 * fraction. The extra date condition repeats the record's own date, so exactly the same rows join.
 * `from` / `to`: SQL expressions for the first and last day (one day: pass the same for both).
 */
export const workJoinForDays = (from: string, to: string, ar = 'ar', alias = 'aw', view = 'attendance_work') =>
  `${view} ${alias} ON ${alias}.attendance_id = ${ar}.id AND ${alias}.shift_date BETWEEN ${from} AND ${to}`;

/** SQL: minutes of a record waiting for verification, shown apart from official time; NULL for any other record. */
export const pendingMinutes = (ar = 'ar') => `CASE WHEN ${ar}.verification_status = 'PENDING_VERIFICATION' THEN (SELECT pw.worked_minutes FROM attendance_work_all pw WHERE pw.attendance_id = ${ar}.id) END`;

/**
 * SQL: limits rows to the caller's reach. Workplace: a supervisor's sites (`param` holds `user.sites`, null for
 * owners). Employee (when the rows are about one, `employeeExpr`): a supervisor's own team.
 */
export const siteFilter = (workplaceExpr: string, param: string, employeeExpr?: string) =>
  `(${param}::uuid[] IS NULL OR ${workplaceExpr} = ANY(${param}::uuid[]))${employeeExpr ? ` AND ${teamFilter(employeeExpr)}` : ''}`;

/**
 * SQL: an owner's "filter by supervisor" (`param` holds that supervisor's id, or null) keeps that supervisor's
 * team, so the owner sees exactly what the supervisor sees. Combined with SUPERVISOR_SITES for the workplaces.
 */
export const supervisorTeam = (param: string, employeeExpr: string) =>
  `(${param}::uuid IS NULL OR EXISTS (SELECT 1 FROM employee_profiles st WHERE st.user_id = ${employeeExpr} AND st.supervisor_id = ${param}::uuid))`;

/**
 * SQL array of the workplaces a supervisor (id in `param`) manages — used by "filter by supervisor"
 * so an owner sees exactly what that supervisor sees. Always combined with the caller's own org /
 * site filter, so it can only narrow results.
 */
export const SUPERVISOR_SITES = (param: string) => `COALESCE((SELECT ap.site_ids FROM administrator_profiles ap WHERE ap.user_id = ${param}::uuid AND ap.access = 'SUPERVISOR'), '{}'::uuid[])`;
