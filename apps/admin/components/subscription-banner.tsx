'use client';
import { CalendarClock } from 'lucide-react';
import { fmtDate } from '@/lib/format';
import type { Plan } from '@/lib/me';

/**
 * Where the company's subscription stands, under the header. Owners are told before it ends, during the grace
 * period and after it; supervisors only once it has become read-only (they cannot renew it).
 */
export function SubscriptionBanner({ plan, isOwner }: { plan?: Plan; isOwner: boolean }) {
  const s = plan?.subscription;
  if (!s) return null;
  const expired = s.state === 'EXPIRED';
  if (!expired && (!isOwner || (s.state !== 'EXPIRING' && s.state !== 'GRACE'))) return null;
  const days = Math.abs(s.daysLeft ?? 0);
  const text = expired
    ? `Your GeoAttend subscription ended on ${fmtDate(s.endsOn)}. Your data is kept: you can view and export it, but changes are paused.${isOwner ? ' Renew to make changes again.' : ' Ask the company owner to renew.'}`
    : s.state === 'GRACE'
      ? `Your GeoAttend subscription ended on ${fmtDate(s.endsOn)}. Everything still works during a short grace period; after it the dashboard becomes view and export only. Renew to avoid that.`
      : s.daysLeft === 0
        ? `Your ${plan!.edition.name} subscription ends today. Renew to keep making changes.`
        : `Your ${plan!.edition.name} subscription ends on ${fmtDate(s.endsOn)}, in ${days} day${days === 1 ? '' : 's'}. Renew to keep everything working.`;
  return (
    <div role={expired ? 'alert' : 'status'} className={expired ? 'border-b border-red-200 bg-red-50' : 'border-b border-amber-200 bg-amber-50'}>
      <div className={`mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2 text-body-sm sm:px-6 lg:px-8 ${expired ? 'text-red-800' : 'text-amber-900'}`}>
        <CalendarClock className="h-4 w-4 shrink-0" aria-hidden />
        <p className="flex-1">{text}</p>
      </div>
    </div>
  );
}
