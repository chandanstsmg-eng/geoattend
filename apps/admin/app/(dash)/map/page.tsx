'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PanelRightClose, PanelRightOpen, RefreshCw } from 'lucide-react';
import { kindFor, LOCATION_GROUPS } from '@/components/maps/markers';
import { get, qs } from '@/lib/api';
import { useLive } from '@/lib/live';
import { Badge, Button, Callout, ErrorState, PageHeader, QueryState, Select, Tabs, cx } from '@/components/ui';
import { SupervisorSelect, WorkplaceSelect, useSupervisors, useWorkplaces } from '@/components/filters';
import { MapLegend, WorkforceMap } from '@/components/live-map';
import { PeopleList, SessionDetails, useNow } from '@/components/live-panel';
import { useMe } from '@/lib/me';
import { useIncludeSimulated } from '@/lib/sim-pref';
import { EmployeeDrawer } from '@/components/employee-drawer';

const group = (key: string) => LOCATION_GROUPS.find((g) => g.key === key)!;
/** Status filters over the marker kinds (and "not checked in", which has no position). The groups come from markers.ts. */
const STATUS_FILTERS: Array<{ value: string; label: string; kinds?: string[] }> = [
  { value: '', label: 'All statuses' },
  { value: 'inside', label: group('onsite').filter, kinds: group('onsite').kinds },
  { value: 'outside', label: group('outside').filter, kinds: group('outside').kinds },
  { value: 'arriving', label: group('arriving').filter, kinds: group('arriving').kinds },
  { value: 'overtime', label: group('overtime').filter, kinds: group('overtime').kinds },
  { value: 'silent', label: 'No fresh location', kinds: [...group('unavailable').kinds, ...group('stale').kinds] },
  { value: 'ended', label: group('ended').filter, kinds: group('ended').kinds },
  { value: 'not-in', label: 'Not checked in' },
];

/** Who belongs where today: each workplace's roster against who is on shift there now. */
function WorkplaceList({ workplaces, roster, rosterKnown, open, onPick }: { workplaces: any[]; roster: any[]; rosterKnown: boolean; open: any[]; onPick: (id: string) => void }) {
  return (
    <ul className="max-h-[calc(100dvh-14rem)] min-h-40 divide-y divide-gray-100 overflow-y-auto">
      {workplaces.map((w) => {
        const rostered = new Set(roster.filter((r) => r.workplace_id === w.id).map((r) => r.employee_id)).size;
        const here = open.filter((s) => s.workplace_id === w.id);
        const late = here.filter((s) => s.is_stale || !s.last_location_at).length;
        return (
          <li key={w.id}>
            <button type="button" onClick={() => onPick(w.id)} className="block w-full px-4 py-3 text-left text-sm hover:bg-gray-50">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate font-semibold text-gray-900">{w.name}</span>
                <span className="tabular shrink-0 text-body-sm text-gray-600">{rosterKnown ? `${here.length} of ${rostered}` : here.length} on shift</span>
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                <span className="tabular">{Math.round(w.radius_m ?? w.radiusM ?? 0)} m radius</span>
                {late > 0 && <Badge tone="amber">{late} no fresh location</Badge>}
              </span>
            </button>
          </li>
        );
      })}
      {workplaces.length === 0 && <li className="px-4 py-10 text-center text-sm text-gray-500">No workplace in this view.</li>}
    </ul>
  );
}

