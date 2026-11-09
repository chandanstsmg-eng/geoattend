/**
 * Payroll-lite. Pay is calculated from the monthly attendance summary (present days,
 * paid / unpaid leave, holidays, absences, hours, overtime) and each employee's pay setup.
 * Until a month is approved the numbers are live; approving freezes a payslip per
 * employee and locks the month. Reopening (with a reason) supersedes that run: it and its
 * payslips stay as history, and the next approval is a new revision.
 * Off unless PAYROLL_ENABLED=true (guard.ts); approved history stays readable to the owner.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one, q, tx } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { idParams, mount, route } from '../../lib/http.js';
import { toCsv } from '../../lib/csv.js';
import { audit } from '../../lib/audit.js';
import { assertInOrg } from '../../lib/tenancy.js';
import { getSettings } from '../settings/settings.service.js';
import { defaultDate, monthlySummary } from '../reports/reports.routes.js';
import { unconfirmedDays } from '../reports/insights.routes.js';
import { calculatePay, daysIn, type PayType } from './calc.js';
import { assertPayrollEnabled } from './guard.js';

const monthParam = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM') });
const ADJ_KINDS = ['ADVANCE', 'BONUS', 'ALLOWANCE', 'DEDUCTION'] as const;

/** Days of `month` between joining and leaving (the whole month when those dates are not recorded). */
function employedDaysIn(month: string, joinedOn: string | null, leftOn: string | null) {
  const days = daysIn(month);
  const first = joinedOn && joinedOn.slice(0, 7) === month ? Number(joinedOn.slice(8, 10)) : 1;
  const last = leftOn && leftOn.slice(0, 7) === month ? Number(leftOn.slice(8, 10)) : days;
  return Math.max(0, last - first + 1);
}

/** Live payroll for a month: everyone employed during it with a pay setup or a scheduled shift. */
export async function computeMonth(orgId: string, month: string, employeeId?: string) {
  assertPayrollEnabled();
  const summary = await monthlySummary(orgId, month, null, false);
  const people = await q(
    `SELECT u.id, u.full_name, ep.employee_code, ep.department, ep.designation, p.pay_type, p.amount::float AS amount, p.ot_multiplier::float AS ot_multiplier, p.hours_per_day::float AS hours_per_day, ep.joined_on, ep.left_on
     FROM users u JOIN employee_profiles ep ON ep.user_id = u.id LEFT JOIN employee_pay p ON p.employee_id = u.id
     WHERE u.org_id = $1 AND u.role = 'EMPLOYEE' AND NOT u.is_demo AND ($2::uuid IS NULL OR u.id = $2)
       AND (ep.joined_on IS NULL OR to_char(ep.joined_on, 'YYYY-MM') <= $3)
       AND (CASE WHEN ep.left_on IS NOT NULL THEN to_char(ep.left_on, 'YYYY-MM') >= $3 ELSE u.is_active END)
     ORDER BY u.full_name`,
    [orgId, employeeId ?? null, month],
  );
  const adjustments = await q(
    `SELECT a.id, a.employee_id, a.kind, a.amount::float AS amount, a.note, a.created_at FROM pay_adjustments a JOIN users u ON u.id = a.employee_id
     WHERE u.org_id = $1 AND a.month = $2 ORDER BY a.created_at`,
    [orgId, month],
  );
  const byEmp = new Map(summary.rows.map((r: any) => [r.employee_id, r]));
  const days = daysIn(month);
  return people
    .filter((p) => p.pay_type || byEmp.has(p.id))
    .map((p) => {
      const s: any = byEmp.get(p.id) ?? { scheduled: 0, present: 0, late: 0, paid_leave: 0, unpaid_leave: 0, holidays: 0, absent: 0, worked_minutes: 0, overtime_minutes: 0, left_early: 0 };
      const mine = adjustments.filter((a) => a.employee_id === p.id);
      const sum = (k: string) => mine.filter((a) => a.kind === k).reduce((n, a) => n + a.amount, 0);
      const attendance = {
        daysInMonth: days, employedDays: employedDaysIn(month, p.joined_on, p.left_on), scheduled: s.scheduled, present: s.present, late: s.late, paidLeave: s.paid_leave, unpaidLeave: s.unpaid_leave,
        holidays: s.holidays, absent: s.absent, workedMinutes: s.worked_minutes, overtimeMinutes: s.overtime_minutes, leftEarly: s.left_early,
      };
      const pay = p.pay_type ? { payType: p.pay_type as PayType, amount: p.amount, otMultiplier: p.ot_multiplier, hoursPerDay: p.hours_per_day } : null;
      return {
        employee: { id: p.id, fullName: p.full_name, employeeCode: p.employee_code, department: p.department, designation: p.designation },
        pay,
        attendance,
        adjustments: mine,
        result: pay ? calculatePay(pay, attendance, { advance: sum('ADVANCE'), bonus: sum('BONUS'), allowance: sum('ALLOWANCE'), deduction: sum('DEDUCTION') }) : null,
      };
    });
}

