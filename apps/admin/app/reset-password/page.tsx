'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { post } from '@/lib/api';
import { Button, Callout, Field, InlineError, Input, Spinner } from '@/components/ui';
import { AuthShell, clearHash, tokenFromHash } from '@/components/auth-shell';

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setToken(tokenFromHash());
    clearHash();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== again) return setError(new Error('The two passwords are not the same.'));
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ role: string }>('/auth/reset-password', { token, newPassword: pw });
      setDone(r.role);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const body = () => {
    if (token === null) return <Spinner />;
    if (!token)
      return (
        <Callout tone="warning">
          This link is incomplete. Open it again from the e-mail, or <Link href="/forgot-password" className="underline">ask for a new one</Link>.
        </Callout>
      );
    if (done)
      return (
        <div className="space-y-4">
          <Callout tone="success">Your password has been changed, and your other sign-ins have ended.</Callout>
          {done === 'EMPLOYEE' ? (
            <p className="text-sm text-gray-700">Sign in to the GeoAttend mobile app with your e-mail address and the new password.</p>
          ) : (
            <Link href="/login" className="block w-full rounded-md bg-accent-600 px-3.5 py-2 text-center text-sm font-semibold text-white hover:bg-accent-700">
              Sign in
            </Link>
          )}
        </div>
      );
    return (
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password" hint="At least 10 characters, with letters and numbers.">
          <Input type="password" autoComplete="new-password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label="New password again">
          <Input type="password" autoComplete="new-password" required minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        <InlineError error={error} />
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Save new password
        </Button>
      </form>
    );
  };

  return (
    <AuthShell title="Choose a new password" description={done ? undefined : 'Saving it signs you out on your other devices.'}>
      {body()}
    </AuthShell>
  );
}
