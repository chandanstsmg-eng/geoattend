'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { get, qs } from '@/lib/api';
import { daysAgoISO, fmtDateTime, fmtTime, minutes, todayISO } from '@/lib/format';
import { rowKeys, LinkButton, Badge, Card, EmptyState, Input, PageHeader, Pagination, QueryState, rowLink, Select, SimBadge, Table, Td, Th, Toolbar } from '@/components/ui';
import { EmployeeSelect, WorkplaceSelect } from '@/components/filters';
import { EmployeeDrawer } from '@/components/employee-drawer';
import { useMe } from '@/lib/me';

const PAGE = 50;

export default function AbsencesPage() {
  const [f, setF] = useState({ from: daysAgoISO(7), to: todayISO(), workplaceId: '', employeeId: '', status: '', prolongedOnly: '' });
  const [emp, setEmp] = useState<string | null>(null);
  const { isOwner } = useMe();
  const [offset, setOffset] = useState(0);
  const list = useQuery({ queryKey: ['absences', f, offset], queryFn: () => get(`/absence-intervals${qs({ ...f, limit: PAGE, offset })}`), refetchInterval: 60_000, placeholderData: (p) => p });
  const set = (k: keyof typeof f) => (v: string) => {
    setF({ ...f, [k]: v });
    setOffset(0);
  };

  return (
    <>
      <PageHeader
        title="Absence events"
        description="An absence starts at the first reliable reading outside the geofence (after the exit is stabilised) and ends at a verified return or the end of the shift. Uncertain readings and tracking gaps never create absences."
      />
      <Card padded={false}>
        <Toolbar>
          <Input type="date" aria-label="From" value={f.from} onChange={(e) => set('from')(e.target.value)} className="w-auto" />
          <span className="text-sm text-gray-500">to</span>
          <Input type="date" aria-label="To" value={f.to} onChange={(e) => set('to')(e.target.value)} className="w-auto" />
          <WorkplaceSelect value={f.workplaceId} onChange={set('workplaceId')} />
          <EmployeeSelect value={f.employeeId} onChange={set('employeeId')} />
          <Select aria-label="Status" value={f.status} onChange={(e) => set('status')(e.target.value)} className="w-auto">
            <option value="">Any status</option>
            <option value="OPEN">Ongoing</option>
            <option value="RETURNED">Returned</option>
            <option value="SHIFT_ENDED">Closed at shift end</option>
          </Select>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={f.prolongedOnly === 'true'} onChange={(e) => set('prolongedOnly')(e.target.checked ? 'true' : '')} /> Prolonged only
          </label>
          {/* The detailed exports are owner-only on the server. */}
          {isOwner && (
            <LinkButton className="sm:ml-auto" href={`/api/v1/reports/absences.csv${qs({ from: f.from, to: f.to, workplaceId: f.workplaceId, employeeId: f.employeeId, includeSimulated: 'true' })}`} size="sm" variant="ghost"><Download className="h-4 w-4" aria-hidden /> CSV</LinkButton>
          )}
        </Toolbar>
        <QueryState query={list} isEmpty={(d: any) => d.items.length === 0} empty={<EmptyState title="No absences in this range" />}>
          {(d: any) => (
            <>
            <Table>
              <thead><tr><Th>Employee</Th><Th>Departed</Th><Th>Returned / closed</Th><Th>Duration</Th><Th>Status</Th><Th>Last known position</Th></tr></thead>
              <tbody>
                {d.items.map((a: any) => (
                  <tr key={a.id} className={rowLink} tabIndex={0} onClick={() => setEmp(a.employee_id)} onKeyDown={rowKeys(() => setEmp(a.employee_id))} aria-label={`${a.full_name}, open employee`}>
                    <Td><span className="font-medium text-gray-900">{a.full_name}</span> <span className="text-xs text-gray-500">{a.employee_code}</span><div className="text-xs text-gray-500">{a.workplace_name}</div></Td>
                    <Td className="tabular text-xs">{fmtDateTime(a.started_at)}</Td>
                    <Td className="tabular text-xs">{a.ended_at ? fmtDateTime(a.ended_at) : '—'}</Td>
                    <Td className="tabular">{minutes(a.duration_minutes)} <span className="text-xs text-gray-500">/ alert {a.threshold_minutes}m</span></Td>
                    <Td><div className="flex flex-wrap gap-1">
                      <Badge dot tone={a.status === 'OPEN' ? (a.prolonged_at ? 'red' : 'amber') : 'gray'}>{a.status === 'OPEN' ? 'Ongoing' : a.status === 'RETURNED' ? 'Returned' : 'Closed at shift end'}</Badge>
                      {a.prolonged_at && <Badge tone="red">prolonged</Badge>}
                      {a.tracking_gap && <Badge tone="orange" title="Location updates stopped during this absence">tracking gap</Badge>}
                      {a.is_simulated && <SimBadge />}
                    </div></Td>
                    <Td className="text-xs">{a.last_known_latitude != null ? <a className="font-medium text-primary-600 hover:underline" target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} href={`https://www.google.com/maps/search/?api=1&query=${a.last_known_latitude},${a.last_known_longitude}`}>Open on map</a> : '—'}{a.last_known_at && <span className="tabular block text-gray-500">last known {fmtTime(a.last_known_at)}</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination offset={offset} limit={PAGE} total={d.total ?? d.items.length} onChange={setOffset} noun="absence" />
            </>
          )}
        </QueryState>
      </Card>
      <EmployeeDrawer employeeId={emp} onClose={() => setEmp(null)} />
    </>
  );
}
