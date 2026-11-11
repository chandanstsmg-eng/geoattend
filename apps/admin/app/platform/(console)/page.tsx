'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { pget, type Company } from '@/lib/platform-api';
import { Card, EmptyState, LinkButton, PageHeader, QueryState, Table, Td, Th } from '@/components/ui';
import { StatusBadge, SubscriptionBadge, renewalText } from '@/components/platform-ui';

interface Overview {
  companies: number;
  byStatus: Record<string, number>;
  byEdition: Record<string, number>;
  bySubscription: Record<string, number>;
  activeEmployees: number;
  activeSupervisors: number;
  attention: Company[];
  settings: { graceDays: number; warningDays: number };
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-card">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="tabular mt-1 text-2xl font-semibold text-navy-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

export default function PlatformOverviewPage() {
  const q = useQuery({ queryKey: ['platform', 'overview'], queryFn: () => pget<Overview>('/overview') });
  return (
    <>
      <PageHeader title="Platform overview" description="Every company on GeoAttend, and the subscriptions that need attention." actions={<LinkButton href="/platform/companies/new" variant="primary"><Plus className="h-4 w-4" aria-hidden /> New company</LinkButton>} />
      <QueryState query={q}>
        {(d) => (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Companies" value={d.companies} hint={`${d.byStatus.SUSPENDED ?? 0} suspended`} />
              <Stat label="Active employees" value={d.activeEmployees} />
              <Stat label="Active supervisors" value={d.activeSupervisors} />
              <Stat label="Need attention" value={d.attention.length} hint={`Ending within ${d.settings.warningDays} days, in grace, expired or suspended`} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Card title="By edition">
                <ul className="space-y-1 text-sm">{Object.entries(d.byEdition).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span className="tabular">{v}</span></li>)}</ul>
              </Card>
              <Card title="By subscription">
                <ul className="space-y-1 text-sm">{Object.entries(d.bySubscription).map(([k, v]) => <li key={k} className="flex justify-between"><SubscriptionBadge state={k as any} /><span className="tabular">{v}</span></li>)}</ul>
              </Card>
            </div>
            <Card title="Needs attention" description={`Grace period after the renewal date: ${d.settings.graceDays} days. Data is never removed.`} padded={false}>
              {d.attention.length === 0 ? (
                <EmptyState title="Nothing needs attention" />
              ) : (
                <Table>
                  <thead><tr><Th>Company</Th><Th>Status</Th><Th>Subscription</Th><Th>Renewal date</Th><Th>Edition</Th></tr></thead>
                  <tbody>
                    {d.attention.map((c) => (
                      <tr key={c.id}>
                        <Td><Link href={`/platform/companies/${c.id}`} className="font-medium text-primary-700 underline-offset-2 hover:underline">{c.name}</Link></Td>
                        <Td><StatusBadge status={c.status} /></Td>
                        <Td><SubscriptionBadge state={c.subscription.state} /></Td>
                        <Td>{renewalText(c)}</Td>
                        <Td>{c.edition.name}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        )}
      </QueryState>
    </>
  );
}
