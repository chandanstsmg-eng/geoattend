/**
 * Application settings: tracking policy, alerting, retention, geofence limits
 * and the employee-facing privacy notice. Stored in application_settings as
 * JSON, validated with zod, cached in-process and invalidated on write.
 */
import { z } from 'zod';
import { NOTIFICATION_TYPES } from '@geoattend/shared';
import { config } from '../../config.js';
import { one, q, type Queryable } from '../../db/pool.js';

export const trackingSchema = z.object({
  updateIntervalSec: z.number().int().min(10).max(600),
  distanceFilterM: z.number().min(0).max(200),
  maxAccuracyM: z.number().min(5).max(200),
  boundaryFactor: z.number().min(0).max(1.5),
  exitHysteresisM: z.number().min(0).max(100),
  entryStabilizationSec: z.number().int().min(0).max(900),
  entryMinReadings: z.number().int().min(1).max(10),
  exitStabilizationSec: z.number().int().min(0).max(1800),
  exitMinReadings: z.number().int().min(1).max(10),
  returnStabilizationSec: z.number().int().min(0).max(900),
  returnMinReadings: z.number().int().min(1).max(10),
  staleAfterSec: z.number().int().min(60).max(3600),
  evidenceMaxAgeSec: z.number().int().min(10).max(600),
  earlyStartMinutes: z.number().int().min(0).max(240),
  endGraceMinutes: z.number().int().min(0).max(240),
  uncertainReviewAfterSec: z.number().int().min(60).max(3600),
  mockLocationPolicy: z.enum(['FLAG', 'BLOCK_ATTENDANCE']),
  offlineQueueMax: z.number().int().min(50).max(5000),
  /**
   * Arrival must also be seen by the server over this many seconds (readings arriving in separate
   * uploads), so a batch of readings with made-up phone times cannot unlock attendance at once.
   */
  entryMinServerSpanSec: z.number().int().min(0).max(600),
  /** Location must be allowed "all the time": otherwise tracking stops when the app is closed. */
  requireBackgroundLocation: z.boolean(),
  /** Precise location must be on (Android "approximate" / iOS "precise off" are refused). */
  requirePreciseLocation: z.boolean(),
  /** Rooted / jailbroken phones and emulators: flag the record, or refuse attendance (manual review instead). */
  deviceIntegrityPolicy: z.enum(['FLAG', 'BLOCK_ATTENDANCE']),
});

export const alertsSchema = z.object({
  prolongedReminderCooldownMin: z.number().int().min(5).max(480),
  /** Alert when a scheduled employee has not started their shift this many minutes after it began (0 = off). */
  noShowAfterMinutes: z.number().int().min(0).max(240),
  notifyOnReturn: z.boolean(),
  notifyOnArrival: z.boolean(),
  webPushTypes: z.array(z.enum(NOTIFICATION_TYPES)),
  emailTypes: z.array(z.enum(NOTIFICATION_TYPES)),
});

export const retentionSchema = z.object({
  locationDays: z.number().int().min(1).max(3650),
  photoDays: z.number().int().min(1).max(3650),
  /** The company's choice to delete photos after photoDays. Has no effect while the server switch is off. */
  photoAutoDelete: z.boolean(),
  notificationDays: z.number().int().min(7).max(3650),
});

/** Smallest geofence allowed anywhere: below this, ordinary indoor GPS error locks genuine workers out. */
export const GEOFENCE_FLOOR_M = 50;

export const geofenceSchema = z.object({
  presetsM: z.array(z.number().min(10).max(1000)).min(1).max(8),
  minRadiusM: z.number().min(10).max(1000),
  maxRadiusM: z.number().min(10).max(1000),
});

export const privacySchema = z.object({
  version: z.number().int().min(1),
  controller: z.string().min(1).max(300),
  contact: z.string().min(1).max(300),
  text: z.string().min(50).max(20000),
});

export const workforceSchema = z.object({
  /** ENFORCE: a new phone cannot sign in until approved. ALERT: it can, and admins are told. OFF: no check. */
  deviceBinding: z.enum(['ENFORCE', 'ALERT', 'OFF']),
  /** Time worked beyond the scheduled shift below this is not counted as overtime. */
  overtimeMinMinutes: z.number().int().min(0).max(240),
  /** Ending the shift this many minutes or more before its scheduled end counts as leaving early. */
  leftEarlyMinutes: z.number().int().min(0).max(240),
  /** REQUIRED: an employee enrolls their face (five photos) before their first shift. OFF: optional. */
  faceEnrollment: z.enum(['REQUIRED', 'OFF']),
  /** Supervisors may publish announcements to the workers of their own workplaces. */
  supervisorAnnouncements: z.boolean(),
  /** Reports round each shift's net worked time to the nearest N minutes (0 = exact). */
  roundingMinutes: z.union([z.literal(0), z.literal(5), z.literal(6), z.literal(10), z.literal(15), z.literal(30)]),
  /** Regular time above this many hours in a Monday–Sunday week counts as overtime in reports (0 = off). */
  weeklyRegularHours: z.number().min(0).max(168),
  /** Company overtime rate: the default for new pay setups. A company policy, not a statutory calculation. */
  overtimeMultiplier: z.number().min(0).max(5),
  /**
   * Keep check-in selfies after the face check matches (until the photo retention period ends).
   * Off: a matched photo is deleted at once and only the result and score are kept.
   */
  keepMatchedPhotos: z.boolean(),
});

