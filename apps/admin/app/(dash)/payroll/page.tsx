'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Lock, Plus, Trash2, Unlock, Wallet } from 'lucide-react';
import { del, get, post } from '@/lib/api';
import { fmtDateTime, todayISO } from '@/lib/format';
import { LinkButton, Badge, Button, Card, ConfirmButton, EmptyState, Field, InlineError, Input, Modal, PageHeader, QueryState, Select, Table, Td, Textarea, Th } from '@/components/ui';
import { PayForm, PAY_TYPE_LABEL, inr } from '@/components/pay-form';
import { UnconfirmedDays } from '@/components/day-close';

const KINDS = { ADVANCE: 'Advance (deducted)', BONUS: 'Bonus', ALLOWANCE: 'Allowance', DEDUCTION: 'Deduction' } as const;
const hours = (m: number) => (m / 60).toFixed(1);

export default function PayrollPage() {
  const qc = useQueryClient();
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [payFor, setPayFor] = useState<any | null>(null);
  const [adjustFor, setAdjustFor] = useState<any | null>(null);
  const [reopening, setReopening] = useState(false);
  const data = useQuery({ queryKey: ['payroll', month], queryFn: () => get(`/payroll/${month}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['payroll'] });
  const approve = useMutation({ meta: { success: 'Payroll approved and locked' }, mutationFn: () => post(`/payroll/${month}/approve`), onSuccess: refresh });
  const paid = useMutation({ meta: { success: 'Marked as paid' }, mutationFn: () => post(`/payroll/${month}/paid`), onSuccess: refresh });
  const run = data.data?.run;
  const rows: any[] = data.data?.rows ?? [];
  const missing = rows.filter((r) => !r.pay).length;
  const total = rows.reduce((n, r) => n + (r.result?.net ?? 0), 0);
  const payable = rows.filter((r) => r.result).length;
  // The server refuses approval while working days are unconfirmed; mirror that here.
  const unconfirmed = useQuery({ queryKey: ['unconfirmed', month], queryFn: () => get(`/insights/unconfirmed?month=${month}`), enabled: !run });
  const openDays: string[] = (unconfirmed.data as any)?.days ?? [];
  const period = new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <>
      <PageHeader
        title="Payroll"
        eyebrow={<Badge tone="orange" title="Check payslips against your own records before paying">Beta</Badge>}
        description="Pay is worked out from attendance: present days, paid and unpaid leave, holidays, absences, hours and overtime. Approve a month to freeze payslips."
        actions={
          <>
            <Input type="month" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-auto" />
            <LinkButton href={`/api/v1/payroll/${month}/salary.csv`}><Download className="h-4 w-4" aria-hidden /> Salary sheet</LinkButton>
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <Wallet className="h-5 w-5 text-primary-700" aria-hidden />
        <div className="mr-auto">
          <p className="text-2xl font-semibold tabular text-gray-900">{inr(run ? Number(run.total_net) : total)}</p>
          <p className="text-xs text-gray-600">
            {run ? `${run.employees} payslips · ` : `${rows.filter((r) => r.result).length} employees · `}
            {run ? (run.status === 'PAID' ? `paid ${fmtDateTime(run.paid_at)}` : `approved ${fmtDateTime(run.approved_at)}${run.approved_by_name ? ` by ${run.approved_by_name}` : ''}`) : 'draft — numbers update as attendance changes'}
          </p>
        </div>
        {!run && (
          <ConfirmButton
            variant="primary"
            loading={approve.isPending}
            disabled={!payable || openDays.length > 0 || unconfirmed.isLoading}
            title={`Approve payroll for ${period}?`}
            description={`${payable} employee${payable === 1 ? '' : 's'} · total ${inr(total)} · ${period}. Payslips are frozen, the month becomes read-only and the approval is recorded in the audit log. Reopening later needs a reason.`}
            confirmLabel="Approve and lock month"
            onConfirm={() => approve.mutate()}
          >
            <Lock className="h-4 w-4" aria-hidden /> Approve month
          </ConfirmButton>
        )}
        {run?.status === 'APPROVED' && (
          <ConfirmButton variant="primary" loading={paid.isPending} title={`Mark ${period} as paid?`} description={`${run.employees} payslips · total ${inr(Number(run.total_net))}. Record this only after the salaries have left your bank.`} confirmLabel="Mark as paid" onConfirm={() => paid.mutate()}>
            <CheckCircle2 className="h-4 w-4" aria-hidden /> Mark as paid
          </ConfirmButton>
        )}
        {run && (
          <Button onClick={() => setReopening(true)}>
            <Unlock className="h-4 w-4" aria-hidden /> Reopen
          </Button>
        )}
        {run && <Badge tone={run.status === 'PAID' ? 'green' : 'navy'}>{run.status.toLowerCase()}</Badge>}
      </div>
      <InlineError error={approve.error ?? paid.error} />
      {!run && <UnconfirmedDays month={month} />}
      {!run && missing > 0 && (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          {missing} employee{missing === 1 ? ' has' : 's have'} no salary set and will not be paid. Use “Set pay” below.
        </p>
      )}

      <Card padded={false}>
        <QueryState query={data} isEmpty={(d: any) => d.rows.length === 0} empty={<EmptyState title="Nobody to pay this month">Add employees and assign them to shifts, or set their pay.</EmptyState>}>
          {() => (
            <Table>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Pay</Th>
                  <Th className="text-right">Present</Th>
                  <Th className="text-right">Leave (paid / unpaid)</Th>
                  <Th className="text-right">Absent</Th>
                  <Th className="text-right">Hours · OT</Th>
                  <Th className="text-right">Earned</Th>
                  <Th className="text-right">Overtime</Th>
                  <Th className="text-right">+ / −</Th>
                  <Th className="text-right">Net pay</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.employee.id}>
                    <Td>
                      <span className="font-medium">{r.employee.fullName}</span> <span className="text-xs text-gray-500">{r.employee.employeeCode}</span>
                    </Td>
                    <Td className="text-xs">{r.pay ? `${inr(r.pay.amount)} ${PAY_TYPE_LABEL[r.pay.payType as keyof typeof PAY_TYPE_LABEL]}` : <Badge tone="amber">not set</Badge>}</Td>
                    <Td className="text-right tabular">{r.attendance.present}</Td>
                    <Td className="text-right tabular">{r.attendance.paidLeave || 0} / {r.attendance.unpaidLeave || 0}</Td>
                    <Td className={`text-right tabular ${r.attendance.absent ? 'font-semibold text-red-700' : ''}`}>{r.attendance.absent}</Td>
                    <Td className="text-right tabular">{hours(r.attendance.workedMinutes)} · {hours(r.attendance.overtimeMinutes)}</Td>
                    <Td className="text-right tabular">
                      {r.result ? inr(r.result.basic - r.result.lossOfPay) : '—'}
                      {r.result?.lossOfPay > 0 && <div className="text-caption text-red-700">−{inr(r.result.lossOfPay)} for {r.result.lossOfPayDays} day(s)</div>}
                    </Td>
                    <Td className="text-right tabular">{r.result?.overtimePay ? inr(r.result.overtimePay) : '—'}</Td>
                    <Td className="text-right tabular text-xs">
                      {r.result?.additions ? <span className="text-teal-700">+{inr(r.result.additions)}</span> : null} {r.result?.deductions ? <span className="text-red-700">−{inr(r.result.deductions)}</span> : null}
                      {!r.result?.additions && !r.result?.deductions && '—'}
                    </Td>
                    <Td className="text-right tabular font-semibold text-gray-900">
                      {r.result ? inr(r.result.net) : '—'}
                      {r.result?.carryForward > 0 && <div className="text-caption font-normal text-amber-700">{inr(r.result.carryForward)} advance left over</div>}
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-1">
                        {r.payslipId ? (
                          <LinkButton href={`/payroll/payslip/${r.payslipId}`} size="sm">Payslip</LinkButton>
                        ) : (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setPayFor(r)}>Set pay</Button>
                            <Button size="sm" variant="ghost" onClick={() => setAdjustFor(r)}><Plus className="h-3.5 w-3.5" aria-hidden /> Adjust</Button>
                          </>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>
      <p className="mt-3 text-xs text-gray-500">
        Monthly salary: one day’s pay (salary ÷ days in the month) is cut for each absent or unpaid-leave day; weekly offs, holidays and paid leave are paid. Daily wage: paid per day present plus paid leave. Overtime: hourly equivalent × overtime rate.
      </p>

      <Modal open={!!payFor} onOpenChange={(o) => !o && setPayFor(null)} title={`Pay for ${payFor?.employee.fullName ?? ''}`}>
        {payFor && <PayForm employeeId={payFor.employee.id} onSaved={() => setPayFor(null)} />}
      </Modal>
      <AdjustModal row={adjustFor} month={month} onClose={() => setAdjustFor(null)} />
      <ReopenModal open={reopening} month={month} onClose={() => setReopening(false)} />
    </>
  );
}

function AdjustModal({ row, month, onClose }: { row: any | null; month: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ kind: 'ADVANCE', amount: '', note: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['payroll'] });
  const add = useMutation({ meta: { success: 'Adjustment added' },
    mutationFn: () => post('/payroll/adjustments', { employeeId: row.employee.id, month, kind: f.kind, amount: Number(f.amount), note: f.note || undefined }),
    onSuccess: () => {
      setF({ kind: f.kind, amount: '', note: '' });
      refresh();
      onClose();
    },
  });
  const remove = useMutation({ meta: { success: 'Adjustment removed', toastError: true }, mutationFn: (id: string) => del(`/payroll/adjustments/${id}`), onSuccess: () => { refresh(); onClose(); } });
  return (
    <Modal open={!!row} onOpenChange={(o) => !o && onClose()} title={`Adjust ${month} — ${row?.employee.fullName ?? ''}`} description="Advances given during the month are taken back from this month’s pay.">
      {row?.adjustments?.length > 0 && (
        <ul className="mb-4 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
          {row.adjustments.map((a: any) => (
            <li key={a.id} className="flex items-center gap-2 px-3 py-2">
              <span className="flex-1">{KINDS[a.kind as keyof typeof KINDS]} {a.note ? <span className="text-xs text-gray-500">· {a.note}</span> : null}</span>
              <span className="tabular">{inr(a.amount)}</span>
              <Button size="sm" variant="ghost" aria-label="Remove" loading={remove.isPending && remove.variables === a.id} onClick={() => remove.mutate(a.id)}><Trash2 className="h-4 w-4" aria-hidden /></Button>
            </li>
          ))}
        </ul>
      )}
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <Field label="Type">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Amount (₹)"><Input type="number" required min={1} step="any" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Note (optional)"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Diwali advance" /></Field></div>
        <div className="sm:col-span-2"><InlineError error={add.error ?? remove.error} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending}>Add</Button>
        </div>
      </form>
    </Modal>
  );
}

function ReopenModal({ open, month, onClose }: { open: boolean; month: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const reopen = useMutation({ meta: { success: 'Month reopened' },
    mutationFn: () => post(`/payroll/${month}/reopen`, { reason }),
    onSuccess: () => {
      setReason('');
      qc.invalidateQueries({ queryKey: ['payroll'] });
      onClose();
    },
  });
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={`Reopen ${month}?`} description="The frozen payslips are discarded and pay is recalculated from current attendance. Employees stop seeing these payslips until you approve again.">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); reopen.mutate(); }}>
        <Field label="Reason (recorded in the audit log)"><Textarea required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <InlineError error={reopen.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={reopen.isPending}>Reopen month</Button>
        </div>
      </form>
    </Modal>
  );
}
