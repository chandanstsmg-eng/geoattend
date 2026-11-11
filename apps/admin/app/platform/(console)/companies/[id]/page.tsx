'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FEATURES, FEATURE_LABEL, pget, ppatch, ppost, pput, REGISTRATION_FIELDS, registrationPayload, type Company, type Edition, type Feature } from '@/lib/platform-api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Badge, Button, Callout, Card, EmptyState, Field, InlineError, Input, KeyValue, Modal, PageHeader, QueryState, Select, Table, Td, Textarea, Th } from '@/components/ui';
import { OneTimeSecret, StatusBadge, SubscriptionBadge, Usage, limitFromInput, limitToInput, renewalText } from '@/components/platform-ui';

interface Owner {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  invitation_open: boolean;
}
interface HistoryRow {
  id: number;
  action: string;
  before_data: unknown;
  after_data: unknown;
  reason: string | null;
  created_at: string;
  admin_name: string | null;
}
interface Detail {
  company: Company;
  owners: Owner[];
  history: HistoryRow[];
}

const ACTION: Record<string, string> = {
  'platform.company.create': 'Company created',
  'platform.company.update': 'Details edited',
  'platform.company.suspend': 'Suspended',
  'platform.company.activate': 'Reactivated',
  'platform.company.subscription': 'Subscription changed',
  'platform.company.renew': 'Renewed',
  'platform.company.add_owner': 'Owner added',
  'platform.company.invite_owner': 'Owner invitation sent again',
};

export default function CompanyPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['platform', 'company', id], queryFn: () => pget<Detail>(`/companies/${id}`) });
  return (
    <QueryState query={q}>
      {(d) => (
        <>
          <PageHeader
            eyebrow={<Link href="/platform/companies" className="underline-offset-2 hover:underline">Companies</Link>}
            title={d.company.name}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge status={d.company.status} /> <Badge tone="navy">{d.company.edition.name}</Badge> <SubscriptionBadge state={d.company.subscription.state} />
                <span>Created {fmtDate(d.company.createdAt)} · last sign-in {d.company.lastSignInAt ? fmtDateTime(d.company.lastSignInAt) : 'never'}</span>
              </span>
            }
          />
          <div className="grid gap-5 xl:grid-cols-2">
            <div className="space-y-5">
              <StatusCard company={d.company} />
              <SubscriptionCard company={d.company} />
            </div>
            <div className="space-y-5">
              <OwnersCard companyId={id} owners={d.owners} />
              <RegistrationCard company={d.company} />
              <HistoryCard history={d.history} />
            </div>
          </div>
        </>
      )}
    </QueryState>
  );
}

const useRefresh = (id: string) => {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['platform', 'company', id] });
    qc.invalidateQueries({ queryKey: ['platform', 'companies'] });
    qc.invalidateQueries({ queryKey: ['platform', 'overview'] });
  };
};

