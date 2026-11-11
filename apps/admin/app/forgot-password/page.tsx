'use client';
import { useState } from 'react';
import Link from 'next/link';
import { post } from '@/lib/api';
import { Button, Callout, Field, InlineError, Input } from '@/components/ui';
import { AuthShell } from '@/components/auth-shell';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ message: string }>('/auth/forgot-password', { email });
      setSent(r.message);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Forgot your password?" description="Enter the e-mail address you sign in with. We will send you a link to choose a new password.">
      {sent ? (
        <Callout tone="success">{sent}</Callout>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <InlineError error={error} />
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-6 border-t border-gray-100 pt-5 text-sm text-gray-600">
        Employees: after choosing a new password, sign in to the GeoAttend mobile app.{' '}
        <Link href="/login" className="font-medium text-primary-600 underline underline-offset-2">Back to sign in</Link>
      </p>
    </AuthShell>
  );
}
