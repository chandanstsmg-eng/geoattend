'use client';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';

export interface Me {
  user: { id: string; fullName: string; email: string; isDemo: boolean };
  organization: { id: string; name: string } | null;
  access: { role: 'OWNER' | 'SUPERVISOR'; sites: string[] | null; awayUntil: string | null } | null;
  permissions: { publishAnnouncements: boolean } | null;
  demoMode: boolean;
  /** The generated sample company (a *_demo database): show the sample-data banner and chip. */
  sampleData?: boolean;
  /** Parts of the product switched on for this server. */
  features?: { payroll: boolean };
}

/** The signed-in administrator (shared cache with the dashboard layout). */
export function useMe() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/auth/me'), retry: false, staleTime: 5 * 60_000 });
  return { me: me.data, isOwner: me.data?.access?.role !== 'SUPERVISOR', query: me };
}
