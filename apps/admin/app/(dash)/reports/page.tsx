'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useIncludeSimulated } from '@/lib/sim-pref';
import { get, qs } from '@/lib/api';
import { hrsNum, shortDay, fmtDate, todayISO } from '@/lib/format';
import { LinkButton, Button, Card, cx, EmptyState, ErrorState, Field, Input, PageHeader, QueryState, SectionHeading, SortTh, Table, Td, Th, type SortDir } from '@/components/ui';
import { absDelta, BarChart, ChartCard, Composition, DataTable, HBarList, Kpi, StatStrip, StatStripSkeleton, LineChart, pctDelta, SERIES_COLORS } from '@/components/charts';
import { useMe } from '@/lib/me';
import { DateRangeSelect, defaultRange, EmployeeSelect, SupervisorSelect, WorkplaceSelect, type DateRangeValue } from '@/components/filters';
import { HoursChart, LocationTable, SupervisorTable, WorkplaceModal } from '@/components/overview/shared';
import { EmployeeDrawer } from '@/components/employee-drawer';

// Overtime is part of total hours: the chart splits each total into regular + overtime, never adds them.
const HOURS_SERIES = [
  { key: 'regular', label: 'Regular hours', color: SERIES_COLORS[0] },
  { key: 'overtime', label: 'Overtime hours', color: SERIES_COLORS[1] },
];

const hours = (m: number) => (m / 60).toFixed(1);