export default function LiveMapPage() {
  const { isOwner } = useMe();
  const [workplaceId, setWorkplaceId] = useState('');
  const [supervisorId, setSupervisorId] = useState('');
  const [status, setStatus] = useState('');
  const sim = useIncludeSimulated();
  const includeSim = sim.include;
  const [shift, setShift] = useState('');
  const [panel, setPanel] = useState(true);
  const [side, setSide] = useState<'people' | 'places'>('people');
  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const live = useQuery({ queryKey: ['live', workplaceId, supervisorId, includeSim], queryFn: () => get(`/tracking/live${qs({ workplaceId, supervisorId, includeSimulated: includeSim })}`), refetchInterval: 30_000, placeholderData: (p) => p });
  const overview = useQuery({ queryKey: ['overview', workplaceId], queryFn: () => get(`/reports/overview${qs({ workplaceId })}`), refetchInterval: 60_000 });
  const wps = useWorkplaces();
  const sups = useSupervisors(isOwner);
  const { state: conn } = useLive();
  const now = useNow();

  const supSites: string[] | null = supervisorId ? (sups.data?.find((s) => s.id === supervisorId)?.site_ids ?? []) : null;
  const filter = STATUS_FILTERS.find((f) => f.value === status);
  const all: any[] = live.data?.sessions ?? [];
  const shifts = [...new Set(all.map((s) => s.shift_name).filter(Boolean))].sort();
  const sessions = (filter?.kinds ? all.filter((s) => filter.kinds!.includes(kindFor(s)) || (status === 'silent' && s.is_open && !s.last_location_at)) : status === 'not-in' ? [] : all).filter((s) => !shift || s.shift_name === shift);
  const sel = all.find((s) => s.id === selected) ?? null;
  // Rostered today with no session at all: nothing to put on the map, but they belong on the list.
  const withSession = new Set(all.map((s) => `${s.employee_id}|${s.shift_name}`));
  const notIn = (overview.data?.roster ?? []).filter(
    (r: any) => !r.session_id && !r.attendance_id && !r.on_leave && !r.holiday && (!supSites || supSites.includes(r.workplace_id)) && !withSession.has(`${r.employee_id}|${r.shift_name}`) && (!shift || r.shift_name === shift),
  );
  const showNotIn = status === '' || status === 'not-in';

  // Links from the overview: ?employee=<id> selects their session, ?workplaceId=<id> filters.
  const [wanted, setWanted] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setWanted(p.get('employee'));
    if (p.get('workplaceId')) setWorkplaceId(p.get('workplaceId')!);
    if (p.get('supervisorId')) setSupervisorId(p.get('supervisorId')!);
    if (STATUS_FILTERS.some((f) => f.value === p.get('status'))) setStatus(p.get('status')!);
  }, []);
  useEffect(() => {
    if (!wanted || !live.data) return;
    const s = all.find((x) => x.employee_id === wanted && x.is_open) ?? all.find((x) => x.employee_id === wanted);
    if (s) setSelected(s.id);
    setWanted(null);
  }, [wanted, live.data, all]);
  const workplaces = (wps.data ?? []).filter((w: any) => w.is_active && (!workplaceId || w.id === workplaceId) && (!supSites || supSites.includes(w.id)));
  const open = all.filter((s) => s.is_open);
  const counts = {
    live: open.filter((s) => s.last_location_at && !s.is_stale).length,
    lastKnown: open.filter((s) => s.last_location_at && s.is_stale).length,
    waiting: open.filter((s) => !s.last_location_at).length,
  };

  return (
    <>
      <PageHeader
        title="Live map"
        description={
          live.error ? <span className="text-red-700">Live positions could not be loaded.</span> : <span className="tabular">
            {open.length} on shift · <span className="text-teal-700">{counts.live} live</span> · {counts.lastKnown} last known · {counts.waiting} no location yet · {overview.error ? 'not-checked-in count unavailable' : `${notIn.length} not checked in`}
          </span>
        }
        actions={
          <>
            <WorkplaceSelect value={workplaceId} onChange={setWorkplaceId} />
            {isOwner && <SupervisorSelect value={supervisorId} onChange={setSupervisorId} />}
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto min-w-44">
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </Select>
            {shifts.length > 1 && (
              <Select aria-label="Shift" value={shift} onChange={(e) => setShift(e.target.value)} className="w-auto min-w-40">
                <option value="">All shifts</option>
                {shifts.map((x) => <option key={x} value={x}>{x}</option>)}
              </Select>
            )}
            {sim.available && (
              <label className="flex h-10 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-700 sm:h-9.5">
                <input type="checkbox" checked={includeSim} onChange={(e) => sim.set(e.target.checked)} /> Include simulated
              </label>
            )}
            {(workplaceId || supervisorId || status || shift) && (
              <Button variant="ghost" onClick={() => { setWorkplaceId(''); setSupervisorId(''); setStatus(''); setShift(''); }}>Reset</Button>
            )}
            <Button onClick={() => setPanel(!panel)} aria-pressed={panel} title={panel ? 'Hide the people panel' : 'Show the people panel'} className="hidden lg:inline-flex">
              {panel ? <PanelRightClose className="h-4 w-4" aria-hidden /> : <PanelRightOpen className="h-4 w-4" aria-hidden />} People
            </Button>
            <Button variant="ghost" aria-label="Refresh" title="Refresh" onClick={() => { live.refetch(); overview.refetch(); }} className="px-2.5">
              <RefreshCw className={cx('h-4 w-4', live.isFetching && 'animate-spin')} aria-hidden />
            </Button>
          </>
        }
      />
      {conn !== 'live' && <Callout tone="warning" className="mb-4">Real-time connection lost — reconnecting. The map refreshes every 30 s meanwhile.</Callout>}
      <div className={cx('grid items-start gap-5', panel && 'lg:grid-cols-[minmax(0,1fr)_minmax(20rem,27%)]')}>
        <section aria-label="Map" className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-card lg:sticky lg:top-[5.5rem]">
          {wps.error ? (
            <ErrorState error={wps.error} onRetry={() => wps.refetch()} />
          ) : live.isLoading || wps.isLoading ? (
            <div className="h-[calc(100dvh-15rem)] min-h-[380px] animate-pulse bg-gray-100" />
          ) : (
            <WorkforceMap sessions={sessions} workplaces={workplaces} pending={live.isPlaceholderData} selected={selected} onSelect={(id) => { setSelected(id); setPanel(true); }} className="h-[calc(100dvh-15rem)] max-h-[860px] min-h-[380px] w-full" />
          )}
          <div className="border-t border-gray-200 px-4 py-3">
            <MapLegend />
          </div>
        </section>

        <section aria-label={sel ? `${sel.full_name} details` : 'People on shift'} className={cx('rounded-lg border border-gray-200 bg-white shadow-card', !panel && 'lg:hidden')}>
          {sel ? (
            <SessionDetails s={sel} now={now} onBack={() => setSelected(null)} onOpenEmployee={setDrawer} />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2.5">
                <Tabs variant="segmented" label="Panel" value={side} onChange={setSide} tabs={[{ value: 'people', label: 'People', count: open.length }, { value: 'places', label: 'Workplaces', count: workplaces.length }]} />
              </div>
              {side === 'people' ? (
                <QueryState query={live}>
                  {() => <PeopleList grouped sessions={sessions} notIn={showNotIn ? notIn : []} selected={selected} onSelect={(id) => { setSelected(id); setPanel(true); }} onOpenEmployee={setDrawer} now={now} className="max-h-[calc(100dvh-14rem)] min-h-40" />}
                </QueryState>
              ) : (
                <WorkplaceList workplaces={workplaces} roster={overview.data?.roster ?? []} rosterKnown={!!overview.data} open={open} onPick={(id) => { setWorkplaceId(id); setSide('people'); }} />
              )}
            </>
          )}
        </section>
      </div>
      <EmployeeDrawer employeeId={drawer} onClose={() => setDrawer(null)} />
    </>
  );
}
