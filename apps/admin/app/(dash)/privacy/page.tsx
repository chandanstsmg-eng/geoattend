'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useMe } from '@/lib/me';
import { Badge, Card, KeyValue, PageHeader, QueryState } from '@/components/ui';

/**
 * The tracking and photo policy exactly as employees see it in the app (they must acknowledge
 * each version before their next shift), with the retention periods currently in force.
 */
export default function PrivacyPage() {
  const { isOwner } = useMe();
  const q = useQuery({ queryKey: ['privacy-notice'], queryFn: () => get('/me/privacy-notice') });
  return (
    <>
      <PageHeader
        title="Privacy policy"
        description="What GeoAttend collects about employees, when, who can see it and how long it is kept. Employees see this text in the app and must accept each new version before their next shift."
      />
      <QueryState query={q}>
        {(d: any) => (
          <div className="grid max-w-5xl items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <Card title={<span className="flex items-center gap-2">Tracking &amp; photo notice <Badge tone="navy">version {d.version}</Badge></span>}>
              <div className="whitespace-pre-line text-sm leading-6 text-gray-800">{d.text}</div>
            </Card>
            <div className="space-y-5">
              <Card title="Retention in force">
                <KeyValue
                  items={[
                    ['Location history', `${d.retention.locationDays} days, then deleted automatically`],
                    ['Attendance photos', `${d.retention.photoDays} days, then deleted automatically`],
                    ['Attendance records', 'Kept for payroll and legal record keeping'],
                    ['Location updates', `About every ${Math.round(d.tracking.updateIntervalSec)} s, only during an active shift or overtime`],
                    ['Tracking window', `From ${d.tracking.earlyStartMinutes} min before a shift until ${d.tracking.endGraceMinutes} min after it`],
                  ]}
                />
              </Card>
              <Card title="Data controller">
                <KeyValue items={[['Organisation', d.controller], ['Privacy contact', d.contact]]} />
                {isOwner && (
                  <p className="mt-3 text-xs text-gray-500">
                    Change the text, controller, contact and retention periods in{' '}
                    <Link href="/settings#privacy" className="font-medium text-primary-700 hover:underline">Settings › Privacy &amp; retention</Link>. Every change is audited and creates a new version.
                  </p>
                )}
              </Card>
            </div>
          </div>
        )}
      </QueryState>
    </>
  );
}