/** Per-employee month totals. */
function MonthlySummary({ workplaceId, includeSimulated }: { workplaceId: string; includeSimulated: string }) {
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const q = useQuery({ queryKey: ['reports', 'monthly', month, workplaceId, includeSimulated], queryFn: () => get(`/reports/monthly${qs({ month, workplaceId, includeSimulated })}`) });
  return (
    <Card
      title="Monthly summary"
      description="Follows the workplace filter only. Employee, supervisor and date range do not apply; choose a month here."
      className="lg:col-span-3"
      padded={false}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Input type="month" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-auto" />
          <LinkButton href={`/api/v1/reports/monthly.csv${qs({ month, workplaceId, includeSimulated })}`} size="sm"><Download className="h-4 w-4" aria-hidden /> Download CSV</LinkButton>
        </div>
      }
    >
      <QueryState query={q} isEmpty={(d: any) => d.rows.length === 0} empty={<EmptyState title="No scheduled shifts in this month yet" />}>
        {(d: any) => (
          <>
            <p className="px-4 pt-3 text-xs text-gray-500">{fmtDate(d.from)} – {fmtDate(d.to)}. Holidays and approved leave are not counted as absences; half-day leave counts as 0.5.</p>
            <Table>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th className="text-right">Shifts</Th>
                  <Th className="text-right">Present</Th>
                  <Th className="text-right">Late</Th>
                  <Th className="text-right">Leave</Th>
                  <Th className="text-right">Holidays</Th>
                  <Th className="text-right">Absent</Th>
                  <Th className="text-right">Hours</Th>
                  <Th className="text-right">Overtime h</Th>
                  <Th className="text-right">Left early</Th>
                  <Th className="text-right">Pending days</Th>
                  <Th className="text-right">Pending h</Th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r: any) => (
                  <tr key={r.employee_id}>
                    <Td>
                      <span className="font-medium">{r.full_name}</span> <span className="text-xs text-gray-500">{r.employee_code}</span>
                    </Td>
                    <Td className="text-right tabular">{r.scheduled}</Td>
                    <Td className="text-right tabular">{r.present}</Td>
                    <Td className="text-right tabular">{r.late || '—'}</Td>
                    <Td className="text-right tabular">{r.leave || '—'}</Td>
                    <Td className="text-right tabular">{r.holidays || '—'}</Td>
                    <Td className={`text-right tabular ${r.absent ? 'font-semibold text-red-700' : ''}`}>{r.absent || '—'}</Td>
                    <Td className="text-right tabular">{hours(r.worked_minutes)}</Td>
                    <Td className="text-right tabular">{r.overtime_minutes ? hours(r.overtime_minutes) : '—'}</Td>
                    <Td className="text-right tabular">{r.left_early || '—'}</Td>
                    <Td className={cx('text-right tabular', r.pending_days && 'text-amber-800')}>{r.pending_days || '—'}</Td>
                    <Td className={cx('text-right tabular', r.pending_minutes && 'text-amber-800')}>{r.pending_minutes ? hours(r.pending_minutes) : '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </QueryState>
    </Card>
  );
}

/**
 * Days and hours per employee: the default export (three columns) and the separate overtime
 * export, for the page's filters. Supervisors get their own workplaces only — the API applies the scope.
 */
const off = (disabled: boolean) => (disabled ? 'pointer-events-none opacity-50' : undefined);

type Filters = { from: string; to: string; workplaceId: string; supervisorId: string; employeeId: string; includeSimulated: boolean };

function HoursSummary({ params }: { params: Filters }) {
  const [sort, setSort] = useState<{ key: 'name' | 'days' | 'hours' | 'overtime'; dir: SortDir }>({ key: 'hours', dir: 'desc' });
  const q = useQuery({ queryKey: ['reports', 'hours', params], queryFn: () => get(`/reports/hours${qs(params)}`), placeholderData: (p) => p });
  const raw: any[] = q.data?.rows ?? [];
  const rows = useMemo(() => {
    const val = (r: any) => (sort.key === 'name' ? r.full_name.toLowerCase() : sort.key === 'days' ? r.days : sort.key === 'hours' ? r.total_minutes : r.overtime_minutes);
    return [...raw].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * (sort.dir === 'asc' ? 1 : -1));
  }, [raw, sort]);
  const none = !raw.length;
  return (
    <Card
      title="Employee attendance summary"
      description="Days worked, total hours and overtime per employee — the default CSV export uses exactly these filters"
      padded={false}
      actions={
        <>
          <LinkButton size="sm" variant="primary" className={off(none)} href={`/api/v1/reports/hours.csv${qs(params)}`} aria-disabled={none} tabIndex={none ? -1 : undefined} title="Employee Name, Total Days Worked, Total Hours Worked">
            <Download className="h-4 w-4" aria-hidden /> Download CSV
          </LinkButton>
          <LinkButton size="sm" className={off(none)} href={`/api/v1/reports/overtime.csv${qs(params)}`} aria-disabled={none} tabIndex={none ? -1 : undefined} title="Employee Name, Total Overtime Hours">
            <Download className="h-4 w-4" aria-hidden /> Overtime CSV
          </LinkButton>
        </>
      }
    >
      <QueryState query={q} isEmpty={() => none} empty={<EmptyState title="No attendance in this period">Choose another date range, workplace or employee.</EmptyState>}>
        {() => (
          <>
            <Table>
              <thead>
                <tr>
                  <SortTh k="name" sort={sort} onSort={setSort}>Employee Name</SortTh>
                  <SortTh k="days" sort={sort} onSort={setSort} className="text-right">Total Days Worked</SortTh>
                  <SortTh k="hours" sort={sort} onSort={setSort} className="text-right">Total Hours Worked</SortTh>
                  <SortTh k="overtime" sort={sort} onSort={setSort} className="text-right">Overtime h</SortTh>
                  <Th className="text-right">Incomplete shifts</Th>
                  <Th className="text-right">Pending h (not counted)</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.employee_id}>
                    <Td><span className="font-medium text-gray-900">{r.full_name}</span> <span className="text-xs text-gray-500">{r.employee_code}</span></Td>
                    <Td className="text-right tabular">{r.days}</Td>
                    <Td className="text-right tabular">{hoursText(r.total_minutes)}</Td>
                    <Td className="text-right tabular">{r.overtime_minutes ? hoursText(r.overtime_minutes) : '—'}</Td>
                    <Td className={cx('text-right tabular', r.incomplete && 'text-amber-800')}>{r.incomplete || '—'}</Td>
                    <Td className={cx('text-right tabular', r.pending_minutes > 0 && 'text-amber-800')}>{r.pending_minutes ? hoursText(r.pending_minutes) : '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {(q.data?.policy?.roundingMinutes > 0 || q.data?.policy?.weeklyRegularHours > 0) && (
              <p className="border-t border-gray-200 px-4 py-3 text-xs text-gray-500">
                {q.data.policy.roundingMinutes ? `Each shift rounded to ${q.data.policy.roundingMinutes} min. ` : ''}
                {q.data.policy.weeklyRegularHours ? `Time over ${q.data.policy.weeklyRegularHours} h per week counts as overtime.` : ''}
              </p>
            )}
          </>
        )}
      </QueryState>
    </Card>
  );
}

