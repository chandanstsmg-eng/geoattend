/**
 * Company (organization) and site isolation.
 *
 * Every admin route whose path has `:id` declares `scope` — what kind of record the id
 * is — and `mount()` refuses ids that belong to another company, or (for supervisors)
 * to a workplace outside their sites, before the handler runs: 404, so such ids are not
 * even confirmed to exist. List queries filter with `orgId` and `siteFilter()` themselves;
 * test/tenancy.test.ts checks both for every registered admin route.
 */
import { one } from '../db/pool.js';
import { notFound } from './errors.js';

export const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

/** SQL for an employee's current workplace. */
export const employeeSite = (employeeCol: string) => `(SELECT wa.workplace_id FROM workplace_assignments wa WHERE wa.employee_id = ${employeeCol} AND wa.effective_to IS NULL LIMIT 1)`;

// Each query returns the record's workplace (`wp`) if it belongs to the company ($2).
const OWNERSHIP = {
  employee: ['Employee', `SELECT ${employeeSite('u.id')} AS wp FROM users u WHERE u.id = $1 AND u.org_id = $2`],
  workplace: ['Workplace', `SELECT id AS wp FROM workplaces WHERE id = $1 AND org_id = $2`],
  shift: ['Shift', `SELECT s.workplace_id AS wp FROM shifts s JOIN workplaces w ON w.id = s.workplace_id WHERE s.id = $1 AND w.org_id = $2`],
  session: ['Session', `SELECT s.workplace_id AS wp FROM tracking_sessions s JOIN users u ON u.id = s.employee_id WHERE s.id = $1 AND u.org_id = $2`],
  attendance: ['Attendance record', `SELECT a.workplace_id AS wp FROM attendance_records a JOIN users u ON u.id = a.employee_id WHERE a.id = $1 AND u.org_id = $2`],
  review: ['Review request', `SELECT ${employeeSite('u.id')} AS wp FROM review_requests r JOIN users u ON u.id = r.employee_id WHERE r.id = $1 AND u.org_id = $2`],
  leave: ['Leave request', `SELECT ${employeeSite('u.id')} AS wp FROM leave_requests l JOIN users u ON u.id = l.employee_id WHERE l.id = $1 AND u.org_id = $2`],
  device: ['Phone', `SELECT ${employeeSite('u.id')} AS wp FROM device_registrations d JOIN users u ON u.id = d.user_id WHERE d.id = $1 AND u.org_id = $2`],
  holiday: ['Holiday', `SELECT workplace_id AS wp FROM holidays WHERE id = $1 AND org_id = $2`],
  notification: ['Notification', `SELECT COALESCE(workplace_id, ${employeeSite('employee_id')}) AS wp FROM notifications WHERE id = $1 AND org_id = $2`],
  payslip: ['Payslip', `SELECT ${employeeSite('p.employee_id')} AS wp FROM payslips p JOIN payroll_runs r ON r.id = p.run_id WHERE p.id = $1 AND r.org_id = $2`],
  adjustment: ['Adjustment', `SELECT ${employeeSite('u.id')} AS wp FROM pay_adjustments a JOIN users u ON u.id = a.employee_id WHERE a.id = $1 AND u.org_id = $2`],
  task: ['Task', `SELECT COALESCE(t.workplace_id, ${employeeSite('t.assignee_id')}) AS wp FROM tasks t WHERE t.id = $1 AND t.org_id = $2`],
  sos: ['SOS', `SELECT COALESCE(s.workplace_id, ${employeeSite('s.employee_id')}) AS wp FROM sos_alerts s WHERE s.id = $1 AND s.org_id = $2`],
  broadcast: ['Announcement', `SELECT b.workplace_id AS wp FROM broadcasts b WHERE b.id = $1 AND b.org_id = $2`],
  overtime: ['Overtime', `SELECT o.workplace_id AS wp FROM overtime_entries o JOIN users u ON u.id = o.employee_id WHERE o.id = $1 AND u.org_id = $2`],
  admin: ['Administrator', `SELECT NULL::uuid AS wp FROM users WHERE id = $1 AND org_id = $2 AND role = 'ADMIN'`],
} as const;

export type Scope = keyof typeof OWNERSHIP;

/**
 * Refuses (404) a record of another company, or — when `sites` is given (a supervisor) —
 * a record whose workplace is not one of their sites.
 */
export async function assertInOrg(scope: Scope, id: string, orgId: string, sites: string[] | null = null) {
  const [what, sql] = OWNERSHIP[scope];
  const row = await one(sql, [id, orgId]);
  if (!row || (sites && !sites.includes(row.wp))) throw notFound(what);
}

/**
 * SQL condition limiting rows to a supervisor's sites; always true for owners.
 * `param` is the placeholder that will hold `user.sites` (null for owners).
 */
export const siteFilter = (workplaceExpr: string, param: string) => `(${param}::uuid[] IS NULL OR ${workplaceExpr} = ANY(${param}::uuid[]))`;

/**
 * SQL array of the workplaces a supervisor (id in `param`) manages — used by "filter by supervisor"
 * so an owner sees exactly what that supervisor sees. Always combined with the caller's own org /
 * site filter, so it can only narrow results.
 */
export const SUPERVISOR_SITES = (param: string) => `COALESCE((SELECT ap.site_ids FROM administrator_profiles ap WHERE ap.user_id = ${param}::uuid AND ap.access = 'SUPERVISOR'), '{}'::uuid[])`;
