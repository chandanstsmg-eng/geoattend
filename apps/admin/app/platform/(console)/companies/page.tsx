'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { pget, qs, type Company, type Edition } from '@/lib/platform-api';
import { useDebounced } from '@/lib/use-debounced';
import { fmtDate } from '@/lib/format';
import { Card, EmptyState, LinkButton, PageHeader, Pagination, QueryState, rowKeys, rowLink, SearchInput, Select, Table, Td, Th, Toolbar } from '@/components/ui';
import { StatusBadge, SubscriptionBadge, Usage, renewalText } from '@/components/platform-ui';

const PAGE = 50;

export default function CompaniesPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [edition, setEdition] = useState('');
  const [subscription, setSubscription] = useState('');
  const [offset, setOffset] = useState(0);
  const s = useDebounced(search, 300);
  const editions = useQuery({ queryKey: ['platform', 'editions'], queryFn: () => pget<Edition[]>('/editions') });
  const list = useQuery({
    queryKey: ['platform', 'companies', s, status, edition, subscription, offset],
    queryFn: () => pget<{ total: number; companies: Company[] }>(`/companies${qs({ search: s, status, edition, subscription, limit: PAGE, offset })}`),
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOffset(0);
  };
  return (
    <>
      <PageHeader title="Companies" description="Status, edition, people in use against the plan’s limits, and renewal dates." actions={<LinkButton href="/platform/companies/new" variant="primary"><Plus className="h-4 w-4" aria-hidden /> New company</LinkButton>} />
      <Card padded={false}>
        <div className="border-b border-gray-200 p-3">
          <Toolbar>
            <SearchInput placeholder="Name, legal name or owner e-mail" value={search} onChange={(e) => reset(setSearch)(e.target.value)} aria-label="Search companies" className="w-72" />
            <Select value={status} onChange={(e) => reset(setStatus)(e.target.value)} aria-label="Status" className="w-auto">
              <option value="">Any status</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
            </Select>
            <Select value={edition} onChange={(e) => reset(setEdition)(e.target.value)} aria-label="Edition" className="w-auto">
              <option value="">Any edition</option>
              {editions.data?.map((e) => <option key={e.code} value={e.code}>{e.name}</option>)}
            </Select>
            <Select value={subscription} onChange={(e) => reset(setSubscription)(e.target.value)} aria-label="Subscription" className="w-auto">
              <option value="">Any subscription</option>
              <option value="ACTIVE">Active</option>
              <option value="TRIAL">Trial</option>
              <option value="EXPIRING">Ending soon</option>
              <option value="GRACE">Grace period</option>
              <option value="EXPIRED">Expired</option>
            </Select>
          </Toolbar>
        </div>
        <QueryState query={list} isEmpty={(d) => d.companies.length === 0} empty={<EmptyState title="No companies match" />}>
          {(d) => (
            <>
              <Table minWidth={900}>
                <thead>
                  <tr><Th>Company</Th><Th>Status</Th><Th>Edition</Th><Th>Employees</Th><Th>Supervisors</Th><Th>Subscription</Th><Th>Renewal date</Th><Th>Created</Th></tr>
                </thead>
                <tbody>
                  {d.companies.map((c) => {
                    const open = () => router.push(`/platform/companies/${c.id}`);
                    return (
                      <tr key={c.id} className={rowLink} tabIndex={0} onClick={open} onKeyDown={rowKeys(open)}>
                        <Td><span className="font-medium text-gray-900">{c.name}</span>{c.registration.legalName && <span className="block text-xs text-gray-500">{c.registration.legalName}</span>}</Td>
                        <Td><StatusBadge status={c.status} /></Td>
                        <Td>{c.edition.name}</Td>
                        <Td><Usage used={c.usage.employees} limit={c.limits.employees} /></Td>
                        <Td><Usage used={c.usage.supervisors} limit={c.limits.supervisors} /></Td>
                        <Td><SubscriptionBadge state={c.subscription.state} /></Td>
                        <Td>{renewalText(c)}</Td>
                        <Td>{fmtDate(c.createdAt)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <Pagination offset={offset} limit={PAGE} total={d.total} onChange={setOffset} noun="company" />
            </>
          )}
        </QueryState>
      </Card>
    </>
  );
}
