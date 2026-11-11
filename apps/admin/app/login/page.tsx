'use client';
import { useEffect, Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Clock, MapPinned, ShieldCheck } from 'lucide-react';
import { post } from '@/lib/api';
import { Button, Field, InlineError, Input } from '@/components/ui';
import { Lockup } from '@/components/brand';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Until the page has loaded its script, a tap would reload the form and lose what was typed.
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
      await post('/auth/login', { email, password, client: 'web' });
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
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
      <div className="-mt-2 text-right">
        <Link href="/forgot-password" className="text-body-sm font-medium text-primary-600 underline underline-offset-2">Forgot password?</Link>
      </div>
      <InlineError error={error} />
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!ready}>
        Sign in
      </Button>
    </form>
  );
}

const POINTS = [
  { icon: MapPinned, title: 'Live workforce map', text: 'See who is on shift, where, and whether their location is fresh.' },
  { icon: ShieldCheck, title: 'Server-verified attendance', text: 'Every check-in is checked against the geofence on the server.' },
  { icon: Clock, title: 'Hours and overtime', text: 'Days, hours and approved overtime, ready to export.' },
];

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh bg-white lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-navy-800 p-10 text-white lg:flex">
        <Lockup inverse size="lg" />
        <div className="max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">Know who is working, where, and for how long.</h2>
          <ul className="mt-8 space-y-5">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white/10 text-accent-200" aria-hidden>
                  <p.icon className="h-[18px] w-[18px]" />
                </span>
                <span>
                  <span className="block font-semibold">{p.title}</span>
                  <span className="block text-sm text-navy-100">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-navy-100/80">Access to location data and attendance photos is restricted to administrators and is audited.</p>
      </aside>
      <div className="flex min-h-dvh flex-col px-4 py-6 sm:px-8">
        <div className="lg:hidden">
          <Lockup />
        </div>
        <div className="flex flex-1 items-start justify-center pb-10 pt-12 sm:items-center sm:pt-10">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-semibold tracking-tight text-navy-800">Sign in to your dashboard</h1>
            <p className="mb-7 mt-1 text-sm text-gray-500">For owners and supervisors.</p>
            <Suspense>
              <LoginForm />
            </Suspense>
            <p className="mt-6 border-t border-gray-100 pt-5 text-sm text-gray-600">
              New business? <Link href="/signup" className="font-medium text-primary-600 underline underline-offset-2">Create a free account</Link>
            </p>
          </div>
        </div>
        <p className="mx-auto max-w-sm text-center text-xs leading-relaxed text-gray-500 lg:hidden">
          Employees mark attendance in the GeoAttend mobile app, not here. Access to location data and attendance photos is restricted to administrators and is audited.
        </p>
        <p className="mx-auto hidden max-w-sm text-center text-xs leading-relaxed text-gray-500 lg:block">Employees mark attendance in the GeoAttend mobile app, not here.</p>
      </div>
    </main>
  );
}
