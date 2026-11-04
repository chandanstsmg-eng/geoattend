/**
 * Copied from packages/shared/src/states.ts. The mobile app is a standalone
 * install (not a workspace member) so React Native's React never clashes with
 * the dashboard's. Keep in sync when the server adds states.
 */
export const SESSION_STATES = [
  'OFF_SHIFT',
  'SHIFT_START_PENDING',
  'TRACKING_PERMISSION_REQUIRED',
  'TRACKING_ACTIVE',
  'OUTSIDE_GEOFENCE',
  'ARRIVAL_CANDIDATE',
  'ATTENDANCE_READY',
  'ATTENDANCE_SUBMISSION_PENDING',
  'PRESENT',
  'TEMPORARILY_AWAY',
  'PROLONGED_ABSENCE',
  'TRACKING_INTERRUPTED',
  'SHIFT_END_PENDING',
  'SHIFT_COMPLETED',
  'MANUAL_REVIEW_REQUIRED',
  'ON_BREAK',
  'ON_OVERTIME',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const STATE_LABELS: Record<SessionState, string> = {
  OFF_SHIFT: 'Off shift',
  SHIFT_START_PENDING: 'Shift starting',
  TRACKING_PERMISSION_REQUIRED: 'Permission required',
  TRACKING_ACTIVE: 'Tracking active',
  OUTSIDE_GEOFENCE: 'Outside workplace',
  ARRIVAL_CANDIDATE: 'Verifying arrival',
  ATTENDANCE_READY: 'Attendance ready',
  ATTENDANCE_SUBMISSION_PENDING: 'Submitting attendance',
  PRESENT: 'Present',
  TEMPORARILY_AWAY: 'Temporarily away',
  PROLONGED_ABSENCE: 'Prolonged absence',
  TRACKING_INTERRUPTED: 'Tracking interrupted',
  SHIFT_END_PENDING: 'Ending shift',
  SHIFT_COMPLETED: 'Shift completed',
  MANUAL_REVIEW_REQUIRED: 'Manual review',
  ON_BREAK: 'On break',
  ON_OVERTIME: 'On overtime',
};

export const PRE_ATTENDANCE_STATES: readonly SessionState[] = [
  'SHIFT_START_PENDING',
  'TRACKING_PERMISSION_REQUIRED',
  'TRACKING_ACTIVE',
  'OUTSIDE_GEOFENCE',
  'ARRIVAL_CANDIDATE',
  'ATTENDANCE_READY',
  'ATTENDANCE_SUBMISSION_PENDING',
];

export function stateLabel(state: string | null | undefined): string {
  if (!state) return '—';
  return (STATE_LABELS as Record<string, string>)[state] ?? state;
}
