import { describe, expect, it } from 'vitest';
import { calculatePay, daysIn } from '../src/modules/payroll/calc.js';

const none = { advance: 0, bonus: 0, allowance: 0, deduction: 0 };
const month = (o: Partial<Parameters<typeof calculatePay>[1]> = {}) => ({
  daysInMonth: 30, scheduled: 26, present: 26, paidLeave: 0, unpaidLeave: 0, holidays: 0, absent: 0, workedMinutes: 26 * 480, overtimeMinutes: 0, ...o,
});

describe('payroll calculation', () => {
  it('pays a full monthly salary when nobody is absent', () => {
    const p = calculatePay({ payType: 'MONTHLY', amount: 15000, otMultiplier: 1, hoursPerDay: 8 }, month(), none);
    expect(p.net).toBe(15000);
    expect(p.payableDays).toBe(30);
  });

  it('cuts one day of pay per absent or unpaid-leave day, not for paid leave or holidays', () => {
    const p = calculatePay({ payType: 'MONTHLY', amount: 15000, otMultiplier: 1, hoursPerDay: 8 }, month({ present: 22, absent: 2, unpaidLeave: 1, paidLeave: 1, holidays: 1 }), none);
    expect(p.lossOfPayDays).toBe(3);
    expect(p.lossOfPay).toBe(1500); // 15000 / 30 × 3
    expect(p.net).toBe(13500);
  });

  it('pays overtime at the hourly equivalent times the multiplier', () => {
    // 15000 / (30 × 8) = 62.5 per hour; 3 h × 62.5 × 2 = 375
    const p = calculatePay({ payType: 'MONTHLY', amount: 15000, otMultiplier: 2, hoursPerDay: 8 }, month({ overtimeMinutes: 180 }), none);
    expect(p.overtimePay).toBe(375);
    expect(p.net).toBe(15375);
  });

  it('pays daily wages for days present plus paid leave', () => {
    const p = calculatePay({ payType: 'DAILY', amount: 600, otMultiplier: 1, hoursPerDay: 8 }, month({ present: 20, paidLeave: 1.5, absent: 4 }), none);
    expect(p.payableDays).toBe(21.5);
    expect(p.net).toBe(12900);
  });

  it('pays hourly staff for hours worked', () => {
    const p = calculatePay({ payType: 'HOURLY', amount: 100, otMultiplier: 1.5, hoursPerDay: 8 }, month({ workedMinutes: 90 * 60, overtimeMinutes: 60 }), none);
    expect(p.basic).toBe(9000);
    expect(p.overtimePay).toBe(150);
    expect(p.net).toBe(9150);
  });

  it('adds bonuses, subtracts advances, and never pays below zero', () => {
    const p = calculatePay({ payType: 'MONTHLY', amount: 10000, otMultiplier: 1, hoursPerDay: 8 }, month(), { advance: 3000, bonus: 500, allowance: 200, deduction: 100 });
    expect(p.net).toBe(7600);
    const q = calculatePay({ payType: 'DAILY', amount: 500, otMultiplier: 1, hoursPerDay: 8 }, month({ present: 2 }), { ...none, advance: 5000 });
    expect(q.net).toBe(0);
    expect(q.carryForward).toBe(4000);
  });

  it('knows the length of each month', () => {
    expect(daysIn('2026-02')).toBe(28);
    expect(daysIn('2028-02')).toBe(29);
    expect(daysIn('2026-10')).toBe(31);
  });
});
