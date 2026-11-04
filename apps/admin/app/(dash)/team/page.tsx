'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { get, patch, post } from '@/lib/api';
import { ago, fmtDate, todayISO } from '@/lib/format';
import { Badge, Button, Card, ConfirmButton, Field, InlineError, Input, Modal, PageHeader, QueryState, Select, Table, Td, Th } from '@/components/ui';
import { useWorkplaces } from '@/components/filters';

type Access = 'OWNER' | 'SUPERVISOR';

function SitePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const wps = useWorkplaces();
  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-gray-200 p-2">
      {wps.data?.map((w: any) => (
        <label key={w.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.includes(w.id)} onChange={(e) => onChange(e.target.checked ? [...value, w.id] : value.filter((x) => x !== w.id))} />
          {w.name}
        </label>
      ))}
      {wps.data?.length === 0 && <p className="text-xs text-gray-500">Add a workplace first.</p>}
    </div>
  );
}

export default function TeamPage() {
  const list = useQuery({ queryKey: ['team'], queryFn: () => get<any[]>('/team') });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  return (
    <>
      <PageHeader
        title="Supervisors"
        description="Owners see everything. Supervisors manage their own workspaces only."
        actions={<Button variant="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden /> Add person</Button>}
      />
      <Card padded={false}>
        <QueryState query={list}>
          {(rows) => (
            <Table>
              <thead><tr><Th>Name</Th><Th>Role</Th><Th>Workspaces</Th><Th className="text-right">Workers</Th><Th>Status</Th><Th>Last sign-in</Th><Th /></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <Td><span className="font-medium text-gray-900">{a.full_name}</span><div className="text-xs text-gray-500">{a.email}</div></Td>
                    <Td className="text-gray-800">{a.access === 'OWNER' ? 'Owner' : 'Supervisor'}</Td>
                    <Td className="text-xs">{a.access === 'OWNER' ? 'All' : (a.site_names ?? []).join(', ') || '—'}</Td>
                    <Td className="text-right tabular">{a.access === 'OWNER' ? '—' : <span title={`${a.site_workers_count} at their workspaces, ${a.reports_count} reporting directly`}>{a.site_workers_count}{a.reports_count ? <span className="text-xs text-gray-500"> ({a.reports_count} direct)</span> : null}</span>}</Td>
                    <Td>
                      {!a.is_active ? <Badge dot tone="gray">Deactivated</Badge> : a.away_until && a.away_until >= todayISO() ? <Badge dot tone="amber">Away until {fmtDate(a.away_until)}</Badge> : <Badge dot tone="green">Active</Badge>}
                    </Td>
                    <Td className="text-xs text-gray-500">{a.last_login_at ? ago(a.last_login_at) : 'never'}</Td>
                    <Td><Button size="sm" variant="ghost" onClick={() => setEditing(a)} aria-label={`Change role or access for ${a.full_name}`}>Change</Button></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>
      <AddPerson open={adding} onClose={() => setAdding(false)} />
      <EditPerson person={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function AddPerson({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const empty = { fullName: '', email: '', phone: '', access: 'SUPERVISOR' as Access, siteIds: [] as string[] };
  const [f, setF] = useState(empty);
  const [pw, setPw] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => post('/team', { ...f, phone: f.phone || undefined }),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ['team'] });
      setPw(r.temporaryPassword);
    },
  });
  const close = () => {
    setF(empty);
    setPw(null);
    add.reset();
    onClose();
  };
  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Add an owner or supervisor" description="They sign in to this dashboard with their email and a temporary password, and are asked to change it.">
      {pw ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-700">Account created. Share this temporary password securely — it will not be shown again:</p>
          <p className="select-all rounded-md bg-gray-100 p-3 font-mono text-sm">{pw}</p>
          <div className="flex justify-end"><Button variant="primary" onClick={close}>Done</Button></div>
        </div>
      ) : (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Full name"><Input required value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
          <Field label="Email"><Input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Mobile (optional)"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Role">
            <Select value={f.access} onChange={(e) => setF({ ...f, access: e.target.value as Access })}>
              <option value="SUPERVISOR">Supervisor — their workplaces only</option>
              <option value="OWNER">Owner — everything</option>
            </Select>
          </Field>
          {f.access === 'SUPERVISOR' && (
            <div className="sm:col-span-2"><Field label="Workplaces they supervise"><SitePicker value={f.siteIds} onChange={(siteIds) => setF({ ...f, siteIds })} /></Field></div>
          )}
          <div className="sm:col-span-2"><InlineError error={add.error} /></div>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={add.isPending}>Add</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function EditPerson({ person, onClose }: { person: any | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<{ access: Access; siteIds: string[] } | null>(null);
  const cur = f ?? (person ? { access: person.access as Access, siteIds: person.site_ids ?? [] } : null);
  const done = () => {
    qc.invalidateQueries({ queryKey: ['team'] });
    setF(null);
    onClose();
  };
  const save = useMutation({ meta: { success: 'Supervisor saved' }, mutationFn: () => patch(`/team/${person.id}`, cur), onSuccess: done });
  const status = useMutation({ meta: { success: 'Supervisor updated', toastError: true }, mutationFn: (isActive: boolean) => post(`/team/${person.id}/status`, { isActive }), onSuccess: done });
  return (
    <Modal open={!!person} onOpenChange={(o) => !o && (setF(null), onClose())} title={person?.full_name ?? ''} description={person?.email}>
      {cur && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Role">
            <Select value={cur.access} onChange={(e) => setF({ ...cur, access: e.target.value as Access })}>
              <option value="SUPERVISOR">Supervisor — their workplaces only</option>
              <option value="OWNER">Owner — everything</option>
            </Select>
          </Field>
          {cur.access === 'SUPERVISOR' && <Field label="Workplaces"><SitePicker value={cur.siteIds} onChange={(siteIds) => setF({ ...cur, siteIds })} /></Field>}
          <InlineError error={save.error ?? status.error} />
          <div className="flex flex-wrap justify-end gap-2">
            {person.is_active ? (
              <ConfirmButton variant="danger" danger className="mr-auto" loading={status.isPending} title={`Deactivate ${person.full_name}?`} description="They are signed out." confirmLabel="Deactivate" onConfirm={() => status.mutate(false)}>Deactivate</ConfirmButton>
            ) : (
              <Button type="button" loading={status.isPending} onClick={() => status.mutate(true)}>Reactivate</Button>
            )}
            <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
