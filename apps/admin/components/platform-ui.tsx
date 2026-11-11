'use client';
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { fmtDate, fmtDateTime } from '@/lib/format';
import type { Company, SubState } from '@/lib/platform-api';
import { Badge, Button, Callout } from './ui';

const SUB: Record<SubState, { label: string; tone: 'green' | 'blue' | 'amber' | 'orange' | 'red' }> = {
  ACTIVE: { label: 'Active', tone: 'green' },
  TRIAL: { label: 'Trial', tone: 'blue' },
  EXPIRING: { label: 'Ending soon', tone: 'amber' },
  GRACE: { label: 'Grace period', tone: 'orange' },
  EXPIRED: { label: 'Expired (read-only)', tone: 'red' },
};

export function SubscriptionBadge({ state }: { state: SubState }) {
  const s = SUB[state] ?? SUB.ACTIVE;
  return <Badge tone={s.tone} dot>{s.label}</Badge>;
}

export function StatusBadge({ status }: { status: Company['status'] }) {
  return status === 'SUSPENDED' ? <Badge tone="red" dot>Suspended</Badge> : <Badge tone="green" dot>Active</Badge>;
}

/** "12 / 25", or "12 / no limit". Over the limit is shown in red (nobody is deactivated; no more can be added). */
export function Usage({ used, limit }: { used: number; limit: number | null }) {
  const over = limit !== null && used > limit;
  return (
    <span className={`tabular ${over ? 'font-semibold text-red-700' : ''}`}>
      {used} / {limit === null ? 'no limit' : limit}
    </span>
  );
}

export function renewalText(c: Pick<Company, 'subscription'>) {
  const s = c.subscription;
  if (!s.endsOn) return 'No end date';
  const d = s.daysLeft ?? 0;
  return `${fmtDate(s.endsOn)} (${d >= 0 ? `${d} day${d === 1 ? '' : 's'} left` : `ended ${-d} day${d === -1 ? '' : 's'} ago`})`;
}

/** A blank box means "no limit" (null). */
export const limitFromInput = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.floor(Number(v))));
export const limitToInput = (v: number | null) => (v === null ? '' : String(v));

/** A one-time secret (invitation link or temporary password) with copy. */
export function OneTimeSecret({ owner }: { owner: { email: string; invitation?: { url: string; expiresAt: string; emailed: boolean }; temporaryPassword?: string | null } }) {
  const [copied, setCopied] = useState(false);
  const value = owner.invitation?.url ?? owner.temporaryPassword ?? '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the text stays selectable */
    }
  };
  return (
    <div className="space-y-3">
      {owner.invitation ? (
        owner.invitation.emailed ? (
          <Callout tone="success">An invitation was e-mailed to {owner.email}. It works once and expires on {fmtDateTime(owner.invitation.expiresAt)}.</Callout>
        ) : (
          <Callout tone="warning">E-mail is not set up: copy this link and send it privately to {owner.email}. It works once and expires on {fmtDateTime(owner.invitation.expiresAt)}.</Callout>
        )
      ) : (
        <Callout tone="warning">Temporary password for {owner.email}, shown once. Pass it on privately; they must choose a new one at first sign-in.</Callout>
      )}
      <div className="flex items-stretch gap-2">
        <p className="min-w-0 flex-1 select-all break-all rounded-md bg-gray-100 p-3 font-mono text-xs">{value}</p>
        <Button type="button" onClick={copy}>
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
