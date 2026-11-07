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

/** "7 h 45 min", or "40 min" under an hour. */
export const hoursMinutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

/** The record that matters on Home: a shift still running, else one dated today. */
export function recordForToday<T extends { shift_date: string; in_progress: boolean | null }>(records: T[], today: string): T | null {
  return records.find((r) => r.in_progress) ?? records.find((r) => r.shift_date === today) ?? null;
}
