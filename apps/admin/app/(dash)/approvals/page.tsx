'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Check, ClipboardCheck, Hourglass, ScanFace, Smartphone, X } from 'lucide-react';
import { LEAVE_TYPE_LABELS, type LeaveType } from '@geoattend/shared';
import { get, post } from '@/lib/api';
import { ago, fmtDate, fmtTime, metres, fmtDateTime } from '@/lib/format';
import { LinkButton, Badge, Button, Card, EmptyState, Field, InlineError, Modal, PageHeader, QueryState, Textarea } from '@/components/ui';
import { EmployeeDrawer } from '@/components/employee-drawer';

type Reject = { title: string; description: string; run: (note: string) => Promise<unknown> };

const KIND_LABEL: Record<string, string> = { ADMIN_CORRECTION: 'Supervisor correction', MANUAL_REVIEW: 'GPS problem — asks to be marked present', DISPUTE: 'Disputes an attendance record', TECHNICAL_ISSUE: 'Reported a technical issue' };

function Item({ icon, who, onWho, meta, children, actions }: { icon: ReactNode; who: string; onWho: () => void; meta: ReactNode; children: ReactNode; actions: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
      <span className="mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-600 sm:flex">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <button className="font-medium text-gray-900 hover:underline" onClick={onWho}>{who}</button>
          <span className="text-xs text-gray-500">{meta}</span>
        </div>
        <div className="mt-0.5 text-sm text-gray-700">{children}</div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
    </li>
  );
}

