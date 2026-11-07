'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { FACE_RESULT } from '@/components/state-badge';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Check, ClipboardList, MapPin, X } from 'lucide-react';
import { get, post, qs } from '@/lib/api';
import { hrsNum, shortDay, daysAgoISO, fmtClock, fmtDate, fmtDateTime, minutes, todayISO } from '@/lib/format';
import { useMe } from '@/lib/me';
import { rowKeys, LinkButton, Badge, Button, Callout, Card, ConfirmButton, CutNotice, cx, DemoTag, Drawer, EmptyState, ErrorState, Field, InlineError, Input, KeyValue, PageHeader, QueryState, SearchInput, SimBadge, Table, Tabs, Td, Textarea, Th, rowLink } from '@/components/ui';
import { DateRangeSelect, defaultRange, WorkplaceSelect, type DateRangeValue } from '@/components/filters';
import { ChartCard, Composition, DataTable, HBarList, Kpi, LineChart, SERIES_COLORS, StatStrip, StatStripSkeleton } from '@/components/charts';

/**
 * Overtime: work after the scheduled end of a shift, started and ended by the employee in the
 * app with a selfie and their location. Nothing counts toward hours or pay until approved here.
 */

type Tab = 'pending' | 'running' | 'approved' | 'rejected' | 'all';
const STATUS: Record<Tab, string | undefined> = { pending: 'PENDING', running: 'RUNNING', approved: 'APPROVED', rejected: 'REJECTED', all: undefined };
const TABS = new Set<Tab>(['pending', 'running', 'approved', 'rejected', 'all']);

