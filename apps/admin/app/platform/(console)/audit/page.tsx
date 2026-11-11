'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { pget, qs } from '@/lib/platform-api';
import { fmtDateTime } from '@/lib/format';
import { Button, Card, EmptyState, PageHeader, QueryState, Table, Td, Th } from '@/components/ui';

interface Row {
  id: number;
  action: string;
  org_id: string | null;
  org_name: string | null;
  target_type: string;
  target_id: string | null;
  reason: string | null;
  ip: string | null;
  created_at: string;
  admin_email: string | null;
  admin_name: string | null;
}
const PAGE = 100;

export default function PlatformAuditPage() {
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: ['platform', 'audit', offset], queryFn: () => pget<Row[]>(`/audit${qs({ limit: PAGE, offset })}`) });
  return (
    <>
      <PageHeader title="Platform audit log" description="Every platform sign-in and change, newest first. Entries cannot be edited or deleted." />
      <Card padded={false}>
        <QueryState query={q} isEmpty={(d) => d.length === 0 && offset === 0} empty={<EmptyState title="No entries yet" />}>
          {(rows) => (
            <>
              <Table minWidth={800}>
                <thead><tr><Th>When</Th><Th>Who</Th><Th>Action</Th><Th>Company</Th><Th>Reason</Th><Th>Address</Th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <Td>{fmtDateTime(r.created_at)}</Td>
                      <Td>{r.admin_name ?? 'System'}{r.admin_email && <span className="block text-xs text-gray-500">{r.admin_email}</span>}</Td>
                      <Td><code className="text-xs">{r.action}</code></Td>
                      <Td>{r.org_id ? <Link href={`/platform/companies/${r.org_id}`} className="text-primary-700 underline-offset-2 hover:underline">{r.org_name ?? r.org_id}</Link> : '—'}</Td>
                      <Td>{r.reason ?? '—'}</Td>
                      <Td>{r.ip ?? '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="flex justify-end gap-2 p-3">
                <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</Button>
                <Button size="sm" disabled={rows.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Older</Button>
              </div>
            </>
          )}
        </QueryState>
      </Card>
    </>
  );
}
