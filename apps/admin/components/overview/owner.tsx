'use client';
/**
 * The owner's overview, in the order the day is run: is everyone where they should be, what needs
 * action, what the company looks like, how the period is going, and which locations and supervisors
 * to look at. The table of today's people comes last, because it is what you scroll to, not what you open with.
 */
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { qs } from '@/lib/api';
import { fmtClock, fmtLongDate } from '@/lib/format';
import { Button, ErrorState, PageHeader, SectionHeading, WhenVisible } from '@/components/ui';
import { DateRangeSelect, defaultRange, SupervisorSelect, useSupervisors, WorkplaceSelect, type DateRangeValue } from '@/components/filters';
import { EmployeeDrawer } from '@/components/employee-drawer';
import { GettingStarted } from '@/components/getting-started';
import type { BoardTab, RosterRow } from '@/components/attendance-board';
import { absDelta, Kpi, pctDelta, StatStrip, StatStripSkeleton } from '@/components/charts';
import { RightNow } from '@/components/right-now';
import { ActivityFeed, AttendanceTrend, AttentionPanel, EmployeesByLocation, ExportMenu, HoursChart, LocationTable, RefreshButton, StaffingChart, SupervisorTable, TodayBoard, useOverview, WorkforceToday, WorkplaceModal } from './shared';

// The map and Google's script load only when this section is about to be seen.
const WorkforceMap = dynamic(() => import('@/components/live-map').then((m) => m.WorkforceMap), { ssr: false, loading: () => <div className="h-[240px] animate-pulse bg-gray-100" /> });

