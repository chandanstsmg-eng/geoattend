'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { get, post } from '@/lib/api';
import { fmtDate, fmtDateTime, minutes } from '@/lib/format';
import { Button, Callout, Card, EmptyState, Field, InlineError, Input, Modal, QueryState, Textarea } from './ui';

/** End-of-day check: the numbers, what still needs a decision, and a Confirm button. */
export function DayClose({ date, onEmployee }: { date: string; onEmployee: (id: string) => void }) {
  const qc = useQueryClient();
  const day = useQuery({ queryKey: ['day-close', date], queryFn: () => get(`/insights/day?date=${date}`), enabled: !!date });
  const [note, setNote] = useState('');
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['day-close'] });
    qc.invalidateQueries({ queryKey: ['unconfirmed'] });
  };
  const close = useMutation({ meta: { success: 'Day confirmed' }, mutationFn: () => post('/insights/day/close', { date, note: note || undefined }), onSuccess: () => { setNote(''); refresh(); } });
  const reopen = useMutation({ meta: { success: 'Day reopened' },
    mutationFn: () => post('/insights/day/reopen', { date, reason: reason.trim() || 'Reopened' }),
    onSuccess: () => {
      setReopening(false);
      setReason('');
      refresh();
    },
  });

  return (
    <Card title="Daily close" description={`Confirm the attendance of ${fmtDate(date)}. Payroll can be approved only when every working day is confirmed.`}>
      <QueryState query={day}>
        {(d: any) => (
          <div className="space-y-4">
            <dl className="grid grid-cols-4 gap-2 text-center">
              {(
                [
                  ['Present', `${d.counts.present}/${d.counts.scheduled}`, false],
                  ['Late', d.counts.late, false],
                  ['Leave', d.counts.onLeave + (d.counts.holiday || 0), false],
                  ['Absent', d.counts.absent, d.counts.absent > 0],
                ] as Array<[string, string | number, boolean]>
              ).map(([k, v, bad]) => (
                <div key={k} className="rounded-md bg-gray-50 px-1 py-2">
                  <dt className="text-xs text-gray-500">{k}</dt>
                  <dd className={bad ? 'tabular font-semibold text-red-700' : 'tabular font-semibold text-gray-900'}>{v}</dd>
                </div>
              ))}
            </dl>
            {d.counts.overtimeMinutes > 0 && <p className="text-xs text-gray-500">{minutes(d.counts.overtimeMinutes)} overtime recorded.</p>}
            {d.toDecide.length > 0 ? (
              <details className="group rounded-md border border-amber-200 bg-amber-50 text-sm text-amber-900">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-medium">
                  {d.toDecide.length} thing{d.toDecide.length > 1 ? 's' : ''} to check before confirming
                  <span className="text-xs font-normal text-amber-800 group-open:hidden">Show</span>
                  <span className="hidden text-xs font-normal text-amber-800 group-open:inline">Hide</span>
                </summary>
                <ul className="space-y-1.5 border-t border-amber-200 px-3 py-2 text-xs">
                  {d.toDecide.map((t: any, i: number) => (
                    <li key={i}>{t.employeeId ? <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onEmployee(t.employeeId)}>{t.text}</button> : t.text}</li>
                  ))}
                  <li className="pt-1 text-amber-800">
                    Fix them in <Link className="underline" href="/approvals">Approvals</Link> or <Link className="underline" href="/attendance">Attendance</Link>, or confirm as they are.
                  </li>
                </ul>
              </details>
            ) : (
              <Callout tone="success">Nothing left to check for this day.</Callout>
            )}
            {d.closed ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="inline-flex items-center gap-1.5 font-medium text-teal-800">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Confirmed
                </span>
                <span className="text-xs text-gray-500">
                  by {d.closed.closed_by_name}, {fmtDateTime(d.closed.closed_at)}
                  {d.closed.note ? ` — “${d.closed.note}”` : ''}
                </span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setReopening(true)}>Reopen…</Button>
              </div>
            ) : (
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); close.mutate(); }}>
                <Input aria-label="Note for the daily close (optional)" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="min-w-0 flex-1" />
                <Button type="submit" variant="primary" loading={close.isPending}>Confirm day</Button>
              </form>
            )}
            <InlineError error={close.error} />
          </div>
        )}
      </QueryState>
      <Modal open={reopening} onOpenChange={setReopening} title={`Reopen ${fmtDate(date)}?`} description="The day goes back to unconfirmed so its records can be corrected. Your reason is kept in the audit log.">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); reopen.mutate(); }}>
          <Field label="Reason" required>
            <Textarea required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Correcting Asha’s check-in time" />
          </Field>
          <InlineError error={reopen.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setReopening(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={reopen.isPending}>Reopen day</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

/** Warning on the payroll page for past days nobody confirmed. */
export function UnconfirmedDays({ month }: { month: string }) {
  const q = useQuery({ queryKey: ['unconfirmed', month], queryFn: () => get(`/insights/unconfirmed?month=${month}`) });
  const days: string[] = q.data?.days ?? [];
  if (!days.length) return null;
  return (
    <Callout tone="info" className="mb-4">
      {days.length} day{days.length > 1 ? 's' : ''} in this month {days.length > 1 ? 'were' : 'was'} not confirmed ({days.slice(0, 5).map((d) => fmtDate(d)).join(', ')}
      {days.length > 5 ? '…' : ''}). Check them on the <Link className="underline" href="/">Overview</Link> before approving payroll.
    </Callout>
  );
}