const hoursText = (m: number) => (Math.round((m / 60) * 100) / 100).toFixed(2);

const RATE = [{ key: 'rate', label: 'Attendance rate', color: SERIES_COLORS[0] }];
const PUNCT = [
  { key: 'onTime', label: 'On time', color: SERIES_COLORS[0] },
  { key: 'late', label: 'Late', color: SERIES_COLORS[1] },
];
const OT_SERIES = [{ key: 'overtime', label: 'Approved overtime (h)', color: SERIES_COLORS[1] }];

/** Analytics for the page's filters: every figure comes from /analytics/dashboard, the same engine as the overview. */
function Analytics({ params, onSupervisor }: { params: Filters; onSupervisor: (id: string) => void }) {
  const [place, setPlace] = useState<any | null>(null);
  const [employee, setEmployee] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['reports', 'analytics', params], queryFn: () => get(`/analytics/dashboard${qs({ ...params, compare: 'true' })}`), placeholderData: (p) => p });
  const d = q.data;
  if (q.isLoading) return <StatStripSkeleton label="Key figures" count={6} />;
  if (q.error && !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return null;
  const s = d.summary;
  const p = d.previous?.expected ? d.previous : null;
  const prev = d.previous ? `Previous period ${fmtDate(d.previous.from)} – ${fmtDate(d.previous.to)}` : '';
  const trend = d.trend.map((t: any) => ({ ...t, rate: t.expected ? Math.round((t.present / t.expected) * 100) : 0, onTime: t.present - t.late }));
  // Days with nobody rostered (weekly off, holidays) have no rate: left out rather than drawn as 0%.
  const rateTrend = trend.filter((t: any) => t.expected > 0);
  const otDays = d.hoursByDay.map((x: any) => ({ date: x.date, overtime: hrsNum(x.overtime) }));
  const ots = d.overtimeStatus;
  // Per-day series behind the sparklines (same days as the charts below).
  const sparkRate = trend.filter((t: any) => t.expected > 0).map((t: any) => t.rate);
  const sparkHours = d.hoursByDay.map((x: any) => (x.worked ?? 0) + (x.overtime ?? 0));
  const sparkOt = d.hoursByDay.map((x: any) => x.overtime ?? 0);
  const sparkLate = d.trend.map((t: any) => t.late);
  return (
    <>
      <StatStrip label="Key figures" count={6}>
        <Kpi label="Attendance rate" value={s.attendanceRate == null ? '—' : Math.round(s.attendanceRate * 100)} unit={s.attendanceRate == null ? undefined : '%'} delta={p && s.attendanceRate != null ? absDelta(s.attendanceRate * 100, p.attendanceRate * 100, 'up', ' pts', prev) : null} sub={`${s.present} of ${s.expected} shifts`} spark={sparkRate} info="Rostered shifts with attendance ÷ rostered shifts, excluding approved leave and holidays. The same calculation as the Overview." />
        <Kpi label="Total hours" value={(s.totalMinutes / 60).toFixed(1)} unit="h" delta={p ? pctDelta(s.totalMinutes, p.totalMinutes, 'up', prev) : null} sub="overtime included" spark={sparkHours} info="Hours = net worked time (unpaid breaks and time away deducted) + approved overtime. A day is a work date with attendance; two shifts on one date count once." />
        <Kpi label="Average per employee" value={s.avgMinutesPerEmployee == null ? '—' : (s.avgMinutesPerEmployee / 60).toFixed(1)} unit={s.avgMinutesPerEmployee == null ? undefined : 'h'} delta={p && s.avgMinutesPerEmployee != null && p.avgMinutesPerEmployee != null ? pctDelta(s.avgMinutesPerEmployee, p.avgMinutesPerEmployee, 'up', prev) : null} sub={`${s.employeesWorked} employee${s.employeesWorked === 1 ? '' : 's'} worked`} title="Total hours ÷ employees with at least one attendance" />
        <Kpi label="Overtime" value={(s.overtimeMinutes / 60).toFixed(1)} unit="h" delta={p ? pctDelta(s.overtimeMinutes, p.overtimeMinutes, 'down', prev) : null} sub={ots.pending.count ? `${ots.pending.count} awaiting approval` : 'approved only'} spark={sparkOt} />
        <Kpi label="Late arrivals" value={s.late} tone={s.late ? 'warn' : undefined} delta={p ? absDelta(s.late, p.late, 'down', '', prev) : null} sub={s.punctualityRate == null ? 'no check-ins' : `${Math.round(s.punctualityRate * 100)}% on time`} spark={sparkLate} />
        <Kpi label="Incomplete shifts" value={s.incomplete} tone={s.incomplete ? 'warn' : undefined} delta={p ? absDelta(s.incomplete, p.incomplete, 'down', '', prev) : null} sub="closed without check-out" />
      </StatStrip>
      <p className="mt-2 text-xs text-gray-500">
        {fmtDate(s.from)} – {fmtDate(s.to)}{d.trend.length < 1 ? '' : ` · ${d.trend.length} day${d.trend.length === 1 ? '' : 's'} with outcomes (future days have none)`}
        {d.previous && !p ? ' · no comparison: the previous period had no rostered shifts' : p ? ` · arrows compare with ${fmtDate(p.from)} – ${fmtDate(p.to)}` : ''}
      </p>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <ChartCard
          className="xl:col-span-2"
          title="Attendance trend"
          subtitle="Attended ÷ rostered shifts per day (leave and holidays excluded)"
          empty={!trend.some((t: any) => t.expected)}
          table={<DataTable data={trend} x="date" series={[{ key: 'rate', label: 'Rate %', color: '' }, { key: 'expected', label: 'Rostered', color: '' }, { key: 'present', label: 'Attended', color: '' }, { key: 'absent', label: 'Absent', color: '' }, { key: 'leave', label: 'Leave', color: '' }]} xTitle={fmtDate} />}
        >
          <LineChart label="Attendance rate per day" data={rateTrend} x="date" series={RATE} xLabel={shortDay} xTitle={fmtDate} format={(v) => `${v}%`} height={250} />
        </ChartCard>
        <ChartCard title="Shift completion" subtitle="Attendance records in the period by how the shift ended" empty={!(s.completed + s.incomplete + s.inProgress)}>
          <Composition
            label="Shift completion"
            parts={[
              { key: 'completed', label: 'Completed', value: s.completed, color: '#0d9488', hint: 'checked out, or closed normally' },
              { key: 'incomplete', label: 'Missing check-out', value: s.incomplete, color: '#d97706', hint: 'closed by the system' },
              { key: 'inProgress', label: 'In progress', value: s.inProgress, color: SERIES_COLORS[2], hint: 'shift still running' },
            ]}
          />
        </ChartCard>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <ChartCard
          title="Punctuality"
          subtitle={s.punctualityRate == null ? 'On-time and late check-ins per day' : `${Math.round(s.punctualityRate * 100)}% of check-ins on time in this period`}
          series={PUNCT}
          empty={!trend.some((t: any) => t.present)}
          table={<DataTable data={trend} x="date" series={PUNCT} xTitle={fmtDate} />}
        >
          <BarChart label="On-time and late check-ins per day" data={trend} x="date" series={PUNCT} xLabel={shortDay} xTitle={fmtDate} height={230} />
        </ChartCard>
        <ChartCard
          title="Overtime analysis"
          subtitle="Approved overtime per day · claims by decision"
          empty={!(s.overtimeMinutes || ots.pending.count || ots.approved.count || ots.rejected.count || ots.running.count)}
          table={<DataTable data={otDays} x="date" series={OT_SERIES} xTitle={fmtDate} />}
        >
          <div className="mb-3 grid grid-cols-4 gap-2 text-center">
            {([['Pending', ots.pending, 'text-amber-700'], ['Approved', ots.approved, 'text-teal-700'], ['Rejected', ots.rejected, 'text-red-700'], ['Running', ots.running, 'text-navy-800']] as const).map(([l, v, c]) => (
              <div key={l} className="rounded-md bg-gray-50 px-2 py-1.5">
                <div className={cx('tabular text-lg font-semibold', c)}>{v.count}</div>
                <div className="text-caption text-gray-500">{l}{v.claimedMinutes ? ` · ${hrsNum(v.claimedMinutes)} h` : ''}</div>
              </div>
            ))}
          </div>
          <LineChart label="Approved overtime hours per day" data={otDays} x="date" series={OT_SERIES} xLabel={shortDay} xTitle={fmtDate} height={170} />
        </ChartCard>
      </div>

      <SectionHeading title="Working hours" description="Net worked time plus approved overtime" />
      <div className="grid gap-5 lg:grid-cols-2">
        <HoursChart d={d} />
        <ChartCard title="Hours worked by employee" subtitle="Regular and overtime hours (overtime is part of the total, never added twice)" series={HOURS_SERIES} empty={!d.hoursByEmployee.length} table={<DataTable data={d.hoursByEmployee.map((e: any) => ({ ...e, regular: hrsNum(e.totalMinutes - e.overtimeMinutes), overtime: hrsNum(e.overtimeMinutes), days: e.days }))} x="name" series={[...HOURS_SERIES, { key: 'days', label: 'Days', color: '' }]} />}>
          <HBarList data={d.hoursByEmployee.map((e: any) => ({ ...e, regular: hrsNum(e.totalMinutes - e.overtimeMinutes), overtime: hrsNum(e.overtimeMinutes) }))} label="Regular and overtime hours by employee" series={HOURS_SERIES} format={(v) => `${v} h`} name={(r) => r.name} max={10} />
        </ChartCard>
      </div>

      <SectionHeading title="By location" description="The same figures, per workplace" />
      <LocationTable d={d} onOpen={setPlace} />
      {d.supervisors && (
        <>
          <SectionHeading title="By supervisor" description="A workplace shared by two supervisors counts for both, so these rows do not add up to the company total" />
          <SupervisorTable rows={d.supervisors} onPick={onSupervisor} />
        </>
      )}
      <WorkplaceModal w={place} onClose={() => setPlace(null)} onEmployee={setEmployee} />
      <EmployeeDrawer employeeId={employee} onClose={() => setEmployee(null)} />
    </>
  );
}

