'use client';
/**
 * The supervisor's overview: their people and their workplaces, nothing else. Every figure is scoped
 * by the API to the sites they supervise, so this page cannot show anyone else's employees whatever
 * is selected. Filtering by employee, workplace and date narrows every section together.
 */
import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowRight, CalendarRange, ClipboardCheck, Inbox } from 'lucide-react';
import { qs } from '@/lib/api';
import { fmtClock, fmtLongDate, hrsNum } from '@/lib/format';
import { Button, ErrorState, LinkButton, PageHeader, SectionHeading, WhenVisible } from '@/components/ui';
import { DateRangeSelect, defaultRange, EmployeeSelect, WorkplaceSelect, type DateRangeValue } from '@/components/filters';
import { EmployeeDrawer } from '@/components/employee-drawer';
import type { BoardTab, RosterRow } from '@/components/attendance-board';
import { ChartCard, HBarList, Kpi, pctDelta, SERIES_COLORS, StatStrip, StatStripSkeleton } from '@/components/charts';
import { RightNow } from '@/components/right-now';
import { ActivityFeed, AttendanceTrend, AttentionPanel, EmployeesByLocation, ExportMenu, LocationTable, RefreshButton, TodayBoard, useOverview, WorkforceToday, WorkplaceModal } from './shared';

// The map and Google's script load only when this section is about to be seen.
const WorkforceMap = dynamic(() => import('@/components/live-map').then((m) => m.WorkforceMap), { ssr: false, loading: () => <div className="h-[240px] animate-pulse bg-gray-100" /> });

const HOURS = [{ key: 'hours', label: 'Hours', color: SERIES_COLORS[0] }];

