'use client';
/**
 * What the owner and supervisor overviews share: the attention panel, activity, today's split, the
 * per-location table and the data behind them. Every figure comes from the API as it stands, so a
 * page can only differ from the reports by what it chooses to show, never by how it counts.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, ArrowRight, CalendarCheck, CircleAlert, Clock, Download, Hourglass, Inbox, MapPinOff, RefreshCw, UsersRound, UserX } from 'lucide-react';
import { get, qs } from '@/lib/api';
import { ago, fmtClock, fmtDate, fmtDateTime, fmtLongDate, hrsNum, minutes, shortDay, todayISO } from '@/lib/format';
import { useMe } from '@/lib/me';
import { useIncludeSimulated } from '@/lib/sim-pref';
import { Badge, Button, Card, cx, EmptyState, LinkButton, Menu, Modal, QueryState, rowKeys, rowLink, SimBadge, SortTh, Table, Td, Th, type SortDir } from '@/components/ui';
import { SeverityBadge } from '@/components/state-badge';
import { AttendanceBoard, type BoardTab, type RosterRow } from '@/components/attendance-board';
import { BarChart, ChartCard, Composition, DataTable, HBarList, LineChart, Meter, SERIES_COLORS } from '@/components/charts';
import { DayClose } from '@/components/day-close';
import { useNow } from '@/components/live-panel';
import type { DateRangeValue } from '@/components/filters';

export const hrs = (m: number) => `${(m / 60).toFixed(m >= 6000 ? 0 : 1)} h`;
export const pct = (r: number | null | undefined) => (r == null ? '—' : `${Math.round(r * 100)}%`);

// Colour follows the measure: attendance / present = brand blue, planned = sky. Workforce states
// use the status palette (green on time, amber late, red absent) and always carry a label.
const RATE = [{ key: 'rate', label: 'Attendance rate', color: SERIES_COLORS[0] }];
const PLAN = [
  { key: 'expected', label: 'Planned (rostered)', color: SERIES_COLORS[2] },
  { key: 'present', label: 'Actual (attended)', color: SERIES_COLORS[0] },
];
const HOURS = [
  { key: 'worked', label: 'Hours worked', color: SERIES_COLORS[0] },
  { key: 'overtime', label: 'Approved overtime', color: SERIES_COLORS[1] },
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
 * workplace it affects (with a time when known) and the next step. Only issues the server reports.
 */
