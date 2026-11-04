/**
 * Payroll is off unless PAYROLL_ENABLED=true: approval, net pay and salary sheets need business rules
 * confirmed by a qualified person first. These checks run on the server; the interface only follows them.
 */
import { config } from '../../config.js';
import { one, type Queryable } from '../../db/pool.js';
import { conflict, HttpError } from '../../lib/errors.js';

export function assertPayrollEnabled() {
  if (!config.payrollEnabled) throw new HttpError(403, 'PAYROLL_DISABLED', 'Payroll is not available in this release. Attendance, hours and overtime reports are unaffected.');
}

/** While payroll is on, a month with a current approved run is frozen: attendance behind its payslips cannot change. */
export async function assertPayrollMonthOpen(orgId: string, date: string, db?: Queryable) {
  if (!config.payrollEnabled) return;
  const month = String(date).slice(0, 7);
  const run = await one(`SELECT 1 FROM payroll_runs WHERE org_id = $1 AND month = $2 AND superseded_at IS NULL`, [orgId, month], db);
  if (run) throw conflict('MONTH_LOCKED', `Payroll for ${month} is already approved. Reopen it to make changes.`);
}
