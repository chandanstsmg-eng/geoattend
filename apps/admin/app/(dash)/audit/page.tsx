'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Card, EmptyState, Input, PageHeader, Pagination, QueryState, Select, Table, Td, Th, Toolbar } from '@/components/ui';

const RESOURCE_TYPES = ['user', 'workplace', 'shift', 'attendance_record', 'attendance_photo', 'tracking_session', 'review_request', 'settings', 'retention', 'attendance_csv', 'absences_csv', 'shift_csv', 'demo'];

export default function AuditPage() {
  const [f, setF] = useState({ action: '', resourceType: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const limit = 100;
  const list = useQuery({ queryKey: ['audit', f, offset], queryFn: () => get(`/audit-logs${qs({ ...f, limit, offset })}`) });
  const set = (k: keyof typeof f) => (v: string) => { setOffset(0); setF({ ...f, [k]: v }); };

  return (
    <>
      <PageHeader title="Audit log" description="Append-only record of administrative changes and of every access to location history and attendance photos. Entries cannot be edited or deleted, even by administrators." />
      <Card padded={false}>
        <Toolbar>
          <Input aria-label="Action prefix" placeholder="Action (e.g. attendance., location_history)" value={f.action} onChange={(e) => set('action')(e.target.value)} className="w-72" />
          <Select aria-label="Resource type" value={f.resourceType} onChange={(e) => set('resourceType')(e.target.value)} className="w-auto">
            <option value="">All resources</option>
            {RESOURCE_TYPES.map((r) => <option key={r} value={r}>{r.replaceAll('_', ' ')}</option>)}
          </Select>
          <Input type="date" aria-label="From" value={f.from} onChange={(e) => set('from')(e.target.value)} className="w-auto" />
          <Input type="date" aria-label="To" value={f.to} onChange={(e) => set('to')(e.target.value)} className="w-auto" />
        </Toolbar>
        <QueryState query={list} isEmpty={(d: any) => d.items.length === 0} empty={<EmptyState title="No audit entries match" />}>
          {(d: any) => (
            <>
              <Table>
                <thead><tr><Th>Time</Th><Th>Actor</Th><Th>Action</Th><Th>Resource</Th><Th>Reason</Th><Th>Details</Th></tr></thead>
                <tbody>
                  {d.items.map((a: any) => (
                    <tr key={a.id}>
                      <Td className="whitespace-nowrap text-xs tabular">{fmtDateTime(a.created_at)}</Td>
                      <Td className="text-sm">{a.actor_name ?? 'System'} <span className="text-xs text-gray-500">{a.actor_role?.toLowerCase()}</span></Td>
                      <Td><code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-800">{a.action}</code></Td>
                      <Td className="text-xs">{a.resource_type}{a.resource_id && <div className="font-mono text-caption text-gray-500">{a.resource_id.slice(0, 13)}…</div>}</Td>
                      <Td className="max-w-xs text-sm">{a.reason ?? '—'}</Td>
                      <Td>
                        {(a.before_data || a.after_data) && (
                          <details>
                            <summary className="cursor-pointer text-xs text-primary-700">before / after</summary>
                            <div className="mt-1 grid max-w-xl gap-2 text-caption sm:grid-cols-2">
                              <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2">{a.before_data ? JSON.stringify(a.before_data, null, 1) : '—'}</pre>
                              <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2">{a.after_data ? JSON.stringify(a.after_data, null, 1) : '—'}</pre>
                            </div>
                          </details>
                        )}
                        {a.ip && <div className="text-caption text-gray-500">{a.ip}</div>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination offset={offset} limit={limit} total={d.total} onChange={setOffset} noun="entry" />
            </>
          )}
        </QueryState>
      </Card>
    </>
  );
}
