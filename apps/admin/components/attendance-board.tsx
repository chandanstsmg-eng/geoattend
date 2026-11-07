'use client';
import { useMemo, useState } from 'react';
import { ClipboardList, ExternalLink, Hourglass, MapPin, MoreHorizontal, UserRound } from 'lucide-react';
import { LEAVE_TYPE_LABELS, type LeaveType } from '@geoattend/shared';
import { fmtClock, minutes } from '@/lib/format';
import { rowKeys, Badge, DemoTag, EmptyState, Menu, Pagination, rowLink, SearchInput, Select, SortTh, Table, Tabs, Td, Th, type SortDir } from './ui';
import { StateBadge, VerificationBadge } from './state-badge';

/** One row of GET /reports/overview `roster`: an (employee, shift) pair scheduled on the date. */
export type RosterRow = Record<string, any>;

export type BoardTab = 'all' | 'attention' | 'in' | 'not-started' | 'leave';

const ON_SITE = new Set(['PRESENT', 'ON_BREAK', 'ON_OVERTIME']);

/** "+45 min overtime", with its approval state unless approved in full. */
function overtimeNote(r: RosterRow) {
  if (!r.overtime_status) return null;
  if (r.overtime_status === 'RUNNING') return `on overtime ${minutes(r.overtime_claimed_minutes)}`;
  if (r.overtime_status === 'PENDING') return `+${minutes(r.overtime_claimed_minutes)} overtime, waiting approval`;
  if (r.overtime_status === 'REJECTED') return 'overtime rejected';
  return `+${minutes(r.overtime_minutes)} overtime${r.overtime_minutes < r.overtime_claimed_minutes ? ' approved' : ''}`;
}

/** Lower = needs action sooner. Drives the default "Status" sort so problems come first. */
export function priority(r: RosterRow) {
  if (r.state === 'PROLONGED_ABSENCE') return 0;
  if (r.no_show) return 1;
  if (r.state === 'TRACKING_INTERRUPTED' || r.state === 'TRACKING_PERMISSION_REQUIRED') return 2;
  if (r.state === 'TEMPORARILY_AWAY') return 3;
  if (r.state === 'MANUAL_REVIEW_REQUIRED') return 4;
  if (r.prolonged_count > 0 || r.verification_status === 'DISPUTED') return 5;
  if (r.is_late || r.left_early) return 6;
  if (r.state && !r.ended_at && !ON_SITE.has(r.state)) return 7; // on shift, not yet present
  if (!r.state && !r.attendance_id && !r.on_leave && !r.holiday) return 8; // yet to arrive
  if (ON_SITE.has(r.state)) return 9;
  if (r.on_leave || r.holiday) return 10;
  return 11;
}

export const needsAttention = (r: RosterRow) => priority(r) <= 6;
export const notStarted = (r: RosterRow) => !r.attendance_id && !r.session_id && !r.on_leave && !r.holiday;
export const onLeave = (r: RosterRow) => !!r.on_leave && !r.attendance_id;

const FILTERS: Record<BoardTab, (r: RosterRow) => boolean> = {
  all: () => true,
  attention: needsAttention,
  in: (r) => !!r.attendance_id,
  'not-started': notStarted,
  leave: onLeave,
};

const EMPTY: Record<BoardTab, [string, string]> = {
  all: ['No one is scheduled on this date', 'Assign employees to shifts that run on this day of the week.'],
  attention: ['Nothing needs attention', 'No-shows, absences, tracking problems and late arrivals appear here.'],
  in: ['No one has checked in yet', 'Attendance appears here as soon as the server records it.'],
  'not-started': ['Everyone scheduled has started', 'People who have not started their shift appear here.'],
  leave: ['Nobody is on leave', 'Approved leave for this date appears here.'],
};

type SortKey = 'name' | 'shift' | 'in' | 'status' | 'worked';
const SORTERS: Record<SortKey, (a: RosterRow, b: RosterRow) => number> = {
  name: (a, b) => a.full_name.localeCompare(b.full_name),
  shift: (a, b) => a.start_time.localeCompare(b.start_time) || a.shift_name.localeCompare(b.shift_name),
  in: (a, b) => (a.recorded_at ?? '9').localeCompare(b.recorded_at ?? '9'),
  status: (a, b) => priority(a) - priority(b) || a.full_name.localeCompare(b.full_name),
  worked: (a, b) => (a.worked_minutes ?? -1) - (b.worked_minutes ?? -1),
};

