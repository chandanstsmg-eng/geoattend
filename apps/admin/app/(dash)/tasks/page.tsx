'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Check, MapPin, Plus, RotateCcw } from 'lucide-react';
import { get, post, qs } from '@/lib/api';
import { ago, fmtDate, fmtDateTime, metres, todayISO } from '@/lib/format';
import { rowKeys, Badge, Button, Card, Drawer, EmptyState, Field, InlineError, Input, Modal, PageHeader, QueryState, rowLink, Table, Tabs, Td, Textarea, Th } from '@/components/ui';
import { useEmployees } from '@/components/filters';

type Status = 'SUBMITTED' | 'OPEN' | 'REOPENED' | 'APPROVED' | 'ALL';
const TONE = { OPEN: 'gray', SUBMITTED: 'amber', APPROVED: 'green', REOPENED: 'red', CANCELLED: 'gray' } as const;
const LABEL = { OPEN: 'to do', SUBMITTED: 'done — check', APPROVED: 'approved', REOPENED: 'sent back', CANCELLED: 'cancelled' } as const;

export default function TasksPage() {
  const [status, setStatus] = useState<Status>('SUBMITTED');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['tasks', status], queryFn: () => get<any[]>(`/tasks${qs({ status })}`) });
  return (
    <>
      <PageHeader
        title="Tasks"
        description="Give staff work with proof: they finish it in the app with a photo and their location, and you approve it or send it back."
        actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Assign task</Button>}
      />
      <Card padded={false}>
        <div className="px-4 pt-3">
          <Tabs value={status} onChange={setStatus} tabs={[{ value: 'SUBMITTED', label: 'To check' }, { value: 'OPEN', label: 'Open' }, { value: 'REOPENED', label: 'Sent back' }, { value: 'APPROVED', label: 'Approved' }, { value: 'ALL', label: 'All' }]} />
        </div>
        <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title={status === 'SUBMITTED' ? 'Nothing to check' : 'No tasks'}>Assign a task to see it here.</EmptyState>}>
          {(rows) => (
            <Table>
              <thead><tr><Th>Task</Th><Th>Employee</Th><Th>Due</Th><Th>Status</Th><Th>Updated</Th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className={rowLink} tabIndex={0} onClick={() => setOpen(t.id)} onKeyDown={rowKeys(() => setOpen(t.id))} aria-label={`${t.title}, open task`}>
                    <Td>
                      <span className="font-medium text-gray-900">{t.title}</span> {t.requires_photo && <Camera className="inline h-3.5 w-3.5 text-gray-500" aria-label="Photo required" />}
                      {t.details && <div className="line-clamp-1 text-xs text-gray-500">{t.details}</div>}
                    </Td>
                    <Td>{t.assignee_name} <span className="text-xs text-gray-500">{t.employee_code}</span></Td>
                    <Td className={`tabular ${t.due_date && t.due_date < todayISO() && ['OPEN', 'REOPENED'].includes(t.status) ? 'font-semibold text-red-700' : ''}`}>{t.due_date ? fmtDate(t.due_date) : '—'}</Td>
                    <Td><Badge dot tone={TONE[t.status as keyof typeof TONE]}>{LABEL[t.status as keyof typeof LABEL]}</Badge></Td>
                    <Td className="text-xs text-gray-500">{ago(t.updated_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>
      <AssignTask open={creating} onClose={() => setCreating(false)} />
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} title="Task" subtitle="Proof of work and review">
        {open && <TaskDetail id={open} />}
      </Drawer>
    </>
  );
}

function AssignTask({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const employees = useEmployees();
  const empty = { title: '', details: '', dueDate: todayISO(), requiresPhoto: true, assigneeIds: [] as string[] };
  const [f, setF] = useState(empty);
  const [filter, setFilter] = useState('');
  const save = useMutation({ meta: { success: 'Task saved' },
    mutationFn: () => post('/tasks', { ...f, details: f.details || undefined, dueDate: f.dueDate || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      setF(empty);
      onClose();
    },
  });
  const people = (employees.data ?? []).filter((e: any) => e.is_active && (!filter || e.full_name.toLowerCase().includes(filter.toLowerCase())));
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title="Assign a task" description="Each person gets their own copy and a notification in the app." wide>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="sm:col-span-2"><Field label="Task"><Input required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Clean and photograph the store front" /></Field></div>
        <div className="sm:col-span-2"><Field label="Details (optional)"><Textarea rows={3} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></Field></div>
        <Field label="Due"><Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
        <Field label="Proof">
          <label className="flex h-10 items-center gap-2 text-sm sm:h-9"><input type="checkbox" checked={f.requiresPhoto} onChange={(e) => setF({ ...f, requiresPhoto: e.target.checked })} /> Photo required</label>
        </Field>
        <div className="sm:col-span-2">
          <Field label={`Employees (${f.assigneeIds.length} chosen)`}>
            <Input placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-2" />
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-gray-200 p-2">
              {people.map((e: any) => (
                <label key={e.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.assigneeIds.includes(e.id)} onChange={(ev) => setF({ ...f, assigneeIds: ev.target.checked ? [...f.assigneeIds, e.id] : f.assigneeIds.filter((x) => x !== e.id) })} />
                  {e.full_name} <span className="text-xs text-gray-500">{e.employee_code}{e.workplace_name ? ` · ${e.workplace_name}` : ''}</span>
                </label>
              ))}
            </div>
          </Field>
        </div>
        <div className="sm:col-span-2"><InlineError error={save.error} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.assigneeIds.length}>Assign</Button>
        </div>
      </form>
    </Modal>
  );
}

function TaskDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const t = useQuery({ queryKey: ['tasks', 'one', id], queryFn: () => get(`/tasks/${id}`) });
  const photo = useMutation({ mutationFn: () => post(`/tasks/${id}/photo-url`) });
  const [note, setNote] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['tasks'] });
  const review = useMutation({ meta: { success: 'Review saved', toastError: true }, mutationFn: (decision: 'APPROVED' | 'REOPENED') => post(`/tasks/${id}/review`, { decision, note: note || undefined }), onSuccess: () => { setNote(''); refresh(); } });
  const cancel = useMutation({ meta: { success: 'Task cancelled', toastError: true }, mutationFn: () => post(`/tasks/${id}/cancel`), onSuccess: refresh });
  return (
    <QueryState query={t}>
      {(x: any) => (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">{x.title}</h3>
            <Badge tone={TONE[x.status as keyof typeof TONE]}>{LABEL[x.status as keyof typeof LABEL]}</Badge>
          </div>
          {x.details && <p className="whitespace-pre-wrap text-gray-700">{x.details}</p>}
          <p className="text-gray-600">
            For <strong>{x.assignee_name}</strong>{x.workplace_name ? ` at ${x.workplace_name}` : ''}{x.due_date ? ` · due ${fmtDate(x.due_date)}` : ''} · assigned by {x.created_by_name ?? '—'} {ago(x.created_at)}
          </p>
          {x.submitted_at && (
            <Card title="Proof">
              <div className="space-y-2">
                <p>Finished {fmtDateTime(x.submitted_at)}{x.submission_note ? <> — “{x.submission_note}”</> : null}</p>
                {x.submitted_lat != null && (
                  <p className="flex items-center gap-1 text-gray-600">
                    <MapPin className="h-4 w-4" aria-hidden /> {x.submitted_lat.toFixed(5)}, {x.submitted_lng.toFixed(5)} (±{metres(x.submitted_accuracy_m)})
                    <a className="ml-2 text-primary-700 underline" href={`https://www.google.com/maps?q=${x.submitted_lat},${x.submitted_lng}`} target="_blank" rel="noreferrer">Open in Maps</a>
                  </p>
                )}
                {x.photo_id && (photo.data ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={(photo.data as any).url} alt={`Proof photo for ${x.title}`} className="max-h-80 rounded-md border border-gray-200" referrerPolicy="no-referrer" />
                ) : (
                  <Button size="sm" onClick={() => photo.mutate()} loading={photo.isPending}><Camera className="h-4 w-4" aria-hidden /> View photo (audited)</Button>
                ))}
                <InlineError error={photo.error} />
              </div>
            </Card>
          )}
          {x.review_note && <p className="text-gray-600">Review note: “{x.review_note}” {x.reviewed_by_name ? `— ${x.reviewed_by_name}` : ''}</p>}
          {x.status === 'SUBMITTED' && (
            <div className="space-y-2">
              <Input aria-label="Note to the employee" placeholder="Note to the employee (needed when sending back)" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="flex gap-2">
                <Button variant="primary" loading={review.isPending && review.variables === 'APPROVED'} onClick={() => review.mutate('APPROVED')}><Check className="h-4 w-4" aria-hidden /> Approve</Button>
                <Button loading={review.isPending && review.variables === 'REOPENED'} onClick={() => review.mutate('REOPENED')}><RotateCcw className="h-4 w-4" aria-hidden /> Send back</Button>
              </div>
            </div>
          )}
          {['OPEN', 'REOPENED'].includes(x.status) && <Button variant="ghost" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel task</Button>}
          <InlineError error={review.error ?? cancel.error} />
        </div>
      )}
    </QueryState>
  );
}