const km = (m: number | null | undefined) => (m == null ? '—' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** Where the overtime was worked, from the readings sent during it. */
function where(o: any): { label: string; tone: 'green' | 'amber' | 'gray'; detail: string } {
  if (!o.readings) {
    const inside = o.start_distance_m <= o.radius_m;
    return { label: inside ? 'At workplace' : 'Off-site', tone: inside ? 'green' : 'amber', detail: `started ${km(o.start_distance_m)} from ${o.workplace_name}` };
  }
  const share = o.inside_readings / o.readings;
  const detail = `${o.readings} location${o.readings === 1 ? '' : 's'}, ${Math.round(share * 100)}% inside · farthest ${km(o.max_distance_m)}`;
  if (share >= 0.8) return { label: 'At workplace', tone: 'green', detail };
  return { label: share > 0 ? 'Partly off-site' : 'Off-site', tone: 'amber', detail };
}

function FaceBadge({ which, status }: { which: string; status: string | null }) {
  if (!status) return <Badge tone="gray" title="The face check runs within a minute">{which}: checking…</Badge>;
  const f = FACE_RESULT[status] ?? { label: status, tone: 'gray' as const };
  return <Badge tone={f.tone}>{which}: {f.label.toLowerCase()}</Badge>;
}

function StatusBadge({ o }: { o: any }) {
  if (o.status === 'RUNNING') return <Badge dot tone="navy">On overtime</Badge>;
  if (o.status === 'PENDING') return <Badge dot tone="amber">Waiting approval</Badge>;
  if (o.status === 'REJECTED') return <Badge dot tone="red">Rejected</Badge>;
  return (
    <Badge dot tone="green" title={o.approved_minutes < o.claimed_minutes ? `${minutes(o.approved_minutes)} of ${minutes(o.claimed_minutes)} approved` : undefined}>
      Approved {o.approved_minutes < o.claimed_minutes ? minutes(o.approved_minutes) : ''}
    </Badge>
  );
}

const hours = (m: number) => (m ? minutes(m) : '0 min');
const OT = [{ key: 'hours', label: 'Approved overtime (h)', color: SERIES_COLORS[1] }];

/**
 * Overtime over a chosen period, from the same analytics engine as the reports: approved hours per
 * day, by employee and by workplace, and claims by decision. Only real entries are counted.
 */
function OvertimeAnalytics({ workplaceId }: { workplaceId: string }) {
  const [range, setRange] = useState<DateRangeValue>(() => defaultRange('30d'));
  const q = useQuery({ queryKey: ['overtime', 'analytics', range.from, range.to, workplaceId], queryFn: () => get(`/analytics/dashboard${qs({ from: range.from, to: range.to, workplaceId })}`), placeholderData: (p) => p });
  const d = q.data;
  const st = d?.overtimeStatus;
  const decided = st ? st.pending.count + st.approved.count + st.rejected.count + st.running.count : 0;
  const ws = (d?.byWorkspace ?? []).filter((w: any) => w.overtimeMinutes > 0).map((w: any) => ({ ...w, hours: hrsNum(w.overtimeMinutes) }));
  return (
    <section aria-label="Overtime analytics" className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-navy-900">Overtime analytics</h2>
        <DateRangeSelect value={range} onChange={setRange} />
      </div>
      {q.error && !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <div className="h-64 animate-pulse rounded-lg border border-gray-200 bg-white" />
      ) : !decided && !d.summary.overtimeMinutes ? (
        // One empty state instead of three empty charts.
        <Card padded={false}>
          <EmptyState title={`No overtime in ${fmtDate(d.from)} – ${fmtDate(d.to)}`}>Charts appear here once employees claim overtime after a shift. Try a longer period or another workplace.</EmptyState>
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
          <ChartCard title="Approved overtime per day" subtitle={`${hrsNum(d.summary.overtimeMinutes)} h approved · ${fmtDate(d.from)} – ${fmtDate(d.to)}`} empty={!d.summary.overtimeMinutes} table={<DataTable data={d.hoursByDay.map((x: any) => ({ date: x.date, hours: hrsNum(x.overtime) }))} x="date" series={OT} xTitle={fmtDate} />}>
            <LineChart label="Approved overtime hours per day" data={d.hoursByDay.map((x: any) => ({ date: x.date, hours: hrsNum(x.overtime) }))} x="date" series={OT} xLabel={shortDay} xTitle={fmtDate} height={200} />
          </ChartCard>
          <ChartCard title="Claims by decision" subtitle="Overtime entries of shifts in the period" empty={!decided}>
            <Composition
              label="Overtime claims by decision"
              parts={[
                { key: 'pending', label: 'Awaiting approval', value: st.pending.count, color: '#d97706', hint: st.pending.claimedMinutes ? `${minutes(st.pending.claimedMinutes)} claimed` : undefined },
                { key: 'approved', label: 'Approved', value: st.approved.count, color: '#0d9488', hint: st.approved.approvedMinutes ? `${minutes(st.approved.approvedMinutes)} approved` : undefined },
                { key: 'rejected', label: 'Rejected', value: st.rejected.count, color: '#dc2626' },
                { key: 'running', label: 'Still running', value: st.running.count, color: SERIES_COLORS[2] },
              ]}
            />
          </ChartCard>
          <ChartCard title="Overtime by employee" subtitle="Approved hours, highest first" empty={!d.overtimeByEmployee.length} className="lg:col-span-2 xl:col-span-1">
            <HBarList data={d.overtimeByEmployee.map((e: any) => ({ ...e, hours: hrsNum(e.overtimeMinutes) }))} label="Approved overtime by employee" series={OT} format={(v) => `${v} h`} name={(r) => (<span className="flex items-center gap-1.5">{r.name}{r.unusual && <Badge tone="amber" title="Overtime is over 25% of their hours, or far above the team's usual">review</Badge>}</span>)} max={8} />
          </ChartCard>
          {ws.length > 1 && (
            <ChartCard title="Overtime by workplace" subtitle="Approved hours" className="lg:col-span-2 xl:col-span-3">
              <HBarList data={ws} label="Approved overtime by workplace" series={OT} format={(v) => `${v} h`} name={(r) => r.name} max={10} />
            </ChartCard>
          )}
        </div>
      )}
    </section>
  );
}

