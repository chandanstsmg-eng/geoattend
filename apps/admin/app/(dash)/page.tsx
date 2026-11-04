'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, ArrowRight, CalendarCheck, CalendarRange, CircleAlert, ClipboardCheck, Clock, Download, Hourglass, Inbox, MapPinOff, RefreshCw, UsersRound, UserX } from 'lucide-react';
import { get, qs } from '@/lib/api';
import { hrsNum, shortDay, ago, fmtClock, fmtDate, fmtDateTime, fmtLongDate, minutes, todayISO } from '@/lib/format';
import { useMe } from '@/lib/me';
import { useIncludeSimulated } from '@/lib/sim-pref';
import { rowKeys, LinkButton, Badge, Button, Card, cx, EmptyState, ErrorState, Menu, Modal, PageHeader, QueryState, SimBadge, Table, Td, Th, rowLink } from '@/components/ui';
import { SeverityBadge } from '@/components/state-badge';
import { DateRangeSelect, defaultRange, SupervisorSelect, useSupervisors, WorkplaceSelect, type DateRangeValue } from '@/components/filters';
import { EmployeeDrawer } from '@/components/employee-drawer';
import { GettingStarted } from '@/components/getting-started';
import { DayClose } from '@/components/day-close';
import { AttendanceBoard, type BoardTab, type RosterRow } from '@/components/attendance-board';
import { absDelta, BarChart, ChartCard, Composition, DataTable, HBarList, Kpi, LineChart, pctDelta, SERIES_COLORS, StatStrip, StatStripSkeleton } from '@/components/charts';
import { WorkforceMap } from '@/components/live-map';
import { useNow } from '@/components/live-panel';
import { RightNow } from '@/components/right-now';

const hrs = (m: number) => `${(m / 60).toFixed(m >= 6000 ? 0 : 1)} h`;
const pct = (r: number | null | undefined) => (r == null ? '—' : `${Math.round(r * 100)}%`);

// Colour follows the measure: attendance / present = brand blue, planned = sky. Workforce states
// use the status palette (green on time, amber late, red absent) and always carry a label.
const RATE = [{ key: 'rate', label: 'Attendance rate', color: SERIES_COLORS[0] }];
const PLAN = [
  { key: 'expected', label: 'Planned (rostered)', color: SERIES_COLORS[2] },
  { key: 'present', label: 'Actual (attended)', color: SERIES_COLORS[0] },
];
const STATE_COLORS = { onTime: '#0d9488', late: '#d97706', notCheckedIn: '#94a3b8', absent: '#dc2626', onLeave: '#5bb0d9' };

const STATUS: Record<string, { tone: 'green' | 'amber' | 'red'; label: string }> = {
  OK: { tone: 'green', label: 'Staffed' },
  ATTENTION: { tone: 'amber', label: 'Absences' },
  SHORT: { tone: 'red', label: 'Short-staffed' },
};

type Severity = 'high' | 'medium';
type Issue = { key: string; title: string; reason: string; icon: typeof Clock; severity: Severity; count: number; items: Array<{ id?: string; text: string; sub?: string; at?: string | null }>; action: { label: string; href: string } };

/**
 * Prioritised operational alerts: each group states why it is raised, its severity, who or which
 * workspace it affects (with a time when known) and the next step. Only issues the server reports.
 */