async function runFor(orgId: string, month: string) {
  return one(`SELECT r.*, u.full_name AS approved_by_name FROM payroll_runs r LEFT JOIN users u ON u.id = r.approved_by WHERE r.org_id = $1 AND r.month = $2 AND r.superseded_at IS NULL`, [orgId, month]);
}

async function assertMonthOpen(orgId: string, month: string) {
  const run = await runFor(orgId, month);
  if (run) throw conflict('MONTH_LOCKED', `Payroll for ${month} is already approved. Reopen it to make changes.`);
}

const payslipSelect = `
  SELECT p.*, r.status AS run_status, r.approved_at, r.paid_at, o.name AS company_name, o.phone AS company_phone
  FROM payslips p JOIN payroll_runs r ON r.id = p.run_id JOIN organizations o ON o.id = r.org_id`;

export const payrollRouter = Router();
mount(payrollRouter, '/api/v1/payroll', 'payroll', [
  // ── pay setup ──
  route({
    method: 'get',
    path: '/pay/:id',
    summary: "An employee's pay setup (null if not set)",
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'employee',
    handler: async ({ params }) => {
      assertPayrollEnabled();
      return one(`SELECT pay_type, amount::float AS amount, ot_multiplier::float AS ot_multiplier, hours_per_day::float AS hours_per_day, updated_at FROM employee_pay WHERE employee_id = $1`, [params.id]);
    },
  }),
  route({
    method: 'put',
    path: '/pay/:id',
    summary: 'Set how an employee is paid',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'employee',
    body: z.object({
      payType: z.enum(['MONTHLY', 'DAILY', 'HOURLY']),
      amount: z.number().min(0).max(10_000_000),
      /** Omitted: the company's overtime rate (Settings › Workforce). */
      otMultiplier: z.number().min(0).max(5).optional(),
      hoursPerDay: z.number().min(1).max(24).default(8),
    }),
    handler: async ({ params, body, user, req }) => {
      assertPayrollEnabled();
      const otMultiplier = body.otMultiplier ?? (await getSettings(user.orgId)).workforce.overtimeMultiplier;
      const before = await one('SELECT * FROM employee_pay WHERE employee_id = $1', [params.id]);
      await q(
        `INSERT INTO employee_pay (employee_id, pay_type, amount, ot_multiplier, hours_per_day, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (employee_id) DO UPDATE SET pay_type = EXCLUDED.pay_type, amount = EXCLUDED.amount, ot_multiplier = EXCLUDED.ot_multiplier,
           hours_per_day = EXCLUDED.hours_per_day, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [params.id, body.payType, body.amount, otMultiplier, body.hoursPerDay, user.id],
      );
      await audit({ actor: user, action: 'payroll.set_pay', resourceType: 'user', resourceId: params.id, before, after: body, req });
      return one(`SELECT pay_type, amount::float AS amount, ot_multiplier::float AS ot_multiplier, hours_per_day::float AS hours_per_day, updated_at FROM employee_pay WHERE employee_id = $1`, [params.id]);
    },
  }),

  // ── adjustments ──
  route({
    method: 'post',
    path: '/adjustments',
    summary: 'Add an advance, bonus, allowance or deduction for a month',
    access: 'admin',
    ownerOnly: true,
    body: z.object({ employeeId: z.uuid(), month: monthParam.shape.month, kind: z.enum(ADJ_KINDS), amount: z.number().positive().max(10_000_000), note: z.string().trim().max(300).optional() }),
    handler: async ({ body, user, req, res }) => {
      assertPayrollEnabled();
      await assertInOrg('employee', body.employeeId, user.orgId);
      await assertMonthOpen(user.orgId, body.month);
      const row = await one(
        `INSERT INTO pay_adjustments (employee_id, month, kind, amount, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, employee_id, month, kind, amount::float AS amount, note, created_at`,
        [body.employeeId, body.month, body.kind, body.amount, body.note || null, user.id],
      );
      await audit({ actor: user, action: 'payroll.adjustment', resourceType: 'pay_adjustment', resourceId: row.id, after: body, req });
      res.status(201);
      return row;
    },
  }),
  route({
    method: 'delete',
    path: '/adjustments/:id',
    summary: 'Remove an adjustment (only while the month is open)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'adjustment',
    handler: async ({ params, user, req }) => {
      assertPayrollEnabled();
      const a = await one('SELECT * FROM pay_adjustments WHERE id = $1', [params.id]);
      await assertMonthOpen(user.orgId, a.month);
      await q('DELETE FROM pay_adjustments WHERE id = $1', [params.id]);
      await audit({ actor: user, action: 'payroll.adjustment_delete', resourceType: 'pay_adjustment', resourceId: params.id, before: a, req });
    },
  }),

  // ── payslips ──
  route({
    method: 'get',
    path: '/payslips/:id',
    summary: 'One payslip (frozen at approval)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'payslip',
    handler: async ({ params }) => one(`${payslipSelect} WHERE p.id = $1`, [params.id]),
  }),

  // ── month ──
  route({
    method: 'get',
    path: '/:month',
    summary: 'Payroll for a month: frozen payslips if approved, otherwise live numbers',
    access: 'admin',
    ownerOnly: true,
    params: monthParam,
    handler: async ({ params, user }) => {
      const run = await runFor(user.orgId, params.month);
      if (run) {
        const slips = await q(`SELECT id, employee_id, net_amount::float AS net_amount, data FROM payslips WHERE run_id = $1 ORDER BY data->'employee'->>'fullName'`, [run.id]);
        return { month: params.month, run, rows: slips.map((s) => ({ ...s.data, payslipId: s.id })) };
      }
      return { month: params.month, run: null, rows: await computeMonth(user.orgId, params.month) };
    },
  }),
  route({
    method: 'post',
    path: '/:month/approve',
    summary: 'Approve the month: freezes a payslip per employee and locks the month',
    access: 'admin',
    ownerOnly: true,
    params: monthParam,
    handler: async ({ params, user, req }) => {
      assertPayrollEnabled();
      // An unfinished month would freeze full pay before its later absences happen.
      if (params.month >= (await defaultDate(user.orgId)).slice(0, 7)) throw conflict('MONTH_NOT_ENDED', 'A month can be approved only after it has ended.');
      const rows = (await computeMonth(user.orgId, params.month)).filter((r) => r.result);
      if (!rows.length) throw badRequest('NOTHING_TO_PAY', 'Set the salary of at least one employee first.');
      // Pay is computed from attendance, so every working day must be confirmed first.
      const open = await unconfirmedDays(user.orgId, params.month);
      if (open.length) throw conflict('DAYS_UNCONFIRMED', `${open.length} day${open.length > 1 ? 's' : ''} of ${params.month} still need confirming in Daily close before payroll can be approved.`, { days: open });
      const org = await one('SELECT name FROM organizations WHERE id = $1', [user.orgId]);
      const run = await tx(async (db) => {
        if (await one('SELECT 1 FROM payroll_runs WHERE org_id = $1 AND month = $2 AND superseded_at IS NULL', [user.orgId, params.month], db)) throw conflict('MONTH_LOCKED', 'This month is already approved.');
        const { revision } = (await one('SELECT COALESCE(max(revision), 0) + 1 AS revision FROM payroll_runs WHERE org_id = $1 AND month = $2', [user.orgId, params.month], db))!;
        const total = rows.reduce((n, r) => n + r.result!.net, 0);
        const run = await one(
          `INSERT INTO payroll_runs (org_id, month, status, total_net, employees, approved_by, revision) VALUES ($1,$2,'APPROVED',$3,$4,$5,$6) RETURNING *`,
          [user.orgId, params.month, total, rows.length, user.id, revision],
          db,
        );
        for (const r of rows) {
          await q(`INSERT INTO payslips (run_id, employee_id, month, net_amount, data) VALUES ($1,$2,$3,$4,$5)`, [run.id, r.employee.id, params.month, r.result!.net, JSON.stringify({ ...r, companyName: org.name, month: params.month })], db);
        }
        await audit({ actor: user, action: 'payroll.approve', resourceType: 'payroll_run', resourceId: run.id, after: { month: params.month, employees: rows.length, totalNet: total }, req }, db);
        return run;
      });
      return run;
    },
  }),
  route({
    method: 'post',
    path: '/:month/paid',
    summary: 'Mark an approved month as paid',
    access: 'admin',
    ownerOnly: true,
    params: monthParam,
    handler: async ({ params, user, req }) => {
      assertPayrollEnabled();
      const run = await runFor(user.orgId, params.month);
      if (!run) throw notFound('Approved payroll');
      if (run.status === 'PAID') throw conflict('ALREADY_PAID', 'This month is already marked as paid.');
      await q(`UPDATE payroll_runs SET status = 'PAID', paid_at = now() WHERE id = $1`, [run.id]);
      await audit({ actor: user, action: 'payroll.paid', resourceType: 'payroll_run', resourceId: run.id, req });
      return runFor(user.orgId, params.month);
    },
  }),
  route({
    method: 'post',
    path: '/:month/reopen',
    summary: 'Unlock an approved month: the run and its payslips stay as history (reason required)',
    access: 'admin',
    ownerOnly: true,
    params: monthParam,
    body: z.object({ reason: z.string().trim().min(5).max(500) }),
    handler: async ({ params, body, user, req }) => {
      assertPayrollEnabled();
      await tx(async (db) => {
        const run = await one(
          `UPDATE payroll_runs SET superseded_at = now(), superseded_by = $3, supersede_reason = $4 WHERE org_id = $1 AND month = $2 AND superseded_at IS NULL RETURNING *`,
          [user.orgId, params.month, user.id, body.reason],
          db,
        );
        if (!run) throw notFound('Approved payroll');
        await audit({ actor: user, action: 'payroll.reopen', resourceType: 'payroll_run', resourceId: run.id, before: { status: run.status, totalNet: run.total_net, revision: run.revision }, reason: body.reason, req }, db);
      });
      return { ok: true };
    },
  }),
  route({
    method: 'get',
    path: '/:month/history',
    summary: 'Every revision of a month, newest first, including superseded runs',
    access: 'admin',
    ownerOnly: true,
    params: monthParam,
    handler: async ({ params, user }) =>
      q(
        `SELECT r.id, r.revision, r.status, r.total_net::float AS total_net, r.employees, r.approved_at, r.paid_at, r.superseded_at, r.supersede_reason,
                a.full_name AS approved_by_name, s.full_name AS superseded_by_name
         FROM payroll_runs r LEFT JOIN users a ON a.id = r.approved_by LEFT JOIN users s ON s.id = r.superseded_by
         WHERE r.org_id = $1 AND r.month = $2 ORDER BY r.revision DESC`,
        [user.orgId, params.month],
      ),
  }),
  route({
    method: 'get',
    path: '/:month/salary.csv',
    summary: 'Salary sheet for the month (CSV) — for your bank or accountant',
    access: 'admin',
    ownerOnly: true,
    raw: true,
    params: monthParam,
    handler: async ({ params, user, res, req }) => {
      assertPayrollEnabled();
      const run = await runFor(user.orgId, params.month);
      const rows: any[] = run
        ? (await q(`SELECT data FROM payslips WHERE run_id = $1 ORDER BY data->'employee'->>'fullName'`, [run.id])).map((s) => s.data)
        : (await computeMonth(user.orgId, params.month)).filter((r) => r.result);
      await audit({ actor: user, action: 'report.export', resourceType: 'salary_csv', after: { month: params.month, rows: rows.length, approved: !!run }, req });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="salary_${params.month}${run ? '' : '_draft'}.csv"`);
      res.send(
        toCsv(
          ['Month', 'Status', 'Employee ID', 'Employee', 'Pay type', 'Rate', 'Payable days', 'Loss-of-pay days', 'Hours worked', 'Overtime hours', 'Basic', 'Loss of pay', 'Overtime pay', 'Bonus + allowance', 'Advances + deductions', 'Net pay'],
          rows.map((r) => [
            params.month, run ? run.status : 'DRAFT', r.employee.employeeCode, r.employee.fullName, r.pay.payType, r.pay.amount, r.result.payableDays ?? '', r.result.lossOfPayDays,
            (r.attendance.workedMinutes / 60).toFixed(2), r.result.overtimeHours, r.result.basic, r.result.lossOfPay, r.result.overtimePay, r.result.additions, r.result.deductions, r.result.net,
          ]),
        ),
      );
    },
  }),
]);