function StatusCard({ company }: { company: Company }) {
  const refresh = useRefresh(company.id);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const next = company.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
  const change = useMutation({
    meta: { success: next === 'SUSPENDED' ? 'Company suspended' : 'Company reactivated' },
    mutationFn: () => ppost(`/companies/${company.id}/status`, { status: next, reason }),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      refresh();
    },
  });
  return (
    <Card title="Status" actions={<Button variant={next === 'SUSPENDED' ? 'danger' : 'primary'} size="sm" onClick={() => setOpen(true)}>{next === 'SUSPENDED' ? 'Suspend…' : 'Reactivate…'}</Button>}>
      <KeyValue
        items={[
          ['Status', <StatusBadge key="s" status={company.status} />],
          ['Since', company.statusChangedAt ? fmtDateTime(company.statusChangedAt) : '—'],
          ['Reason', company.statusReason ?? '—'],
          ['Registered through', company.registrationSource.toLowerCase().replace('_', ' ')],
        ]}
      />
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={next === 'SUSPENDED' ? `Suspend ${company.name}?` : `Reactivate ${company.name}?`}
        description={next === 'SUSPENDED' ? 'Every owner, supervisor and employee of this company is signed out and cannot sign in until it is reactivated. No data is deleted.' : 'Its people can sign in again.'}
      >
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
          <Field label="Reason" hint="Recorded in the platform audit log and the company’s own audit log."><Textarea required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <InlineError error={change.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant={next === 'SUSPENDED' ? 'danger' : 'primary'} loading={change.isPending}>{next === 'SUSPENDED' ? 'Suspend company' : 'Reactivate company'}</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

type SubForm = { editionCode: string; employeeLimit: string; supervisorLimit: string; features: Record<Feature, boolean>; subscriptionStatus: Company['subscription']['status']; startsOn: string; endsOn: string; reason: string };
const toForm = (c: Company): SubForm => ({
  editionCode: c.edition.code,
  employeeLimit: limitToInput(c.limits.employees),
  supervisorLimit: limitToInput(c.limits.supervisors),
  features: { ...c.features },
  subscriptionStatus: c.subscription.status,
  startsOn: c.subscription.startsOn ?? '',
  endsOn: c.subscription.endsOn ?? '',
  reason: '',
});

function SubscriptionCard({ company }: { company: Company }) {
  const refresh = useRefresh(company.id);
  const editions = useQuery({ queryKey: ['platform', 'editions'], queryFn: () => pget<Edition[]>('/editions') });
  const [f, setF] = useState<SubForm>(() => toForm(company));
  const [warnings, setWarnings] = useState<string[]>([]);
  const [renewOpen, setRenewOpen] = useState(false);
  useEffect(() => setF(toForm(company)), [company]);
  const pickEdition = (code: string) => {
    const e = editions.data?.find((x) => x.code === code);
    // Picking an edition fills in its limits and modules; they can still be changed for this company before saving.
    setF(e ? { ...f, editionCode: code, employeeLimit: limitToInput(e.limits.employees), supervisorLimit: limitToInput(e.limits.supervisors), features: { ...e.features } } : { ...f, editionCode: code });
  };
  const save = useMutation({
    meta: { success: 'Subscription saved' },
    mutationFn: () =>
      pput<{ company: Company; warnings: string[] }>(`/companies/${company.id}/subscription`, {
        editionCode: f.editionCode,
        applyEditionDefaults: false,
        employeeLimit: limitFromInput(f.employeeLimit),
        supervisorLimit: limitFromInput(f.supervisorLimit),
        features: f.features,
        subscriptionStatus: f.subscriptionStatus,
        startsOn: f.startsOn || null,
        endsOn: f.endsOn || null,
        reason: f.reason || undefined,
      }),
    onSuccess: (r) => {
      setWarnings(r.warnings);
      refresh();
    },
  });
  return (
    <Card title="Edition and subscription" actions={<Button size="sm" onClick={() => setRenewOpen(true)}>Renew…</Button>}>
      <div className="mb-4">
        <KeyValue
          items={[
            ['Renewal date', renewalText(company)],
            ['Subscription', <SubscriptionBadge key="s" state={company.subscription.state} />],
            ['Employees', <Usage key="e" used={company.usage.employees} limit={company.limits.employees} />],
            ['Supervisors', <Usage key="s2" used={company.usage.supervisors} limit={company.limits.supervisors} />],
          ]}
        />
      </div>
      {company.subscription.readOnly && <Callout tone="danger" className="mb-4">Expired: the company’s administrators can view and export, but not change anything. Employees still record attendance. Renew to restore full access.</Callout>}
      <form className="space-y-3 border-t border-gray-100 pt-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Edition">
            <Select value={f.editionCode} onChange={(e) => pickEdition(e.target.value)}>
              {editions.data?.map((e) => <option key={e.code} value={e.code}>{e.name}{e.isActive ? '' : ' (no longer offered)'}</option>)}
            </Select>
          </Field>
          <Field label="Subscription status">
            <Select value={f.subscriptionStatus} onChange={(e) => setF({ ...f, subscriptionStatus: e.target.value as SubForm['subscriptionStatus'] })}>
              <option value="ACTIVE">Active (paid)</option>
              <option value="TRIAL">Trial</option>
              <option value="CANCELLED">Cancelled (runs to the renewal date)</option>
            </Select>
          </Field>
          <Field label="Employee limit" hint="Blank: no limit."><Input type="number" min={0} value={f.employeeLimit} onChange={(e) => setF({ ...f, employeeLimit: e.target.value })} /></Field>
          <Field label="Supervisor limit" hint="Blank: no limit."><Input type="number" min={0} value={f.supervisorLimit} onChange={(e) => setF({ ...f, supervisorLimit: e.target.value })} /></Field>
          <Field label="Starts on"><Input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} /></Field>
          <Field label="Renewal date" hint="Last day covered. Blank: no end date."><Input type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></Field>
        </div>
        <Field label="Optional modules" hint="Attendance, GPS, leave, reports, exports, SOS and notifications are always included. Payroll also needs the server switch.">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {FEATURES.map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.features[k]} onChange={(e) => setF({ ...f, features: { ...f.features, [k]: e.target.checked } })} /> {FEATURE_LABEL[k]}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Reason (optional)"><Input value={f.reason} maxLength={500} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {warnings.map((w) => <Callout key={w} tone="warning">{w}</Callout>)}
        <InlineError error={save.error} />
        <div className="flex justify-end"><Button type="submit" variant="primary" loading={save.isPending}>Save subscription</Button></div>
      </form>
      <RenewDialog company={company} open={renewOpen} onOpenChange={setRenewOpen} />
    </Card>
  );
}

function RenewDialog({ company, open, onOpenChange }: { company: Company; open: boolean; onOpenChange: (o: boolean) => void }) {
  const refresh = useRefresh(company.id);
  const [mode, setMode] = useState<'edition' | 'days' | 'date'>('edition');
  const [days, setDays] = useState('365');
  const [endsOn, setEndsOn] = useState('');
  const renew = useMutation({
    meta: { success: 'Subscription renewed' },
    mutationFn: () => ppost(`/companies/${company.id}/renew`, mode === 'days' ? { durationDays: Number(days) } : mode === 'date' ? { endsOn } : {}),
    onSuccess: () => {
      onOpenChange(false);
      refresh();
    },
  });
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`Renew ${company.name}`} description="Extends from the current renewal date, or from today if it has already passed. The status becomes Active.">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); renew.mutate(); }}>
        <Field label="Extend by">
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="edition">The edition’s term</option>
            <option value="days">A number of days</option>
            <option value="date">Until a date</option>
          </Select>
        </Field>
        {mode === 'days' && <Field label="Days"><Input type="number" min={1} max={3660} required value={days} onChange={(e) => setDays(e.target.value)} /></Field>}
        {mode === 'date' && <Field label="New renewal date"><Input type="date" required value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></Field>}
        <InlineError error={renew.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={renew.isPending}>Renew</Button>
        </div>
      </form>
    </Modal>
  );
}

