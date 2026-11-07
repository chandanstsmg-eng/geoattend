/**
 * What an attendance record's status means to the employee. One place, because a pending record
 * must never look confirmed: an unknown or missing status is treated as not counted.
 */
import type { Tone } from './theme';

const KNOWN: Record<string, { label: string; tone: Tone; counted: boolean }> = {
  VERIFIED: { label: 'Verified', tone: 'success', counted: true },
  MANUAL_APPROVED: { label: 'Approved by manager', tone: 'success', counted: true },
  CORRECTED: { label: 'Corrected', tone: 'info', counted: true },
  DISPUTED: { label: 'Disputed', tone: 'warning', counted: true },
  VOIDED: { label: 'Not counted', tone: 'danger', counted: false },
  PENDING_VERIFICATION: { label: 'Waiting for manager check', tone: 'warning', counted: false },
};

export function attendanceStatus(status: string | null | undefined) {
  return (status && KNOWN[status]) || { label: 'Being checked', tone: 'warning' as Tone, counted: false };
}

/**
 * The server's guidance follows the session, and the session is PRESENT even when the record behind
 * it is still waiting for a person. So a record that does not count must not borrow that wording.
 */
export function shownGuidance(status: {
  guidance: { tone: Tone; title: string; message: string };
  session: { stateLabel: string };
  attendance?: { verificationStatus?: string | null } | null;
}) {
  const g = status.guidance;
  const same = { ...g, badge: status.session.stateLabel };
  if (!status.attendance) return same;
  const v = attendanceStatus(status.attendance.verificationStatus);
  if (v.counted || !(g.tone === 'success' || g.title.startsWith('Present'))) return same;
  const why = status.attendance.verificationStatus === 'VOIDED' ? 'This check-in does not count towards your attendance.' : 'A manager must confirm this check-in before it counts.';
  return { tone: v.tone, title: v.label, message: g.tone === 'success' ? why : `${g.message} ${why}`, badge: 'Checked in' };
}

/** "7 h 45 min", or "40 min" under an hour. */
export const hoursMinutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

/** The record that matters on Home: a shift still running, else one dated today. */
export function recordForToday<T extends { shift_date: string; in_progress: boolean | null }>(records: T[], today: string): T | null {
  return records.find((r) => r.in_progress) ?? records.find((r) => r.shift_date === today) ?? null;
}