export const breakTypeSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/, 'Use capital letters, digits and _'),
  label: z.string().trim().min(1).max(60),
  /** Paid breaks count as worked time; unpaid ones are subtracted. */
  paid: z.boolean(),
  /** After this long the break is overdue and administrators are alerted. */
  maxMinutes: z.number().int().min(1).max(480),
});
export const breaksSchema = z.object({
  types: z
    .array(breakTypeSchema)
    .min(1)
    .max(12)
    .refine((t) => new Set(t.map((x) => x.key)).size === t.length, 'Each break type needs a different key'),
  /** Require a selfie when starting a break. */
  requirePhoto: z.boolean(),
});
export type BreakType = z.infer<typeof breakTypeSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
export const digestSchema = z.object({
  /** Local times (the company's main workplace time zone) for the daily summary. */
  times: z.array(hhmm).max(4),
  /** WhatsApp numbers with country code, digits only, e.g. 919800000000. */
  whatsappNumbers: z.array(z.string().regex(/^\d{10,15}$/, 'Digits with country code, e.g. 919800000000')).max(10),
  emailRecipients: z.array(z.email()).max(10),
  /** On the 1st, e-mail last month's summary (CSV) to the e-mail recipients. */
  monthlyReport: z.boolean(),
});

export const settingsSchema = z.object({
  tracking: trackingSchema,
  alerts: alertsSchema,
  retention: retentionSchema,
  geofence: geofenceSchema,
  privacy: privacySchema,
  workforce: workforceSchema,
  digest: digestSchema,
  breaks: breaksSchema,
});
export type Settings = z.infer<typeof settingsSchema>;
export type TrackingSettings = z.infer<typeof trackingSchema>;

export const DEFAULT_PRIVACY_TEXT = `What we collect
• Your device location (latitude, longitude, reported GPS accuracy and time) — only while a shift you started is active, including overtime you start.
• One attendance photograph per shift, captured by you with the device camera after you reach your workplace, and a selfie when you start and end overtime.
• Device and permission status (for example whether location permission is granted) so that tracking problems can be reported honestly.

Why we collect it
• To confirm that attendance is marked at the assigned workplace.
• To record when you leave and return to the workplace during a shift, and to alert your administrator about prolonged absences.

When tracking happens
• Tracking starts only when you tap "Start shift" and stops when you end the shift, when the shift window closes, or when an administrator ends the session.
• If you tap "Start overtime" after your shift ends, tracking continues — wherever you work — until you tap "End overtime". The location is evidence for your manager when approving the overtime. If your phone stops sending location for an hour, overtime ends at the last location received.
• While tracking is active the app shows a persistent notification on Android and an in-app indicator.
• No location is collected outside an active shift.

Who can see it
• Administrators of your organisation. Every view of location history or attendance photos by an administrator is recorded in an audit log.

How long it is kept
• Raw location history is deleted automatically after the period configured by your organisation (shown below).
• Attendance photos are kept for the period shown below. They are deleted automatically only if that has been switched on, which is also shown below.
• Attendance records (times, verification status) are kept for payroll and legal record keeping.

Your choices
• You can deny or revoke location permission at any time in device settings. Attendance cannot then be verified automatically; the app will tell you and you can request a manual review.
• You can dispute an attendance record or request a correction from the app.

GPS limitations
• GPS readings are estimates and can be affected by buildings, weather and device settings. The system never treats a single reading as proof, and never treats a lost signal as proof that you left.`;

