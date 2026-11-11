'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FEATURES, FEATURE_LABEL, pget, ppatch, type Edition, type Feature } from '@/lib/platform-api';
import { Badge, Button, Callout, Card, Field, InlineError, Input, PageHeader, QueryState, Textarea } from '@/components/ui';
import { limitFromInput, limitToInput } from '@/components/platform-ui';

export default function EditionsPage() {
  const q = useQuery({ queryKey: ['platform', 'editions'], queryFn: () => pget<Edition[]>('/editions') });
  return (
    <>
      <PageHeader title="Editions" description="The limits, modules and term a company gets when it is assigned an edition." />
      <Callout tone="info" className="mb-5">Changing an edition affects companies assigned it from now on. Companies that already have it keep their own limits and modules; change those on the company’s page.</Callout>
      <QueryState query={q}>
        {(rows) => (
          <div className="grid gap-5 lg:grid-cols-3">
            {rows.map((e) => <EditionCard key={e.code} edition={e} />)}
          </div>
        )}
      </QueryState>
    </>
  );
}

function EditionCard({ edition }: { edition: Edition }) {
  const qc = useQueryClient();
  const init = () => ({
    name: edition.name,
    description: edition.description ?? '',
    employeeLimit: limitToInput(edition.limits.employees),
    supervisorLimit: limitToInput(edition.limits.supervisors),
    features: { ...edition.features } as Record<Feature, boolean>,
    defaultDurationDays: String(edition.defaultDurationDays),
    isActive: edition.isActive,
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [edition]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    meta: { success: `${edition.name} saved` },
    mutationFn: () =>
      ppatch(`/editions/${edition.code}`, {
        name: f.name,
        description: f.description || null,
        employeeLimit: limitFromInput(f.employeeLimit),
        supervisorLimit: limitFromInput(f.supervisorLimit),
        features: f.features,
        defaultDurationDays: Number(f.defaultDurationDays),
        isActive: f.isActive,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'editions'] }),
  });
  return (
    <Card title={<span className="flex items-center gap-2">{edition.name} <Badge tone="gray">{edition.code}</Badge></span>} description={`${edition.companies ?? 0} compan${edition.companies === 1 ? 'y' : 'ies'}`}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description"><Textarea maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Employee limit" hint="Blank: no limit."><Input type="number" min={0} value={f.employeeLimit} onChange={(e) => setF({ ...f, employeeLimit: e.target.value })} /></Field>
          <Field label="Supervisor limit" hint="Blank: no limit."><Input type="number" min={0} value={f.supervisorLimit} onChange={(e) => setF({ ...f, supervisorLimit: e.target.value })} /></Field>
        </div>
        <Field label="Term (days)"><Input type="number" min={1} max={3660} required value={f.defaultDurationDays} onChange={(e) => setF({ ...f, defaultDurationDays: e.target.value })} /></Field>
        <Field label="Optional modules">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {FEATURES.map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.features[k]} onChange={(e) => setF({ ...f, features: { ...f.features, [k]: e.target.checked } })} /> {FEATURE_LABEL[k]}
              </label>
            ))}
          </div>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Offered to new companies
        </label>
        <InlineError error={save.error} />
        <div className="flex justify-end"><Button type="submit" variant="primary" loading={save.isPending}>Save</Button></div>
      </form>
    </Card>
  );
}