const defaults = (): { range: DateRangeValue; workplaceId: string; supervisorId: string; employeeId: string; includeSimulated: boolean } => ({ range: defaultRange('30d'), workplaceId: '', supervisorId: '', employeeId: '', includeSimulated: false });

export default function ReportsPage() {
  const { isOwner } = useMe();
  const sim = useIncludeSimulated();
  const [f, setF] = useState(defaults);
  // Demo mode only: the shared choice (also used by the Overview and Live map).
  useEffect(() => setF((x) => ({ ...x, includeSimulated: sim.include })), [sim.include]);
  const [day, setDay] = useState(todayISO());
  const params: Filters = { from: f.range.from, to: f.range.to, workplaceId: f.workplaceId, supervisorId: isOwner ? f.supervisorId : '', employeeId: f.employeeId, includeSimulated: f.includeSimulated };
  const dirty = f.workplaceId || f.supervisorId || f.employeeId || f.range.preset !== '30d';
  const exportQs = { from: f.range.from, to: f.range.to, workplaceId: f.workplaceId, employeeId: f.employeeId, includeSimulated: String(f.includeSimulated) };
  const summary = useQuery({ queryKey: ['reports', 'daily', exportQs], queryFn: () => get<any[]>(`/reports/daily-summary${qs({ from: exportQs.from, to: exportQs.to, workplaceId: exportQs.workplaceId, includeSimulated: exportQs.includeSimulated })}`), enabled: isOwner });

  return (
    <>
      <PageHeader title="Reports" description="Attendance, hours and overtime analytics. Figures, charts and the employee summary follow these filters; the sections further down say what they cover." />
      <div className="-mx-4 mb-5 border-b sm:sticky sm:top-16 sm:z-10 border-gray-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
          <DateRangeSelect value={f.range} onChange={(range) => setF({ ...f, range })} />
          <WorkplaceSelect value={f.workplaceId} onChange={(workplaceId) => setF({ ...f, workplaceId })} />
          {isOwner && <SupervisorSelect value={f.supervisorId} onChange={(supervisorId) => setF({ ...f, supervisorId })} />}
          <EmployeeSelect value={f.employeeId} onChange={(employeeId) => setF({ ...f, employeeId })} />
          {sim.available && (
            <label className="flex h-10 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-700 sm:h-9.5">
              <input type="checkbox" checked={f.includeSimulated} onChange={(e) => sim.set(e.target.checked)} /> Include demo &amp; simulated
            </label>
          )}
          {dirty && <Button variant="ghost" onClick={() => setF({ ...defaults(), includeSimulated: sim.include })}>Reset filters</Button>}
        </div>
      </div>

      <Analytics params={params} onSupervisor={(supervisorId) => setF({ ...f, supervisorId })} />

      <div className="mt-5">
        <HoursSummary params={params} />
      </div>

      {isOwner && (
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <Card title="Detailed exports" description="Raw records for the date range, workplace and employee above, in UTC server times. The supervisor filter does not apply." className="lg:col-span-1">
            <div className="flex flex-col gap-2">
              <LinkButton size="sm" variant="primary" href={`/api/v1/reports/attendance.csv${qs(exportQs)}`}><Download className="h-4 w-4" aria-hidden /> Attendance records (CSV)</LinkButton>
              <LinkButton size="sm" href={`/api/v1/reports/absences.csv${qs(exportQs)}`}><Download className="h-4 w-4" aria-hidden /> Absence intervals (CSV)</LinkButton>
              <hr className="my-1 border-gray-200" />
              <Field label="Shift roster for one day (includes employees with no attendance)" hint="Follows the workplace filter only."><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
              <LinkButton size="sm" className={off(!day)} href={`/api/v1/reports/shift.csv${qs({ date: day, workplaceId: f.workplaceId, includeSimulated: exportQs.includeSimulated })}`}><Download className="h-4 w-4" aria-hidden /> Shift roster (CSV)</LinkButton>
            </div>
          </Card>
          <Card title="Daily attendance by workplace" description="Follows the date range and workplace filters only." className="lg:col-span-2" padded={false}>
            <QueryState query={summary} isEmpty={(rows) => rows.length === 0} empty={<EmptyState title="No attendance in this range" />}>
              {(rows) => (
                <div className="max-h-96 overflow-y-auto" tabIndex={0} role="region" aria-label="Table, scrolls">
                  <Table>
                    <thead><tr><Th>Date</Th><Th>Workplace</Th><Th className="text-right">Attended</Th><Th className="text-right">Late</Th><Th className="text-right">Manual</Th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={`${r.shift_date}-${r.workplace_name}`}>
                          <Td>{fmtDate(r.shift_date)}</Td>
                          <Td>{r.workplace_name}</Td>
                          <Td className="text-right tabular">{r.attended}</Td>
                          <Td className="text-right tabular">{r.late}</Td>
                          <Td className="text-right tabular">{r.manual}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
            </QueryState>
          </Card>
          <MonthlySummary workplaceId={f.workplaceId} includeSimulated={exportQs.includeSimulated} />
        </div>
      )}
    </>
  );
}