export const DEFAULT_SETTINGS: Settings = {
  tracking: {
    updateIntervalSec: 30,
    // 0 = time-driven updates. A movement filter would silence a stationary phone,
    // which the server would then (correctly) report as a tracking interruption.
    distanceFilterM: 0,
    maxAccuracyM: 25,
    boundaryFactor: 0.5,
    exitHysteresisM: 10,
    entryStabilizationSec: 20,
    entryMinReadings: 2,
    exitStabilizationSec: 60,
    exitMinReadings: 2,
    returnStabilizationSec: 20,
    returnMinReadings: 2,
    staleAfterSec: 300,
    evidenceMaxAgeSec: 90,
    earlyStartMinutes: 60,
    endGraceMinutes: 30,
    uncertainReviewAfterSec: 300,
    mockLocationPolicy: 'BLOCK_ATTENDANCE',
    offlineQueueMax: 2000,
    entryMinServerSpanSec: 20,
    requireBackgroundLocation: true,
    requirePreciseLocation: true,
    deviceIntegrityPolicy: 'BLOCK_ATTENDANCE',
  },
  alerts: {
    prolongedReminderCooldownMin: 30,
    noShowAfterMinutes: 15,
    notifyOnReturn: true,
    notifyOnArrival: true,
    webPushTypes: ['BREAK_OVERDUE', 'PROLONGED_ABSENCE', 'TRACKING_INTERRUPTED', 'PERMISSION_REVOKED', 'DUPLICATE_SUBMISSION', 'MANUAL_REVIEW_REQUESTED', 'LATE_ARRIVAL', 'NO_SHOW', 'LEAVE_REQUESTED'],
    emailTypes: ['PROLONGED_ABSENCE', 'MANUAL_REVIEW_REQUESTED', 'NO_SHOW'],
  },
  retention: { locationDays: 90, photoDays: 180, photoAutoDelete: false, notificationDays: 365 },
  // 100 m by default: smaller circles reject genuine workers whose phones report ±30–60 m indoors.
  geofence: { presetsM: [50, 100, 200, 500], minRadiusM: 50, maxRadiusM: 1000 },
  // Version 2: overtime (tracking after the shift, anywhere, until the employee ends it).
  privacy: { version: 2, controller: 'Your organisation (configure in Settings)', contact: 'hr@example.com', text: DEFAULT_PRIVACY_TEXT },
  workforce: { deviceBinding: 'ENFORCE', overtimeMinMinutes: 15, leftEarlyMinutes: 15, faceEnrollment: 'REQUIRED', supervisorAnnouncements: true, roundingMinutes: 0, weeklyRegularHours: 0, overtimeMultiplier: 1, keepMatchedPhotos: true },
  digest: { times: ['10:00', '19:00'], whatsappNumbers: [], emailRecipients: [], monthlyReport: true },
  breaks: {
    types: [
      { key: 'LUNCH', label: 'Lunch', paid: false, maxMinutes: 45 },
      { key: 'TEA', label: 'Tea break', paid: true, maxMinutes: 15 },
      { key: 'PERSONAL', label: 'Personal', paid: false, maxMinutes: 15 },
      { key: 'OFFICIAL', label: 'Official work outside', paid: true, maxMinutes: 60 },
    ],
    requirePhoto: true,
  },
};

// Each company has its own settings (defaults for anything it has not changed).
const cache = new Map<string, Settings>();

export async function getSettings(orgId: string, db?: Queryable): Promise<Settings> {
  const hit = cache.get(orgId);
  if (hit) return hit;
  const rows = await q<{ key: string; value: unknown }>('SELECT key, value FROM application_settings WHERE org_id = $1', [orgId], db);
  const merged: any = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) if (r.key in merged) merged[r.key] = { ...merged[r.key], ...(r.value as object) };
  const parsed = settingsSchema.parse(merged);
  cache.set(orgId, parsed);
  return parsed;
}

/** Whether anything may delete this company's photos on its own: the server switch and the company's choice. */
export const photoDeletionAllowed = (s: Pick<Settings, 'retention'>) => config.photoAutoDeleteEnabled && s.retention.photoAutoDelete;

export function invalidateSettings(orgId?: string) {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

export async function saveSettingsSection<K extends keyof Settings>(orgId: string, key: K, value: Settings[K], userId: string | null, db?: Queryable) {
  await q(
    `INSERT INTO application_settings (org_id, key, value, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, key, JSON.stringify(value), userId],
    db,
  );
  invalidateSettings(orgId);
}

/** The company an employee belongs to (for code paths that start from an employee id). */
export async function orgOfUser(userId: string, db?: Queryable): Promise<string> {
  const u = await q<{ org_id: string }>('SELECT org_id FROM users WHERE id = $1', [userId], db);
  if (!u[0]) throw new Error(`unknown user ${userId}`);
  return u[0].org_id;
}

export async function hasAcknowledgedNotice(userId: string, orgId: string) {
  const s = await getSettings(orgId);
  return !!(await one('SELECT 1 FROM notice_acknowledgements WHERE user_id = $1 AND notice_version = $2', [userId, s.privacy.version]));
}
