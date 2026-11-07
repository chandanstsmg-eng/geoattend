'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post, put, del, qs, errorMessage } from '@/lib/api';
import { ago, fmtDate, fmtDateTime, fmtTime, metres, todayISO, businessInstant } from '@/lib/format';
import { Badge, Button, Card, ConfirmButton, Drawer, Field, InlineError, Input, KeyValue, Modal, QueryState, Select, SimBadge, Table, Tabs, Td, Th, Textarea, EmptyState } from './ui';
import { StateBadge, VerificationBadge } from './state-badge';
import { useSupervisors, useWorkplaces } from './filters';
import { SessionTimeline } from './session-timeline';
import { RosterEntryForm } from './roster-form';
import { PayForm } from './pay-form';
import { DayReplay } from './day-replay';
import { useMe } from '@/lib/me';

export function EmployeeDrawer({ employeeId, onClose }: { employeeId: string | null; onClose: () => void }) {
  return (
    <Drawer open={!!employeeId} onOpenChange={(o) => !o && onClose()} title="Employee" subtitle="Profile, assignment, attendance and tracking history">
      {employeeId && <EmployeeDetail id={employeeId} />}
    </Drawer>
  );
}

function EmployeeDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'profile' | 'attendance' | 'sessions' | 'locations'>('profile');
  const { isOwner } = useMe();
  const emp = useQuery({ queryKey: ['employees', id], queryFn: () => get(`/employees/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['employees'] });
    qc.invalidateQueries({ queryKey: ['overview'] });
  };

  return (
    <QueryState query={emp}>
      {(e: any) => (
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">{e.full_name}</h3>
            <Badge tone="navy">{e.employee_code}</Badge>
            {!e.is_active && <Badge tone="red">Deactivated</Badge>}
            {e.is_demo && <Badge tone="purple">Demo employee</Badge>}
            {e.open_session && <StateBadge state={e.open_session.state} />}
          </div>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'profile', label: 'Profile & assignment' },
              { value: 'attendance', label: 'Attendance' },
              { value: 'sessions', label: 'Shift sessions' },
              { value: 'locations', label: 'Location history' },
            ]}
          />
          {tab === 'profile' && (isOwner ? <ProfileTab e={e} onChanged={refresh} /> : <SupervisorProfile e={e} onChanged={refresh} />)}
          {tab === 'attendance' && <AttendanceTab id={id} />}
          {tab === 'sessions' && <SessionsTab id={id} />}
          {tab === 'locations' && <LocationsTab id={id} />}
        </div>
      )}
    </QueryState>
  );
}

/** Roster entries with add / remove (owners: any workplace; supervisors: their own — the API checks). */
function RosterList({ e, onChanged }: { e: any; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const removeShift = useMutation({ meta: { success: 'Roster entry removed', toastError: true }, mutationFn: (assignmentId: string) => del(`/employees/${e.id}/shifts/${assignmentId}`), onSuccess: onChanged });
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-gray-700">Roster — where, when and under whom</p>
        {!adding && <Button size="sm" onClick={() => setAdding(true)}>Add to roster</Button>}
      </div>
      {(e.shifts ?? []).length === 0 && !adding ? (
        <p className="text-sm text-gray-500">Not rostered. Add an entry so the employee can start a shift.</p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
          {(e.shifts ?? []).map((s: any) => (
            <li key={s.assignmentId} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p>
                  <span className="font-medium text-gray-900">{s.workplaceName}</span>
                  <span className="text-gray-600"> · {s.name} {s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)}</span>
                </p>
                <p className="text-xs text-gray-500">
                  {s.effectiveTo === s.effectiveFrom ? fmtDate(s.effectiveFrom) : `${fmtDate(s.effectiveFrom)} – ${s.effectiveTo ? fmtDate(s.effectiveTo) : 'until changed'}`}
                  {s.managerName ? ` · ${s.managerName}` : ''}
                </p>
                {s.notes && <p className="mt-0.5 text-xs text-gray-700">{s.notes}</p>}
              </div>
              <ConfirmButton size="sm" variant="ghost" title="Remove this roster entry?" description="Future days are removed; days already worked stay in the history." confirmLabel="Remove" danger onConfirm={() => removeShift.mutate(s.assignmentId)} loading={removeShift.isPending && removeShift.variables === s.assignmentId}>
                Remove
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      <InlineError error={removeShift.error} />
      {adding && (
        <div className="mt-3 rounded-md border border-gray-200 bg-gray-50/60 p-3">
          <RosterEntryForm employeeId={e.id} defaultWorkplaceId={e.workplace_id} onDone={() => { setAdding(false); onChanged(); }} onCancel={() => setAdding(false)} />
        </div>
      )}
    </div>
  );
}

function ProfileTab({ e, onChanged }: { e: any; onChanged: () => void }) {
  const { me } = useMe();
  const wps = useWorkplaces();
  const sups = useSupervisors();
  const [form, setForm] = useState({ fullName: e.full_name, email: e.email, employeeCode: e.employee_code, phone: e.phone ?? '', department: e.department ?? '', designation: e.designation ?? '', joinedOn: e.joined_on ?? '', leftOn: e.left_on ?? '' });
  const assignSup = useMutation({ meta: { success: 'Supervisor changed', toastError: true }, mutationFn: (supervisorId: string | null) => put(`/employees/${e.id}/supervisor`, { supervisorId }), onSuccess: onChanged });
  const [reasonFor, setReasonFor] = useState<null | 'deactivate'>(null);
  const [reason, setReason] = useState('');
  const [tempPw, setTempPw] = useState<string | null>(null);

  const update = useMutation({ meta: { success: 'Employee saved' },
    mutationFn: () => patch(`/employees/${e.id}`, { ...form, phone: form.phone || null, department: form.department || null, designation: form.designation || null, joinedOn: form.joinedOn || null, leftOn: form.leftOn || null }),
    onSuccess: onChanged,
  });
  const assignWp = useMutation({ meta: { success: 'Workplace changed', toastError: true }, mutationFn: (workplaceId: string | null) => put(`/employees/${e.id}/workplace`, { workplaceId }), onSuccess: onChanged });
  const deactivate = useMutation({ meta: { success: 'Employee deactivated' }, mutationFn: () => post(`/employees/${e.id}/deactivate`, { reason }), onSuccess: () => { setReasonFor(null); setReason(''); onChanged(); } });
  const reactivate = useMutation({ meta: { success: 'Employee reactivated', toastError: true }, mutationFn: () => post(`/employees/${e.id}/reactivate`), onSuccess: onChanged });
  const resetPw = useMutation({ mutationFn: () => post(`/employees/${e.id}/reset-password`), onSuccess: (r: any) => setTempPw(r.temporaryPassword) });

  const set = (k: keyof typeof form) => (ev: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: ev.target.value });

  return (
    <div className="space-y-5">
      <Card title="Profile">
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            update.mutate();
          }}
        >
          <Field label="Full name"><Input value={form.fullName} onChange={set('fullName')} required /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={set('email')} required /></Field>
          <Field label="Employee ID"><Input value={form.employeeCode} onChange={set('employeeCode')} required /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Department"><Input value={form.department} onChange={set('department')} /></Field>
          <Field label="Designation"><Input value={form.designation} onChange={set('designation')} /></Field>
          <Field label="Joining date"><Input type="date" value={form.joinedOn} onChange={set('joinedOn')} /></Field>
          <Field label="Last working day"><Input type="date" value={form.leftOn} onChange={set('leftOn')} /></Field>
          <div className="sm:col-span-2 flex items-center gap-2">
            <Button type="submit" variant="primary" loading={update.isPending}>Save profile</Button>
            {update.isSuccess && <span className="text-xs text-teal-700">Saved</span>}
          </div>
          <div className="sm:col-span-2"><InlineError error={update.error} /></div>
        </form>
      </Card>

      <Card title="Workplace, supervisor & roster">
        <div className="space-y-4">
          <Field label="Home workplace" hint="Their usual site. Days elsewhere go on the roster below.">
            <Select value={e.workplace_id ?? ''} onChange={(ev) => assignWp.mutate(ev.target.value || null)} disabled={assignWp.isPending}>
              <option value="">— Not assigned —</option>
              {wps.data?.map((w: any) => (
                <option key={w.id} value={w.id}>{w.name}{w.is_active ? '' : ' (disabled)'}</option>
              ))}
            </Select>
          </Field>
          <InlineError error={assignWp.error} />
          <Field label="Supervisor" hint={e.workplace_id ? 'Supervisors of the home workplace.' : 'Choose a home workplace first.'}>
            <Select value={e.supervisor_id ?? ''} onChange={(ev) => assignSup.mutate(ev.target.value || null)} disabled={assignSup.isPending || !e.workplace_id}>
              <option value="">— None —</option>
              {sups.data?.filter((s: any) => s.site_ids.includes(e.workplace_id)).map((s: any) => (
                <option key={s.id} value={s.id}>{s.full_name}</option>
              ))}
            </Select>
          </Field>
          <InlineError error={assignSup.error} />
          <RosterList e={e} onChanged={onChanged} />
        </div>
      </Card>

      {me?.features?.payroll && (
        <Card title="Salary">
          <PayForm employeeId={e.id} />
        </Card>
      )}

      <FaceCard employeeId={e.id} />
      <PhonesCard employeeId={e.id} />

      <Card title="Account">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => resetPw.mutate()} loading={resetPw.isPending}>Reset password</Button>
          {e.is_active ? (
            <Button variant="danger" onClick={() => setReasonFor('deactivate')}>Deactivate</Button>
          ) : (
            <Button onClick={() => reactivate.mutate()} loading={reactivate.isPending}>Reactivate</Button>
          )}
        </div>
        <p className="mt-2 text-xs text-gray-500">Last sign-in: {e.last_login_at ? fmtDateTime(e.last_login_at) : 'never'}. Deactivating ends any open shift session, signs the employee out everywhere and keeps all history.</p>
        <InlineError error={resetPw.error ?? reactivate.error} />
      </Card>

      <Modal open={reasonFor === 'deactivate'} onOpenChange={(o) => !o && setReasonFor(null)} title={`Deactivate ${e.full_name}?`} description="A reason is required and recorded in the audit log.">
        <form className="space-y-3" onSubmit={(ev) => { ev.preventDefault(); deactivate.mutate(); }}>
          <Field label="Reason"><Textarea value={reason} onChange={(ev) => setReason(ev.target.value)} required minLength={3} /></Field>
          <InlineError error={deactivate.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setReasonFor(null)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={deactivate.isPending}>Deactivate</Button>
          </div>
        </form>
      </Modal>
      <Modal open={!!tempPw} onOpenChange={(o) => !o && setTempPw(null)} title="Temporary password" description="Shown once. Share it securely; the employee should change it after signing in.">
        <p className="rounded-md bg-gray-100 p-3 font-mono text-sm select-all">{tempPw}</p>
      </Modal>
    </div>
  );
}

/** Supervisors see the profile read-only, roster their workers at their own workplaces, and manage phones. */
function SupervisorProfile({ e, onChanged }: { e: any; onChanged: () => void }) {
  return (
    <div className="space-y-5">
      <Card title="Profile">
        <KeyValue
          items={[
            ['Email', e.email],
            ['Phone', e.phone ?? '—'],
            ['Department', e.department ?? '—'],
            ['Designation', e.designation ?? '—'],
            ['Workplace', e.workplace_name ?? '—'],
            ['Supervisor', e.supervisor_name ?? '—'],
          ]}
        />
        <p className="mt-2 text-xs text-gray-500">Profile, home workplace and pay are changed by the owner.</p>
      </Card>
      <Card title="Roster">
        <RosterList e={e} onChanged={onChanged} />
      </Card>
      <FaceCard employeeId={e.id} />
      <PhonesCard employeeId={e.id} />
    </div>
  );
}

const PHONE_TONE = { APPROVED: 'green', PENDING: 'amber', REVOKED: 'gray' } as const;

/** The employee's phones: one approved at a time; approving another retires the old one. */
function PhonesCard({ employeeId }: { employeeId: string }) {
  const qc = useQueryClient();
  const phones = useQuery({ queryKey: ['devices', employeeId], queryFn: () => get<any[]>(`/devices${qs({ employeeId })}`) });
  const act = useMutation({ meta: { success: 'Phone updated', toastError: true },
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'revoke' }) => post(`/devices/${id}/${action}`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
  return (
    <Card title="Phones">
      <QueryState query={phones} isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-gray-500">No phone yet. The first phone the employee signs in on is approved automatically.</p>}>
        {(rows) => (
          <ul className="space-y-1.5">
            {rows.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{d.model ?? 'Phone'}</span> <span className="text-xs text-gray-500">{d.platform} · {d.device_id.slice(0, 8)}… · last seen {ago(d.last_seen_at)}</span>
                  {d.status_note && <span className="block text-xs text-gray-500">{d.status_note}</span>}
                </span>
                <Badge tone={PHONE_TONE[d.status as keyof typeof PHONE_TONE]}>{d.status.toLowerCase()}</Badge>
                {d.status !== 'APPROVED' && <Button size="sm" variant="primary" loading={act.isPending && act.variables?.id === d.id && act.variables.action === 'approve'} onClick={() => act.mutate({ id: d.id, action: 'approve' })}>Approve</Button>}
                {d.status !== 'REVOKED' && <Button size="sm" loading={act.isPending && act.variables?.id === d.id && act.variables.action === 'revoke'} onClick={() => act.mutate({ id: d.id, action: 'revoke' })}>{d.status === 'PENDING' ? 'Reject' : 'Remove'}</Button>}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <InlineError error={act.error} />
      <p className="mt-2 text-xs text-gray-500">Each employee can use one approved phone. Approving a new phone signs the old one out. A phone approved for one employee cannot be used by another.</p>
    </Card>
  );
}

function AttendanceTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['attendance', 'employee', id], queryFn: () => get(`/attendance${qs({ employeeId: id, limit: 60 })}`) });
  return (
    <QueryState query={q} isEmpty={(d: any) => d.items.length === 0} empty={<EmptyState title="No attendance records" />}>
      {(d: any) => (
        <Table>
          <thead><tr><Th>Date</Th><Th>Shift</Th><Th>Recorded (server)</Th><Th>Status</Th><Th>Evidence</Th></tr></thead>
          <tbody>
            {d.items.map((r: any) => (
              <tr key={r.id}>
                <Td>{fmtDate(r.shift_date)}</Td>
                <Td>{r.shift_name}</Td>
                <Td className="tabular">{fmtTime(r.recorded_at)} {r.is_late && <Badge tone="amber">late {r.late_by_minutes}m</Badge>}</Td>
                <Td><VerificationBadge status={r.verification_status} /> {r.is_simulated && <SimBadge />}</Td>
                <Td className="text-xs text-gray-600">{r.evidence_distance_m != null ? `${metres(r.evidence_distance_m)} ±${Math.round(r.evidence_accuracy_m)} m` : 'manual'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </QueryState>
  );
}

function SessionsTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['session', 'list', id], queryFn: () => get<any[]>(`/tracking/sessions${qs({ employeeId: id, limit: 30 })}`) });
  const [open, setOpen] = useState<string | null>(null);
  const [replay, setReplay] = useState<string | null>(null);
  return (
    <QueryState query={q} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No shift sessions yet" />}>
      {(d) => (
        <ul className="space-y-2">
          {d.map((s: any) => (
            <li key={s.id} className="rounded-md border border-gray-200">
              <button className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
                <span className="font-medium">{fmtDate(s.shift_date)}</span>
                <span className="text-gray-600">{s.shift_name}</span>
                <StateBadge state={s.state} />
                {s.is_simulated && <SimBadge />}
                <span className="ml-auto text-xs text-gray-500">{fmtTime(s.started_at)} – {s.ended_at ? fmtTime(s.ended_at) : 'open'}</span>
              </button>
              {open === s.id && (
                <div className="space-y-3 border-t border-gray-100 p-3">
                  {replay === s.id ? (
                    <DayReplay sessionId={s.id} />
                  ) : (
                    <Button size="sm" onClick={() => setReplay(s.id)}>Replay on map (audited)</Button>
                  )}
                  <SessionTimeline sessionId={s.id} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </QueryState>
  );
}

function LocationsTab({ id }: { id: string }) {
  const today = new Date();
  const [day, setDay] = useState(todayISO());
  const [load, setLoad] = useState(false);
  const from = businessInstant(`${day}T00:00`);
  const to = new Date(new Date(businessInstant(`${day}T23:59`)).getTime() + 59_000).toISOString();
  const q = useQuery({ queryKey: ['locations', id, day], queryFn: () => get<any[]>(`/employees/${id}/location-history${qs({ from, to })}`), enabled: load });
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">Raw location history is sensitive. Viewing it is recorded in the audit log with your name.</p>
      <div className="flex items-end gap-2">
        <Field label="Day"><Input type="date" value={day} onChange={(e) => { setDay(e.target.value); setLoad(false); }} /></Field>
        <Button variant="primary" onClick={() => setLoad(true)}>Load (audited)</Button>
      </div>
      {load && (
        <QueryState query={q} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No locations for this day" />}>
          {(d) => (
            <Table>
              <thead><tr><Th>Device time</Th><Th>Received</Th><Th>Distance</Th><Th>Accuracy</Th><Th>Classification</Th><Th>Source</Th></tr></thead>
              <tbody>
                {d.map((l: any) => (
                  <tr key={l.id}>
                    <Td className="tabular">{fmtTime(l.client_time)}</Td>
                    <Td className="tabular text-xs text-gray-500">{ago(l.received_at)}</Td>
                    <Td className="tabular">{metres(l.distance_m)}</Td>
                    <Td className="tabular">±{Math.round(l.accuracy_m)} m</Td>
                    <Td><Badge tone={l.classification === 'INSIDE' ? 'green' : l.classification === 'OUTSIDE' ? 'gray' : 'amber'}>{l.classification.toLowerCase().replace('_', ' ')}</Badge></Td>
                    <Td className="text-xs">{l.source.toLowerCase()} {l.is_mocked && <Badge tone="red">mock</Badge>} {l.is_simulated && <SimBadge />}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      )}
      {q.error && <p className="text-sm text-red-600">{errorMessage(q.error)}</p>}
    </div>
  );
}

const POSE_LABEL: Record<string, string> = { FRONT: 'Front', LEFT: 'Left', RIGHT: 'Right', UP: 'Chin up', DOWN: 'Chin down' };

/** The employee's enrolled face: five photos taken in the app on first use; an owner can reset it. */
function FaceCard({ employeeId }: { employeeId: string }) {
  const { isOwner } = useMe();
  const [show, setShow] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [reason, setReason] = useState('');
  const face = useQuery({ queryKey: ['face', employeeId, show], queryFn: () => get(`/faces/employees/${employeeId}`), enabled: show });
  const reset = useMutation({ meta: { success: 'Face enrolment reset', toastError: true },
    mutationFn: () => post(`/faces/employees/${employeeId}/reset`, { reason }),
    onSuccess: () => {
      setResetting(false);
      setReason('');
      face.refetch();
    },
  });
  const d = face.data as any;
  return (
    <Card title="Face enrollment">
      {!show ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-gray-600">Five photos the employee takes in the app before their first shift. Shift photos are compared with them.</p>
          <Button size="sm" onClick={() => setShow(true)}>Show enrollment (audited)</Button>
        </div>
      ) : (
        <QueryState query={face}>
          {() =>
            d.enrolled ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-700">Enrolled {fmtDate(d.enrolledAt)}{d.matching ? '' : ' · automatic matching is off on this server'}</p>
                <div className="grid grid-cols-5 gap-2">
                  {d.photos.map((p: any) => (
                    <figure key={p.pose} className="min-w-0">
                      {p.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.url} alt={`Enrolled face, ${POSE_LABEL[p.pose]}`} className="aspect-[3/4] w-full rounded border border-gray-200 object-cover" referrerPolicy="no-referrer" />
                      ) : (
                        <div className="aspect-[3/4] w-full rounded border border-dashed border-gray-300" />
                      )}
                      <figcaption className="mt-0.5 truncate text-caption text-gray-500">{POSE_LABEL[p.pose]}</figcaption>
                    </figure>
                  ))}
                </div>
                {isOwner && !resetting && <Button size="sm" variant="ghost" onClick={() => setResetting(true)}>Reset — ask for new photos</Button>}
                {resetting && (
                  <form className="space-y-2" onSubmit={(ev) => { ev.preventDefault(); reset.mutate(); }}>
                    <Field label="Reason (audited)"><Input required minLength={3} value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. photos were blurry" /></Field>
                    <InlineError error={reset.error} />
                    <div className="flex gap-2">
                      <Button type="button" size="sm" onClick={() => setResetting(false)}>Cancel</Button>
                      <Button type="submit" size="sm" variant="danger" loading={reset.isPending}>Reset enrollment</Button>
                    </div>
                    <p className="text-xs text-gray-500">The employee is asked to take the five photos again before their next shift. The old photos are deleted tonight.</p>
                  </form>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-600">Not enrolled yet. The app asks for the five photos before the employee's next shift.</p>
            )
          }
        </QueryState>
      )}
    </Card>
  );
}
