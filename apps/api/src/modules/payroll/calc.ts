/**
 * Salary for one employee and month, from the monthly attendance summary.
 *
 *  MONTHLY  amount per month. Loss of pay = per-day rate × (absent days + unpaid leave),
 *           per-day rate = amount ÷ calendar days in the month (weekly offs, holidays and
 *           paid leave are paid).
 *  DAILY    amount per day present (half-day paid leave counts as half a day).
 *  HOURLY   amount per hour worked.
 *  Overtime is paid per hour at the hourly equivalent × the employee's multiplier
 *  (monthly: amount ÷ (days in month × hours per day); daily: amount ÷ hours per day).
 * Advances and deductions are subtracted, bonuses and allowances added. Net never goes
 * below zero; anything left over is reported as `carryForward`. Rounded to whole rupees.
 */
export type PayType = 'MONTHLY' | 'DAILY' | 'HOURLY';

export interface PaySetup {
  payType: PayType;
  amount: number;
  otMultiplier: number;
  hoursPerDay: number;
}

export interface MonthAttendance {
  daysInMonth: number;
  scheduled: number;
  present: number;
  paidLeave: number;
  unpaidLeave: number;
  holidays: number;
  absent: number;
  workedMinutes: number;
  overtimeMinutes: number;
}

export interface Adjustments {
  advance: number;
  bonus: number;
  allowance: number;
  deduction: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function calculatePay(pay: PaySetup, a: MonthAttendance, adj: Adjustments) {
  const hourly =
    pay.payType === 'HOURLY' ? pay.amount : pay.payType === 'DAILY' ? pay.amount / pay.hoursPerDay : pay.amount / (a.daysInMonth * pay.hoursPerDay);

  let basic: number;
  let lossOfPayDays = 0;
  let lossOfPay = 0;
  let payableDays: number | null = null;
  if (pay.payType === 'MONTHLY') {
    const perDay = pay.amount / a.daysInMonth;
    lossOfPayDays = Math.min(a.daysInMonth, a.absent + a.unpaidLeave);
    lossOfPay = perDay * lossOfPayDays;
    basic = pay.amount;
    payableDays = a.daysInMonth - lossOfPayDays;
  } else if (pay.payType === 'DAILY') {
    payableDays = a.present + a.paidLeave;
    basic = pay.amount * payableDays;
  } else {
    basic = hourly * (a.workedMinutes / 60);
  }

  const overtimeHours = a.overtimeMinutes / 60;
  const overtimePay = overtimeHours * hourly * pay.otMultiplier;
  const gross = basic - lossOfPay + overtimePay + adj.bonus + adj.allowance;
  const deductions = adj.advance + adj.deduction;
  const raw = gross - deductions;
  const net = Math.max(0, Math.round(raw));
  return {
    hourlyRate: r2(hourly),
    basic: r2(basic),
    payableDays,
    lossOfPayDays,
    lossOfPay: r2(lossOfPay),
    overtimeHours: r2(overtimeHours),
    overtimePay: r2(overtimePay),
    additions: r2(adj.bonus + adj.allowance),
    deductions: r2(deductions),
    gross: r2(gross),
    net,
    carryForward: raw < 0 ? Math.round(-raw) : 0, // advance larger than this month's pay
  };
}

export const daysIn = (month: string) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
