'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { Lockup } from '@/components/brand';
import { post } from '@/lib/api';
import { Button, Field, InlineError, Input } from '@/components/ui';

const POINTS = ['Attendance only at your workplace, verified by GPS', 'Works on your staff’s own phones', 'Live map, alerts, leave and monthly reports'];

export default function SignupPage() {
  const router = useRouter();
  // Until the page has loaded its script, a tap would reload the form and lose what was typed.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [f, setF] = useState({ companyName: '', fullName: '', email: '', phone: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/signup', { ...f, phone: f.phone || undefined });
      router.replace('/?welcome=1');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-navy-900 px-4 py-8">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-xl bg-white shadow-2xl md:grid-cols-[1fr_1.1fr]">
        <div className="hidden flex-col justify-between bg-navy-800 p-8 text-white md:flex">
          <div>
            <Lockup inverse size="lg" />
            <h2 className="mt-6 text-2xl font-bold leading-snug">Set up attendance for your business in a few minutes.</h2>
            <ul className="mt-6 space-y-3 text-sm text-navy-100">
              {POINTS.map((p) => (
                <li key={p} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-200" aria-hidden /> {p}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-navy-100/70">Your company’s data is kept separate from every other company’s.</p>
        </div>

        <div className="p-6 sm:p-8">
          <h1 className="text-xl font-semibold text-gray-900">Create your company account</h1>
          <p className="mt-1 text-sm text-gray-600">You will be the administrator. Add your workplace and staff next.</p>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <Field label="Business name"><Input required minLength={2} autoComplete="organization" value={f.companyName} onChange={set('companyName')} placeholder="e.g. Sri Lakshmi Textiles" /></Field>
            <Field label="Your name"><Input required autoComplete="name" value={f.fullName} onChange={set('fullName')} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email (you sign in with this)"><Input required type="email" autoComplete="email" value={f.email} onChange={set('email')} /></Field>
              <Field label="Mobile (optional)"><Input type="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
            </div>
            <Field label="Password" hint="At least 10 characters, with letters and digits.">
              <Input required type="password" autoComplete="new-password" minLength={10} value={f.password} onChange={set('password')} />
            </Field>
            <InlineError error={error} />
            <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!ready}>Create account</Button>
          </form>
          <p className="mt-6 text-center text-sm text-gray-600">
            Already have an account? <Link href="/login" className="font-medium text-primary-700 underline">Sign in</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
