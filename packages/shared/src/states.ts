/** Server-side attendance / tracking states. The server is the only writer. */
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

/** States in which the device is expected to be reporting locations. */
export const TRACKING_STATES: readonly SessionState[] = [
  'TRACKING_ACTIVE',
  'OUTSIDE_GEOFENCE',
  'ARRIVAL_CANDIDATE',
  'ATTENDANCE_READY',
  'ATTENDANCE_SUBMISSION_PENDING',
  'PRESENT',
  'TEMPORARILY_AWAY',
  'PROLONGED_ABSENCE',
  'ON_BREAK',
  'ON_OVERTIME',
];

/** States in which the session is open (location collection is authorised). */
export const OPEN_STATES: readonly SessionState[] = [
  'SHIFT_START_PENDING',
  'TRACKING_PERMISSION_REQUIRED',
  ...TRACKING_STATES,
  'TRACKING_INTERRUPTED',
  'MANUAL_REVIEW_REQUIRED',
];

export const PRE_ATTENDANCE_STATES: readonly SessionState[] = [
  'SHIFT_START_PENDING',
  'TRACKING_PERMISSION_REQUIRED',
  'TRACKING_ACTIVE',
  'OUTSIDE_GEOFENCE',
  'ARRIVAL_CANDIDATE',
  'ATTENDANCE_READY',
  'ATTENDANCE_SUBMISSION_PENDING',
];

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

/** Visual grouping used by the admin map legend. */
export type MarkerKind = 'present' | 'break' | 'overtime' | 'arriving' | 'away' | 'prolonged' | 'stale' | 'interrupted' | 'review' | 'ended';

export function markerKind(state: SessionState, isStale: boolean): MarkerKind {
  if (state === 'SHIFT_COMPLETED' || state === 'OFF_SHIFT' || state === 'SHIFT_END_PENDING') return 'ended';
  if (state === 'TRACKING_INTERRUPTED' || state === 'TRACKING_PERMISSION_REQUIRED') return 'interrupted';
  if (isStale) return 'stale';
  if (state === 'PRESENT') return 'present';
  if (state === 'ON_BREAK') return 'break';
  if (state === 'ON_OVERTIME') return 'overtime';
  if (state === 'TEMPORARILY_AWAY') return 'away';
  if (state === 'PROLONGED_ABSENCE') return 'prolonged';
  if (state === 'MANUAL_REVIEW_REQUIRED') return 'review';
  return 'arriving';
}

export const NOTIFICATION_TYPES = [
  'SHIFT_STARTED',
  'ARRIVED',
  'ATTENDANCE_MARKED',
  'LATE_ARRIVAL',
  'GEOFENCE_EXIT',
  'PROLONGED_ABSENCE',
  'RETURNED',
  'PERMISSION_REVOKED',
  'BACKGROUND_UNAVAILABLE',
  'TRACKING_INTERRUPTED',
  'TRACKING_RESUMED',
  'ATTENDANCE_SUBMISSION_FAILED',
  'DUPLICATE_SUBMISSION',
  'MANUAL_REVIEW_REQUESTED',
  'TECHNICAL_ISSUE_REPORTED',
  'SHIFT_COMPLETED',
  'TRACKING_TERMINATED',
  'GEOFENCE_CHANGED',
  'MOCK_LOCATION_FLAGGED',
  'ATTENDANCE_READY',
  'NO_SHOW',
  'LEAVE_REQUESTED',
  'LEAVE_DECIDED',
  'NEW_DEVICE',
  'SHARED_DEVICE',
  'APPROVAL_OVERDUE',
  'FACE_MISMATCH',
  'TASK_ASSIGNED',
  'TASK_SUBMITTED',
  'TASK_REVIEWED',
  'SOS',
  'BROADCAST',
  'BREAK_STARTED',
  'BREAK_ENDED',
  'BREAK_OVERDUE',
  'OVERTIME_PROMPT',
  'OVERTIME_STARTED',
  'OVERTIME_ENDED',
  'OVERTIME_DECIDED',
  'MISSING_CHECKOUT',
  'ATTENDANCE_PENDING',
  'WEEKLY_SUMMARY',
  'SHIFT_REMINDER',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  SHIFT_STARTED: 'Shift started',
  ARRIVED: 'Arrived at workplace',
  ATTENDANCE_MARKED: 'Attendance marked',
  LATE_ARRIVAL: 'Late arrival',
  GEOFENCE_EXIT: 'Left workplace',
  PROLONGED_ABSENCE: 'Prolonged absence',
  RETURNED: 'Returned to workplace',
  PERMISSION_REVOKED: 'Location permission revoked',
  BACKGROUND_UNAVAILABLE: 'Background tracking unavailable',
  TRACKING_INTERRUPTED: 'Location updates stale',
  TRACKING_RESUMED: 'Tracking resumed',
  ATTENDANCE_SUBMISSION_FAILED: 'Attendance submission failed',
  DUPLICATE_SUBMISSION: 'Duplicate attendance submission',
  MANUAL_REVIEW_REQUESTED: 'Manual review requested',
  TECHNICAL_ISSUE_REPORTED: 'Technical issue reported',
  SHIFT_COMPLETED: 'Shift completed',
  TRACKING_TERMINATED: 'Tracking terminated by admin',
  GEOFENCE_CHANGED: 'Geofence changed',
  MOCK_LOCATION_FLAGGED: 'Mock location indicator',
  ATTENDANCE_READY: 'Attendance ready',
  NO_SHOW: 'Shift not started',
  LEAVE_REQUESTED: 'Leave requested',
  LEAVE_DECIDED: 'Leave request answered',
  NEW_DEVICE: 'Sign-in from a new phone',
  SHARED_DEVICE: 'Phone used by two employees',
  APPROVAL_OVERDUE: 'Approval waiting over a day',
  FACE_MISMATCH: 'Photo may not match',
  TASK_ASSIGNED: 'New task',
  TASK_SUBMITTED: 'Task done — check it',
  TASK_REVIEWED: 'Task reviewed',
  SOS: 'SOS — employee needs help',
  BROADCAST: 'Message from your company',
  BREAK_STARTED: 'Break started',
  BREAK_ENDED: 'Break ended',
  BREAK_OVERDUE: 'Break over time limit',
  OVERTIME_PROMPT: 'Shift ended — still working?',
  OVERTIME_STARTED: 'Overtime started',
  OVERTIME_ENDED: 'Overtime waiting for approval',
  OVERTIME_DECIDED: 'Overtime answered',
  MISSING_CHECKOUT: 'Missing check-out',
  ATTENDANCE_PENDING: 'Attendance waiting for verification',
  WEEKLY_SUMMARY: 'Your week',
  SHIFT_REMINDER: 'Your shift starts soon',
};

export const LEAVE_TYPES = ['CASUAL', 'SICK', 'EARNED', 'UNPAID', 'OTHER'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  CASUAL: 'Casual leave',
  SICK: 'Sick leave',
  EARNED: 'Earned leave',
  UNPAID: 'Unpaid leave',
  OTHER: 'Other',
};
export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
