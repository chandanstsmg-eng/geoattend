'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pget, ppost, REGISTRATION_FIELDS, registrationPayload, type Company, type Edition } from '@/lib/platform-api';
import { todayISO } from '@/lib/format';
import { Button, Card, Field, InlineError, Input, LinkButton, PageHeader, Select, Textarea } from '@/components/ui';
import { OneTimeSecret } from '@/components/platform-ui';

type Created = { company: Company; owner: { id: string; email: string; invitation?: { url: string; expiresAt: string; emailed: boolean }; temporaryPassword?: string | null } };

export default function NewCompanyPage() {
  const qc = useQueryClient();
  const editions = useQuery({ queryKey: ['platform', 'editions'], queryFn: () => pget<Edition[]>('/editions') });
  const [f, setF] = useState({ name: '', phone: '', editionCode: '', status: 'ACTIVE' as 'ACTIVE' | 'TRIAL', startsOn: todayISO(), term: 'edition' as 'edition' | 'days' | 'date' | 'none', durationDays: '365', endsOn: '' });
  const [reg, setReg] = useState<Record<string, string>>({});
  const [owner, setOwner] = useState({ fullName: '', email: '', phone: '', delivery: 'invitation' as 'invitation' | 'temporary-password' });
  const [created, setCreated] = useState<Created | null>(null);
  const editionCode = f.editionCode || editions.data?.find((e) => e.isActive)?.code || '';
  const edition = editions.data?.find((e) => e.code === editionCode);

  const create = useMutation({
    mutationFn: () =>
      ppost<Created>('/companies', {
        name: f.name,
        phone: f.phone || undefined,
        registration: registrationPayload(reg),
        editionCode,
        subscription: {
          status: f.status,
          startsOn: f.startsOn || undefined,
          ...(f.term === 'days' ? { durationDays: Number(f.durationDays) } : f.term === 'date' ? { endsOn: f.endsOn } : f.term === 'none' ? { endsOn: null } : {}),
        },
        owner: { fullName: owner.fullName, email: owner.email, phone: owner.phone || undefined, delivery: owner.delivery },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['platform'] });
      setCreated(r);
    },
  });

  if (created)
    return (
      <>
        <PageHeader title={`${created.company.name} created`} description="The first owner’s sign-in details are shown once, below." />
        <Card className="max-w-2xl">
          <div className="space-y-4">
            <OneTimeSecret owner={created.owner} />
            <div className="flex flex-wrap justify-end gap-2">
              <LinkButton href="/platform/companies/new" onClick={() => setCreated(null)}>Create another</LinkButton>
              <LinkButton href={`/platform/companies/${created.company.id}`} variant="primary">Open company</LinkButton>
            </div>
          </div>
        </Card>
      </>
    );

  return (
    <>
      <PageHeader title="New company" eyebrow={<Link href="/platform/companies" className="underline-offset-2 hover:underline">Companies</Link>} description="The company gets the edition’s limits and modules, which you can change for it afterwards." />
      <form className="grid max-w-4xl gap-5" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Card title="Company">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company name" required><Input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          </div>
        </Card>
        <Card title="Registration details" description="Optional. Shown to platform administrators only.">
          <div className="grid gap-3 sm:grid-cols-2">
            {REGISTRATION_FIELDS.map((r) => (
              <div key={r.key} className={r.key === 'notes' || r.key === 'addressLine' ? 'sm:col-span-2' : ''}>
                <Field label={r.label}>
                  {r.key === 'notes' ? <Textarea value={reg[r.key] ?? ''} onChange={(e) => setReg({ ...reg, [r.key]: e.target.value })} /> : <Input type={r.type ?? 'text'} value={reg[r.key] ?? ''} onChange={(e) => setReg({ ...reg, [r.key]: e.target.value })} />}
                </Field>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Edition and subscription">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Edition" hint={edition ? `${edition.limits.employees ?? 'Unlimited'} employees, ${edition.limits.supervisors ?? 'unlimited'} supervisors, ${edition.defaultDurationDays}-day term.` : undefined}>
              <Select value={editionCode} onChange={(e) => setF({ ...f, editionCode: e.target.value })}>
                {editions.data?.filter((e) => e.isActive).map((e) => <option key={e.code} value={e.code}>{e.name}</option>)}
              </Select>
            </Field>
            <Field label="Subscription status">
              <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'ACTIVE' | 'TRIAL' })}>
                <option value="ACTIVE">Active (paid)</option>
                <option value="TRIAL">Trial</option>
              </Select>
            </Field>
            <Field label="Starts on"><Input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} /></Field>
            <Field label="Term">
              <Select value={f.term} onChange={(e) => setF({ ...f, term: e.target.value as typeof f.term })}>
                <option value="edition">The edition’s term{edition ? ` (${edition.defaultDurationDays} days)` : ''}</option>
                <option value="days">A number of days</option>
                <option value="date">Until a renewal date</option>
                <option value="none">No end date</option>
              </Select>
            </Field>
            {f.term === 'days' && <Field label="Days"><Input type="number" min={1} max={3660} required value={f.durationDays} onChange={(e) => setF({ ...f, durationDays: e.target.value })} /></Field>}
            {f.term === 'date' && <Field label="Renewal date (last day covered)"><Input type="date" required min={f.startsOn} value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></Field>}
          </div>
        </Card>
        <Card title="First owner">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name" required><Input required value={owner.fullName} onChange={(e) => setOwner({ ...owner, fullName: e.target.value })} /></Field>
            <Field label="E-mail" required><Input type="email" required value={owner.email} onChange={(e) => setOwner({ ...owner, email: e.target.value })} /></Field>
            <Field label="Mobile"><Input value={owner.phone} onChange={(e) => setOwner({ ...owner, phone: e.target.value })} /></Field>
            <Field label="First sign-in">
              <Select value={owner.delivery} onChange={(e) => setOwner({ ...owner, delivery: e.target.value as typeof owner.delivery })}>
                <option value="invitation">Send an invitation link (they choose their password)</option>
                <option value="temporary-password">Create a temporary password</option>
              </Select>
            </Field>
          </div>
        </Card>
        <InlineError error={create.error} />
        <div className="flex justify-end gap-2">
          <LinkButton href="/platform/companies">Cancel</LinkButton>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!editionCode}>Create company</Button>
        </div>
      </form>
    </>
  );
}
