'use client';
import { useMe } from '@/lib/me';
import { OwnerOverview } from '@/components/overview/owner';
import { SupervisorOverview } from '@/components/overview/supervisor';

export default function OverviewPage() {
  const { isOwner } = useMe();
  return isOwner ? <OwnerOverview /> : <SupervisorOverview />;
}
