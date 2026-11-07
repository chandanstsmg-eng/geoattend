'use client';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Upload, X } from 'lucide-react';
import { Kpi, StatStrip, StatStripSkeleton } from '@/components/charts';
import { ImportEmployees } from '@/components/import-employees';
import { useMe } from '@/lib/me';
import { get, post, qs } from '@/lib/api';
import { ago } from '@/lib/format';
import { Badge, Button, Card, cx, DemoTag, EmptyState, Field, InlineError, Input, Modal, PageHeader, Pagination, QueryState, rowLink, SearchInput, Select, SortTh, Table, Td, Th, Toolbar, type SortDir } from '@/components/ui';
import { StateBadge } from '@/components/state-badge';
import { SupervisorSelect, WorkplaceSelect, useEmployees, useWorkplaces } from '@/components/filters';
import { EmployeeDrawer } from '@/components/employee-drawer';

export default function EmployeesPage() {
  // The header's "Find employee" box opens this page with ?q=…
  const q = useSearchParams().get('q');
  const [search, setSearch] = useState(q ?? '');
  useEffect(() => {
    if (q !== null) setSearch(q);
  }, [q]);
  const [workplaceId, setWorkplaceId] = useState('');
  const [status, setStatus] = useState('active');
  const [supervisorId, setSupervisorId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const { isOwner } = useMe();
  const list = useQuery({ queryKey: ['employees', search, workplaceId, status, supervisorId], queryFn: () => get<any[]>(`/employees${qs({ search, workplaceId, status, supervisorId })}`) });
  // Directory figures over everyone the caller may see (independent of the table filters).
  const everyone = useEmployees();
  const all = everyone.data ?? [];
  const active = all.filter((e) => e.is_active);
  const stats = {
    total: all.length,
    active: active.length,
    onShift: active.filter((e) => e.open_session).length,
    noWorkspace: active.filter((e) => !e.workplace_id).length,
    noShift: active.filter((e) => !(e.shifts ?? []).length).length,
    noSupervisor: active.filter((e) => !e.supervisor_id && !e.supervisor_name).length,
  };
  // Quick filters for the gaps above (applied to the loaded list), sorting and paging.
  const [gap, setGap] = useState<'' | 'onShift' | 'noWorkspace' | 'noShift'>('');
  const [sort, setSort] = useState<{ key: 'name' | 'code' | 'workplace' | 'signin'; dir: SortDir }>({ key: 'name', dir: 'asc' });
  const [offset, setOffset] = useState(0);
  const PAGE = 25;
  const rows = useMemo(() => {
    const keep = (list.data ?? []).filter((e) => (gap === 'onShift' ? e.open_session : gap === 'noWorkspace' ? !e.workplace_id : gap === 'noShift' ? !(e.shifts ?? []).length : true));
    const val = (e: any) => (sort.key === 'name' ? e.full_name.toLowerCase() : sort.key === 'code' ? String(e.employee_code ?? '') : sort.key === 'workplace' ? (e.workplace_name ?? '~').toLowerCase() : e.last_login_at ?? '');
    return keep.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * (sort.dir === 'asc' ? 1 : -1));
  }, [list.data, gap, sort]);
  useEffect(() => setOffset(0), [search, workplaceId, status, supervisorId, gap]);
  const quick = (key: typeof gap) => () => setGap(gap === key ? '' : key);

  return (
    <>
      <PageHeader
        title="Employees"
        description="Accounts, workplaces, supervisors and rosters."
        actions={
          isOwner && <>
            <Button onClick={() => setImporting(true)}>
              <Upload className="h-4 w-4" aria-hidden /> Import
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New employee
            </Button>
          </>
        }
      />
      {everyone.error ? null : everyone.isLoading ? (
        <StatStripSkeleton label="Directory figures" count={5} className="mb-4" />
      ) : (
        <StatStrip label="Directory figures" count={5} className="mb-4">
            <Kpi label="Employees" value={stats.total} sub={`${stats.active} active · ${stats.total - stats.active} deactivated`} />
            <Kpi label="On shift now" value={stats.onShift} sub="open shift session" onClick={quick('onShift')} title="Show only people on shift (click again to clear)" />
            <Kpi label="No workplace" value={stats.noWorkspace} tone={stats.noWorkspace ? 'warn' : undefined} sub="cannot be rostered yet" onClick={quick('noWorkspace')} title="Active employees without a home workplace" />
            <Kpi label="No shift assigned" value={stats.noShift} tone={stats.noShift ? 'warn' : undefined} sub="not on any roster" onClick={quick('noShift')} title="Active employees with no roster entry" />
            <Kpi label="No supervisor" value={stats.noSupervisor} sub="reports to nobody" onClick={isOwner ? () => setSupervisorId(supervisorId === 'none' ? '' : 'none') : undefined} title="Active employees without a supervisor" />
        </StatStrip>
      )}
      <Card padded={false}>
        <Toolbar>
          {gap && (
            <Button size="sm" variant="subtle" onClick={() => setGap('')} aria-label="Clear quick filter">
              {gap === 'onShift' ? 'On shift now' : gap === 'noWorkspace' ? 'No workplace' : 'No shift assigned'} <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          )}
          <SearchInput aria-label="Search employees" placeholder="Name, email or employee ID" value={search} onChange={(e) => setSearch(e.target.value)} className="sm:w-72" />
          <WorkplaceSelect value={workplaceId} onChange={setWorkplaceId} />
          {isOwner && <SupervisorSelect value={supervisorId === 'none' ? '' : supervisorId} onChange={setSupervisorId} />}
          {isOwner && (
            <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={supervisorId === 'none'} onChange={(e) => setSupervisorId(e.target.checked ? 'none' : '')} /> No supervisor</label>
          )}
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
            <option value="active">Active</option>
            <option value="inactive">Deactivated</option>
            <option value="all">All</option>
          </Select>
        </Toolbar>
        <QueryState query={list} isEmpty={() => rows.length === 0} empty={<EmptyState title="No employees match">Create an employee or change the filters.</EmptyState>}>
          {() => (
            <>
            <Table>
              <thead>
                <tr>
                  <SortTh k="name" sort={sort} onSort={setSort}>Employee</SortTh>
                  <SortTh k="code" sort={sort} onSort={setSort}>Employee ID</SortTh>
                  <SortTh k="workplace" sort={sort} onSort={setSort}>Workplace &amp; shifts</SortTh>
                  <Th>Supervisor</Th>
                  <Th>Right now</Th>
                  <SortTh k="signin" sort={sort} onSort={setSort}>Last sign-in</SortTh>
                </tr>
              </thead>
              <tbody>
                {rows.slice(offset, offset + PAGE).map((e) => (
                  <tr key={e.id} className={cx(rowLink, !e.is_active && 'text-gray-500')} onClick={() => setSelected(e.id)} tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && setSelected(e.id)} aria-label={`${e.full_name}, open employee`}>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-gray-900">{e.full_name}</span>
                        {e.is_demo && <DemoTag />}
                      </div>
                      <div className="text-xs text-gray-500">{e.email}</div>
                    </Td>
                    <Td className="tabular">{e.employee_code}</Td>
                    <Td>
                      {e.workplace_name ?? <span className="text-gray-500">No workplace</span>}
                      <div className="text-xs text-gray-500">{(e.shifts ?? []).map((s: any) => s.name).join(', ') || 'No shift assigned'}</div>
                    </Td>
                    <Td className="text-body-sm">{e.supervisor_name ?? <span className="text-gray-500">—</span>}</Td>
                    <Td>
                      {!e.is_active ? <Badge dot tone="gray">Deactivated</Badge> : e.open_session ? <StateBadge state={e.open_session.state} /> : <span className="text-body-sm text-gray-500">Off shift</span>}
                    </Td>
                    <Td className="text-xs text-gray-500">{e.last_login_at ? ago(e.last_login_at) : 'never'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination offset={offset} limit={PAGE} total={rows.length} onChange={setOffset} noun="employee" />
            </>
          )}
        </QueryState>
      </Card>
      <ImportEmployees open={importing} onClose={() => setImporting(false)} />
      <CreateEmployee open={creating} onClose={() => setCreating(false)} onCreated={(id) => setSelected(id)} />
      <EmployeeDrawer employeeId={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function CreateEmployee({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const wps = useWorkplaces();
  const empty = { fullName: '', email: '', employeeCode: '', phone: '', department: '', designation: '', workplaceId: '' };
  const [f, setF] = useState(empty);
  const [result, setResult] = useState<{ id: string; pw?: string } | null>(null);
  const create = useMutation({
    mutationFn: () => post('/employees', { ...f, phone: f.phone || null, department: f.department || null, designation: f.designation || null, workplaceId: f.workplaceId || undefined }),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      setResult({ id: r.employee.id, pw: r.temporaryPassword });
    },
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const close = () => {
    if (result) onCreated(result.id);
    setF(empty);
    setResult(null);
    create.reset();
    onClose();
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="New employee" description="A temporary password is generated and shown once. Assign shifts after creating the account.">
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-700">Account created. Share this temporary password securely — it will not be shown again:</p>
          <p className="rounded-md bg-gray-100 p-3 font-mono text-sm select-all">{result.pw}</p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>Continue to assignment</Button>
          </div>
        </div>
      ) : (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Full name"><Input required value={f.fullName} onChange={set('fullName')} /></Field>
          <Field label="Email"><Input required type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Employee ID"><Input required value={f.employeeCode} onChange={set('employeeCode')} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Department"><Input value={f.department} onChange={set('department')} /></Field>
          <Field label="Designation"><Input value={f.designation} onChange={set('designation')} /></Field>
          <div className="sm:col-span-2">
            <Field label="Workplace">
              <Select value={f.workplaceId} onChange={set('workplaceId')}>
                <option value="">Assign later</option>
                {wps.data?.filter((w: any) => w.is_active).map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </Field>
          </div>
          <div className="sm:col-span-2"><InlineError error={create.error} /></div>
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Button type="button" onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending}>Create employee</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