function RegistrationCard({ company }: { company: Company }) {
  const refresh = useRefresh(company.id);
  const init = () => ({ name: company.name, phone: company.phone ?? '', reg: { ...company.registration } as Record<string, string> });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [company]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    meta: { success: 'Company details saved' },
    mutationFn: () => ppatch(`/companies/${company.id}`, { name: f.name, phone: f.phone || null, registration: registrationPayload(f.reg) }),
    onSuccess: refresh,
  });
  return (
    <Card title="Company and registration details">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Company name"><Input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        {REGISTRATION_FIELDS.map((r) => (
          <div key={r.key} className={r.key === 'notes' || r.key === 'addressLine' ? 'sm:col-span-2' : ''}>
            <Field label={r.label}>
              {r.key === 'notes' ? (
                <Textarea value={f.reg[r.key] ?? ''} onChange={(e) => setF({ ...f, reg: { ...f.reg, [r.key]: e.target.value } })} />
              ) : (
                <Input type={r.type ?? 'text'} value={f.reg[r.key] ?? ''} onChange={(e) => setF({ ...f, reg: { ...f.reg, [r.key]: e.target.value } })} />
              )}
            </Field>
          </div>
        ))}
        <div className="sm:col-span-2"><InlineError error={save.error} /></div>
        <div className="flex justify-end sm:col-span-2"><Button type="submit" variant="primary" loading={save.isPending}>Save details</Button></div>
      </form>
    </Card>
  );
}