export function AttentionPanel({ a, d, onEmployee, className }: { a: any; d: any; onEmployee: (id: string) => void; className?: string }) {
  const short = (d.byWorkspace as any[]).filter((w) => w.status === 'SHORT');
  const issues = ([
    { key: 'noshow', title: 'No-show', reason: 'Shift started, no check-in and no leave', icon: UserX, severity: 'high', count: a.noShowToday.length, items: a.noShowToday.map((x: any) => ({ id: x.employeeId, text: x.name, sub: `${x.workplace} · shift ${x.start ?? ''}` })), action: { label: 'Review attendance', href: '/attendance' } },
    { key: 'short', title: 'Coverage below requirement', reason: 'Fewer people rostered today than the workplace target', icon: UsersRound, severity: 'high', count: short.length, items: short.map((w) => ({ text: w.name, sub: `short by ${w.shortage}` })), action: { label: 'Open roster', href: '/roster' } },
    { key: 'location', title: 'Location unavailable', reason: 'Checked in, but the phone stopped sending location', icon: MapPinOff, severity: 'high', count: a.locationErrors.length, items: a.locationErrors.map((x: any) => ({ id: x.employeeId, text: x.name, sub: x.state === 'TRACKING_PERMISSION_REQUIRED' ? 'permission needed' : 'updates stopped', at: x.since })), action: { label: 'Open live map', href: '/map' } },
    { key: 'outside', title: 'Outside the geofence', reason: 'Fresh location clearly outside the workplace area', icon: MapPinOff, severity: 'medium', count: d.kpis.outsideGeofence, items: [], action: { label: 'Open live map', href: '/map' } },
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

export function ActivityFeed({ items, onEmployee, className }: { items: any[]; onEmployee: (id: string) => void; className?: string }) {
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

export function WorkplaceModal({ w, onClose, onEmployee }: { w: any | null; onClose: () => void; onEmployee: (id: string) => void }) {
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
            {isOwner && <LinkButton href={`/workplaces/${w.id}`} size="sm">Workplace settings</LinkButton>}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Today's rostered people, each in one state; location problems are a separate, overlapping note. */
export function WorkforceToday({ d, onState, className }: { d: any; onState: (key: string) => void; className?: string }) {
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

/** The queries behind an overview, narrowed together so every section answers the same question. */
export function useOverview({ range, workplaceId, supervisorId = '', employeeId = '' }: { range: DateRangeValue; workplaceId: string; supervisorId?: string; employeeId?: string }) {
  const sim = useIncludeSimulated();
  const filters = { from: range.from, to: range.to, workplaceId, supervisorId, employeeId, compare: 'true', includeSimulated: String(sim.include) };
  const dash = useQuery({ queryKey: ['dashboard', filters], queryFn: () => get(`/analytics/dashboard${qs(filters)}`), refetchInterval: 60_000, placeholderData: (p) => p });
  const live = useQuery({ queryKey: ['live', workplaceId, supervisorId, sim.include], queryFn: () => get(`/tracking/live${qs({ workplaceId, supervisorId, includeSimulated: sim.include })}`), refetchInterval: 30_000 });
  const today = useQuery({ queryKey: ['overview', workplaceId], queryFn: () => get(`/reports/overview${qs({ workplaceId })}`), refetchInterval: 60_000 });
  const approvals = useQuery({ queryKey: ['approvals', 'count'], queryFn: () => get<{ total: number }>('/approvals/count'), refetchInterval: 60_000 });
  const sessions = useMemo(() => (live.data?.sessions ?? []).filter((x: any) => x.is_open && (!employeeId || x.employee_id === employeeId)), [live.data, employeeId]);
  const now = useNow(30_000);
  const d = dash.data;
  const previous = d?.previous?.expected ? d.previous : null; // no comparison against an empty period
  // Days with nobody rostered (weekly off, holidays) have no rate: they are left out rather than drawn as 0%.
  const trend = useMemo(() => (d?.trend ?? []).map((t: any) => ({ ...t, rate: t.expected ? Math.round((t.present / t.expected) * 100) : 0 })), [d]);
  const download = (path: string) => window.location.assign(`/api/v1/reports/${path}${qs({ from: range.from, to: range.to, workplaceId, includeSimulated: String(sim.include) })}`);
  const refresh = () => { dash.refetch(); live.refetch(); today.refetch(); approvals.refetch(); };
  return { dash, live, today, d, sessions, now, previous, trend, download, refresh, waiting: approvals.data?.total ?? 0, prevLabel: d?.previous ? `${fmtDate(d.previous.from)} – ${fmtDate(d.previous.to)}` : '' };
}

/** Same export for both roles; the API decides what each may download. */
export function ExportMenu({ range, workplaceId, download }: { range: DateRangeValue; workplaceId: string; download: (path: string) => void }) {
  return (
    <Menu
      label="Export report"
      triggerClassName="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-3.5 text-sm font-medium text-gray-800 shadow-xs hover:border-gray-400 hover:bg-gray-50 sm:h-9.5"
      trigger={<><Download className="h-4 w-4" aria-hidden /> Export</>}
      items={[
        { heading: `${fmtDate(range.from)} – ${fmtDate(range.to)}${workplaceId ? ' · selected workplace' : ''}` },
        { label: 'Hours summary (CSV)', icon: <Download />, onSelect: () => download('hours.csv') },
        { label: 'Overtime (CSV)', icon: <Download />, onSelect: () => download('overtime.csv') },
        'separator',
        { label: 'Open reports', icon: <ArrowRight />, href: '/reports' },
      ]}
    />
  );
}

export function RefreshButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <span className="hidden sm:inline-flex">
      <Button aria-label="Refresh" title="Refresh" onClick={onClick} className="px-2.5">
        <RefreshCw className={cx('h-4 w-4', busy && 'animate-spin')} aria-hidden />
      </Button>
    </span>
  );
}

export function AttendanceTrend({ d, trend, className }: { d: any; trend: any[]; className?: string }) {
  return (
    <ChartCard
      className={className}
      title="Attendance rate"
      subtitle={`Attended ÷ rostered shifts per day (leave and holidays excluded) · period average ${pct(d.summary?.attendanceRate)}`}
      empty={!trend.some((t) => t.expected)}
      table={<DataTable data={trend} x="date" series={[{ key: 'rate', label: 'Rate %', color: '' }, { key: 'expected', label: 'Rostered', color: '' }, { key: 'present', label: 'Attended', color: '' }, { key: 'late', label: 'Late', color: '' }, { key: 'absent', label: 'Absent', color: '' }]} xTitle={fmtDate} />}
    >
      <LineChart label="Attendance rate per day" data={trend.filter((t) => t.expected > 0)} x="date" series={RATE} xLabel={shortDay} xTitle={fmtDate} format={(v) => `${v}%`} height={230} />
    </ChartCard>
  );
}

export function StaffingChart({ d, trend, className }: { d: any; trend: any[]; className?: string }) {
  const shortDays = trend.filter((t) => t.present < t.expected && t.date < (d.today ?? '')).length;
  return (
    <ChartCard
      className={className}
      title="Planned vs actual staffing"
      subtitle={shortDays ? `${shortDays} past day${shortDays === 1 ? '' : 's'} below plan in this period` : 'Rostered shifts against shifts attended, per day'}
      series={PLAN}
      empty={!trend.some((t) => t.expected)}
      table={<DataTable data={trend} x="date" series={[...PLAN, { key: 'absent', label: 'Gap (absent)', color: '' }]} xTitle={fmtDate} />}
    >
      <BarChart label="Planned and actual staffing per day" data={trend} x="date" series={PLAN} xLabel={shortDay} xTitle={fmtDate} height={200} />
    </ChartCard>
  );
}

export function HoursChart({ d, className }: { d: any; className?: string }) {
  const rows = (d.hoursByDay ?? []).map((x: any) => ({ date: x.date, worked: hrsNum(x.worked), overtime: hrsNum(x.overtime) }));
  return (
    <ChartCard
      className={className}
      title="Hours per day"
      subtitle={`${hrs(d.summary?.totalMinutes ?? 0)} worked, of which ${hrs(d.summary?.overtimeMinutes ?? 0)} approved overtime`}
      series={HOURS}
      empty={!rows.some((r: any) => r.worked || r.overtime)}
      table={<DataTable data={rows} x="date" series={HOURS} xTitle={fmtDate} />}
    >
      <BarChart label="Hours worked and approved overtime per day" data={rows} x="date" series={HOURS} xLabel={shortDay} xTitle={fmtDate} format={(v) => `${v} h`} height={200} />
    </ChartCard>
  );
}

const HOME = [{ key: 'homeWorkers', label: 'Employees based here', color: SERIES_COLORS[0] }];

/** Where people are based. The live picture is on the map; this is the structure of the workforce. */
export function EmployeesByLocation({ d, onOpen, className }: { d: any; onOpen: (w: any) => void; className?: string }) {
  const rows = [...d.byWorkspace].sort((a: any, b: any) => b.homeWorkers - a.homeWorkers);
  return (
    <ChartCard title="Employees by location" subtitle={`${d.kpis.totalWorkers} active employees across ${rows.length} workplace${rows.length === 1 ? '' : 's'}`} empty={!rows.length} className={className}>
      <HBarList data={rows} label="Employees based at each workplace" series={HOME} format={(v) => String(v)} name={(r) => r.name} onSelect={onOpen} max={8} />
    </ChartCard>
  );
}

const worstFirst = (a: any, b: any) => b.shortage - a.shortage || b.absentToday - a.absentToday || (a.completionRate ?? 2) - (b.completionRate ?? 2);

/** Each workplace on one line: today's staffing against the period's attendance, worst first. */
export function LocationTable({ d, onOpen }: { d: any; onOpen: (w: any) => void }) {
  const rows = [...d.byWorkspace].sort(worstFirst);
  return (
    <Card title="Location performance" description="Today’s staffing and this period’s attendance and hours · the workplaces needing most attention come first" padded={false}>
      {rows.length === 0 ? (
        <EmptyState title="No active workplaces" />
      ) : (
        <Table minWidth={820}>
          <thead>
            <tr>
              <Th>Workplace</Th>
              <Th className="w-44">Checked in today</Th>
              <Th className="w-44">Attendance rate</Th>
              <Th className="text-right">Late</Th>
              <Th className="text-right">Hours</Th>
              <Th className="text-right">Overtime</Th>
              <Th>Staffing</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w: any) => (
              <tr key={w.id} tabIndex={0} className={rowLink} onClick={() => onOpen(w)} onKeyDown={rowKeys(() => onOpen(w))} aria-label={`${w.name}, open hours by employee`}>
                <Td className="font-medium text-gray-900">{w.name}<span className="block text-xs font-normal text-gray-500">{w.homeWorkers} based here</span></Td>
                <Td><span className="tabular">{w.presentNow} of {w.assignedToday}</span>{w.minStaff != null && <span className="tabular text-xs text-gray-500"> · needs {w.minStaff}</span>}<Meter value={w.presentNow} max={Math.max(1, w.assignedToday)} /></Td>
                <Td><span className="tabular">{pct(w.completionRate)}</span> <span className="tabular text-xs text-gray-500">{w.present}/{w.expected}</span><Meter value={w.completionRate ?? 0} tone={w.completionRate != null && w.completionRate < 0.8 ? 'warn' : 'navy'} /></Td>
                <Td className="text-right tabular">{w.late || '—'}</Td>
                <Td className="text-right tabular">{hrs(w.totalMinutes)}</Td>
                <Td className="text-right tabular">{w.overtimeMinutes ? hrs(w.overtimeMinutes) : '—'}</Td>
                <Td><Badge dot tone={STATUS[w.status]!.tone}>{w.status === 'SHORT' ? `Short by ${w.shortage}` : STATUS[w.status]!.label}</Badge></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

type SupKey = 'name' | 'workers' | 'checkedIn' | 'rate' | 'hours' | 'overtime';
const supValue: Record<SupKey, (s: any) => number | string> = { name: (s) => s.name.toLowerCase(), workers: (s) => s.workers, checkedIn: (s) => s.checkedIn, rate: (s) => s.completionRate ?? -1, hours: (s) => s.totalMinutes, overtime: (s) => s.overtimeMinutes };

/**
 * How each supervisor's workplaces did in the period. A workplace shared by two supervisors counts
 * for both, so the rows do not add up to the company total.
 */
export function SupervisorTable({ rows, onPick }: { rows: any[]; onPick: (id: string) => void }) {
  const [sort, setSort] = useState<{ key: SupKey; dir: SortDir }>({ key: 'rate', dir: 'asc' });
  const sorted = [...rows].sort((a, b) => {
    const [x, y] = [supValue[sort.key](a), supValue[sort.key](b)];
    return (x < y ? -1 : x > y ? 1 : 0) * (sort.dir === 'asc' ? 1 : -1);
  });
  return (
    <Card title="Supervisor performance" description="Attendance and hours at each supervisor’s workplaces in this period · select a row to filter the page" padded={false}>
      {rows.length === 0 ? (
        <EmptyState title="No supervisors yet" action={<LinkButton href="/team">Add a supervisor</LinkButton>} />
      ) : (
        <Table minWidth={760}>
          <thead>
            <tr>
              <SortTh k="name" sort={sort} onSort={setSort}>Supervisor</SortTh>
              <SortTh k="workers" sort={sort} onSort={setSort} className="text-right">Employees</SortTh>
              <SortTh k="checkedIn" sort={sort} onSort={setSort} className="text-right">Working now</SortTh>
              <SortTh k="rate" sort={sort} onSort={setSort} className="w-48">Attendance rate</SortTh>
              <SortTh k="hours" sort={sort} onSort={setSort} className="text-right">Hours</SortTh>
              <SortTh k="overtime" sort={sort} onSort={setSort} className="text-right">Overtime</SortTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.id} tabIndex={0} className={rowLink} onClick={() => onPick(s.id)} onKeyDown={rowKeys(() => onPick(s.id))} aria-label={`${s.name}, filter the page to this supervisor`}>
                <Td className="font-medium text-gray-900">{s.name}<span className="block text-xs font-normal text-gray-500">{s.workspaces} workplace{s.workspaces === 1 ? '' : 's'}</span></Td>
                <Td className="text-right tabular">{s.workers}</Td>
                <Td className="text-right tabular">{s.checkedIn}</Td>
                <Td><span className="tabular">{pct(s.completionRate)}</span><Meter value={s.completionRate ?? 0} tone={s.completionRate != null && s.completionRate < 0.8 ? 'warn' : 'navy'} /></Td>
                <Td className="text-right tabular">{hrs(s.totalMinutes)}</Td>
                <Td className="text-right tabular">{s.overtimeMinutes ? hrs(s.overtimeMinutes) : '—'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** Today's people, one row per shift. Beside it, owners close the day. */
export function TodayBoard({ today, rows, tab, onTab, onEmployee, workplaceId, owner }: { today: any; rows: RosterRow[]; tab: BoardTab; onTab: (t: BoardTab) => void; onEmployee: (id: string) => void; workplaceId: string; owner: boolean }) {
  return (
    <div className={cx('grid items-start gap-4', owner && 'xl:grid-cols-[minmax(0,1fr)_22rem]')}>
      <div id="today-board" className="scroll-mt-24">
        <QueryState query={today}>
          {() => (rows.length === 0 ? (
            <Card title="Today’s attendance"><EmptyState title="Nobody is rostered today" icon={<CalendarCheck aria-hidden />} action={<LinkButton href="/roster">Open roster</LinkButton>} /></Card>
          ) : (
            <AttendanceBoard rows={rows} tab={tab} onTab={onTab} onEmployee={onEmployee} showWorkplace={!workplaceId} pageSize={10} />
          ))}
        </QueryState>
      </div>
      {owner && today.data?.date && today.data.date <= todayISO() && <DayClose date={today.data.date} onEmployee={onEmployee} />}
    </div>
  );
}
