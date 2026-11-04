/** Response shapes of the GeoAttend API (see apps/api/src/modules/**). Dates arrive as ISO strings. */
import type { SessionState } from '../states';

export interface ApiUser {
  id: string;
  email: string;
  fullName: string;
  role: 'EMPLOYEE' | 'ADMIN';
  isDemo: boolean;
  mustChangePassword: boolean;
}

export interface LoginResponse {
  user: ApiUser;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
}

export interface Guidance {
  tone: 'info' | 'warning' | 'success' | 'danger';
  title: string;
  message: string;
}

export interface BreakType {
  key: string;
  label: string;
  paid: boolean;
  maxMinutes: number;
}

export type Classification = 'INSIDE' | 'OUTSIDE' | 'AMBIGUOUS' | 'INSUFFICIENT_ACCURACY' | string;

/** The status object returned by tracking.service.ts `sessionStatus()`. */
export interface SessionStatus {
  session: {
    id: string;
    state: SessionState;
    stateLabel: string;
    shiftId: string;
    shiftName: string;
    shiftDate: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
    startedAt: string;
    endedAt: string | null;
    terminationReason: string | null;
    authorizationStatus: string | null;
    lastLocationAt: string | null;
    lastLocationClientAt: string | null;
    lastDistanceM: number | null;
    lastAccuracyM: number | null;
    lastClassification: Classification | null;
    isStale: boolean;
    isSimulated: boolean;
    simClockOffsetSec: number;
    foregroundPermission: string | null;
    backgroundPermission: string | null;
  };
  workplace: { id: string; name: string; address: string | null; latitude: number; longitude: number; radiusM: number };
  attendance: { id: string; recordedAt: string; verificationStatus: string; isLate: boolean; lateByMinutes: number } | null;
  absence: { startedAt: string; thresholdMinutes: number; prolongedAt: string | null } | null;
  review: { id: string; reason: string; createdAt: string } | null;
  /** The open break, if any. */
  break: {
    id: string;
    typeKey: string;
    label: string;
    paid: boolean;
    maxMinutes: number;
    note: string | null;
    startedAt: string;
    endsAt: string;
    leftAt: string | null;
    overdueAt: string | null;
  } | null;
  /** Overtime for this shift, if started. Ending the shift while it runs ends it. */
  overtime: {
    id: string;
    note: string | null;
    startedAt: string;
    endedAt: string | null;
    status: OvertimeStatus;
    approvedMinutes: number | null;
  } | null;
  /** The shift has ended: the employee may start overtime (selfie + location, any place). */
  canStartOvertime: boolean;
  /** True only while present: a break can be started (from inside the workplace area). */
  canStartBreak: boolean;
  breakOptions: { types: BreakType[]; requirePhoto: boolean };
  guidance: Guidance;
  attendanceAvailable: boolean;
  /** Instruction to follow in the attendance photo (shown on the camera). */
  attendanceChallenge: { en: string; hi: string } | null;
  canRequestReview: boolean;
  suggestReview: boolean;
  tracking: {
    shouldTrack: boolean;
    stopReason: string | null;
    updateIntervalSec: number;
    distanceFilterM: number;
    maxAccuracyM: number;
    offlineQueueMax: number;
    staleAfterSec: number;
    evidenceMaxAgeSec: number;
    requireBackgroundLocation?: boolean;
    requirePreciseLocation?: boolean;
    /** Null while on overtime: it is not bound to the shift window. */
    windowClosesAt: string | null;
  };
}

export interface ShiftWindow {
  shiftDate: string;
  startsAt: string;
  endsAt: string;
  windowOpensAt: string;
  windowClosesAt: string;
}

export interface ShiftView {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  timezone: string;
  daysOfWeek: number[];
  arrivalGraceMinutes: number;
  absenceThresholdMinutes: number | null;
  isActive: boolean;
  current: (ShiftWindow & { sessionId: string | null; completed: boolean }) | null;
  next: ShiftWindow | null;
  /** Where this shift is worked (the roster can place an employee at several workplaces). */
  workplace: { id: string; name: string };
  /** Rostered dates (YYYY-MM-DD, `to` null = until changed) and the manager for each. */
  ranges: Array<{ from: string; to: string | null; managerName: string | null; notes?: string | null }>;
}

export interface Assignment {
  /** The supervisor the worker reports to (set by the owner). */
  supervisor?: { id: string; fullName: string; phone: string | null } | null;
  employee: {
    id: string;
    fullName: string;
    email: string;
    isDemo: boolean;
    employeeCode?: string;
    department?: string | null;
    designation?: string | null;
  };
  workplace: {
    id: string;
    name: string;
    address: string | null;
    latitude: number;
    longitude: number;
    radiusM: number;
    timezone: string;
    isActive: boolean;
    isDemo: boolean;
  } | null;
  shifts: ShiftView[];
  leaveToday: { id: string; leave_type: LeaveType; half_day: boolean; start_date: string; end_date: string } | null;
  /** Holidays at the employee's workplace from today for the next 60 days. */
  holidays: Array<{ holiday_date: string; name: string }>;
  openSession: SessionStatus | null;
  noticeAcknowledged: boolean;
  /** Five-photo face enrollment, done once in the app. */
  faceEnrollment: { required: boolean; enrolled: boolean };
  /** What the phone must allow before a shift can be tracked (the server enforces it too). Missing on older servers. */
  locationRules?: { requireBackground: boolean; requirePrecise: boolean };
  serverTime: string;
}