export default function OvertimePage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('pending');
  const [workplaceId, setWorkplaceId] = useState('');
  const [date, setDate] = useState('');
  const [range, setRange] = useState({ from: daysAgoISO(30), to: todayISO() });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const onlyWorkplace = (id: string) => (setWorkplaceId(id), setSelected(new Set()));
  const [open, setOpen] = useState<any | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null;
    if (t && TABS.has(t)) setTab(t);
  }, []);

  const summary = useQuery({ queryKey: ['overtime', 'summary', workplaceId, date], queryFn: () => get(`/overtime/summary${qs({ workplaceId, date })}`), refetchInterval: 60_000 });
  const dated = tab === 'approved' || tab === 'rejected' || tab === 'all';
  const list = useQuery({
    queryKey: ['overtime', 'list', tab, workplaceId, dated ? range : null],
    queryFn: () => get<any[]>(`/overtime${qs({ status: STATUS[tab], workplaceId, ...(dated ? range : {}) })}`),
    refetchInterval: 60_000,
  });
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list.data ?? []).filter((o) => !q || o.full_name.toLowerCase().includes(q) || String(o.employee_code ?? '').toLowerCase().includes(q) || o.workplace_name.toLowerCase().includes(q));
  }, [list.data, search]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['overtime'] });
    qc.invalidateQueries({ queryKey: ['approvals'] });
    qc.invalidateQueries({ queryKey: ['overview'] });
  };
  const bulk = useMutation({ meta: { success: 'Overtime decisions saved' },
    // Only rows on screen: a row hidden by the search is never approved unseen.
    mutationFn: () => post<{ approved: number; skipped: number }>('/overtime/decisions', { ids: pendingRows.filter((o) => selected.has(o.id)).map((o) => o.id) }),
    onSuccess: () => {
      setSelected(new Set());
      refresh();
    },
  });

  const s = summary.data;
  const pendingRows = tab === 'pending' ? rows : [];
  const allChecked = pendingRows.length > 0 && pendingRows.every((o) => selected.has(o.id));
  const chosen = pendingRows.filter((o) => selected.has(o.id));
  const chosenMinutes = chosen.reduce((n, o) => n + (o.claimed_minutes ?? 0), 0);
  const toggle = (id: string) => setSelected((cur) => {
    const n = new Set(cur);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <>
      <PageHeader
        title="Overtime"
        description="Work after a shift's scheduled end. Employees start and end overtime in the app with a selfie and their location; it counts toward hours and pay only once you approve it."
        actions={
          <>
            <WorkplaceSelect value={workplaceId} onChange={(v) => (setWorkplaceId(v), setSelected(new Set()))} />
            <Input type="date" aria-label="Summary date" value={date || s?.date || ''} onChange={(e) => setDate(e.target.value)} className="w-auto" />
            {date && date !== todayISO() && <Button onClick={() => setDate('')}>Today</Button>}
          </>
        }
      />

      {summary.error && !s ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : !s ? (
        <StatStripSkeleton label="Overtime summary" count={5} />
      ) : (
        <StatStrip label="Overtime summary" count={5}>
          <Kpi label="On overtime now" value={s.running} sub="still working after their shift" />
          <Kpi label={date && date !== todayISO() ? `Overtime on ${fmtDate(s.date)}` : 'Overtime today'} value={hours(s.claimed_minutes)} sub={`${s.workers} ${s.workers === 1 ? 'person' : 'people'} · worked so far`} />
          <Kpi label="Approved for the day" value={hours(s.approved_minutes)} sub="counts toward pay" />
          <Kpi label="Waiting approval" value={s.pending} sub={s.pending ? `${minutes(s.pending_minutes)} in total` : 'nothing waiting'} tone={s.pending ? 'warn' : undefined} />
          <Kpi label="Approved this month" value={hours(s.month_approved_minutes)} sub={s.month} />
        </StatStrip>
      )}

      {s?.byWorkplace?.length > 1 && (
        <Card title={`By workplace · ${fmtDate(s.date)}`} padded={false} className="mt-6">
          <Table minWidth={560}>
            <thead>
              <tr>
                <Th>Workplace</Th>
                <Th className="text-right">People</Th>
                <Th className="text-right">On overtime now</Th>
                <Th className="text-right">Worked</Th>
                <Th className="text-right">Approved</Th>
                <Th className="text-right">Waiting</Th>
              </tr>
            </thead>
            <tbody>
              {s.byWorkplace.map((w: any) => (
                <tr key={w.workplace_id} className={rowLink} tabIndex={0} onClick={() => onlyWorkplace(w.workplace_id)} onKeyDown={rowKeys(() => onlyWorkplace(w.workplace_id))} aria-label={`${w.workplace_name}, show only this workplace`}>
                  <Td className="font-medium text-gray-900">{w.workplace_name}</Td>
                  <Td className="tabular text-right">{w.workers}</Td>
                  <Td className="tabular text-right">{w.running || '—'}</Td>
                  <Td className="tabular text-right">{hours(w.claimed_minutes)}</Td>
                  <Td className="tabular text-right">{hours(w.approved_minutes)}</Td>
                  <Td className="tabular text-right">{w.pending ? <span className="text-amber-700">{w.pending}</span> : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <section aria-label="Overtime entries" className="mt-6 rounded-lg border border-gray-200 bg-white shadow-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3">
          <Tabs
            className="shrink-0"
            variant="segmented"
            label="Filter overtime"
            value={tab}
            onChange={(t) => (setTab(t), setSelected(new Set()))}
            tabs={[
              { value: 'pending', label: 'Waiting approval', count: s?.pending, alert: true },
              { value: 'running', label: 'On overtime now', count: s?.running },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'all', label: 'All' },
            ]}
          />
          <div className="flex w-full flex-col gap-2 sm:ml-auto sm:w-auto sm:flex-row sm:items-center">
            {dated && (
              <div className="flex items-center gap-2">
                <Input type="date" aria-label="From" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="w-auto" />
                <span className="text-sm text-gray-500">to</span>
                <Input type="date" aria-label="To" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="w-auto" />
              </div>
            )}
            <SearchInput aria-label="Search overtime" placeholder="Search name, ID or workplace" value={search} onChange={(e) => (setSearch(e.target.value), setSelected(new Set()))} className="sm:w-56" />
          </div>
        </div>
        {tab === 'pending' && chosen.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-primary-50 px-4 py-2.5 text-sm">
            <span className="font-medium text-gray-900">{chosen.length} selected</span>
            <ConfirmButton size="sm" variant="primary" loading={bulk.isPending} title={`Approve ${chosen.length} overtime ${chosen.length === 1 ? 'entry' : 'entries'}?`} description={`${minutes(chosenMinutes)} of worked time will count toward hours and pay.`} confirmLabel="Approve" onConfirm={() => bulk.mutate()}>
              <Check className="h-4 w-4" aria-hidden /> Approve all worked time
            </ConfirmButton>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            <InlineError error={bulk.error} />
          </div>
        )}
        {bulk.data && bulk.data.skipped > 0 && (
          <Callout tone="warning" className="m-4">{bulk.data.skipped} could not be approved (already decided, still running, or not one of your sites).</Callout>
        )}
        <QueryState
          query={list}
          isEmpty={() => rows.length === 0}
          empty={
            <EmptyState title={search ? 'No one matches this search' : tab === 'pending' ? 'No overtime waiting for approval' : tab === 'running' ? 'No one is on overtime right now' : 'No overtime in this range'}>
              {!search && tab === 'pending' && 'When an employee ends overtime in the app, it appears here for you to approve.'}
            </EmptyState>
          }
        >
          {() => (
            <Table minWidth={860}>
              <thead>
                <tr>
                  {tab === 'pending' && (
                    <Th label="" className="w-10">
                      <input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(pendingRows.map((o) => o.id)))} />
                    </Th>
                  )}
                  <Th>Employee</Th>
                  <Th>When</Th>
                  <Th>Worked</Th>
                  <Th>Where</Th>
                  <Th>Photo proof</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const w = where(o);
                  return (
                    <tr key={o.id} className={rowLink} tabIndex={0} onClick={() => setOpen(o)} onKeyDown={rowKeys(() => setOpen(o))} aria-label={`${o.full_name}, review overtime`}>
                      {tab === 'pending' && (
                        <Td className="row-actions">
                          <input type="checkbox" aria-label={`Select ${o.full_name}`} checked={selected.has(o.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(o.id)} />
                        </Td>
                      )}
                      <Td>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-gray-900">{o.full_name}</span>
                          {o.is_demo && <DemoTag />}
                          {o.is_simulated && <SimBadge />}
                        </div>
                        <div className="text-xs text-gray-500">{[o.employee_code, o.workplace_name].filter(Boolean).join(' · ')}</div>
                      </Td>
                      <Td>
                        <div className="text-gray-800">{fmtDate(o.shift_date)}</div>
                        <div className="tabular text-xs text-gray-500">
                          {fmtClock(o.started_at)}–{o.ended_at ? fmtClock(o.ended_at) : 'now'} · after {o.shift_name}
                        </div>
                      </Td>
                      <Td className="tabular">
                        <div className="text-gray-900">{minutes(o.claimed_minutes)}</div>
                        {o.status === 'RUNNING' && <div className="text-xs text-gray-500">so far</div>}
                        {o.end_reason && o.end_reason !== 'EMPLOYEE' && <div className="text-xs text-amber-800">{o.end_reason === 'TRACKING_LOST' ? 'ended: phone went quiet' : o.end_reason === 'NEXT_SHIFT' ? 'ended: next shift' : 'ended by admin'}</div>}
                      </Td>
                      <Td>
                        <Badge dot tone={w.tone}>{w.label}</Badge>
                        <div className="mt-1 text-xs text-gray-500">{w.detail}</div>
                      </Td>
                      <Td>
                        <div className="flex flex-col items-start gap-1">
                          <FaceBadge which="start" status={o.start_face_status} />
                          {o.ended_at && <FaceBadge which="end" status={o.has_end_photo || o.end_face_status ? o.end_face_status : 'NO_PHOTO'} />}
                        </div>
                      </Td>
                      <Td>
                        <StatusBadge o={o} />
                        {o.decided_by_name && <div className="mt-1 text-xs text-gray-500">by {o.decided_by_name}</div>}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </QueryState>
        <CutNotice shown={list.data?.length ?? 0} cap={1000} noun="entries" />
      </section>

      <OvertimeAnalytics workplaceId={workplaceId} />

      <OvertimeDrawer entry={open} onClose={() => setOpen(null)} onDone={refresh} />
    </>
  );
}

function OvertimeDrawer({ entry: o, onClose, onDone }: { entry: any | null; onClose: () => void; onDone: () => void }) {
  const { isOwner } = useMe();
  const [photos, setPhotos] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mins, setMins] = useState('');
  const [note, setNote] = useState('');
  const [endReason, setEndReason] = useState('');
  useEffect(() => {
    setPhotos(false);
    setEditing(false);
    setMins(o ? String(o.approved_minutes ?? o.claimed_minutes) : '');
    setNote('');
    setEndReason('');
  }, [o]);

  const link = (which: 'start' | 'end') => post<{ url: string }>(`/overtime/${o.id}/photo-url`, { which }).then((r) => r.url).catch(() => null);
  const urls = useQuery({ queryKey: ['overtime', 'photos', o?.id], queryFn: async () => ({ start: await link('start'), end: await link('end') }), enabled: !!o && photos, staleTime: 60_000 });
  const decide = useMutation({ meta: { success: 'Decision saved' },
    mutationFn: (decision: 'APPROVE' | 'REJECT') => post(`/overtime/${o.id}/decision`, { decision, minutes: decision === 'APPROVE' ? Number(mins) : undefined, note: note.trim() || undefined }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  const end = useMutation({ meta: { success: 'Overtime ended' },
    mutationFn: () => post(`/tracking/sessions/${o.session_id}/terminate`, { reason: `overtime ended: ${endReason.trim()}` }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  if (!o) return <Drawer open={false} onOpenChange={() => undefined} title="">{null}</Drawer>;
  const w = where(o);
  const canDecide = o.status !== 'RUNNING' && (o.status === 'PENDING' || editing);
  const tooMany = Number(mins) > o.claimed_minutes;
  const tile = (label: string, url: string | null | undefined, missing: string) => (
    <figure className="min-w-0">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`${label} of ${o.full_name}`} className="aspect-[3/4] w-full rounded-md border border-gray-200 object-cover" referrerPolicy="no-referrer" />
      ) : (
        <div className="flex aspect-[3/4] w-full items-center justify-center rounded-md border border-dashed border-gray-300 px-2 text-center text-xs text-gray-500">{missing}</div>
      )}
      <figcaption className="mt-1 text-xs text-gray-600">{label}</figcaption>
    </figure>
  );

  return (
    <Drawer open onOpenChange={(v) => !v && onClose()} title={o.full_name} subtitle={`Overtime · ${fmtDate(o.shift_date)} · ${o.workplace_name}`}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge o={o} />
          {o.is_simulated && <SimBadge />}
        </div>
        <KeyValue
          items={[
            ['Started', fmtDateTime(o.started_at)],
            ['Ended', o.ended_at ? fmtDateTime(o.ended_at) : 'Still working'],
            ['Worked', `${minutes(o.claimed_minutes)}${o.status === 'RUNNING' ? ' so far' : ''}`],
            ['Shift', `${o.shift_name}, ended ${fmtClock(o.scheduled_end_at)}`],
            ['Where', `${w.label} — ${w.detail}`],
            ['Start location', `${km(o.start_distance_m)} from ${o.workplace_name} (±${Math.round(o.start_accuracy_m)} m)`],
            ...(o.note ? ([['Employee note', `“${o.note}”`]] as Array<[string, ReactNode]>) : []),
            ...(o.decided_at ? ([['Decision', `${o.status === 'APPROVED' ? `Approved ${minutes(o.approved_minutes)}` : 'Rejected'} by ${o.decided_by_name ?? 'an administrator'}, ${fmtDateTime(o.decided_at)}${o.decision_note ? ` — “${o.decision_note}”` : ''}`]] as Array<[string, ReactNode]>) : []),
          ]}
          cols={1}
        />

        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-900">Photo proof</h3>
            {!photos && (
              <Button size="sm" onClick={() => setPhotos(true)}>
                <Camera className="h-4 w-4" aria-hidden /> Show photos
              </Button>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            <FaceBadge which="start" status={o.start_face_status} />
            {o.ended_at && <FaceBadge which="end" status={o.has_end_photo || o.end_face_status ? o.end_face_status : 'NO_PHOTO'} />}
          </div>
          {photos && (
            <div className="mt-3">
              <QueryState query={urls}>
                {(d) => (
                  <div className="grid grid-cols-2 gap-3">
                    {tile('Overtime start', d.start, 'No photo')}
                    {tile('Overtime end', d.end, o.ended_at ? 'No end photo' : 'Not ended yet')}
                  </div>
                )}
              </QueryState>
              <p className="mt-2 text-xs text-gray-500">Viewing these photos is recorded in the audit log.</p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {o.status === 'RUNNING' && (
            <LinkButton href={`/map?employee=${o.employee_id}`} size="sm"><MapPin className="h-4 w-4" aria-hidden /> Show on live map</LinkButton>
          )}
          <LinkButton href={`/attendance?record=${o.attendance_id}`} size="sm"><ClipboardList className="h-4 w-4" aria-hidden /> Attendance record</LinkButton>
        </div>

        {o.status === 'RUNNING' && (
          <form
            className="space-y-3 rounded-md border border-gray-200 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              end.mutate();
            }}
          >
            <h3 className="text-sm font-semibold text-gray-900">End overtime now</h3>
            <p className="text-sm text-gray-600">For overtime the employee forgot to end. Location collection stops; you can then approve or reject it.</p>
            <Field label="Reason" required>
              <Input required minLength={3} value={endReason} onChange={(e) => setEndReason(e.target.value)} placeholder="e.g. left site at 20:00, forgot to end" />
            </Field>
            <InlineError error={end.error} />
            <Button type="submit" variant="danger" size="sm" loading={end.isPending}>End overtime</Button>
          </form>
        )}

        {o.status !== 'RUNNING' && !canDecide && (
          <Button size="sm" onClick={() => setEditing(true)}>Change decision</Button>
        )}

        {canDecide && (
          <form
            className="space-y-3 rounded-md border border-gray-200 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              decide.mutate('APPROVE');
            }}
          >
            <h3 className="text-sm font-semibold text-gray-900">{o.status === 'PENDING' ? 'Decide' : 'Change decision'}</h3>
            <Field label="Minutes to approve" hint={`Up to ${minutes(o.claimed_minutes)} — the time between the overtime photos. Approve less to leave out travel or idle time.`} error={tooMany ? `At most ${o.claimed_minutes} minutes` : undefined}>
              <Input type="number" min={0} max={o.claimed_minutes} value={mins} onChange={(e) => setMins(e.target.value)} className="w-32" />
            </Field>
            <Field label="Note to the employee" hint="Required when rejecting.">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
            </Field>
            <InlineError error={decide.error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={decide.isPending && decide.variables === 'APPROVE'} disabled={tooMany || mins === ''}>
                <Check className="h-4 w-4" aria-hidden /> Approve {mins !== '' && !tooMany ? minutes(Number(mins)) : ''}
              </Button>
              <Button type="button" variant="danger" loading={decide.isPending && decide.variables === 'REJECT'} disabled={note.trim().length < 3} title={note.trim().length < 3 ? 'Write a note first' : undefined} onClick={() => decide.mutate('REJECT')}>
                <X className="h-4 w-4" aria-hidden /> Reject
              </Button>
            </div>
            {!isOwner && <p className="text-xs text-gray-500">You can decide overtime for the workplaces you supervise.</p>}
          </form>
        )}
      </div>
    </Drawer>
  );
}
