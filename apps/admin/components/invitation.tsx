'use client';
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { fmtDateTime } from '@/lib/format';
import { Button, Callout, Field, Select } from './ui';

export type Delivery = 'temporary-password' | 'invitation';
export interface Invitation {
  url: string;
  expiresAt: string;
  emailed: boolean;
}

/** How a new account gets its first password. The temporary password stays the default. */
export function DeliveryChoice({ value, onChange }: { value: Delivery; onChange: (d: Delivery) => void }) {
  return (
    <Field label="First sign-in" hint={value === 'invitation' ? 'They get a one-time link and choose their own password. No password is shown to you.' : 'A temporary password is shown to you once; they change it at first sign-in.'}>
      <Select value={value} onChange={(e) => onChange(e.target.value as Delivery)}>
        <option value="temporary-password">Create a temporary password</option>
        <option value="invitation">Send an invitation link (they choose their password)</option>
      </Select>
    </Field>
  );
}

/** The invitation link once, with a copy button and whether it was e-mailed. */
export function InvitationResult({ invitation }: { invitation: Invitation }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invitation.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the link stays selectable */
    }
  };
  return (
    <div className="space-y-3">
      {invitation.emailed ? (
        <Callout tone="success">The invitation was e-mailed. It works once and expires on {fmtDateTime(invitation.expiresAt)}.</Callout>
      ) : (
        <Callout tone="warning">E-mail is not set up: copy this link and send it privately. It works once and expires on {fmtDateTime(invitation.expiresAt)}.</Callout>
      )}
      <div className="flex items-stretch gap-2">
        <p className="min-w-0 flex-1 select-all break-all rounded-md bg-gray-100 p-3 font-mono text-xs">{invitation.url}</p>
        <Button type="button" onClick={copy} aria-label="Copy invitation link">
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