function AttentionPanel({ a, d, onEmployee, className }: { a: any; d: any; onEmployee: (id: string) => void; className?: string }) {
  const short = (d.byWorkspace as any[]).filter((w) => w.status === 'SHORT');
  const issues = ([
    { key: 'noshow', title: 'No-show', reason: 'Shift started, no check-in and no leave', icon: UserX, severity: 'high', count: a.noShowToday.length, items: a.noShowToday.map((x: any) => ({ id: x.employeeId, text: x.name, sub: `${x.workplace} · shift ${x.start ?? ''}` })), action: { label: 'Review attendance', href: '/attendance' } },
    { key: 'short', title: 'Coverage below requirement', reason: 'Fewer people rostered today than the workspace target', icon: UsersRound, severity: 'high', count: short.length, items: short.map((w) => ({ text: w.name, sub: `short by ${w.shortage}` })), action: { label: 'Open roster', href: '/roster' } },
    { key: 'location', title: 'Location unavailable', reason: 'Checked in, but the phone stopped sending location', icon: MapPinOff, severity: 'high', count: a.locationErrors.length, items: a.locationErrors.map((x: any) => ({ id: x.employeeId, text: x.name, sub: x.state === 'TRACKING_PERMISSION_REQUIRED' ? 'permission needed' : 'updates stopped', at: x.since })), action: { label: 'Open live map', href: '/map' } },
    { key: 'outside', title: 'Outside the geofence', reason: 'Fresh location clearly outside the workspace area', icon: MapPinOff, severity: 'medium', count: d.kpis.outsideGeofence, items: [], action: { label: 'Open live map', href: '/map' } },
    { key: 'late', title: 'Late arrival', reason: 'Checked in after the start time plus grace', icon: AlarmClock, severity: 'medium', count: a.lateToday.length, items: a.lateToday.map((x: any) => ({ id: x.employeeId, text: x.name, sub: `${minutes(x.minutes)} late`, at: x.at })), action: { label: 'View records', href: '/attendance?late=true' } },
    { key: 'checkout', title: 'Missing check-out', reason: 'Shift closed by the system without a check-out', icon: CircleAlert, severity: 'medium', count: a.missingCheckout.length, items: a.missingCheckout.map((x: any) => ({ id: x.employeeId, text: x.name, sub: `${fmtDate(x.date)} · ${x.workplace}` })), action: { label: 'Review attendance', href: '/attendance' } },
    { key: 'review', title: 'Unverified attendance', reason: 'Manual review, dispute or technical-issue requests', icon: Inbox, severity: 'medium', count: a.pendingCorrections, items: [], action: { label: 'Open approvals', href: '/approvals' } },
    { key: 'overtime', title: 'Overtime awaiting approval', reason: 'Finished overtime not yet decided', icon: Hourglass, severity: 'medium', count: a.overtimePending, items: [], action: { label: 'Review overtime', href: '/overtime?tab=pending' } },
  ] as Issue[]).filter((i) => i.count > 0);
  const high = issues.filter((i) => i.severity === 'high').reduce((n, i) => n + i.count, 0);
  const total = issues.reduce((n, i) => n + i.count, 0);
  return (
    <section className={cx('rounded-lg border border-gray-200 bg-white shadow-card', className)} aria-labelledby="attention-title">
      <header className="flex items-center justify-between gap-2 border-b border-gray-200 px-5 py-3">
        <h2 id="attention-title" className="text-title font-semibold text-navy-900">Needs attention</h2>
        {total === 0 ? <Badge tone="green" dot>All clear</Badge> : <span className="flex gap-1.5">{high > 0 && <Badge tone="red" dot>{high} urgent</Badge>}{total - high > 0 && <Badge tone="amber" dot>{total - high} to review</Badge>}</span>}
      </header>
      {issues.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-500">No no-shows, coverage gaps, location problems, late arrivals or pending reviews.</p>
      ) : (
        <ul className="grid gap-px bg-gray-100 md:grid-cols-2 xl:grid-cols-3">
          {issues.map((g) => (
            <li key={g.key} className="flex flex-col bg-white px-5 py-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="flex min-w-0 items-baseline gap-2 text-sm font-semibold text-gray-900">
                  <span className={cx('tabular', g.severity === 'high' ? 'text-red-700' : 'text-amber-700')}>{g.count}</span>
                  {g.title}
                  <span className="sr-only">({g.severity === 'high' ? 'urgent' : 'to review'})</span>
                </h3>
                <Link href={g.action.href} className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-body-sm font-medium text-primary-600 hover:underline">
                  {g.action.label} <ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
              </div>
              {g.items.length === 0 ? (
                <p className="mt-0.5 text-xs text-gray-500">{g.reason}</p>
              ) : (
                <ul className="mt-1.5 space-y-px">
                  {g.items.slice(0, 3).map((it, i) => {
                    const body = (
                      <>
                        <span className="max-w-[55%] shrink-0 truncate font-medium text-gray-800">{it.text}</span>
                        {it.sub && <span className="min-w-0 flex-1 truncate text-xs text-gray-500">{it.sub}</span>}
                        {it.at && <span className="tabular shrink-0 text-xs text-gray-500" title={fmtDateTime(it.at)}>{fmtClock(it.at)}</span>}
                      </>
                    );
                    return (
                      <li key={`${it.id ?? it.text}-${i}`}>
                        {it.id ? (
                          <button type="button" onClick={() => onEmployee(it.id!)} className="-mx-1 flex w-[calc(100%+0.5rem)] items-baseline gap-2 rounded px-1 py-1 text-left text-body-sm hover:bg-gray-50">{body}</button>
                        ) : (
                          <span className="flex items-baseline gap-2 py-1 text-body-sm">{body}</span>
                        )}
                      </li>
                    );
                  })}
                  {g.items.length > 3 && <li className="text-xs text-gray-500">and {g.items.length - 3} more</li>}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


const ACTIVITY_TONE: Record<string, string> = {
  ATTENDANCE_MARKED: 'bg-teal-500',
  SHIFT_COMPLETED: 'bg-gray-400',
  LATE_ARRIVAL: 'bg-amber-500',
  NO_SHOW: 'bg-red-500',
};

function ActivityFeed({ items, onEmployee, className }: { items: any[]; onEmployee: (id: string) => void; className?: string }) {
  return (
    <Card title="Recent activity" padded={false} className={className} actions={<Link className="text-body-sm font-medium text-primary-600 hover:underline" href="/notifications">View all</Link>}>
      {items.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : (
        <ol className="max-h-[400px] divide-y divide-gray-100 overflow-y-auto">
          {items.map((n) => (
            <li key={n.id}>
              <button type="button" disabled={!n.employee_id} onClick={() => n.employee_id && onEmployee(n.employee_id)} className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left text-sm hover:bg-gray-50 disabled:hover:bg-transparent">
                <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', ACTIVITY_TONE[n.type] ?? (n.severity === 'CRITICAL' ? 'bg-red-500' : n.severity === 'WARNING' ? 'bg-amber-500' : 'bg-primary-500'))} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-gray-900">{n.title}</span>
                    {n.severity === 'CRITICAL' && <SeverityBadge severity={n.severity} />}
                    {n.is_simulated && <SimBadge />}
                  </span>
                  <span className="block truncate text-xs text-gray-500">
                    {n.employee_name ?? '—'}
                    {n.workplace_name ? ` · ${n.workplace_name}` : ''}
                  </span>
                </span>
                <span className="shrink-0 whitespace-nowrap text-xs text-gray-500" title={fmtDateTime(n.created_at)}>{ago(n.created_at)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function WorkspaceModal({ w, onClose, onEmployee }: { w: any | null; onClose: () => void; onEmployee: (id: string) => void }) {
  const { isOwner } = useMe();
  return (
    <Modal open={!!w} onOpenChange={(o) => !o && onClose()} title={w?.name ?? ''} description="Verified attendance time in the selected period, by employee">
      {w && (
        <div className="space-y-3">
          {w.employees.length ? (
            <HBarList data={w.employees.map((e: any) => ({ ...e, hours: hrsNum(e.minutes) }))} label="Hours by employee" series={[{ key: 'hours', label: 'Hours', color: SERIES_COLORS[0] }]} format={(v) => `${v} h`} name={(r) => r.name} onSelect={(r) => { onClose(); onEmployee(r.id); }} />
          ) : (
            <p className="text-sm text-gray-500">No attendance in this period.</p>
          )}
          {w.noEvidenceMinutes > 0 && (
            <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">
              {hrs(w.noEvidenceMinutes)} of shift time had no location updates (tracking interrupted or permission off). Attendance time is not proof of continuous presence.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <LinkButton href={`/map?workplaceId=${w.id}`} size="sm">Live map</LinkButton>
            {isOwner && <LinkButton href={`/workplaces/${w.id}`} size="sm">Workspace settings</LinkButton>}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Today's rostered people, each in one state; location problems are a separate, overlapping note. */
function WorkforceToday({ d, onState, className }: { d: any; onState: (key: string) => void; className?: string }) {
  const b = d.todayStatus.breakdown;
  const parts = [
    { key: 'onTime', label: 'Present, on time', value: b.onTime, color: STATE_COLORS.onTime },
    { key: 'late', label: 'Present, late', value: b.late, color: STATE_COLORS.late },
    { key: 'notCheckedIn', label: 'Not checked in yet', value: b.notCheckedIn, color: STATE_COLORS.notCheckedIn, hint: 'shift not over, no attendance yet' },
    { key: 'absent', label: 'Absent', value: b.absent, color: STATE_COLORS.absent, hint: 'no-show, or shift over without attendance' },
    { key: 'onLeave', label: 'On leave / holiday', value: b.onLeave, color: STATE_COLORS.onLeave },
  ];
  const total = parts.reduce((n, p) => n + p.value, 0);
  return (
    <section className={cx('flex flex-col rounded-lg border border-gray-200 bg-white px-4 pb-4 pt-3.5 shadow-card sm:px-5', className)} aria-labelledby="today-title">
      <h2 id="today-title" className="text-title font-semibold text-navy-900">Workforce today</h2>
      <p className="mb-3 text-xs text-gray-500">{total} {total === 1 ? 'person' : 'people'} rostered · {fmtLongDate(d.today)}</p>
      {total === 0 ? (
        <p className="flex flex-1 items-center justify-center py-10 text-sm text-gray-500">Nobody is rostered today</p>
      ) : (
        <Composition label="Rostered people today by state" parts={parts} onSelect={onState} />
      )}
      {d.todayStatus.locationUnavailable > 0 && (
        <Link href="/map" className="mt-3 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-body-sm text-amber-900 hover:bg-amber-100">
          <MapPinOff className="h-4 w-4 shrink-0" aria-hidden />
          <span className="flex-1"><strong className="tabular">{d.todayStatus.locationUnavailable}</strong> checked in without a fresh location — not counted as absent</span>
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      )}
    </section>
  );
}

export default function OverviewPage() {
  const { isOwner } = useMe();
  const [welcome, setWelcome] = useState(false);
  useEffect(() => setWelcome(new URLSearchParams(window.location.search).get('welcome') === '1'), []);
  const [range, setRange] = useState<DateRangeValue>(() => defaultRange('7d'));
  const [workplaceId, setWorkplaceId] = useState('');
  const [supervisorId, setSupervisorId] = useState('');
  const [employee, setEmployee] = useState<string | null>(null);
  const [wsDetail, setWsDetail] = useState<any | null>(null);
  const [tab, setTab] = useState<BoardTab>('all');
  const sim = useIncludeSimulated();

  const filters = { from: range.from, to: range.to, workplaceId, supervisorId: isOwner ? supervisorId : '', compare: 'true', includeSimulated: String(sim.include) };
  const dash = useQuery({ queryKey: ['dashboard', filters], queryFn: () => get(`/analytics/dashboard${qs(filters)}`), refetchInterval: 60_000, placeholderData: (p) => p });
  const live = useQuery({ queryKey: ['live', workplaceId, filters.supervisorId, sim.include], queryFn: () => get(`/tracking/live${qs({ workplaceId, supervisorId: filters.supervisorId, includeSimulated: sim.include })}`), refetchInterval: 30_000 });
  const today = useQuery({ queryKey: ['overview', workplaceId], queryFn: () => get(`/reports/overview${qs({ workplaceId })}`), refetchInterval: 60_000 });
  const sups = useSupervisors(isOwner);
  const supSites: string[] | null = filters.supervisorId ? (sups.data?.find((s) => s.id === filters.supervisorId)?.site_ids ?? []) : null;
  const rows: RosterRow[] = useMemo(() => (today.data?.roster ?? []).filter((r: any) => !supSites || supSites.includes(r.workplace_id)), [today.data, supSites]);

  const d = dash.data;
  const k = d?.kpis;
  const s = d?.summary;
  const p = d?.previous?.expected ? d.previous : null; // no comparison against an empty period
  const sessions = (live.data?.sessions ?? []).filter((x: any) => x.is_open);
  const filtered = !!(workplaceId || filters.supervisorId);
  const now = useNow(30_000);
  // The export covers exactly what the page counts.
  const download = (path: string) => window.location.assign(`/api/v1/reports/${path}${qs({ from: range.from, to: range.to, workplaceId, includeSimulated: String(sim.include) })}`);
  const toBoard = (t: BoardTab) => {
    setTab(t);
    document.getElementById('today-board')?.scrollIntoView({ behavior: 'smooth' });
  };
  // Days with nobody rostered (weekly off, holidays) have no rate: they are left out rather than drawn as 0%.
  const trend = (d?.trend ?? []).map((t: any) => ({ ...t, rate: t.expected ? Math.round((t.present / t.expected) * 100) : 0 }));
  const rateTrend = trend.filter((t: any) => t.expected > 0);
  // Per-day series for the KPI sparklines (days with rostered shifts only, for the rates).
  const sparkRate = trend.filter((t: any) => t.expected > 0).map((t: any) => t.rate);
  const sparkLate = trend.map((t: any) => t.late);
  const sparkAbsent = trend.map((t: any) => t.absent);
  const sparkHours = (d?.hoursByDay ?? []).map((x: any) => (x.worked ?? 0) + (x.overtime ?? 0));
  const shortDays = trend.filter((t: any) => t.present < t.expected && t.date < (d?.today ?? '')).length;
  const prevLabel = d?.previous ? `${fmtDate(d.previous.from)} – ${fmtDate(d.previous.to)}` : '';

  const periodFigures = !k || !s ? (
    <StatStripSkeleton label="This period" count={5} />
  ) : (
    <StatStrip label="This period" count={5}>
      <Kpi label="Attendance rate" value={s.attendanceRate == null ? '—' : Math.round(s.attendanceRate * 100)} unit={s.attendanceRate == null ? undefined : '%'} delta={p && s.attendanceRate != null ? absDelta(s.attendanceRate * 100, p.attendanceRate * 100, 'up', ' pts', `Previous period ${prevLabel}`) : null} sub={`${s.present} of ${s.expected} shifts`} spark={sparkRate} title="Rostered shifts with attendance ÷ rostered shifts (approved leave and holidays excluded), past days and today" href="/reports" />
      <Kpi label="Present today" value={d.todayStatus.breakdown.onTime + d.todayStatus.breakdown.late} sub={`of ${k.scheduledToday} rostered`} onClick={() => toBoard('in')} title="People rostered today with attendance recorded" />
      <Kpi label="Late arrivals" value={s.late} tone={s.late ? 'warn' : undefined} delta={p ? absDelta(s.late, p.late, 'down', '', `Previous period ${prevLabel}`) : null} sub={s.present ? `${Math.round((s.late / s.present) * 100)}% of check-ins` : 'in this period'} spark={sparkLate} href="/attendance?late=true" />
      <Kpi label="Absences" value={s.absent} tone={s.absent ? 'bad' : undefined} delta={p ? absDelta(s.absent, p.absent, 'down', '', `Previous period ${prevLabel}`) : null} sub="rostered shifts missed" spark={sparkAbsent} title="Rostered shifts without attendance (past days; today only no-shows and finished shifts)" onClick={() => toBoard('not-started')} />
      <Kpi label="Hours worked" value={(s.totalMinutes / 60).toFixed(s.totalMinutes >= 6000 ? 0 : 1)} unit="h" delta={p ? pctDelta(s.totalMinutes, p.totalMinutes, 'up', `Previous period ${prevLabel}`) : null} sub={s.overtimeMinutes ? `${(s.overtimeMinutes / 60).toFixed(1)} h overtime` : 'no approved overtime'} spark={sparkHours} href="/reports" title="Net worked time plus approved overtime — the same figures as the CSV export" />
    </StatStrip>
  );

  return (
    <>
      <PageHeader
        title={isOwner ? 'Workforce Overview' : 'Team Overview'}
        description={
          d ? (
            <>
              {fmtLongDate(d.today)}
              {dash.dataUpdatedAt > 0 && <span className="text-gray-500"> · updated {fmtClock(new Date(dash.dataUpdatedAt))}</span>}
            </>
          ) : undefined
        }
        actions={
          <>
            <WorkplaceSelect value={workplaceId} onChange={setWorkplaceId} />
            {isOwner && <SupervisorSelect value={supervisorId} onChange={setSupervisorId} />}
            {filtered && (
              <Button variant="ghost" onClick={() => { setWorkplaceId(''); setSupervisorId(''); }}>
                Reset
              </Button>
            )}
            <Button aria-label="Refresh" title="Refresh" onClick={() => { dash.refetch(); live.refetch(); today.refetch(); }} className="hidden px-2.5 sm:inline-flex">
              <RefreshCw className={cx('h-4 w-4', dash.isFetching && 'animate-spin')} aria-hidden />
            </Button>
          </>
        }
      />
      {isOwner && <GettingStarted welcome={welcome} />}

      {dash.error && !d ? (
        <ErrorState error={dash.error} onRetry={() => dash.refetch()} />
      ) : (
        <>
          {/* 1 · Is the workforce where it should be, this minute? */}
          <RightNow sessions={sessions} rows={rows} now={now} loading={live.isLoading || today.isLoading} error={live.error ?? today.error} onRetry={() => { live.refetch(); today.refetch(); }} onNotArrived={() => toBoard('not-started')} mapHref={`/map${qs({ workplaceId })}`} />

          {/* 2 · What to act on */}
          {d && <AttentionPanel a={d.attention} d={d} onEmployee={setEmployee} className="mt-4" />}

          {!isOwner && (
            <div className="mt-3 flex flex-wrap gap-2">
              <LinkButton href="/roster" size="sm"><CalendarRange className="h-4 w-4" aria-hidden /> Roster</LinkButton>
              <LinkButton href="/attendance" size="sm"><ClipboardCheck className="h-4 w-4" aria-hidden /> Attendance</LinkButton>
              <LinkButton href="/approvals" size="sm"><Inbox className="h-4 w-4" aria-hidden /> Approvals</LinkButton>
            </div>
          )}

          {/* 3 · Where people are, and what just happened. The map stays a strip until a few people are out. */}
          <div className="mt-4 grid items-stretch gap-4 xl:grid-cols-3">
            <section aria-label="Live map preview" className="flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-card xl:col-span-2">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-5 py-3">
                <div className="min-w-0">
                  <h2 className="text-title font-semibold text-navy-900">{isOwner ? 'Live map' : 'Live team map'}</h2>
                  <p className="tabular text-xs text-gray-500">{sessions.length} on shift · select a person for details</p>
                </div>
                <Link href={`/map${qs({ workplaceId })}`} className="inline-flex items-center gap-1 text-body-sm font-medium text-primary-600 hover:underline">
                  Open live map <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </header>
              {d ? (
                <WorkforceMap sessions={sessions} workplaces={d.byWorkspace} selected={null} onSelect={(id) => { const x = sessions.find((y: any) => y.id === id); if (x) setEmployee(x.employee_id); }} search={false} className={sessions.length < 5 ? 'h-[240px]' : 'h-[340px] lg:h-[400px]'} />
              ) : (
                <div className="h-[340px] animate-pulse bg-gray-100" />
              )}
            </section>
            {d && <ActivityFeed items={d.activity} onEmployee={setEmployee} className="max-h-[480px]" />}
          </div>

          {/* 4 · How the period is going */}
          <div className="mb-2.5 mt-7 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-title font-semibold text-navy-900">This period</h2>
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
              <DateRangeSelect value={range} onChange={setRange} />
              <Menu
                label="Export report"
                triggerClassName="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-3.5 text-sm font-medium text-gray-800 shadow-xs hover:border-gray-400 hover:bg-gray-50 sm:h-9.5"
                trigger={<><Download className="h-4 w-4" aria-hidden /> Export</>}
                items={[
                  { heading: `${fmtDate(range.from)} – ${fmtDate(range.to)}${workplaceId ? ' · selected workspace' : ''}` },
                  { label: 'Hours summary (CSV)', icon: <Download />, onSelect: () => download('hours.csv') },
                  { label: 'Overtime (CSV)', icon: <Download />, onSelect: () => download('overtime.csv') },
                  'separator',
                  { label: 'Open reports', icon: <ArrowRight />, href: '/reports' },
                ]}
              />
            </div>
          </div>
          {periodFigures}
          {d && !p && d.previous && <p className="mt-2 text-xs text-gray-500">No comparison shown: there were no rostered shifts in the previous period ({prevLabel}).</p>}

          {d && (
            <>
              <div className="mt-4 grid items-stretch gap-4 xl:grid-cols-3">
                <WorkforceToday d={d} onState={(key) => toBoard(key === 'onTime' || key === 'late' ? 'in' : key === 'onLeave' ? 'leave' : 'not-started')} />
                {isOwner && (
                  <ChartCard
                    className="xl:col-span-2"
                    title="Attendance rate"
                    subtitle={`Attended ÷ rostered shifts per day (leave and holidays excluded) · period average ${pct(s?.attendanceRate)}`}
                    empty={!trend.some((t: any) => t.expected)}
                    table={<DataTable data={trend} x="date" series={[{ key: 'rate', label: 'Rate %', color: '' }, { key: 'expected', label: 'Rostered', color: '' }, { key: 'present', label: 'Attended', color: '' }, { key: 'late', label: 'Late', color: '' }, { key: 'absent', label: 'Absent', color: '' }]} xTitle={fmtDate} />}
                  >
                    <LineChart label="Attendance rate per day" data={rateTrend} x="date" series={RATE} xLabel={shortDay} xTitle={fmtDate} format={(v) => `${v}%`} height={230} />
                  </ChartCard>
                )}
              </div>
              {isOwner && (
                <ChartCard
                  className="mt-4"
                  title="Planned vs actual staffing"
                  subtitle={shortDays ? `${shortDays} past day${shortDays === 1 ? '' : 's'} below plan in this period` : 'Rostered shifts against shifts attended, per day'}
                  series={PLAN}
                  empty={!trend.some((t: any) => t.expected)}
                  table={<DataTable data={trend} x="date" series={[...PLAN, { key: 'absent', label: 'Gap (absent)', color: '' }]} xTitle={fmtDate} />}
                >
                  <BarChart label="Planned and actual staffing per day" data={trend} x="date" series={PLAN} xLabel={shortDay} xTitle={fmtDate} height={200} />
                </ChartCard>
              )}

              {/* 5 · Location-wise staffing (supervisors; owners have the Workspaces page) */}
              {!isOwner && (
              <Card title="Location-wise staffing" description="Today’s staffing and the period’s attendance and hours · click a row for hours by employee" padded={false} className="mt-4">
                {d.byWorkspace.length === 0 ? (
                  <EmptyState title="No active workspaces">Ask the owner to add one.</EmptyState>
                ) : (
                  <Table minWidth={920}>
                    <thead>
                      <tr>
                        <Th>Workspace</Th>
                        <Th className="text-right">Rostered today</Th>
                        <Th className="text-right">Checked in</Th>
                        <Th className="text-right">Absent today</Th>
                        <Th className="text-right">Attendance rate</Th>
                        <Th className="text-right">Late</Th>
                        <Th className="text-right">Hours</Th>
                        <Th className="text-right">Overtime</Th>
                        <Th className="text-right" label="No location evidence">No GPS evidence</Th>
                        <Th>Staffing</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.byWorkspace.map((w: any) => (
                        <tr key={w.id} tabIndex={0} className={rowLink} onClick={() => setWsDetail(w)} onKeyDown={rowKeys(() => setWsDetail(w))}>
                          <Td className="font-medium text-gray-900">{w.name}<span className="block text-xs font-normal text-gray-500">{w.homeWorkers} home worker{w.homeWorkers === 1 ? '' : 's'}</span></Td>
                          <Td className="text-right tabular">{w.assignedToday}{w.minStaff != null && <span className="text-gray-400"> / {w.minStaff}</span>}</Td>
                          <Td className="text-right tabular">{w.presentNow}</Td>
                          <Td className={cx('text-right tabular', w.absentToday > 0 && 'font-semibold text-red-700')}>{w.absentToday}</Td>
                          <Td className="text-right tabular">{pct(w.completionRate)}<span className="block text-xs text-gray-400">{w.present}/{w.expected}</span></Td>
                          <Td className="text-right tabular">{w.late || '—'}</Td>
                          <Td className="text-right tabular">{hrs(w.totalMinutes)}</Td>
                          <Td className="text-right tabular">{w.overtimeMinutes ? hrs(w.overtimeMinutes) : '—'}</Td>
                          <Td className="text-right tabular text-gray-600">{w.noEvidenceMinutes ? hrs(w.noEvidenceMinutes) : '—'}</Td>
                          <Td>
                            <Badge dot tone={STATUS[w.status]!.tone}>{w.status === 'SHORT' ? `Short by ${w.shortage}` : STATUS[w.status]!.label}</Badge>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
              )}

            </>
          )}

          {/* 6 · Today's board (+ daily close for owners) */}
          <div className={cx('mt-4 grid items-start gap-4', isOwner && 'xl:grid-cols-[minmax(0,1fr)_22rem]')}>
            <div id="today-board" className="scroll-mt-24">
              <QueryState query={today}>
                {() => (rows.length === 0 ? (
                  <Card title="Today’s attendance"><EmptyState title="Nobody is rostered today" icon={<CalendarCheck aria-hidden />} action={<LinkButton href="/roster">Open roster</LinkButton>} /></Card>
                ) : (
                  <AttendanceBoard rows={rows} tab={tab} onTab={setTab} onEmployee={setEmployee} showWorkplace={!workplaceId} />
                ))}
              </QueryState>
            </div>
            {isOwner && today.data?.date && today.data.date <= todayISO() && <DayClose date={today.data.date} onEmployee={setEmployee} />}
          </div>
        </>
      )}
      <WorkspaceModal w={wsDetail} onClose={() => setWsDetail(null)} onEmployee={setEmployee} />
      <EmployeeDrawer employeeId={employee} onClose={() => setEmployee(null)} />
    </>
  );
}
