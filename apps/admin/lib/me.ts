'use client';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';

export interface Me {
  user: { id: string; fullName: string; email: string; isDemo: boolean; mustChangePassword?: boolean };
  organization: { id: string; name: string } | null;
  access: { role: 'OWNER' | 'SUPERVISOR'; sites: string[] | null; awayUntil: string | null } | null;
  permissions: { publishAnnouncements: boolean } | null;
  demoMode: boolean;
  /** The generated sample company (a *_demo database): show the sample-data banner and chip. */
  sampleData?: boolean;
  /** Optional modules switched on for this company's plan (payroll also needs the server switch). */
  features?: { payroll: boolean; announcements?: boolean; tasks?: boolean; overtime?: boolean };
  /** The company's edition and subscription; limits and usage are sent to owners only. */
  plan?: Plan;
}

export type SubscriptionState = 'ACTIVE' | 'TRIAL' | 'EXPIRING' | 'GRACE' | 'EXPIRED';
export interface Plan {
  edition: { code: string; name: string };
  subscription: { status: 'TRIAL' | 'ACTIVE' | 'CANCELLED'; startsOn: string | null; endsOn: string | null; state: SubscriptionState; daysLeft: number | null; readOnly: boolean };
  limits?: { employees: number | null; supervisors: number | null };
  usage?: { employees: number; supervisors: number; owners: number };
}

/** The signed-in administrator (shared cache with the dashboard layout). */
export function useMe() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/auth/me'), retry: false, staleTime: 5 * 60_000 });
  return { me: me.data, isOwner: me.data?.access?.role !== 'SUPERVISOR', query: me };
}
