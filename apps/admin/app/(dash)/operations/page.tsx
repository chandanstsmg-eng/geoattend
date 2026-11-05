'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useMe } from '@/lib/me';
import { Badge, Button, Callout, Card, EmptyState, Field, Input, PageHeader, Pagination, QueryState, Select, Table, Tabs, Td, Th, Toolbar } from '@/components/ui';

/**
 * For whoever runs the platform, not for companies: it covers every company, so it needs the operations
 * token as well as an owner's sign-in. The token stays in this page's memory: it is never stored, and
 * leaving the page forgets it. It deliberately has no link in the menu.
 */
type Tone = 'green' | 'amber' | 'red' | 'gray' | 'blue';
const STATE_TONE: Record<string, Tone> = { RUNNING: 'blue', SCHEDULED: 'green', PENDING: 'gray', NEVER_RUN: 'gray', RETRYING: 'amber', FAILED: 'red', INTERRUPTED: 'amber', OK: 'green', TIMED_OUT: 'red' };
const LEVEL_TONE: Record<string, Tone> = { ok: 'green', warn: 'amber', fail: 'red', off: 'gray' };
const STATUSES = ['OK', 'FAILED', 'TIMED_OUT', 'INTERRUPTED'];
const CHECKS: Array<[string, string]> = [['api', 'API'], ['database', 'Database'], ['worker', 'Background worker'], ['jobs', 'Jobs'], ['queue', 'Notification queue'], ['storage', 'Photo storage'], ['backups', 'Backups'], ['alerts', 'Alerts']];

const when = (v?: string | null) => (v ? fmtDateTime(v) : '—');
const took = (ms?: number | null) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

async function ops<T = any>(token: string, path: string): Promise<T> {
  const res = await fetch(`/api/v1/ops${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (res.status === 404) throw new Error('That token was not accepted, or monitoring is not switched on for this server.');
  const body = await res.json().catch(() => null);
  if (!res.ok && !(path === '/health' && res.status === 503)) throw new Error(body?.error?.message ?? `The server answered ${res.status}.`);
  return body as T;
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular ${tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : 'text-gray-900'}`}>{value}</div>
    </div>
  );
}

function checkDetail(key: string, c: any) {
  if (c?.message) return c.message;
  if (key === 'api') return `Up for ${Math.round((c.uptimeSeconds ?? 0) / 60)} minutes`;
  if (key === 'database') return `${c.connections} of ${c.maxConnections} connections, ${c.latencyMs} ms`;
  if (key === 'jobs') return `${c.failing} failing, ${c.stalled?.length ?? 0} stuck, ${c.interrupted?.length ?? 0} interrupted`;
  if (key === 'queue') return `${c.notificationsDue} due, ${c.notificationsGaveUp24h} gave up today, ${c.reportsGaveUp7d} summaries gave up this week`;
  if (key === 'storage') return `Reachable (${c.driver})`;
  if (key === 'alerts') return `${c.open} open${c.channel ? '' : ', no alert channel set up'}`;
  return '';
}