export function SupervisorOverview() {
  const [range, setRange] = useState<DateRangeValue>(() => defaultRange('7d'));
  const [workplaceId, setWorkplaceId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [employee, setEmployee] = useState<string | null>(null);
  const [place, setPlace] = useState<any | null>(null);
  const [tab, setTab] = useState<BoardTab>('all');

  const o = useOverview({ range, workplaceId, employeeId });
  const { d, previous: p, trend, prevLabel, sessions } = o;
  const rows: RosterRow[] = useMemo(() => (o.today.data?.roster ?? []).filter((r: any) => !employeeId || r.employee_id === employeeId), [o.today.data, employeeId]);

  const k = d?.kpis;
  const s = d?.summary;
  const b = d?.todayStatus?.breakdown;
  const filtered = !!(workplaceId || employeeId);
  const exceptions = d ? d.attention.noShowToday.length + d.attention.lateToday.length + d.attention.locationErrors.length + d.attention.missingCheckout.length : 0;
  const toBoard = (t: BoardTab) => {
    setTab(t);
    document.getElementById('today-board')?.scrollIntoView({ behavior: 'smooth' });
  };
  const places = (d?.byWorkspace ?? []).filter((w: any) => w.totalMinutes > 0).map((w: any) => ({ ...w, hours: hrsNum(w.totalMinutes) })).sort((x: any, y: any) => y.hours - x.hours);
  const people = (d?.hoursByEmployee ?? []).map((e: any) => ({ ...e, hours: hrsNum(e.totalMinutes) }));

  return (
    <>
      <PageHeader
        title="Team Overview"
        description={d ? <>{fmtLongDate(d.today)}{o.dash.dataUpdatedAt > 0 && <span> · updated {fmtClock(new Date(o.dash.dataUpdatedAt))}</span>}</> : undefined}
        actions={
          <>
            <WorkplaceSelect value={workplaceId} onChange={setWorkplaceId} />
            <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
            <DateRangeSelect value={range} onChange={setRange} />
            {filtered && <Button variant="ghost" onClick={() => { setWorkplaceId(''); setEmployeeId(''); }}>Reset</Button>}
            <RefreshButton busy={o.dash.isFetching} onClick={o.refresh} />
          </>
        }
      />

      {o.dash.error && !d ? (
        <ErrorState error={o.dash.error} onRetry={() => o.dash.refetch()} />
      ) : (
        <>
          <RightNow sessions={sessions} rows={rows} now={o.now} loading={o.live.isLoading || o.today.isLoading} error={o.live.error ?? o.today.error} onRetry={o.refresh} onNotArrived={() => toBoard('not-started')} workplaceId={workplaceId} />
          {d && <AttentionPanel a={d.attention} d={d} onEmployee={setEmployee} className="mt-4" />}

          <div className="mt-3 flex flex-wrap gap-2">
            <LinkButton href="/attendance" size="sm"><ClipboardCheck className="h-4 w-4" aria-hidden /> Attendance</LinkButton>
            <LinkButton href="/approvals" size="sm"><Inbox className="h-4 w-4" aria-hidden /> Approvals</LinkButton>
            <LinkButton href="/roster" size="sm"><CalendarRange className="h-4 w-4" aria-hidden /> Roster</LinkButton>
          </div>

          <SectionHeading title="Your team" description="Only the employees and workplaces assigned to you" />
          {!k || !s || !b ? (
            <StatStripSkeleton label="Your team" count={6} />
          ) : (
            <StatStrip label="Your team" count={6}>
              <Kpi label="Assigned employees" value={k.totalWorkers} sub={`at ${k.activeWorkspaces} workplace${k.activeWorkspaces === 1 ? '' : 's'}`} href="/employees" />
              <Kpi label="Active now" value={k.checkedIn} sub={`${k.liveLocated} with a fresh location`} href={`/map${qs({ workplaceId })}`} title="Open shifts with attendance recorded" />
              <Kpi label="Today’s attendance" value={b.onTime + b.late} sub={`of ${k.scheduledToday} rostered`} onClick={() => toBoard('in')} />
              <Kpi label="Pending approvals" value={o.waiting} tone={o.waiting ? 'warn' : undefined} sub={s.pending ? `${s.pending} records not counted yet` : 'waiting for you'} href="/approvals" />
              <Kpi label="Hours worked" value={(s.totalMinutes / 60).toFixed(s.totalMinutes >= 6000 ? 0 : 1)} unit="h" delta={p ? pctDelta(s.totalMinutes, p.totalMinutes, 'up', `Previous period ${prevLabel}`) : null} sub={s.overtimeMinutes ? `${(s.overtimeMinutes / 60).toFixed(1)} h overtime` : 'in this period'} href="/reports" />
              <Kpi label="Exceptions" value={exceptions} tone={exceptions ? 'warn' : undefined} sub="late, no-show, no location, no check-out" href="/attendance" />
            </StatStrip>
          )}

          {d && (
            <>
              <div className="mt-4 grid items-stretch gap-4 xl:grid-cols-3">
                <WorkforceToday d={d} onState={(key) => toBoard(key === 'onTime' || key === 'late' ? 'in' : key === 'onLeave' ? 'leave' : 'not-started')} />
                <AttendanceTrend d={d} trend={trend} className="xl:col-span-2" />
              </div>

              <SectionHeading title="Locations" description="Today’s staffing and this period’s performance at your workplaces" />
              <LocationTable d={d} onOpen={setPlace} />

              <SectionHeading title="Working hours" description="Verified attendance time in this period" />
              <div className="grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
                <ChartCard title="Hours by employee" subtitle="Highest first" empty={!people.length}>
                  <HBarList data={people} label="Hours by employee" series={HOURS} format={(v) => `${v} h`} name={(r) => r.name} onSelect={(r) => setEmployee(r.employeeId)} max={10} />
                </ChartCard>
                <ChartCard title="Time at each workplace" subtitle="Includes approved overtime" empty={!places.length}>
                  <HBarList data={places} label="Hours at each workplace" series={HOURS} format={(v) => `${v} h`} name={(r) => r.name} onSelect={setPlace} max={10} />
                </ChartCard>
                <EmployeesByLocation d={d} onOpen={setPlace} />
              </div>
            </>
          )}

          <SectionHeading title="Live activity" />
          <div className="grid items-stretch gap-4 xl:grid-cols-3">
            <section aria-label="Live map preview" className="flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-card xl:col-span-2">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-5 py-3">
                <div className="min-w-0">
                  <h3 className="text-title font-semibold text-navy-900">Live team map</h3>
                  <p className="tabular text-xs text-gray-500">{sessions.length} on shift · select a person for details</p>
                </div>
                <Link href={`/map${qs({ workplaceId })}`} className="inline-flex items-center gap-1 text-body-sm font-medium text-primary-600 hover:underline">
                  Open live map <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </header>
              {d ? (
                <WhenVisible className="min-h-[240px]">
                <WorkforceMap sessions={sessions} workplaces={d.byWorkspace} selected={null} onSelect={(id) => { const x = sessions.find((y: any) => y.id === id); if (x) setEmployee(x.employee_id); }} search={false} className={sessions.length < 5 ? 'h-[240px]' : 'h-[340px] lg:h-[400px]'} />
                </WhenVisible>
              ) : (
                <div className="h-[340px] animate-pulse bg-gray-100" />
              )}
            </section>
            {d && <ActivityFeed items={d.activity} onEmployee={setEmployee} className="max-h-[480px]" />}
          </div>

          <SectionHeading title="Today’s people" />
          <TodayBoard today={o.today} rows={rows} tab={tab} onTab={setTab} onEmployee={setEmployee} workplaceId={workplaceId} owner={false} />
        </>
      )}
      <WorkplaceModal w={place} onClose={() => setPlace(null)} onEmployee={setEmployee} />
      <EmployeeDrawer employeeId={employee} onClose={() => setEmployee(null)} />
    </>
  );
}
