'use client';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, UsersRound } from 'lucide-react';
import { get, qs } from '@/lib/api';
import { DAY_NAMES, todayISO } from '@/lib/format';
import { useMe } from '@/lib/me';
import { Badge, Button, Card, cx, EmptyState, Modal, PageHeader, QueryState, Select, useKeyboardScroll } from '@/components/ui';
import { WorkplaceSelect } from '@/components/filters';
import { BulkAssignForm, RosterEntryForm } from '@/components/roster-form';
import { Kpi, StatStrip, StatStripSkeleton } from '@/components/charts';
import { EmployeeDrawer } from '@/components/employee-drawer';

/** Shift type by its hours, shown as the entry's coloured left edge. */
const SHIFT_KIND = {
  day: { label: 'Day', bar: 'border-l-navy-700' },
  evening: { label: 'Evening', bar: 'border-l-sky-400' },
  night: { label: 'Night / overnight', bar: 'border-l-gray-500' },
  long: { label: 'Over 16 h', bar: 'border-l-red-500' },
} as const;
function shiftKind(start: string, end: string): keyof typeof SHIFT_KIND {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const len = (m(end) - m(start) + 1440) % 1440 || 1440;
  if (len > 16 * 60) return 'long';
  if (m(end) <= m(start) || m(start) >= 20 * 60) return 'night';
  return m(start) >= 12 * 60 ? 'evening' : 'day';
}

const DAY_MS = 86400_000;
const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const isoOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const weekday = (n: number) => ((new Date(n * DAY_MS).getUTCDay() + 6) % 7) + 1; // 1 = Monday
const mondayOf = (iso: string) => isoOf(dayNum(iso) - (weekday(dayNum(iso)) - 1));

/** Entries of one employee that cover `day` and whose shift runs on that weekday. */
function entriesOn(rows: any[], day: number) {
  return rows.filter((r) => dayNum(r.effective_from) <= day && (!r.effective_to || dayNum(r.effective_to) >= day) && r.days_of_week.includes(weekday(day)));
}

/**
 * The week at a glance. Coverage counts only workplaces with a daily target: each day contributes
 * min(rostered, target) of its target. Overlapping entries are refused when saving, so there are
 * no conflicts to count here.
 */
function CoverageSummary({ roster, staffing, employees }: { roster?: any[]; staffing?: any; employees?: any[] }) {
  if (!roster || !staffing) return <StatStripSkeleton label="Week summary" count={4} className="mb-4" />;
  const scheduled = new Set(roster.map((r) => r.employee_id)).size;
  const cells = (staffing.workplaces ?? []).flatMap((w: any) => (w.minStaff != null && w.minStaff > 0 ? w.days.map((d: any) => ({ ...d, target: w.minStaff })) : []));
  const target = cells.reduce((n: number, c: any) => n + c.target, 0);
  const covered = cells.reduce((n: number, c: any) => n + Math.min(c.rostered, c.target), 0);
  const short = cells.filter((c: any) => c.shortage > 0).length;
  const unassigned = staffing.unassigned?.length ?? Math.max(0, (employees?.length ?? 0) - scheduled);
  return (
    <StatStrip label="Week summary" count={4} className="mb-4">
      <Kpi label="Scheduled employees" value={scheduled} sub={employees ? `of ${employees.length} active` : 'this week'} />
      <Kpi label="Shift coverage" value={target ? Math.round((covered / target) * 100) : '—'} unit={target ? '%' : undefined} tone={target && covered < target ? 'warn' : undefined} sub={target ? `${covered} of ${target} required person-days` : 'set a daily target on a workplace'} title="Rostered people against each workplace's daily target, capped at the target" />
      <Kpi label="Understaffed days" value={short} tone={short ? 'bad' : undefined} sub="workplace-days below target" />
      <Kpi label="Not rostered" value={unassigned} tone={unassigned ? 'warn' : undefined} sub="active employees with no shift this week" />
    </StatStrip>
  );
}