function Overview({ token }: { token: string }) {
  const health = useQuery({ queryKey: ['ops-health', token], queryFn: () => ops(token, '/health'), refetchInterval: 15_000 });
  const jobs = useQuery({ queryKey: ['ops-jobs', token], queryFn: () => ops(token, '/jobs'), refetchInterval: 15_000 });
  return (
    <>
      <QueryState query={jobs}>
        {(d: any) => (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <Stat label="Total jobs" value={d.summary.total} />
              <Stat label="Running" value={d.summary.running} />
              <Stat label="Pending" value={d.summary.pending} />
              <Stat label="Retrying" value={d.summary.retrying} tone={d.summary.retrying ? 'amber' : undefined} />
              <Stat label="Failing now" value={d.summary.failed} tone={d.summary.failed ? 'red' : undefined} />
              <Stat label="Runs completed / failed" value={`${d.summary.completedRuns} / ${d.summary.failedRuns}`} />
            </div>
            <Card padded={false} title="Jobs" className="mb-4">
              <Table>
                <thead><tr><Th>Job</Th><Th>State</Th><Th>Last success</Th><Th>Last failure</Th><Th>Took</Th><Th>Next run</Th><Th>Failure reason</Th></tr></thead>
                <tbody>
                  {d.jobs.map((j: any) => (
                    <tr key={j.job}>
                      <Td className="font-mono text-xs">{j.job}</Td>
                      <Td><Badge tone={STATE_TONE[j.state] ?? 'gray'}>{j.state.replace('_', ' ').toLowerCase()}</Badge></Td>
                      <Td className="whitespace-nowrap text-xs tabular">{when(j.last_ok_at)}</Td>
                      <Td className="whitespace-nowrap text-xs tabular">{when(j.last_failed_at)}</Td>
                      <Td className="text-xs tabular">{took(j.last_duration_ms)}</Td>
                      <Td className="whitespace-nowrap text-xs tabular">{when(j.next_run_at)}</Td>
                      <Td className="max-w-xs text-xs">{j.last_error ?? '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </>
        )}
      </QueryState>
      <QueryState query={health}>
        {(h: any) => (
          <Card padded={false} title="Health">
            <Table>
              <tbody>
                {CHECKS.map(([key, label]) => (
                  <tr key={key}>
                    <Td className="text-sm">{label}</Td>
                    <Td><Badge tone={LEVEL_TONE[h.checks[key]?.status] ?? 'gray'}>{h.checks[key]?.status === 'off' ? 'not monitored' : h.checks[key]?.status}</Badge></Td>
                    <Td className="text-xs">{checkDetail(key, h.checks[key])}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </QueryState>
    </>
  );
}

function History({ token, kind }: { token: string; kind: 'runs' | 'failures' }) {
  const [f, setF] = useState({ job: '', status: '', company: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const set = (k: keyof typeof f) => (v: string) => { setOffset(0); setF({ ...f, [k]: v }); };
  const jobs = useQuery({ queryKey: ['ops-jobs', token], queryFn: () => ops(token, '/jobs') });
  const companies = useQuery({ queryKey: ['ops-companies', token], queryFn: () => ops(token, '/companies') });
  const list = useQuery({ queryKey: ['ops', kind, token, f, offset], queryFn: () => ops(token, `/${kind}${qs({ ...f, limit, offset })}`) });
  return (
    <Card padded={false}>
      <Toolbar>
        <Select aria-label="Job" value={f.job} onChange={(e) => set('job')(e.target.value)} className="w-auto">
          <option value="">All jobs</option>
          {jobs.data?.jobs.map((j: any) => <option key={j.job} value={j.job}>{j.job}</option>)}
        </Select>
        {kind === 'runs' && (
          <Select aria-label="Status" value={f.status} onChange={(e) => set('status')(e.target.value)} className="w-auto">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
          </Select>
        )}
        <Select aria-label="Company" value={f.company} onChange={(e) => set('company')(e.target.value)} className="w-auto">
          <option value="">All companies</option>
          {companies.data?.items.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Input type="date" aria-label="From" value={f.from} onChange={(e) => set('from')(e.target.value)} className="w-auto" />
        <Input type="date" aria-label="To" value={f.to} onChange={(e) => set('to')(e.target.value)} className="w-auto" />
      </Toolbar>
      <QueryState query={list} isEmpty={(d: any) => d.items.length === 0} empty={<EmptyState title="Nothing matches" />}>
        {(d: any) => (
          <>
            {kind === 'runs' ? (
              <Table>
                <thead><tr><Th>Started</Th><Th>Job</Th><Th>Status</Th><Th>Took</Th><Th>Companies</Th><Th>Failures</Th><Th>Reason</Th></tr></thead>
                <tbody>
                  {d.items.map((r: any) => (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap text-xs tabular">{when(r.started_at)}</Td>
                      <Td className="font-mono text-xs">{r.job}</Td>
                      <Td><Badge tone={STATE_TONE[r.status] ?? 'gray'}>{r.status.replace('_', ' ').toLowerCase()}</Badge></Td>
                      <Td className="text-xs tabular">{took(r.duration_ms)}</Td>
                      <Td className="text-xs tabular">{r.companies}{r.companies_failed ? ` (${r.companies_failed} failed)` : ''}</Td>
                      <Td className="text-xs tabular">{r.failures}</Td>
                      <Td className="max-w-xs text-xs">{r.error ?? '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <Table>
                <thead><tr><Th>When</Th><Th>Job</Th><Th>Company</Th><Th>Reason</Th></tr></thead>
                <tbody>
                  {d.items.map((x: any) => (
                    <tr key={x.id}>
                      <Td className="whitespace-nowrap text-xs tabular">{when(x.at)}</Td>
                      <Td className="font-mono text-xs">{x.job}</Td>
                      <Td className="text-xs">{x.company ?? '—'}</Td>
                      <Td className="max-w-md text-xs">{x.message}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <Pagination offset={offset} limit={limit} total={d.total} onChange={setOffset} noun={kind === 'runs' ? 'run' : 'failure'} />
          </>
        )}
      </QueryState>
    </Card>
  );
}

function Alerts({ token }: { token: string }) {
  const list = useQuery({ queryKey: ['ops-alerts', token], queryFn: () => ops(token, '/alerts'), refetchInterval: 30_000 });
  return (
    <Card padded={false}>
      <QueryState query={list} isEmpty={(d: any) => d.items.length === 0} empty={<EmptyState title="No alerts" />}>
        {(d: any) => (
          <Table>
            <thead><tr><Th>Opened</Th><Th>Severity</Th><Th>Problem</Th><Th>Told</Th><Th>Closed</Th></tr></thead>
            <tbody>
              {d.items.map((a: any) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-xs tabular">{when(a.opened_at)}</Td>
                  <Td><Badge tone={a.severity === 'CRITICAL' ? 'red' : 'amber'}>{a.severity.toLowerCase()}</Badge></Td>
                  <Td className="max-w-md text-sm">{a.message}</Td>
                  <Td className="text-xs">{a.notified_at ? when(a.notified_at) : (a.notify_error ?? 'Not yet')}</Td>
                  <Td className="whitespace-nowrap text-xs tabular">{a.closed_at ? when(a.closed_at) : 'Open'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
    </Card>
  );
}

function Backups({ token }: { token: string }) {
  const list = useQuery({ queryKey: ['ops-backups', token], queryFn: () => ops(token, '/backups') });
  return (
    <Card padded={false}>
      <QueryState query={list} isEmpty={(d: any) => d.items.length === 0} empty={<EmptyState title="No backups found on this server" />}>
        {(d: any) => (
          <>
            {!d.monitored && <div className="p-3"><Callout tone="warning">Backups are not monitored on this server, so nothing warns if they stop.</Callout></div>}
            <Table>
              <thead><tr><Th>Backup</Th><Th>Made</Th><Th>Result</Th><Th>Check</Th><Th>Size</Th><Th>Problem</Th></tr></thead>
              <tbody>
                {d.items.map((b: any) => (
                  <tr key={b.name}>
                    <Td className="font-mono text-xs">{b.name}</Td>
                    <Td className="whitespace-nowrap text-xs tabular">{when(b.createdAt)}</Td>
                    <Td className="text-xs">{b.result?.replace('_', ' ').toLowerCase() ?? '—'}</Td>
                    <Td><Badge tone={b.status === 'OK' ? 'green' : 'red'}>{b.status.replace('_', ' ').toLowerCase()}</Badge></Td>
                    <Td className="text-xs tabular">{Math.round(b.sizeBytes / 1048576)} MB</Td>
                    <Td className="max-w-xs text-xs">{b.problem ?? '—'}</Td>
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

type Tab = 'overview' | 'runs' | 'failures' | 'alerts' | 'backups';
const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'runs', label: 'Run history' },
  { value: 'failures', label: 'Failures' },
  { value: 'alerts', label: 'Alerts' },
  { value: 'backups', label: 'Backups' },
];

export default function OperationsPage() {
  const { isOwner } = useMe();
  const [entry, setEntry] = useState('');
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState('');
  const [tab, setTab] = useState<Tab>('overview');

  if (!isOwner) return <EmptyState title="Not available" />;

  const open = async (e: FormEvent) => {
    e.preventDefault();
    setProblem('');
    try {
      await ops(entry.trim(), '/jobs');
      setToken(entry.trim());
      setEntry('');
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  return (
    <>
      <PageHeader title="Operations" description="Background jobs, health and backups across the whole platform. For whoever runs the server." />
      {!token ? (
        <Card className="max-w-md">
          <form onSubmit={open} className="space-y-3">
            <Field label="Operations token" hint="OPS_TOKEN from the server's settings. It is kept only until you leave this page." error={problem || undefined}>
              <Input type="password" autoComplete="off" value={entry} onChange={(e) => setEntry(e.target.value)} />
            </Field>
            <Button type="submit" disabled={!entry.trim()}>Open</Button>
          </form>
        </Card>
      ) : (
        <>
          <Tabs value={tab} onChange={setTab} tabs={TABS} label="Operations" className="mb-4" />
          {tab === 'overview' && <Overview token={token} />}
          {(tab === 'runs' || tab === 'failures') && <History key={tab} token={token} kind={tab} />}
          {tab === 'alerts' && <Alerts token={token} />}
          {tab === 'backups' && <Backups token={token} />}
        </>
      )}
    </>
  );
}
