'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { get } from '@/lib/api';
import { rowKeys, LinkButton, Badge, Button, Card, DemoTag, EmptyState, PageHeader, QueryState, rowLink, Table, Td, Th } from '@/components/ui';

export default function WorkplacesPage() {
  const router = useRouter();
  const list = useQuery({ queryKey: ['workplaces'], queryFn: () => get<any[]>('/workplaces') });
  const open = (id: string) => router.push(`/workplaces/${id}`);
  return (
    <>
      <PageHeader
        title="Workplaces"
        description="Attendance is accepted only after the server verifies the worker is inside the radius."
        actions={
          <LinkButton href="/workplaces/new" variant="primary">
              <Plus className="h-4 w-4" aria-hidden /> New workplace
            </LinkButton>
        }
      />
      <Card padded={false}>
        <QueryState
          query={list}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState title="No workplaces yet" icon={<Building2 aria-hidden />} action={<Link href="/workplaces/new" className="text-sm font-medium text-primary-700 hover:underline">Add your first workplace</Link>}>
              Create one to start assigning employees and shifts.
            </EmptyState>
          }
        >
          {(rows) => (
            <Table minWidth={760}>
              <thead>
                <tr>
                  <Th>Workplace</Th>
                  <Th className="text-right">Radius</Th>
                  <Th className="text-right">Employees</Th>
                  <Th className="text-right">On shift now</Th>
                  <Th>Absence alert</Th>
                  <Th>Time zone</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id} className={rowLink} tabIndex={0} onClick={() => open(w.id)} onKeyDown={rowKeys(() => open(w.id))} aria-label={`${w.name}, open workplace`}>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-gray-900">{w.name}</span>
                        {w.is_demo && <DemoTag />}
                      </div>
                      <div className="max-w-sm truncate text-xs text-gray-500" title={w.address || `${w.latitude.toFixed(6)}, ${w.longitude.toFixed(6)}`}>
                        {w.address || `No address · ${w.latitude.toFixed(5)}, ${w.longitude.toFixed(5)}`}
                      </div>
                    </Td>
                    <Td className="text-right tabular">{w.radius_m} m</Td>
                    <Td className="text-right tabular">{w.employee_count}</Td>
                    <Td className="text-right tabular">{w.open_sessions || <span className="text-gray-500">0</span>}</Td>
                    <Td className="tabular text-gray-600">after {w.absence_threshold_minutes} min</Td>
                    <Td className="text-gray-600">{w.timezone}</Td>
                    <Td>
                      <Badge dot tone={w.is_active ? 'green' : 'gray'}>{w.is_active ? 'Active' : 'Disabled'}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>
    </>
  );
}
