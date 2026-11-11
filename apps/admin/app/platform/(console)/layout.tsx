'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { ApiError, pget, ppost, type PlatformAdmin } from '@/lib/platform-api';
import { Button, Card, cx, ErrorState, Field, InlineError, Input, Spinner } from '@/components/ui';
import { Lockup } from '@/components/brand';

const NAV = [
  { href: '/platform', label: 'Overview' },
  { href: '/platform/companies', label: 'Companies' },
  { href: '/platform/editions', label: 'Editions' },
  { href: '/platform/settings', label: 'Settings' },
  { href: '/platform/audit', label: 'Audit log' },
];
const active = (href: string, path: string) => (href === '/platform' ? path === '/platform' : path === href || path.startsWith(`${href}/`));

const usePlatformMe = () => useQuery({ queryKey: ['platform', 'me'], queryFn: () => pget<{ admin: PlatformAdmin }>('/auth/me'), retry: false, staleTime: 5 * 60_000 });

function ChangePassword() {
  const qc = useQueryClient();
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  const change = useMutation({
    meta: { success: 'Password changed' },
    mutationFn: () => ppost('/auth/change-password', f),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'me'] }),
  });
  return (
    <div className="mx-auto mt-20 max-w-md px-4">
      <Card title="Choose your own password" description="You signed in with a temporary password. Choose a new one to continue.">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
          <Field label="Temporary password"><Input type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></Field>
          <Field label="New password" hint="At least 10 characters, with letters and numbers."><Input type="password" autoComplete="new-password" required minLength={10} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></Field>
          <InlineError error={change.error} />
          <Button type="submit" variant="primary" loading={change.isPending}>Change password</Button>
        </form>
      </Card>
    </div>
  );
}

export default function PlatformLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const me = usePlatformMe();
  if (me.error && !(me.error instanceof ApiError && me.error.status === 401)) {
    return (
      <div className="mx-auto mt-20 max-w-md">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }
  if (me.isLoading || !me.data) return <Spinner label="Loading platform console…" />;
  if (me.data.admin.mustChangePassword) return <ChangePassword />;

  async function signOut() {
    await ppost('/auth/logout').catch(() => undefined);
    router.replace('/platform/login');
  }

  return (
    <div className="min-h-dvh bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
          <Link href="/platform" className="flex items-center gap-2" aria-label="Platform overview">
            <Lockup />
            <span className="rounded-md bg-navy-800 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">Platform</span>
          </Link>
          <nav aria-label="Platform" className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active(n.href, path) ? 'page' : undefined}
                className={cx('whitespace-nowrap rounded-md px-3 py-1.5 text-body-sm', active(n.href, path) ? 'bg-navy-50 font-semibold text-navy-800' : 'text-gray-600 hover:bg-gray-100')}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-right text-xs leading-tight text-gray-500 md:block">
              <span className="block font-medium text-gray-900">{me.data.admin.fullName}</span>
              {me.data.admin.email}
            </span>
            <Button size="sm" onClick={signOut}>
              <LogOut className="h-4 w-4" aria-hidden /> Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