/** Rostered people per workplace and day against the workplace's target (if it has one). */
function Staffing({ data, days, today }: { data: any; days: number[]; today: number }) {
  const scroller = useKeyboardScroll<HTMLDivElement>();
  if (!data?.workplaces?.length) return null;
  return (
    <Card padded={false} className="mb-4" title="Staffing" description="People rostered per workplace and day, against the workplace's daily target">
      <div ref={scroller} className="relative overflow-x-auto">
        <table className="w-full min-w-[920px] table-fixed text-left text-sm">
          <thead>
            <tr>
              <th scope="col" className="w-48 border-b border-gray-200 bg-gray-50/70 px-3 py-2 text-xs font-semibold text-gray-500">Workplace</th>
              {days.map((d, i) => (
                <th key={d} scope="col" className={cx('border-b border-l border-gray-200 bg-gray-50/70 px-2 py-2 text-center text-xs font-semibold', d === today ? 'text-navy-800' : 'text-gray-500')}>
                  {DAY_NAMES[i]} <span className="tabular">{new Date(d * DAY_MS).getUTCDate()}</span>
                  {d === today && <span className="sr-only"> (today)</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.workplaces.map((w: any) => (
              <tr key={w.id}>
                <th scope="row" className="w-48 border-b border-gray-100 px-3 py-2 text-body-sm font-medium text-gray-900">
                  {w.name}
                  <span className="block text-xs font-normal text-gray-500">{w.minStaff != null ? `target ${w.minStaff} / day` : 'no target set'}</span>
                </th>
                {days.map((d) => {
                  const cell = w.days.find((x: any) => x.date === isoOf(d));
                  return (
                    <td key={d} className={cx('border-b border-l border-gray-100 px-2 py-2 text-center', cell?.shortage > 0 ? 'bg-red-50/60' : d === today && 'bg-navy-50/60')}>
                      <span className={cx('tabular text-sm font-semibold', cell?.rostered ? 'text-navy-800' : 'text-gray-500')}>{cell?.rostered ?? 0}</span>
                      {cell?.shortage > 0 && (
                        <Badge tone="red" className="ml-1.5" title={`${cell.shortage} below the target`}>−{cell.shortage}</Badge>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function RosterPage() {
  useMe();
  const qc = useQueryClient();
  const [bulk, setBulk] = useState(false);
  const [week, setWeek] = useState(() => mondayOf(todayISO()));
  const [workplaceId, setWorkplaceId] = useState('');
  const [managerId, setManagerId] = useState('');
  const [adding, setAdding] = useState<{ employeeId: string; name: string; date: string; home: string | null } | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => dayNum(week) + i), [week]);
  const roster = useQuery({
    queryKey: ['roster', week, workplaceId, managerId],
    queryFn: () => get<any[]>(`/roster${qs({ from: week, to: isoOf(dayNum(week) + 6), workplaceId, managerId })}`),
  });
  const gridScroller = useKeyboardScroll<HTMLDivElement>();
  const employees = useQuery({ queryKey: ['employees', 'active'], queryFn: () => get<any[]>('/employees?status=active') });
  const managers = useQuery({ queryKey: ['roster', 'managers', ''], queryFn: () => get<any[]>('/roster/managers') });
  const staffing = useQuery({ queryKey: ['roster', 'staffing', week, workplaceId], queryFn: () => get<any>(`/roster/staffing${qs({ from: week, to: isoOf(dayNum(week) + 6), workplaceId })}`) });
  const today = dayNum(todayISO());
  // Phones show one day at a time: today when this week is on screen.
  const [phoneDay, setPhoneDay] = useState<number | null>(null);
  const shownDay = phoneDay !== null && days.includes(phoneDay) ? phoneDay : days.includes(today) ? today : days[0]!;

  // Everyone active is listed (so empty days can be filled), unless a filter narrows it to rostered people.
  const rows = useMemo(() => {
    const byEmp = new Map<string, any[]>();
    for (const r of roster.data ?? []) byEmp.set(r.employee_id, [...(byEmp.get(r.employee_id) ?? []), r]);
    const filtered = !!workplaceId || !!managerId;
    const list = (employees.data ?? [])
      .filter((e) => !filtered || byEmp.has(e.id))
      .map((e) => ({ id: e.id, name: e.full_name, code: e.employee_code, home: e.workplace_id as string | null, entries: byEmp.get(e.id) ?? [] }));
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [roster.data, employees.data, workplaceId, managerId]);

  const label = `${new Date(`${week}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })} – ${new Date((dayNum(week) + 6) * DAY_MS).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;

  return (
    <>
      <PageHeader
        title="Rosters"
        description="Workers can start a shift only on rostered days, at the rostered workplace."
        actions={
          <>
            <WorkplaceSelect value={workplaceId} onChange={setWorkplaceId} />
            <Select aria-label="Supervisor" value={managerId} onChange={(e) => setManagerId(e.target.value)} className="w-auto">
              <option value="">All supervisors</option>
              {managers.data?.map((m: any) => (
                <option key={m.id} value={m.id}>{m.full_name}</option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => setBulk(true)}>
              <UsersRound className="h-4 w-4" aria-hidden /> Assign workers
            </Button>
          </>
        }
      />
      {!roster.error && !staffing.error && <CoverageSummary roster={roster.data} staffing={staffing.data} employees={employees.data} />}
      <Staffing data={staffing.data} days={days} today={today} />
      <Card
        padded={false}
        title={
          <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" aria-label="Previous week" onClick={() => setWeek(isoOf(dayNum(week) - 7))}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="tabular min-w-44 text-center">{label}</span>
            <Button size="sm" variant="ghost" aria-label="Next week" onClick={() => setWeek(isoOf(dayNum(week) + 7))}><ChevronRight className="h-4 w-4" /></Button>
          </span>
        }
        actions={week !== mondayOf(todayISO()) && <Button size="sm" onClick={() => setWeek(mondayOf(todayISO()))}>This week</Button>}
      >
        {/* The rows are built from the employee list too: without it, "nobody rostered" would be untrue. */}
        <QueryState query={employees.error ? (employees as typeof roster) : roster} isEmpty={() => rows.length === 0} empty={<EmptyState title="Nobody rostered for this filter this week" />}>
          {() => (
            <>
            <div className="sm:hidden">
              <div role="tablist" aria-label="Day" className="flex justify-between gap-0.5 border-b border-gray-200 px-2 py-2">
                {days.map((d, i) => (
                  <button key={d} type="button" role="tab" aria-selected={d === shownDay} onClick={() => setPhoneDay(d)} className={cx('flex h-12 flex-1 flex-col items-center justify-center rounded-md text-xs', d === shownDay ? 'bg-navy-800 text-white' : d === today ? 'bg-navy-50 text-navy-800' : 'text-gray-600')}>
                    {DAY_NAMES[i]}
                    <span className="text-sm font-semibold tabular">{new Date(d * DAY_MS).getUTCDate()}</span>
                  </button>
                ))}
              </div>
              <ul className="divide-y divide-gray-100">
                {[...rows].sort((a, b) => Number(entriesOn(b.entries, shownDay).length > 0) - Number(entriesOn(a.entries, shownDay).length > 0)).map((r) => {
                  const on = entriesOn(r.entries, shownDay);
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-2">
                      <button type="button" className="min-w-0 flex-1 py-1 text-left" onClick={() => setDrawer(r.id)}>
                        <span className="block truncate font-medium text-gray-900">{r.name}</span>
                        <span className="block text-xs text-gray-500">{r.code}</span>
                      </button>
                      {on.length === 0 ? <span className="text-xs text-gray-500">Off</span> : (
                        <span className="flex flex-col items-end gap-0.5">
                          {on.map((e) => <span key={e.id} className={cx('rounded border border-l-4 border-gray-200 bg-white px-1.5 py-0.5 text-xs font-medium tabular text-gray-900', SHIFT_KIND[shiftKind(e.start_time, e.end_time)].bar)}>{e.start_time.slice(0, 5)}–{e.end_time.slice(0, 5)}</span>)}
                        </span>
                      )}
                      <button type="button" aria-label={`Add roster entry for ${r.name} on ${isoOf(shownDay)}`} onClick={() => setAdding({ employeeId: r.id, name: r.name, date: isoOf(shownDay), home: r.home })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100">
                        <Plus className="h-4 w-4" aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            {/* `relative` keeps the absolutely positioned screen-reader text inside the scroll box (it otherwise widens the page). */}
            <div ref={gridScroller} className="relative hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[920px] table-fixed text-left text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="w-48 border-b border-gray-200 bg-gray-50/70 px-3 py-2 text-xs font-medium text-gray-500">Employee</th>
                    {days.map((d, i) => (
                      <th key={d} scope="col" className={cx('border-b border-l border-gray-200 bg-gray-50/70 px-2 py-2 text-xs font-semibold', d === today ? 'text-navy-800' : 'text-gray-500')}>
                        {DAY_NAMES[i]} <span className="tabular">{new Date(d * DAY_MS).getUTCDate()}</span>
                        {d === today && <span className="sr-only"> (today)</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="align-top">
                      <th scope="row" className="border-b border-gray-100 px-3 py-2 font-normal">
                        <button className="text-left font-medium text-gray-900 hover:underline" onClick={() => setDrawer(r.id)}>{r.name}</button>
                        <span className="block text-xs text-gray-500">{r.code}</span>
                      </th>
                      {days.map((d) => {
                        const on = entriesOn(r.entries, d);
                        return (
                          <td key={d} className={cx('group border-b border-l border-gray-100 p-1', d === today && 'bg-navy-50/50')}>
                            <ul className="space-y-1">
                              {on.map((e) => (
                                <li
                                  key={e.id}
                                  className={cx('rounded border border-l-4 border-gray-200 bg-white px-1.5 py-1 text-xs leading-tight shadow-xs', SHIFT_KIND[shiftKind(e.start_time, e.end_time)].bar)}
                                  title={`${e.workplace_name} · ${e.shift_name} (${SHIFT_KIND[shiftKind(e.start_time, e.end_time)].label})${e.manager_name ? ` · assigned by ${e.manager_name}` : ''}`}
                                >
                                  <span className="tabular block font-medium text-gray-900">{e.start_time.slice(0, 5)}–{e.end_time.slice(0, 5)}</span>
                                  {/* The workplace is named only when it is not the worker's usual one. */}
                                  {r.home && e.workplace_id && e.workplace_id !== r.home && <span className="block truncate text-gray-500">{e.workplace_name}</span>}
                                </li>
                              ))}
                            </ul>
                            {(
                              <button
                                onClick={() => setAdding({ employeeId: r.id, name: r.name, date: isoOf(d), home: r.home })}
                                className={cx('mt-1 flex min-h-7 w-full items-center justify-center rounded text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:opacity-100', on.length ? '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100' : '')}
                                aria-label={`Add roster entry for ${r.name} on ${isoOf(d)}`}
                              >
                                <Plus className="h-3.5 w-3.5" aria-hidden />
                              </button>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
                <caption className="caption-bottom border-t border-gray-100 px-3 py-2 text-left text-xs text-gray-500">
                  {Object.values(SHIFT_KIND).map((k) => (
                    <span key={k.label} className="mr-4 inline-flex items-center gap-1.5">
                      <span aria-hidden className={cx('h-3 w-1 rounded-sm border-l-4', k.bar)} /> {k.label}
                    </span>
                  ))}
                  Hover an entry for its workplace and who assigned it.
                </caption>
              </table>
            </div>
            </>
          )}
        </QueryState>
      </Card>
      <p className="mt-3 text-xs text-gray-500">To change or end an entry, open the employee and use their roster list.</p>
      {staffing.data?.unassigned?.length > 0 && (
        <Card className="mt-6" title={`Not rostered this week · ${staffing.data.unassigned.length}`} padded={false}>
          <ul className="flex flex-wrap gap-2 p-4">
            {staffing.data.unassigned.map((u: any) => (
              <li key={u.id}>
                <button type="button" onClick={() => setDrawer(u.id)} className="rounded-md border border-gray-200 px-2.5 py-1 text-body-sm hover:bg-gray-50">
                  {u.full_name} <span className="text-xs text-gray-500">{u.workplace_name ?? 'no workplace'}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Modal open={bulk} onOpenChange={setBulk} title="Assign workers" description="One shift and date range for several workers. Clashes are refused per worker." wide>
        {bulk && <BulkAssignForm defaultWorkplaceId={workplaceId || undefined} defaultFrom={week >= mondayOf(todayISO()) ? week : todayISO()} onDone={() => setBulk(false)} onCancel={() => setBulk(false)} />}
      </Modal>

      <Modal open={!!adding} onOpenChange={(o) => !o && setAdding(null)} title={adding ? `Roster ${adding.name}` : ''} description="Choose the workplace, shift, manager and dates." wide>
        {adding && (
          <RosterEntryForm
            employeeId={adding.employeeId}
            defaultWorkplaceId={workplaceId || adding.home}
            defaultFrom={adding.date}
            onDone={() => {
              setAdding(null);
              qc.invalidateQueries({ queryKey: ['employees'] });
            }}
            onCancel={() => setAdding(null)}
          />
        )}
      </Modal>
      <EmployeeDrawer employeeId={drawer} onClose={() => { setDrawer(null); qc.invalidateQueries({ queryKey: ['roster'] }); }} />
    </>
  );
}
