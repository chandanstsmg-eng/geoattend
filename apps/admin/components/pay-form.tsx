'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '@/lib/api';
import { Button, Field, InlineError, Input, Select } from './ui';

export const inr = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

export const PAY_TYPE_LABEL = { MONTHLY: 'per month', DAILY: 'per day', HOURLY: 'per hour' } as const;

/** How an employee is paid: monthly salary, daily wage or hourly rate, plus overtime rate. */
export function PayForm({ employeeId, onSaved }: { employeeId: string; onSaved?: () => void }) {
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ['pay', employeeId], queryFn: () => get(`/payroll/pay/${employeeId}`) });
  const [f, setF] = useState({ payType: 'MONTHLY', amount: '', otMultiplier: '1', hoursPerDay: '8' });
  useEffect(() => {
    const p = current.data;
    if (p) setF({ payType: p.pay_type, amount: String(p.amount), otMultiplier: String(p.ot_multiplier), hoursPerDay: String(p.hours_per_day) });
  }, [current.data]);
  const save = useMutation({ meta: { success: 'Pay saved' },
    mutationFn: () => put(`/payroll/pay/${employeeId}`, { payType: f.payType, amount: Number(f.amount), otMultiplier: Number(f.otMultiplier), hoursPerDay: Number(f.hoursPerDay) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pay', employeeId] });
      qc.invalidateQueries({ queryKey: ['payroll'] });
      onSaved?.();
    },
  });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Field label="Paid">
        <Select value={f.payType} onChange={(e) => setF({ ...f, payType: e.target.value })}>
          <option value="MONTHLY">Monthly salary</option>
          <option value="DAILY">Daily wage</option>
          <option value="HOURLY">Hourly rate</option>
        </Select>
      </Field>
      <Field label={`Amount (₹ ${PAY_TYPE_LABEL[f.payType as keyof typeof PAY_TYPE_LABEL]})`}>
        <Input type="number" required min={0} step="any" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
      </Field>
      <Field label="Overtime rate" hint="1 = normal hourly rate, 2 = double.">
        <Select value={f.otMultiplier} onChange={(e) => setF({ ...f, otMultiplier: e.target.value })}>
          {['0', '1', '1.5', '2'].map((m) => <option key={m} value={m}>{m === '0' ? 'No overtime pay' : `${m}× hourly rate`}</option>)}
        </Select>
      </Field>
      <Field label="Working hours per day" hint="Used to work out the hourly rate for overtime.">
        <Input type="number" min={1} max={24} step="0.5" value={f.hoursPerDay} onChange={(e) => setF({ ...f, hoursPerDay: e.target.value })} />
      </Field>
      <div className="sm:col-span-2"><InlineError error={save.error} /></div>
      <div className="flex items-center gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" loading={save.isPending}>Save pay</Button>
        {save.isSuccess && <span className="text-xs text-teal-700">Saved</span>}
      </div>
    </form>
  );
}
