'use client';
import { STATE_LABELS, type SessionState } from '@geoattend/shared';
import { Battery, BatteryCharging, BatteryLow } from 'lucide-react';
import { Badge } from './ui';

const TONES: Record<SessionState, Parameters<typeof Badge>[0]['tone']> = {
  OFF_SHIFT: 'gray',
  SHIFT_START_PENDING: 'blue',
  TRACKING_PERMISSION_REQUIRED: 'red',
  TRACKING_ACTIVE: 'blue',
  OUTSIDE_GEOFENCE: 'gray',
  ARRIVAL_CANDIDATE: 'blue',
  ATTENDANCE_READY: 'navy',
  ATTENDANCE_SUBMISSION_PENDING: 'navy',
  PRESENT: 'green',
  TEMPORARILY_AWAY: 'amber',
  PROLONGED_ABSENCE: 'red',
  TRACKING_INTERRUPTED: 'orange',
  SHIFT_END_PENDING: 'gray',
  SHIFT_COMPLETED: 'gray',
  MANUAL_REVIEW_REQUIRED: 'purple',
  ON_BREAK: 'teal',
  ON_OVERTIME: 'navy',
};

export function StateBadge({ state }: { state: string | null | undefined }) {
  if (!state) return <Badge dot>Not started</Badge>;
  return <Badge dot tone={TONES[state as SessionState] ?? 'gray'}>{STATE_LABELS[state as SessionState] ?? state}</Badge>;
}

/** Phone battery from the last upload; red when nearly flat and not charging. */
export function BatteryBadge({ level, charging, lowPower }: { level: number | null | undefined; charging?: boolean | null; lowPower?: boolean | null }) {
  if (level === null || level === undefined) return null;
  const pct = Math.round(level * 100);
  const tone = charging ? 'green' : pct <= 15 ? 'red' : pct <= 30 ? 'amber' : 'gray';
  return (
    <Badge tone={tone} title={`Phone battery at the last upload${lowPower ? ', power-saving mode on' : ''}`}>
      {charging ? <BatteryCharging className="h-3.5 w-3.5" aria-label="Charging" /> : pct <= 15 ? <BatteryLow className="h-3.5 w-3.5" aria-hidden /> : <Battery className="h-3.5 w-3.5" aria-hidden />} {pct}%{lowPower ? ' · saver' : ''}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <Badge dot tone={severity === 'CRITICAL' ? 'red' : severity === 'WARNING' ? 'amber' : 'gray'}>{severity === 'CRITICAL' ? 'Critical' : severity === 'WARNING' ? 'Warning' : 'Info'}</Badge>;
}

export function VerificationBadge({ status }: { status: string }) {
  const tone = status === 'VERIFIED' ? 'green' : status === 'MANUAL_APPROVED' ? 'navy' : status === 'CORRECTED' ? 'blue' : status === 'DISPUTED' || status === 'PENDING_VERIFICATION' ? 'amber' : 'red';
  const label = status.replace('_', ' ').toLowerCase();
  return <Badge dot tone={tone}>{label[0]!.toUpperCase() + label.slice(1)}</Badge>;
}

/** What a face check found. A missing or unclear face asks for a look; only a mismatch is red. */
export const FACE_RESULT: Record<string, { tone: 'green' | 'red' | 'amber' | 'gray' | 'blue'; label: string }> = {
  MATCH: { tone: 'green', label: 'Matches enrolled face' },
  MISMATCH: { tone: 'red', label: 'Does not match' },
  NO_FACE: { tone: 'amber', label: 'No clear face' },
  REFERENCE_SET: { tone: 'blue', label: 'Used as reference photo' },
  NOT_CHECKED: { tone: 'gray', label: 'Not compared' },
  NOT_ENROLLED: { tone: 'gray', label: 'Face not enrolled' },
  NO_PHOTO: { tone: 'gray', label: 'No photo' },
  ERROR: { tone: 'amber', label: 'Face check failed' },
};
