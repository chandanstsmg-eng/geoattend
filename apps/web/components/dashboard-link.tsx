'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { site } from '@/lib/site';

// Links to the administrator dashboard. Without NEXT_PUBLIC_DASHBOARD_URL it targets
// the same host on port 3400, so it also works when the site is opened from a phone on the LAN.
export function DashboardLink({ path = '/login', className, children }: { path?: string; className?: string; children: ReactNode }) {
  const [href, setHref] = useState(site.dashboardUrl ? site.dashboardUrl + path : process.env.NODE_ENV === 'production' ? path : `http://localhost:3400${path}`);
  useEffect(() => {
    if (!site.dashboardUrl) setHref(`${window.location.protocol}//${window.location.hostname}:3400${path}`);
  }, [path]);
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}