export type LeaveType = 'CASUAL' | 'SICK' | 'EARNED' | 'UNPAID' | 'OTHER';
export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface LeaveRequest {
  id: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  half_day: boolean;
  days: number;
  reason: string;
  status: LeaveStatus;
  requested_by: string;
  employee_id: string;
  decision_note: string | null;
  decided_by_name: string | null;
  created_at: string;
}

export interface PayResult {
  basic: number;
  payableDays: number | null;
  lossOfPayDays: number;
  lossOfPay: number;
  overtimeHours: number;
  overtimePay: number;
  additions: number;
  deductions: number;
  net: number;
  carryForward: number;
}
export interface PayAttendance {
  daysInMonth: number;
  present: number;
  paidLeave: number;
  unpaidLeave: number;
  holidays: number;
  absent: number;
  workedMinutes: number;
  overtimeMinutes: number;
  late?: number;
}
export interface PayAdjustment {
  id: string;
  kind: 'ADVANCE' | 'BONUS' | 'ALLOWANCE' | 'DEDUCTION';
  amount: number;
  note: string | null;
}
export interface Earnings {
  month: string;
  estimate: { attendance: PayAttendance; result: PayResult; adjustments: PayAdjustment[]; payType: 'MONTHLY' | 'DAILY' | 'HOURLY' } | null;
  payslips: Array<{ id: string; month: string; net_amount: number; status: 'APPROVED' | 'PAID'; paid_at: string | null }>;
}
export interface Payslip {
  id: string;
  month: string;
  net_amount: number;
  status: 'APPROVED' | 'PAID';
  company_name: string;
  data: { employee: { fullName: string; employeeCode: string }; pay: { payType: string; amount: number; otMultiplier: number }; attendance: PayAttendance; adjustments: PayAdjustment[]; result: PayResult };
}

export interface Task {
  id: string;
  title: string;
  details: string | null;
  due_date: string | null;
  requires_photo: boolean;
  status: 'OPEN' | 'SUBMITTED' | 'APPROVED' | 'REOPENED' | 'CANCELLED';
  workplace_name: string | null;
  created_by_name: string | null;
  submitted_at: string | null;
  submission_note: string | null;
  review_note: string | null;
  photo_id: string | null;
  created_at: string;
}

export interface DeviceStatus {
  batteryLevel: number | null;
  charging: boolean | null;
  lowPowerMode: boolean | null;
  network: 'wifi' | 'cellular' | 'none' | 'other' | 'unknown';
}

export interface Reading {
  clientEventId: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  clientTime: string;
  altitudeM?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
  isMocked?: boolean;
}

export interface ReadingResult {
  clientEventId: string;
  status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
  reason?: string;
}

export interface LocationsResponse {
  results: ReadingResult[];
  status: SessionStatus;
}

export interface UploadTicket {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
}

export interface IntentResponse {
  photoId: string;
  upload: UploadTicket;
}

export interface AttendanceResponse {
  attendance: { id: string; recordedAt: string; verificationStatus: string; isLate: boolean; lateByMinutes: number };
  replay: boolean;
}

export interface AttendanceHistoryItem {
  id: string;
  shift_date: string;
  recorded_at: string;
  verification_status: string;
  is_late: boolean;
  late_by_minutes: number;
  evidence_distance_m: number | null;
  evidence_accuracy_m: number | null;
  workplace_name: string;
  shift_name: string;
  is_simulated: boolean;
  away_minutes: number;
  worked_minutes: number | null;
  scheduled_minutes: number | null;
  in_progress: boolean | null;
  /** Approved overtime only. */
  overtime_minutes: number;
  /** Overtime worked after the shift (so far, while it runs), whatever its approval. */
  overtime_claimed_minutes?: number;
  overtime_status?: OvertimeStatus | null;
  left_early: boolean;
}

export type OvertimeStatus = 'RUNNING' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface SessionHistoryItem {
  id: string;
  shift_date: string;
  state: SessionState;
  started_at: string;
  ended_at: string | null;
  termination_reason: string | null;
  shift_name: string;
}

export interface AttendanceHistory {
  attendance: AttendanceHistoryItem[];
  sessions: SessionHistoryItem[];
}

export interface ReviewItem {
  id: string;
  kind: 'MANUAL_REVIEW' | 'TECHNICAL_ISSUE' | 'DISPUTE';
  status: string;
  reason: string;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
  attendance_id: string | null;
  session_id: string | null;
}

export interface PrivacyNotice {
  version: number;
  controller: string;
  contact: string;
  text: string;
  retention: { locationDays: number; photoDays: number };
  tracking: { updateIntervalSec: number; earlyStartMinutes: number; endGraceMinutes: number };
  acknowledged: boolean;
}

export interface PermissionReport {
  foreground: 'granted' | 'denied' | 'undetermined';
  background: 'granted' | 'denied' | 'undetermined' | 'unavailable';
  locationServicesEnabled: boolean;
  precise?: boolean | null;
  batteryOptimization?: string | null;
  clientTime?: string | null;
  deviceId?: string | null;
}
