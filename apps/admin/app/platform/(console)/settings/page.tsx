'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pget, pput, type Edition, type PlatformSettings } from '@/lib/platform-api';
import { Button, Card, Field, InlineError, Input, PageHeader, QueryState, Select } from '@/components/ui';

export default function PlatformSettingsPage() {
  const q = useQuery({ queryKey: ['platform', 'settings'], queryFn: () => pget<PlatformSettings>('/settings') });
  return (
    <>
      <PageHeader title="Platform settings" description="Rules that apply to every company." />
      <QueryState query={q}>{(s) => <SettingsForm settings={s} />}</QueryState>
    </>
  );
}

function SettingsForm({ settings }: { settings: PlatformSettings }) {
  const qc = useQueryClient();
  const editions = useQuery({ queryKey: ['platform', 'editions'], queryFn: () => pget<Edition[]>('/editions') });
  const init = () => ({
    signupEnabled: settings.signup.enabled,
    editionCode: settings.signup.editionCode,
    trialDays: String(settings.signup.trialDays),
    graceDays: String(settings.subscriptions.graceDays),
    warningDays: String(settings.subscriptions.warningDays),
    email: settings.support.email ?? '',
    phone: settings.support.phone ?? '',
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    meta: { success: 'Platform settings saved' },
    mutationFn: () =>
      pput<PlatformSettings>('/settings', {
        signup: { enabled: f.signupEnabled, editionCode: f.editionCode, trialDays: Number(f.trialDays) },
        subscriptions: { graceDays: Number(f.graceDays), warningDays: Number(f.warningDays) },
        support: { email: f.email.trim() || null, phone: f.phone.trim() || null },
      }),
    onSuccess: (s) => qc.setQueryData(['platform', 'settings'], s),
  });
  return (
    <form className="grid max-w-3xl gap-5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Card title="Self sign-up" description="Whether businesses can create a company themselves from the sign-up page.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Self sign-up">
            <Select value={f.signupEnabled ? 'on' : 'off'} onChange={(e) => setF({ ...f, signupEnabled: e.target.value === 'on' })}>
              <option value="on">Open</option>
              <option value="off">Closed (companies are created here)</option>
            </Select>
          </Field>
          <Field label="Edition for new sign-ups">
            <Select value={f.editionCode} onChange={(e) => setF({ ...f, editionCode: e.target.value })}>
              {editions.data?.map((e) => <option key={e.code} value={e.code}>{e.name}</option>)}
            </Select>
          </Field>
          <Field label="Trial length (days)"><Input type="number" min={1} max={365} required value={f.trialDays} onChange={(e) => setF({ ...f, trialDays: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Subscriptions" description="After the renewal date and the grace period, a company becomes view and export only for its administrators. Data is never removed, and employees keep recording attendance.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Grace period (days)"><Input type="number" min={0} max={90} required value={f.graceDays} onChange={(e) => setF({ ...f, graceDays: e.target.value })} /></Field>
          <Field label="Warn owners this many days before" hint="Owners see a notice in their dashboard."><Input type="number" min={0} max={120} required value={f.warningDays} onChange={(e) => setF({ ...f, warningDays: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Support contact">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Support e-mail"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Support phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        </div>
      </Card>
      <InlineError error={save.error} />
      <div className="flex justify-end"><Button type="submit" variant="primary" loading={save.isPending}>Save settings</Button></div>
    </form>
  );
}
