'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { post } from '@/lib/api';
import { Button, Callout, Field, InlineError, Input, KeyValue, Spinner } from '@/components/ui';
import { AuthShell, clearHash, tokenFromHash } from '@/components/auth-shell';

interface InvitationInfo {
  email: string;
  fullName: string;
  company: string;
  role: 'OWNER' | 'SUPERVISOR' | 'EMPLOYEE';
  expiresAt: string;
}
const ROLE: Record<InvitationInfo['role'], string> = { OWNER: 'Owner', SUPERVISOR: 'Supervisor', EMPLOYEE: 'Employee' };

export default function AcceptInvitePage() {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = tokenFromHash();
    clearHash();
    setToken(t);
    if (t) post<InvitationInfo>('/auth/invitation', { token: t }).then(setInfo, setLoadError);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== again) return setError(new Error('The two passwords are not the same.'));
    setBusy(true);
    setError(null);
    try {
      await post('/auth/accept-invitation', { token, password: pw });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const body = () => {
    if (token === null) return <Spinner label="Opening your invitation…" />;
    if (!token) return <Callout tone="warning">This invitation link is incomplete. Open it again from the e-mail, or ask whoever invited you to send a new one.</Callout>;
    if (loadError) return <InlineError error={loadError} />;
    if (!info) return <Spinner label="Opening your invitation…" />;
    if (done)
      return (
        <div className="space-y-4">
          <Callout tone="success">Your password is set. Welcome to {info.company}.</Callout>
          {info.role === 'EMPLOYEE' ? (
            <p className="text-sm text-gray-700">
              Now install the GeoAttend mobile app and sign in with <strong>{info.email}</strong> and the password you just chose. Attendance is marked in the app, not on this website.
            </p>
          ) : (
            <Link href="/login" className="block w-full rounded-md bg-accent-600 px-3.5 py-2 text-center text-sm font-semibold text-white hover:bg-accent-700">
              Sign in to the dashboard
            </Link>
          )}
        </div>
      );
    return (
      <div className="space-y-5">
        <KeyValue
          cols={1}
          items={[
            ['Name', info.fullName],
            ['E-mail', info.email],
            ['Company', info.company],
            ['Role', ROLE[info.role]],
          ]}
        />
        <form onSubmit={submit} className="space-y-4">
          <Field label="Choose a password" hint="At least 10 characters, with letters and numbers.">
            <Input type="password" autoComplete="new-password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Password again">
            <Input type="password" autoComplete="new-password" required minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          <InlineError error={error} />
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Set password
          </Button>
        </form>
      </div>
    );
  };

  return (
    <AuthShell title="Accept your invitation" description={done ? undefined : 'Choose the password you will sign in with.'}>
      {body()}
    </AuthShell>
  );
}