export default function ApprovalsPage() {
  const qc = useQueryClient();
  const inbox = useQuery({ queryKey: ['approvals'], queryFn: () => get('/approvals'), refetchInterval: 60_000 });
  const [employee, setEmployee] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Reject | null>(null);
  const done = () => {
    qc.invalidateQueries({ queryKey: ['approvals'] });
    qc.invalidateQueries({ queryKey: ['leave'] });
    qc.invalidateQueries({ queryKey: ['overview'] });
    qc.invalidateQueries({ queryKey: ['devices'] });
  };
  const act = useMutation({ meta: { success: 'Decision saved' }, mutationFn: ({ path, body }: { key: string; path: string; body: unknown }) => post(path, body), onSuccess: done });
  const busy = (key: string) => act.isPending && act.variables?.key === key;
  const go = (key: string, path: string, body: unknown = {}) => act.mutate({ key, path, body });

  return (
    <>
      <PageHeader title="Approvals" description="Everything waiting for you in one place. Approve with one tap; rejections need a short reason that the employee sees." />
      <InlineError error={act.error} />
      <QueryState query={inbox} isEmpty={(d: any) => d.counts.total === 0} empty={<EmptyState title="All caught up" icon={<Check className="h-6 w-6" />}>Nothing is waiting for a decision.</EmptyState>}>
        {(d: any) => (
          <div className="space-y-6">
            {d.devices.length > 0 && (
              <Card title={<>New phones <Badge tone="amber">{d.devices.length}</Badge></>} padded={false}>
                <ul className="divide-y divide-gray-100">
                  {d.devices.map((p: any) => (
                    <Item
                      key={p.id}
                      icon={<Smartphone className="h-4 w-4" />}
                      who={p.full_name}
                      onWho={() => setEmployee(p.user_id)}
                      meta={`${p.employee_code ?? ''} · asked ${ago(p.created_at)}`}
                      actions={
                        <>
                          <Button size="sm" variant="primary" loading={busy(`dev-ok-${p.id}`)} onClick={() => go(`dev-ok-${p.id}`, `/devices/${p.id}/approve`)}><Check className="h-4 w-4" aria-hidden /> Approve phone</Button>
                          <Button size="sm" loading={busy(`dev-no-${p.id}`)} onClick={() => go(`dev-no-${p.id}`, `/devices/${p.id}/revoke`, { note: 'Rejected from approvals' })}><X className="h-4 w-4" aria-hidden /> Reject</Button>
                        </>
                      }
                    >
                      Wants to sign in on {p.model ? <strong>{p.model}</strong> : 'a new phone'} ({p.platform}).{' '}
                      {p.current_phone ? <>Current phone: {p.current_phone.model ?? p.current_phone.platform}, last used {ago(p.current_phone.lastSeenAt)}. Approving signs the old phone out.</> : 'No other phone is approved.'}
                    </Item>
                  ))}
                </ul>
              </Card>
            )}

            {d.leave.length > 0 && (
              <Card title={<>Leave <Badge tone="amber">{d.leave.length}</Badge></>} padded={false}>
                <ul className="divide-y divide-gray-100">
                  {d.leave.map((l: any) => (
                    <Item
                      key={l.id}
                      icon={<CalendarOff className="h-4 w-4" />}
                      who={l.full_name}
                      onWho={() => setEmployee(l.employee_id)}
                      meta={`${l.employee_code ?? ''} · asked ${ago(l.created_at)} · ${l.approved_this_year} approved this year`}
                      actions={
                        <>
                          <Button size="sm" variant="primary" loading={busy(`lv-${l.id}`)} onClick={() => go(`lv-${l.id}`, `/leave/${l.id}/decide`, { decision: 'APPROVED' })}><Check className="h-4 w-4" aria-hidden /> Approve</Button>
                          <Button size="sm" onClick={() => setRejecting({ title: 'Reject leave', description: `${l.full_name} · ${fmtDate(l.start_date)}`, run: (note) => post(`/leave/${l.id}/decide`, { decision: 'REJECTED', note }) })}><X className="h-4 w-4" aria-hidden /> Reject</Button>
                        </>
                      }
                    >
                      <strong>{LEAVE_TYPE_LABELS[l.leave_type as LeaveType]}</strong>, {l.start_date === l.end_date ? fmtDate(l.start_date) : `${fmtDate(l.start_date)} – ${fmtDate(l.end_date)}`} ({l.half_day ? 'half day' : `${l.days} day${l.days === 1 ? '' : 's'}`}): “{l.reason}”
                    </Item>
                  ))}
                </ul>
              </Card>
            )}

            {d.counts.overtime > 0 && (
              <Card title={<>Overtime <Badge tone="amber">{d.counts.overtime}</Badge></>} padded={false}>
                <ul className="divide-y divide-gray-100">
                  <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                    <span className="mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-600 sm:flex"><Hourglass className="h-4 w-4" /></span>
                    <p className="min-w-0 flex-1 text-sm text-gray-700">
                      {d.counts.overtime} overtime {d.counts.overtime === 1 ? 'entry is' : 'entries are'} waiting. Check the photos and where it was worked, then approve all or part of the time — only approved overtime is paid.
                    </p>
                    <LinkButton href="/overtime?tab=pending" size="sm" variant="primary">Review overtime</LinkButton>
                  </li>
                </ul>
              </Card>
            )}

            {d.verifications?.length > 0 && (
              <Card title={<>Sent late from a phone <Badge tone="amber">{d.verifications.length}</Badge></>} padded={false}>
                <ul className="divide-y divide-gray-100">
                  {d.verifications.map((v: any) => (
                    <Item
                      key={v.id}
                      icon={<Hourglass className="h-4 w-4" />}
                      who={v.full_name}
                      onWho={() => setEmployee(v.employee_id)}
                      meta={`${v.shift_name} · ${fmtDate(v.shift_date)} · ${v.workplace_name}`}
                      actions={
                        <>
                          <LinkButton href={`/attendance?record=${v.id}`} size="sm">See evidence</LinkButton>
                          <Button size="sm" variant="primary" loading={busy(`vf-${v.id}`)} onClick={() => go(`vf-${v.id}`, `/attendance/${v.id}/verification`, { decision: 'APPROVE', note: 'Checked in approvals' })}><Check className="h-4 w-4" aria-hidden /> Approve</Button>
                          <Button size="sm" onClick={() => setRejecting({ title: 'Reject this record', description: `${v.full_name}'s attendance for ${fmtDate(v.shift_date)} stops counting.`, run: (note) => post(`/attendance/${v.id}/verification`, { decision: 'REJECT', note }) })}><X className="h-4 w-4" aria-hidden /> Reject</Button>
                        </>
                      }
                    >
                      Phone time {v.evidence_client_time ? fmtDateTime(v.evidence_client_time) : 'not available'}{v.received_at ? `, received ${fmtDateTime(v.received_at)}` : ''}.{' '}
                      {v.evidence_distance_m != null ? `${Math.round(v.evidence_distance_m)} m from the centre (±${Math.round(v.evidence_accuracy_m)} m, area ${v.radius_m_at_record} m).` : 'No location.'}{' '}
                      {(v.risk_flags ?? []).join(', ')}
                    </Item>
                  ))}
                </ul>
              </Card>
            )}

            {d.counts.faces > 0 && <FaceReviews onWho={setEmployee} onReject={setRejecting} onDone={done} />}

            {d.reviews.length > 0 && (
              <Card title={<>Attendance requests <Badge tone="amber">{d.reviews.length}</Badge></>} padded={false}>
                <ul className="divide-y divide-gray-100">
                  {d.reviews.map((r: any) => (
                    <Item
                      key={r.id}
                      icon={<ClipboardCheck className="h-4 w-4" />}
                      who={r.full_name}
                      onWho={() => setEmployee(r.employee_id)}
                      meta={`${KIND_LABEL[r.kind]} · ${ago(r.created_at)}`}
                      actions={
                        r.kind === 'MANUAL_REVIEW' ? (
                          <>
                            <Button size="sm" variant="primary" loading={busy(`rv-${r.id}`)} onClick={() => go(`rv-${r.id}`, `/attendance/reviews/${r.id}/resolve`, { decision: 'APPROVE', note: 'Marked present from approvals' })}><Check className="h-4 w-4" aria-hidden /> Mark present</Button>
                            <Button size="sm" onClick={() => setRejecting({ title: 'Reject request', description: r.full_name, run: (note) => post(`/attendance/reviews/${r.id}/resolve`, { decision: 'REJECT', note }) })}><X className="h-4 w-4" aria-hidden /> Reject</Button>
                          </>
                        ) : r.kind === 'ADMIN_CORRECTION' ? (
                            <>
                              <Button size="sm" variant="primary" loading={busy(`rv-${r.id}`)} onClick={() => go(`rv-${r.id}`, `/attendance/reviews/${r.id}/resolve`, { decision: 'APPROVE', note: 'Approved from approvals' })}><Check className="h-4 w-4" aria-hidden /> Apply correction</Button>
                              <Button size="sm" onClick={() => setRejecting({ title: 'Reject correction', description: `${r.full_name}'s record stays as it is.`, run: (note) => post(`/attendance/reviews/${r.id}/resolve`, { decision: 'REJECT', note }) })}><X className="h-4 w-4" aria-hidden /> Reject</Button>
                            </>
                          ) : r.kind === 'DISPUTE' ? (
                          <>
                            <LinkButton href="/attendance?tab=reviews" size="sm" variant="primary">Correct record</LinkButton>
                            <Button size="sm" onClick={() => setRejecting({ title: 'Reject dispute', description: `${r.full_name} keeps the original record.`, run: (note) => post(`/attendance/reviews/${r.id}/resolve`, { decision: 'REJECT', note }) })}><X className="h-4 w-4" aria-hidden /> Reject</Button>
                          </>
                        ) : (
                          <Button size="sm" loading={busy(`rv-${r.id}`)} onClick={() => go(`rv-${r.id}`, `/attendance/reviews/${r.id}/resolve`, { decision: 'ACKNOWLEDGE', note: 'Seen' })}>Acknowledge</Button>
                        )
                      }
                    >
                      “{r.reason}”
                      {r.shift_name && (
                        <span className="block text-xs text-gray-500">
                          {r.shift_name} · {fmtDate(r.shift_date)}
                          {r.recorded_at ? ` · recorded ${fmtTime(r.recorded_at)}` : ''}
                          {r.last_distance_m != null ? ` · last fix ${metres(r.last_distance_m)} from the workplace (±${Math.round(r.last_accuracy_m)} m)` : ''}
                        </span>
                      )}
                    </Item>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
      </QueryState>
      <RejectModal value={rejecting} onClose={() => setRejecting(null)} onDone={done} />
      <EmployeeDrawer employeeId={employee} onClose={() => setEmployee(null)} />
    </>
  );
}

const FACE_TEXT: Record<string, string> = { MISMATCH: 'does not match', NO_FACE: 'shows no single clear face', MATCH: 'matches', NOT_ENROLLED: 'not compared (no enrolled face)' };

/** Attendance held because a start or end photo did not match the enrolled face. */
function FaceReviews({ onWho, onReject, onDone }: { onWho: (id: string) => void; onReject: (r: Reject) => void; onDone: () => void }) {
  const list = useQuery({ queryKey: ['approvals', 'faces'], queryFn: () => get<any[]>('/faces/reviews') });
  const [comparing, setComparing] = useState<any | null>(null);
  const approve = useMutation({ meta: { success: 'Attendance approved', toastError: true }, mutationFn: (id: string) => post(`/faces/reviews/${id}`, { decision: 'APPROVE' }), onSuccess: onDone });
  const describe = (r: any) =>
    [
      r.face_status && r.face_status !== 'MATCH' ? `start photo ${FACE_TEXT[r.face_status] ?? r.face_status}${r.face_score != null ? ` (${Math.round(r.face_score)}%)` : ''}` : null,
      r.end_face_status && r.end_face_status !== 'MATCH' ? `end photo ${FACE_TEXT[r.end_face_status] ?? r.end_face_status}${r.end_face_score != null ? ` (${Math.round(r.end_face_score)}%)` : ''}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  return (
    <Card title={<>Face checks <Badge tone="amber">{list.data?.length ?? '…'}</Badge></>} padded={false}>
      <InlineError error={approve.error} />
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No face checks waiting" />}>
        {(rows) => (
          <ul className="divide-y divide-gray-100">
            {rows.map((r) => (
              <Item
                key={r.id}
                icon={<ScanFace className="h-4 w-4" />}
                who={r.full_name}
                onWho={() => onWho(r.employee_id)}
                meta={`${r.shift_name} · ${fmtDate(r.shift_date)} · ${r.workplace_name}`}
                actions={
                  <>
                    <Button size="sm" onClick={() => setComparing(r)}>Compare photos</Button>
                    <Button size="sm" variant="primary" loading={approve.isPending && approve.variables === r.id} onClick={() => approve.mutate(r.id)}>
                      <Check className="h-4 w-4" aria-hidden /> Same person
                    </Button>
                    <Button size="sm" onClick={() => onReject({ title: 'Mark absent', description: `${r.full_name}'s attendance for ${fmtDate(r.shift_date)} is voided.`, run: (note) => post(`/faces/reviews/${r.id}`, { decision: 'REJECT', note }) })}>
                      <X className="h-4 w-4" aria-hidden /> Mark absent
                    </Button>
                  </>
                }
              >
                The {describe(r)}. Attendance is on hold until you decide.
              </Item>
            ))}
          </ul>
        )}
      </QueryState>
      <ComparePhotos record={comparing} onClose={() => setComparing(null)} />
    </Card>
  );
}

function ComparePhotos({ record, onClose }: { record: any | null; onClose: () => void }) {
  const links = useQuery({ queryKey: ['face-review-photos', record?.id], queryFn: () => post(`/faces/reviews/${record.id}/photos`), enabled: !!record, staleTime: 60_000 });
  const tile = (label: string, url: string | null | undefined, note: string) => (
    <figure className="min-w-0">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`${label} of ${record?.full_name}`} className="aspect-[3/4] w-full rounded-md border border-gray-200 object-cover" referrerPolicy="no-referrer" />
      ) : (
        <div className="flex aspect-[3/4] w-full items-center justify-center rounded-md border border-dashed border-gray-300 px-2 text-center text-xs text-gray-500">{note}</div>
      )}
      <figcaption className="mt-1 text-xs text-gray-600">{label}</figcaption>
    </figure>
  );
  return (
    <Modal open={!!record} onOpenChange={(o) => !o && onClose()} title={record ? `Compare: ${record.full_name}` : ''} description="Viewing these photos is recorded in the audit log." wide>
      <QueryState query={links}>
        {(d: any) => (
          <div className="grid grid-cols-3 gap-3">
            {tile('Enrolled face', d.enrolled, 'No enrolled photo')}
            {tile('Start of shift', d.start, record?.face_status === 'MATCH' ? 'Matched — photo not kept' : 'No photo')}
            {tile('End of shift', d.end, record?.end_face_status === 'MATCH' ? 'Matched — photo not kept' : 'No photo')}
          </div>
        )}
      </QueryState>
      {record?.challenge && <p className="mt-3 text-sm text-gray-700">At the start the app asked: <strong>{record.challenge}</strong>.</p>}
    </Modal>
  );
}

function RejectModal({ value, onClose, onDone }: { value: Reject | null; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const run = useMutation({
    mutationFn: () => value!.run(note.trim()),
    onSuccess: () => {
      setNote('');
      onDone();
      onClose();
    },
  });
  return (
    <Modal open={!!value} onOpenChange={(o) => !o && (run.reset(), onClose())} title={value?.title ?? ''} description={value?.description}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        <Field label="Reason (the employee sees this)"><Textarea required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <InlineError error={run.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={run.isPending}>Reject</Button>
        </div>
      </form>
    </Modal>
  );
}