type Secret = { email: string; invitation?: { url: string; expiresAt: string; emailed: boolean }; temporaryPassword?: string | null };

function OwnersCard({ companyId, owners }: { companyId: string; owners: Owner[] }) {
  const refresh = useRefresh(companyId);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ fullName: '', email: '', phone: '', delivery: 'invitation' as 'invitation' | 'temporary-password' });
  const reinvite = useMutation({
    mutationFn: (o: Owner) => ppost<{ invitation: Secret['invitation'] }>(`/companies/${companyId}/owners/${o.id}/invitation`).then((r) => ({ email: o.email, invitation: r.invitation })),
    onSuccess: (s) => {
      setSecret(s);
      refresh();
    },
  });
  const add = useMutation({
    mutationFn: () => ppost<{ owner: Secret }>(`/companies/${companyId}/owners`, { ...f, phone: f.phone || undefined }),
    onSuccess: (r) => {
      setAdding(false);
      setF({ fullName: '', email: '', phone: '', delivery: 'invitation' });
      setSecret(r.owner);
      refresh();
    },
  });
  return (
    <Card title="Owners" padded={false} actions={<Button size="sm" onClick={() => setAdding(true)}>Add owner…</Button>}>
      {owners.length === 0 ? (
        <EmptyState title="No owner yet" />
      ) : (
        <Table stack={false} minWidth={480}>
          <thead><tr><Th>Owner</Th><Th>Last sign-in</Th><Th label="Actions" /></tr></thead>
          <tbody>
            {owners.map((o) => (
              <tr key={o.id}>
                <Td>
                  <span className="font-medium text-gray-900">{o.full_name}</span> {!o.is_active && <Badge tone="gray">Deactivated</Badge>}
                  <span className="block text-xs text-gray-500">{o.email}</span>
                </Td>
                <Td>{o.last_login_at ? fmtDateTime(o.last_login_at) : o.invitation_open ? 'Never (invitation open)' : 'Never'}</Td>
                <Td className="text-right">
                  {o.is_active && !o.last_login_at && (
                    <Button size="sm" loading={reinvite.isPending && reinvite.variables?.id === o.id} onClick={() => reinvite.mutate(o)}>Send invitation again</Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <div className="px-4 pb-3"><InlineError error={reinvite.error} /></div>
      <Modal open={adding} onOpenChange={setAdding} title="Add an owner" description="For example when the first owner has left. They get full access to this company.">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Full name"><Input required value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
          <Field label="E-mail"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Mobile"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="First sign-in">
            <Select value={f.delivery} onChange={(e) => setF({ ...f, delivery: e.target.value as typeof f.delivery })}>
              <option value="invitation">Send an invitation link</option>
              <option value="temporary-password">Create a temporary password</option>
            </Select>
          </Field>
          <div className="sm:col-span-2"><InlineError error={add.error} /></div>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={add.isPending}>Add owner</Button>
          </div>
        </form>
      </Modal>
      <Modal open={!!secret} onOpenChange={(o) => !o && setSecret(null)} title="Owner sign-in details" description="Shown once.">
        {secret && <OneTimeSecret owner={secret} />}
      </Modal>
    </Card>
  );
}

function HistoryCard({ history }: { history: HistoryRow[] }) {
  return (
    <Card title="Platform history" description="The latest 50 platform changes to this company." padded={false}>
      {history.length === 0 ? (
        <EmptyState title="No platform changes yet" />
      ) : (
        <ul className="divide-y divide-gray-100">
          {history.map((h) => (
            <li key={h.id} className="px-4 py-2.5 text-sm">
              <p className="font-medium text-gray-900">{ACTION[h.action] ?? h.action}</p>
              <p className="text-xs text-gray-500">
                {fmtDateTime(h.created_at)} · {h.admin_name ?? 'System'}
                {h.reason ? ` · ${h.reason}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
