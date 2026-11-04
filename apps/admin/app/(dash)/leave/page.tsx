'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { LEAVE_TYPE_LABELS, LEAVE_TYPES, type LeaveType } from '@geoattend/shared';
import { del, get, post, qs } from '@/lib/api';
import { useWorkplaces } from '@/components/filters';
import { useMe } from '@/lib/me';
import { ago, fmtDate, todayISO } from '@/lib/format';
import { Badge, Button, Card, EmptyState, Field, InlineError, Input, Modal, PageHeader, QueryState, Select, Table, Tabs, Td, Textarea, Th } from '@/components/ui';
import { EmployeeDrawer } from '@/components/employee-drawer';

type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'ALL';
const STATUS_TONE = { PENDING: 'amber', APPROVED: 'green', REJECTED: 'red', CANCELLED: 'gray' } as const;

function range(l: any) {
  return l.start_date === l.end_date ? fmtDate(l.start_date) : `${fmtDate(l.start_date)} – ${fmtDate(l.end_date)}`;
}

export default function LeavePage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>('PENDING');
  const [rejecting, setRejecting] = useState<any | null>(null);
  const [recording, setRecording] = useState(false);
  const [employee, setEmployee] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['leave', status], queryFn: () => get<any[]>(`/leave${qs({ status })}`) });
  const pending = useQuery({ queryKey: ['leave', 'PENDING'], queryFn: () => get<any[]>('/leave?status=PENDING'), enabled: status !== 'PENDING' });
  const pendingCount = status === 'PENDING' ? list.data?.length : pending.data?.length;

  const decide = useMutation({ meta: { success: 'Leave decision saved', toastError: true },
    mutationFn: ({ id, decision, note }: { id: string; decision: 'APPROVED' | 'REJECTED'; note?: string }) => post(`/leave/${id}/decide`, { decision, note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      setRejecting(null);
    },
  });

  return (
    <>
      <PageHeader
        title="Leave & holidays"
        description="Approve leave from your phone or desk. Approved leave and holidays show on the overview and stop no-show alerts for those days."
        actions={
          <Button variant="primary" onClick={() => setRecording(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Record leave
          </Button>
        }
      />
      <Card padded={false}>
        <div className="px-4 pt-3">
          <Tabs
            value={status}
            onChange={setStatus}
            tabs={[
              { value: 'PENDING', label: 'Waiting', count: pendingCount, alert: true },
              { value: 'APPROVED', label: 'Approved' },
              { value: 'REJECTED', label: 'Rejected' },
              { value: 'ALL', label: 'All' },
            ]}
          />
        </div>
        <InlineError error={decide.error} />
        <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title={status === 'PENDING' ? 'Nothing waiting for approval' : 'No leave requests'}>Employees apply for leave from the GeoAttend app.</EmptyState>}>
          {(rows) => (
            <Table>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Leave</Th>
                  <Th>Dates</Th>
                  <Th>Reason</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="align-top">
                    <Td>
                      <button className="text-left font-medium text-gray-900 hover:underline" onClick={() => setEmployee(l.employee_id)}>
                        {l.full_name}
                      </button>
                      <div className="text-xs text-gray-500">
                        {l.employee_code}
                        {l.workplace_name ? ` · ${l.workplace_name}` : ''}
                      </div>
                    </Td>
                    <Td>{LEAVE_TYPE_LABELS[l.leave_type as LeaveType]}</Td>
                    <Td className="tabular">
                      {range(l)}
                      <div className="text-xs text-gray-500">{l.half_day ? 'Half day' : `${l.days} day${l.days === 1 ? '' : 's'}`}</div>
                    </Td>
                    <Td className="max-w-xs">
                      <p className="whitespace-pre-wrap text-sm">{l.reason}</p>
                      <p className="text-xs text-gray-500">
                        {l.requested_by === l.employee_id ? 'Requested' : `Recorded by ${l.requested_by_name}`} {ago(l.created_at)}
                      </p>
                    </Td>
                    <Td>
                      <Badge dot tone={STATUS_TONE[l.status as keyof typeof STATUS_TONE]}>{l.status[0] + l.status.slice(1).toLowerCase()}</Badge>
                      {l.decided_by_name && l.status !== 'PENDING' && l.requested_by === l.employee_id && <div className="mt-1 text-xs text-gray-500">by {l.decided_by_name}</div>}
                      {l.decision_note && l.requested_by === l.employee_id && <div className="mt-1 max-w-[14rem] text-xs text-gray-600">“{l.decision_note}”</div>}
                    </Td>
                    <Td>
                      {l.status === 'PENDING' && (
                        <div className="flex gap-2">
                          <Button size="sm" variant="primary" loading={decide.isPending && decide.variables?.id === l.id && decide.variables.decision === 'APPROVED'} onClick={() => decide.mutate({ id: l.id, decision: 'APPROVED' })}>
                            <Check className="h-4 w-4" aria-hidden /> Approve
                          </Button>
                          <Button size="sm" onClick={() => setRejecting(l)}>
                            <X className="h-4 w-4" aria-hidden /> Reject
                          </Button>
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>

      <div className="mt-6">
        <Holidays />
      </div>

      <RejectModal leave={rejecting} busy={decide.isPending} onCancel={() => setRejecting(null)} onReject={(note) => decide.mutate({ id: rejecting.id, decision: 'REJECTED', note })} />
      <RecordLeave open={recording} onClose={() => setRecording(false)} />
      <EmployeeDrawer employeeId={employee} onClose={() => setEmployee(null)} />
    </>
  );
}

/** Holidays for all workplaces or one. Weekly offs are the days a shift does not run (set on Shifts). */
function Holidays() {
  const qc = useQueryClient();
  const year = new Date().getFullYear();
  const wps = useWorkplaces();
  const list = useQuery({ queryKey: ['holidays', year], queryFn: () => get<any[]>(`/holidays${qs({ from: todayISO(), to: `${year + 1}-12-31` })}`) });
  const [f, setF] = useState({ date: '', name: '', workplaceId: '' });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['holidays'] });
    qc.invalidateQueries({ queryKey: ['overview'] });
  };
  const add = useMutation({ meta: { success: 'Holiday added' }, mutationFn: () => post('/holidays', { ...f, workplaceId: f.workplaceId || null }), onSuccess: () => { setF({ date: '', name: '', workplaceId: f.workplaceId }); refresh(); } });
  const national = useMutation({ meta: { success: 'National holidays added', toastError: true }, mutationFn: () => post('/holidays/national', { year }), onSuccess: refresh });
  const remove = useMutation({ meta: { success: 'Holiday removed', toastError: true }, mutationFn: (id: string) => del(`/holidays/${id}`), onSuccess: refresh });
  const { isOwner } = useMe();
  return (
    <Card
      title="Holidays"
      description="Upcoming, for all workplaces or one"
      actions={isOwner && <Button size="sm" loading={national.isPending} onClick={() => national.mutate()}>Add national holidays {year}</Button>}
    >
      <p className="mb-3 text-sm text-gray-600">
        On a holiday nobody is expected: no no-show alerts, and the day is not counted as absent. Weekly offs are the days a shift does not run (set them on <Link className="text-primary-700 underline" href="/shifts">Shifts</Link>).
      </p>
      {isOwner && <form className="mb-4 grid gap-2 sm:grid-cols-[10rem_1fr_14rem_auto]" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <Input type="date" aria-label="Holiday date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <Input aria-label="Holiday name" placeholder="e.g. Diwali" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Select aria-label="Workplace" value={f.workplaceId} onChange={(e) => setF({ ...f, workplaceId: e.target.value })}>
          <option value="">All workplaces</option>
          {wps.data?.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
        <Button type="submit" variant="primary" loading={add.isPending}><Plus className="h-4 w-4" aria-hidden /> Add</Button>
      </form>}
      <InlineError error={add.error ?? national.error ?? remove.error} />
      {national.data && <p className="mb-2 text-xs text-teal-700">Added {(national.data as any).added} national holiday(s).</p>}
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-gray-500">No upcoming holidays.</p>}>
        {(rows) => (
          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
            {rows.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="w-32 shrink-0 tabular">{fmtDate(h.holiday_date)}</span>
                <span className="flex-1 font-medium">{h.name}</span>
                <span className="text-xs text-gray-500">{h.workplace_name ?? 'All workplaces'}</span>
                {isOwner && <Button size="sm" variant="ghost" aria-label={`Remove ${h.name}`} loading={remove.isPending && remove.variables === h.id} onClick={() => remove.mutate(h.id)}><X className="h-4 w-4" aria-hidden /></Button>}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </Card>
  );
}

function RejectModal({ leave, busy, onCancel, onReject }: { leave: any | null; busy: boolean; onCancel: () => void; onReject: (note: string) => void }) {
  const [note, setNote] = useState('');
  return (
    <Modal open={!!leave} onOpenChange={(o) => !o && onCancel()} title="Reject leave" description={leave ? `${leave.full_name} · ${range(leave)}. The employee sees this reason in the app.` : ''}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onReject(note.trim());
          setNote('');
        }}
      >
        <Field label="Reason">
          <Textarea required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: stock count that week, please pick another date" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy}>Reject</Button>
        </div>
      </form>
    </Modal>
  );
}

function RecordLeave({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const employees = useQuery({ queryKey: ['employees', '', '', 'active'], queryFn: () => get<any[]>('/employees?status=active'), enabled: open });
  const empty = { employeeId: '', leaveType: 'CASUAL' as LeaveType, startDate: todayISO(), endDate: todayISO(), halfDay: false, reason: '' };
  const [f, setF] = useState(empty);
  const save = useMutation({ meta: { success: 'Leave recorded' },
    mutationFn: () => post('/leave', { ...f, endDate: f.halfDay ? f.startDate : f.endDate }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      close();
    },
  });
  const close = () => {
    setF(empty);
    save.reset();
    onClose();
  };
  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Record leave" description="For an employee who called in or told you in person. It is approved immediately and the employee is notified.">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="sm:col-span-2">
          <Field label="Employee">
            <Select required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
              <option value="">Choose…</option>
              {employees.data?.map((e) => <option key={e.id} value={e.id}>{e.full_name} ({e.employee_code})</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Type">
          <Select value={f.leaveType} onChange={(e) => setF({ ...f, leaveType: e.target.value as LeaveType })}>
            {LEAVE_TYPES.map((t) => <option key={t} value={t}>{LEAVE_TYPE_LABELS[t]}</option>)}
          </Select>
        </Field>
        <Field label="Length">
          <label className="flex h-10 items-center gap-2 text-sm sm:h-9"><input type="checkbox" checked={f.halfDay} onChange={(e) => setF({ ...f, halfDay: e.target.checked })} /> Half day</label>
        </Field>
        <Field label="From"><Input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} /></Field>
        <Field label="To"><Input type="date" required disabled={f.halfDay} min={f.startDate} value={f.halfDay ? f.startDate : f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        <div className="sm:col-span-2">
          <Field label="Reason"><Input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Called in sick" /></Field>
        </div>
        <div className="sm:col-span-2"><InlineError error={save.error} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save leave</Button>
        </div>
      </form>
    </Modal>
  );
}