export function OwnerOverview() {
  const [welcome, setWelcome] = useState(false);
  useEffect(() => setWelcome(new URLSearchParams(window.location.search).get('welcome') === '1'), []);
  const [range, setRange] = useState<DateRangeValue>(() => defaultRange('7d'));
  const [workplaceId, setWorkplaceId] = useState('');
  const [supervisorId, setSupervisorId] = useState('');
  const [employee, setEmployee] = useState<string | null>(null);
  const [place, setPlace] = useState<any | null>(null);
  const [tab, setTab] = useState<BoardTab>('all');

  const o = useOverview({ range, workplaceId, supervisorId });
  const { d, previous: p, trend, prevLabel, sessions } = o;
  const sups = useSupervisors(true);
  const supSites: string[] | null = supervisorId ? (sups.data?.find((s) => s.id === supervisorId)?.site_ids ?? []) : null;
  const rows: RosterRow[] = useMemo(() => (o.today.data?.roster ?? []).filter((r: any) => !supSites || supSites.includes(r.workplace_id)), [o.today.data, supSites]);

  const k = d?.kpis;
  const s = d?.summary;
  const filtered = !!(workplaceId || supervisorId);
  const toBoard = (t: BoardTab) => {
    setTab(t);
    document.getElementById('today-board')?.scrollIntoView({ behavior: 'smooth' });
  };
  const sparkRate = trend.filter((t: any) => t.expected > 0).map((t: any) => t.rate);
  const pending = d?.overtimeStatus?.pending;

  return (
    <>
      <PageHeader
        title="Workforce Overview"
        description={d ? <>{fmtLongDate(d.today)}{o.dash.dataUpdatedAt > 0 && <span> · updated {fmtClock(new Date(o.dash.dataUpdatedAt))}</span>}</> : undefined}
        actions={
          <>
            <WorkplaceSelect value={workplaceId} onChange={setWorkplaceId} />
            <SupervisorSelect value={supervisorId} onChange={setSupervisorId} />
            <DateRangeSelect value={range} onChange={setRange} />
            {filtered && <Button variant="ghost" onClick={() => { setWorkplaceId(''); setSupervisorId(''); }}>Reset</Button>}
            <ExportMenu range={range} workplaceId={workplaceId} download={o.download} />
            <RefreshButton busy={o.dash.isFetching} onClick={o.refresh} />
          </>
        }
      />
      <GettingStarted welcome={welcome} />

      {o.dash.error && !d ? (
        <ErrorState error={o.dash.error} onRetry={() => o.dash.refetch()} />
      ) : (
        <>
          <RightNow sessions={sessions} rows={rows} now={o.now} loading={o.live.isLoading || o.today.isLoading} error={o.live.error ?? o.today.error} onRetry={o.refresh} onNotArrived={() => toBoard('not-started')} workplaceId={workplaceId} />
          {d && <AttentionPanel a={d.attention} d={d} onEmployee={setEmployee} className="mt-4" />}

          <SectionHeading title="Your workforce" description="Who you have, and who is working today" />
          {!k ? (
            <StatStripSkeleton label="Your workforce" count={6} />
          ) : (
            <StatStrip label="Your workforce" count={6}>
              <Kpi label="Total employees" value={k.allWorkers} sub={k.allWorkers > k.totalWorkers ? `${k.allWorkers - k.totalWorkers} deactivated` : 'none deactivated'} href="/employees" />
              <Kpi label="Active employees" value={k.totalWorkers} sub="accounts in use" href="/employees" />
              <Kpi label="Supervisors" value={d.supervisors?.length ?? 0} sub={supervisorId ? 'selected' : 'active'} href="/team" />
              <Kpi label="Workplaces" value={k.activeWorkspaces} sub="active" href="/workplaces" />
              <Kpi label="Working now" value={k.checkedIn} sub={`of ${k.scheduledToday} rostered today`} href={`/map${qs({ workplaceId })}`} title="Open shifts with attendance recorded" />
              <Kpi label="Absent today" value={k.absentToday} tone={k.absentToday ? 'bad' : undefined} sub="no-show or shift over" onClick={() => toBoard('not-started')} />
            </StatStrip>
          )}

          <SectionHeading title="This period" description={d ? `Compared with ${prevLabel || 'the previous period'}` : undefined} />
          {!s ? (
            <StatStripSkeleton label="This period" count={6} />
          ) : (
            <StatStrip label="This period" count={6}>
              <Kpi label="Attendance rate" value={s.attendanceRate == null ? '—' : Math.round(s.attendanceRate * 100)} unit={s.attendanceRate == null ? undefined : '%'} delta={p && s.attendanceRate != null ? absDelta(s.attendanceRate * 100, p.attendanceRate * 100, 'up', ' pts', `Previous period ${prevLabel}`) : null} sub={`${s.present} of ${s.expected} shifts`} spark={sparkRate} title="Rostered shifts with attendance ÷ rostered shifts (approved leave and holidays excluded), past days and today" href="/reports" />
              <Kpi label="Hours worked" value={(s.totalMinutes / 60).toFixed(s.totalMinutes >= 6000 ? 0 : 1)} unit="h" delta={p ? pctDelta(s.totalMinutes, p.totalMinutes, 'up', `Previous period ${prevLabel}`) : null} sub={s.employeesWorked ? `${s.employeesWorked} ${s.employeesWorked === 1 ? 'person' : 'people'}` : 'in this period'} spark={(d.hoursByDay ?? []).map((x: any) => x.worked ?? 0)} href="/reports" title="Net worked time plus approved overtime — the same figures as the CSV export" />
              <Kpi label="Overtime" value={(s.overtimeMinutes / 60).toFixed(1)} unit="h" delta={p ? pctDelta(s.overtimeMinutes, p.overtimeMinutes, 'down', `Previous period ${prevLabel}`) : null} sub={pending?.count ? `${pending.count} waiting approval` : 'approved'} href="/overtime" title="Approved overtime, plus time over the weekly limit where Settings sets one. Claims waiting approval never count." />
              <Kpi label="Late arrivals" value={s.late} tone={s.late ? 'warn' : undefined} delta={p ? absDelta(s.late, p.late, 'down', '', `Previous period ${prevLabel}`) : null} sub={s.present ? `${Math.round((s.late / s.present) * 100)}% of check-ins` : 'in this period'} spark={trend.map((t: any) => t.late)} href="/attendance?late=true" />
              <Kpi label="Absences" value={s.absent} tone={s.absent ? 'bad' : undefined} delta={p ? absDelta(s.absent, p.absent, 'down', '', `Previous period ${prevLabel}`) : null} sub="rostered shifts missed" spark={trend.map((t: any) => t.absent)} title="Rostered shifts without attendance (past days; today only no-shows and finished shifts)" href="/attendance" />
              <Kpi label="Pending approvals" value={o.waiting ?? '—'} tone={o.waiting ? 'warn' : undefined} sub={o.waiting == null ? 'could not be loaded' : s.pending ? `${s.pending} records not counted yet` : 'all decisions'} href="/approvals" title="Everything waiting in Approvals. Pending attendance is not counted until a person decides." />
            </StatStrip>
          )}
          {d && !p && d.previous && <p className="mt-2 text-xs text-gray-500">No comparison shown: there were no rostered shifts in the previous period ({prevLabel}).</p>}

          {d && (
            <>
              <div className="mt-4 grid items-stretch gap-4 xl:grid-cols-3">
                <WorkforceToday d={d} onState={(key) => toBoard(key === 'onTime' || key === 'late' ? 'in' : key === 'onLeave' ? 'leave' : 'not-started')} />
                <AttendanceTrend d={d} trend={trend} className="xl:col-span-2" />
              </div>
              <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-2">
                <StaffingChart d={d} trend={trend} />
                <HoursChart d={d} />
              </div>

              <SectionHeading title="Locations and supervisors" description="Where to look first" />
              <LocationTable d={d} onOpen={setPlace} />
              <div className="mt-4 grid items-start gap-4 xl:grid-cols-3">
                {d.supervisors && <div className="xl:col-span-2"><SupervisorTable rows={d.supervisors} onPick={setSupervisorId} /></div>}
                <EmployeesByLocation d={d} onOpen={setPlace} />
              </div>
            </>
          )}

          <SectionHeading title="Live activity" />
          <div className="grid items-stretch gap-4 xl:grid-cols-3">
            <section aria-label="Live map preview" className="flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-card xl:col-span-2">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-5 py-3">
                <div className="min-w-0">
                  <h3 className="text-title font-semibold text-navy-900">Live map</h3>
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
          <TodayBoard today={o.today} rows={rows} tab={tab} onTab={setTab} onEmployee={setEmployee} workplaceId={workplaceId} owner />
        </>
      )}
      <WorkplaceModal w={place} onClose={() => setPlace(null)} onEmployee={setEmployee} />
      <EmployeeDrawer employeeId={employee} onClose={() => setEmployee(null)} />
    </>
  );
}