const PAGE = 25;

function StatusCell({ r }: { r: RosterRow }) {
  const badge = r.no_show ? (
    <Badge dot tone="red" title="The shift began a while ago and it has not been started">No-show</Badge>
  ) : r.holiday && !r.state ? (
    <Badge dot tone="teal">Holiday</Badge>
  ) : r.on_leave && !r.state ? (
    <Badge dot tone="teal">On leave</Badge>
  ) : (
    <StateBadge state={r.state} />
  );
  const notes = [
    r.on_leave && !r.state ? `${LEAVE_TYPE_LABELS[r.on_leave.leave_type as LeaveType]}${r.on_leave.half_day ? ', half day' : ''}` : null,
    r.holiday && !r.state ? r.holiday : null,
    r.away_minutes ? `Away ${minutes(r.away_minutes)}` : null,
    r.prolonged_count > 0 ? `${r.prolonged_count} prolonged` : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col items-start gap-1">
      {badge}
      {notes.length > 0 && <span className={r.prolonged_count > 0 ? 'text-xs text-red-700' : 'text-xs text-gray-500'}>{notes.join(' · ')}</span>}
    </div>
  );
}

export function AttendanceBoard({ rows, tab, onTab, onEmployee, showWorkplace, pageSize = PAGE }: { rows: RosterRow[]; tab: BoardTab; onTab: (t: BoardTab) => void; onEmployee: (id: string) => void; showWorkplace: boolean; pageSize?: number }) {
  const [search, setSearch] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'status', dir: 'asc' });
  const [offset, setOffset] = useState(0);

  const shifts = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.shift_id, `${r.shift_name} (${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)})${showWorkplace ? ` · ${r.workplace_name}` : ''}`);
    return [...m.entries()];
  }, [rows, showWorkplace]);

  const base = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => (!shiftId || r.shift_id === shiftId) && (!q || r.full_name.toLowerCase().includes(q) || String(r.employee_code).toLowerCase().includes(q)));
  }, [rows, search, shiftId]);
  const counts = useMemo(() => Object.fromEntries((Object.keys(FILTERS) as BoardTab[]).map((k) => [k, base.filter(FILTERS[k]).length])) as Record<BoardTab, number>, [base]);
  const visible = useMemo(() => {
    const list = base.filter(FILTERS[tab]).sort(SORTERS[sort.key]);
    return sort.dir === 'desc' ? list.reverse() : list;
  }, [base, tab, sort]);
  const page = visible.slice(offset, offset + pageSize);
  const reset = <T,>(fn: (v: T) => void) => (v: T) => {
    setOffset(0);
    fn(v);
  };

  return (
    <section aria-label="Today's attendance" className="rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3">
        <Tabs
          className="shrink-0"
          variant="segmented"
          label="Filter attendance"
          value={tab}
          onChange={reset(onTab)}
          tabs={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'attention', label: 'Needs attention', count: counts.attention, alert: true },
            { value: 'in', label: 'Checked in', count: counts.in },
            { value: 'not-started', label: 'Not started', count: counts['not-started'] },
            { value: 'leave', label: 'On leave', count: counts.leave },
          ]}
        />
        <div className="flex w-full flex-col gap-2 sm:ml-auto sm:w-auto sm:flex-row">
          <SearchInput aria-label="Search employees" placeholder="Search name or ID" value={search} onChange={(e) => reset(setSearch)(e.target.value)} className="sm:w-56" />
          {shifts.length > 1 && (
            <Select aria-label="Shift" value={shiftId} onChange={(e) => reset(setShiftId)(e.target.value)} className="w-56">
              <option value="">All shifts</option>
              {shifts.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>
      {page.length === 0 ? (
        <EmptyState title={search || shiftId ? 'No one matches these filters' : EMPTY[tab][0]}>{search || shiftId ? 'Try a different name, ID or shift.' : EMPTY[tab][1]}</EmptyState>
      ) : (
        <>
          <Table minWidth={680}>
            <thead>
              <tr>
                <SortTh k="name" sort={sort} onSort={setSort}>Employee</SortTh>
                <SortTh k="shift" sort={sort} onSort={setSort}>Shift</SortTh>
                <SortTh k="in" sort={sort} onSort={setSort}>Checked in</SortTh>
                <SortTh k="status" sort={sort} onSort={setSort}>Status</SortTh>
                <SortTh k="worked" sort={sort} onSort={setSort}>Worked</SortTh>
                <Th label="">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {page.map((r) => (
                <tr key={`${r.employee_id}-${r.shift_id}`} className={rowLink} tabIndex={0} onClick={() => onEmployee(r.employee_id)} onKeyDown={rowKeys(() => onEmployee(r.employee_id))} aria-label={`${r.full_name}, open details`}>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-gray-900">{r.full_name}</span>
                      {r.is_demo && <DemoTag />}
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.employee_code}
                      {showWorkplace ? ` · ${r.workplace_name}` : ''}
                    </div>
                  </Td>
                  <Td>
                    <div className="text-gray-800">{r.shift_name}</div>
                    <div className="tabular text-xs text-gray-500" title={r.timezone}>
                      {r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}
                    </div>
                  </Td>
                  <Td>
                    {r.attendance_id ? (
                      <div className="flex flex-col items-start gap-1">
                        <span className="tabular text-gray-900" title={r.timezone ? `Shift time zone ${r.timezone}; shown in your local time` : undefined}>{fmtClock(r.recorded_at)}</span>
                        {r.is_late && <span className="text-xs text-amber-800">Late by {minutes(r.late_by_minutes)}</span>}
                        {r.verification_status !== 'VERIFIED' && <VerificationBadge status={r.verification_status} />}
                      </div>
                    ) : (
                      <span className="text-gray-500" aria-label="Not recorded">—</span>
                    )}
                  </Td>
                  <Td>
                    <StatusCell r={r} />
                  </Td>
                  <Td className="tabular">
                    {r.worked_minutes != null ? (
                      <div className="flex flex-col items-start">
                        <span className="text-gray-900">{minutes(r.worked_minutes)}</span>
                        {(r.in_progress || r.overtime_status || r.left_early) && (
                          <span className={r.left_early || r.overtime_status === 'PENDING' ? 'text-xs text-amber-800' : 'text-xs text-gray-500'}>
                            {[r.in_progress && r.overtime_status !== 'RUNNING' && 'so far', overtimeNote(r), r.left_early && 'left early'].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </div>
                    ) : r.pending_minutes != null ? (
                      <div className="flex flex-col items-start">
                        <span className="text-amber-800">{minutes(r.pending_minutes)}</span>
                        <span className="text-xs text-amber-800">pending, not counted</span>
                      </div>
                    ) : (
                      <span className="text-gray-500" aria-label="None">—</span>
                    )}
                  </Td>
                  <Td className="row-actions w-12 text-right">
                    <Menu
                      label={`Actions for ${r.full_name}`}
                      trigger={<MoreHorizontal className="h-4 w-4" aria-hidden />}
                      items={[
                        { label: 'Open employee', icon: <UserRound />, onSelect: () => onEmployee(r.employee_id) },
                        { label: 'Attendance records', icon: <ClipboardList />, href: `/attendance?employeeId=${r.employee_id}` },
                        ...(r.session_id && !r.ended_at ? [{ label: 'Show on live map', icon: <MapPin />, href: `/map?employee=${r.employee_id}` }] : []),
                        ...(r.attendance_id ? [{ label: 'Open attendance record', icon: <ExternalLink />, href: `/attendance?record=${r.attendance_id}` }] : []),
                        ...(r.overtime_status ? [{ label: r.overtime_status === 'PENDING' ? 'Approve overtime' : 'Overtime', icon: <Hourglass />, href: `/overtime?tab=${r.overtime_status === 'RUNNING' ? 'running' : r.overtime_status === 'PENDING' ? 'pending' : 'all'}` }] : []),
                      ]}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination offset={offset} limit={pageSize} total={visible.length} onChange={setOffset} noun="scheduled shift" />
        </>
      )}
    </section>
  );
}
