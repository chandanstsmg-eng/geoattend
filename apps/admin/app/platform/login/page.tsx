'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ppost } from '@/lib/platform-api';
import { Button, Field, InlineError, Input } from '@/components/ui';
import { AuthShell } from '@/components/auth-shell';

function Form() {
  const router = useRouter();
  const params = useSearchParams();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await ppost('/auth/login', { email, password });
      const next = params.get('next');
      router.replace(next && next.startsWith('/platform') && !next.startsWith('//') ? next : '/platform');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Email">
        <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password">
        <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <InlineError error={error} />
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!ready}>
        Sign in
      </Button>
    </form>
  );
}

export default function PlatformLoginPage() {
  return (
    <AuthShell title="GeoAttend platform" description="For GeoAttend’s own administrators. Company owners and supervisors sign in on the main sign-in page.">
      <Suspense>
        <Form />
      </Suspense>
    </AuthShell>
  );
}
