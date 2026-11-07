'use client';
/**
 * The first thing on the Overview: is the workforce where it should be at this moment? Everyone
 * expected right now (open sessions plus people whose shift is running but who have not arrived),
 * split into four plain states. Counted from the live sessions and today's roster only.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { LinkButton, cx, ErrorState } from './ui';
import type { RosterRow } from './attendance-board';

const clockIn = (now: number, timeZone: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(now);

/** A shift of today's roster that is running at `now` (overnight shifts run from their start until midnight here). */
function running(r: RosterRow, now: number) {
  const cur = clockIn(now, r.timezone);
  const start = r.start_time.slice(0, 5);
  const end = r.end_time.slice(0, 5);
  return end > start ? cur >= start && cur < end : cur >= start;
}

function stateOf(s: any): 'onSite' | 'outside' | 'silent' {
  if (s.state === 'TRACKING_INTERRUPTED' || s.state === 'TRACKING_PERMISSION_REQUIRED' || s.is_stale || !s.last_location_at) return 'silent';
  if (s.state === 'ON_OVERTIME' || s.state === 'ON_BREAK' || s.last_classification === 'INSIDE') return 'onSite';
  return 'outside';
}

function Cell({ label, value, hint, tone, href, onClick }: { label: string; value: number; hint: string; tone?: 'good' | 'warn' | 'bad' | 'muted'; href?: string; onClick?: () => void }) {
  const inner: ReactNode = (
    <>
      <span className="flex items-center gap-1.5 text-body-sm font-medium text-gray-600">
        <span aria-hidden className={cx('h-2 w-2 rounded-full', tone === 'good' ? 'bg-teal-600' : tone === 'warn' ? 'bg-amber-500' : tone === 'bad' ? 'bg-red-600' : 'bg-gray-400')} />
        {label}
      </span>
      <span className={cx('mt-0.5 block text-2xl font-semibold leading-8 tracking-tight tabular', value === 0 ? 'text-gray-500' : tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-navy-800')}>{value}</span>
      <span className="block text-xs text-gray-500">{hint}</span>
    </>
  );
  const cls = 'flex h-full w-full flex-col justify-start bg-white px-4 py-3 text-left transition-colors hover:bg-gray-50';
  return href ? <Link href={href} className={cls}>{inner}</Link> : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

export function RightNow({ sessions, rows, now, loading, error, onRetry, onNotArrived, mapHref }: { sessions: any[]; rows: RosterRow[]; now: number; loading: boolean; error: unknown; onRetry: () => void; onNotArrived: () => void; mapHref: string }) {
  if (error) return <section className="rounded-lg border border-gray-200 bg-white shadow-card"><ErrorState error={error} onRetry={onRetry} /></section>;
  if (loading) return <div aria-busy className="h-[132px] animate-pulse rounded-lg border border-gray-200 bg-white" />;

  const n = { onSite: 0, outside: 0, silent: 0 };
  for (const s of sessions) n[stateOf(s)]++;
  const notArrived = rows.filter((r) => running(r, now) && !r.attendance_id && !r.session_id && !r.on_leave && !r.holiday).length;
  const expected = sessions.length + notArrived;
  const problems = expected - n.onSite;

  if (expected === 0) {
    const later = rows.filter((r) => !r.on_leave && !r.holiday && r.start_time.slice(0, 5) > clockIn(now, r.timezone));
    const next = later.map((r) => r.start_time.slice(0, 5)).sort()[0];
    return (
      <section aria-label="Right now" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-5 py-4 shadow-card">
        <div>
          <p className="text-lg font-semibold text-navy-900">No shift is running right now</p>
          <p className="text-sm text-gray-500">{next ? `Next start ${next} · ${later.filter((r) => r.start_time.slice(0, 5) === next).length} rostered` : 'Nobody else is rostered today.'}</p>
        </div>
        <LinkButton href="/roster">Open roster</LinkButton>
      </section>
    );
  }

  const parts = [
    { key: 'site', value: n.onSite, cls: 'bg-teal-600' },
    { key: 'out', value: n.outside, cls: 'bg-amber-500' },
    { key: 'silent', value: n.silent, cls: 'bg-gray-400' },
    { key: 'missing', value: notArrived, cls: 'bg-red-600' },
  ].filter((p) => p.value > 0);

  return (
    <section aria-labelledby="now-title" className="grid overflow-hidden rounded-lg border border-gray-200 bg-white shadow-card xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="px-5 py-4">
        <h2 id="now-title" className="text-body-sm font-medium text-gray-500">Right now</h2>
        <p className="mt-0.5 text-[1.75rem] font-semibold leading-9 tracking-tight text-navy-800 tabular">
          {n.onSite} <span className="text-lg font-medium text-gray-500">of {expected} on site</span>
        </p>
        <p className="text-sm text-gray-600">{problems === 0 ? 'Everyone expected is where they should be.' : `${problems} ${problems === 1 ? 'person needs' : 'people need'} a look.`}</p>
        <div className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden>
          {parts.map((p) => <span key={p.key} className={p.cls} style={{ flexGrow: p.value, flexBasis: 0 }} />)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-gray-200 bg-gray-200 sm:grid-cols-4 xl:border-l xl:border-t-0">
        <Cell label="On site" value={n.onSite} hint="fresh location inside" tone="good" href={mapHref} />
        <Cell label="Outside" value={n.outside} hint="away from the zone" tone="warn" href={mapHref} />
        <Cell label="Phone silent" value={n.silent} hint="no fresh location" tone="muted" href={mapHref} />
        <Cell label="Not arrived" value={notArrived} hint="shift started, no check-in" tone="bad" onClick={onNotArrived} />
      </div>
    </section>
  );
}
