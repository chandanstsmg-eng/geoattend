import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { OPEN_STATES } from '@geoattend/shared';
import { one, q } from '../../db/pool.js';
import { config } from '../../config.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { SUPERVISOR_SITES, siteFilter } from '../../lib/tenancy.js';
import { createDownloadUrl, requestOrigin } from '../../lib/storage.js';
import { idParams, isoDate, mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { getSettings } from '../settings/settings.service.js';
import { endSession, ingestReadings, reportPermissions, reserveEndPhoto, sessionStatus, startSession } from './tracking.service.js';
import { cancelManualReview, requestManualReview } from '../attendance/attendance.service.js';
import { endBreak, reserveBreakPhoto, startBreak } from './breaks.service.js';
import { reserveOvertimePhoto, startOvertime } from './overtime.service.js';

const locationLimiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 10_000 : 240, standardHeaders: 'draft-8', legacyHeaders: false });

export const readingSchema = z.object({
  clientEventId: z.uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().positive().max(5000),
  clientTime: z.iso.datetime({ offset: true }),
  altitudeM: z.number().min(-1000).max(20000).nullable().optional(),
  speedMps: z.number().min(0).max(400).nullable().optional(),
  headingDeg: z.number().min(0).max(360).nullable().optional(),
  isMocked: z.boolean().optional(),
});

/** Battery and network at upload time — lets "tracking stopped" alerts name the likely cause. */
const deviceStatusSchema = z.object({
  batteryLevel: z.number().min(0).max(1).nullable().optional(),
  charging: z.boolean().nullable().optional(),
  lowPowerMode: z.boolean().nullable().optional(),
  network: z.enum(['wifi', 'cellular', 'none', 'other', 'unknown']).optional(),
});

async function saveDeviceStatus(sessionId: string, employeeId: string, d: z.infer<typeof deviceStatusSchema>) {
  await q(
    `UPDATE tracking_sessions SET last_battery_level = $3, last_battery_charging = $4, last_low_power_mode = $5, last_network = $6, last_device_status_at = now()
     WHERE id = $1 AND employee_id = $2 AND ended_at IS NULL`,
    [sessionId, employeeId, d.batteryLevel ?? null, d.charging ?? null, d.lowPowerMode ?? null, d.network ?? 'unknown'],
  );
}

async function ownOrAdmin(sessionId: string, user: { id: string; role: string; orgId: string; sites: string[] | null }) {
  const s = await one('SELECT s.employee_id, s.workplace_id, u.org_id FROM tracking_sessions s JOIN users u ON u.id = s.employee_id WHERE s.id = $1', [sessionId]);
  if (!s || (user.role === 'ADMIN' && (s.org_id !== user.orgId || (user.sites && !user.sites.includes(s.workplace_id))))) throw notFound('Session');
  if (user.role !== 'ADMIN' && s.employee_id !== user.id) throw forbidden();
}

export const trackingRouter = Router();
mount(trackingRouter, '/api/v1/tracking', 'tracking', [
  route({
    method: 'post',
    path: '/sessions',
    summary: 'Start an authorised shift session (employee action)',
    access: 'employee',
    body: z.object({ shiftId: z.uuid(), deviceId: z.string().min(8).max(128).optional() }),
    handler: async ({ user, body, res }) => {
      const s = await startSession(user.id, body.shiftId, body.deviceId ?? null, 'EMPLOYEE');
      res.status(201);
      return sessionStatus(s.id);
    },
  }),
  route({
    method: 'get',
    path: '/sessions/current',
    summary: "The employee's open session status, or null",
    access: 'employee',
    handler: async ({ user }) => {
      const s = await one('SELECT id FROM tracking_sessions WHERE employee_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', [user.id]);
      return { status: s ? await sessionStatus(s.id) : null };
    },
  }),
  route({
    method: 'get',
    path: '/sessions/:id',
    summary: 'Session status (owner or admin)',
    access: 'authenticated',
    params: idParams,
    handler: async ({ user, params }) => {
      await ownOrAdmin(params.id, user);
      return sessionStatus(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/permissions',
    summary: 'Report device permission / location-services status',
    access: 'employee',
    params: idParams,
    body: z.object({
      foreground: z.enum(['granted', 'denied', 'undetermined']),
      background: z.enum(['granted', 'denied', 'undetermined', 'unavailable']),
      locationServicesEnabled: z.boolean(),
      precise: z.boolean().nullable().optional(),
      batteryOptimization: z.string().max(60).nullable().optional(),
      clientTime: z.iso.datetime({ offset: true }).nullable().optional(),
      deviceId: z.string().min(8).max(128).nullable().optional(),
    }),
    handler: async ({ user, params, body }) => {
      await reportPermissions(params.id, user.id, body);
      return sessionStatus(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/locations',
    summary: 'Upload location readings (single or offline batch, idempotent by clientEventId)',
    access: 'employee',
    pre: [locationLimiter],
    body: z.object({
      sessionId: z.uuid(),
      source: z.enum(['FOREGROUND', 'BACKGROUND']).default('FOREGROUND'),
      readings: z.array(readingSchema).min(1).max(500),
      device: deviceStatusSchema.optional(),
    }),
    handler: async ({ user, body }) => {
      const out = await ingestReadings(body.sessionId, user.id, body.readings.map((r) => ({ ...r, source: body.source })), 'EMPLOYEE');
      if (body.device) await saveDeviceStatus(body.sessionId, user.id, body.device);
      return { results: out.results, status: await sessionStatus(body.sessionId) };
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/end-photo',
    summary: 'Reserve a private upload for the end-of-shift selfie',
    access: 'employee',
    params: idParams,
    body: z.object({ contentType: z.enum(['image/jpeg', 'image/png']), sizeBytes: z.number().int().positive() }),
    handler: async ({ user, params, body, req, res }) => {
      res.status(201);
      return reserveEndPhoto(user.id, params.id, body, requestOrigin(req));
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/end',
    summary: 'End shift — stops location collection (optionally with the end-of-shift selfie)',
    access: 'employee',
    params: idParams,
    body: z.object({ photoId: z.uuid().optional() }).optional(),
    handler: async ({ user, params, body }) => {
      await endSession(params.id, user, 'EMPLOYEE', undefined, body?.photoId ?? null);
      return sessionStatus(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/terminate',
    summary: 'Administrator terminates a tracking session',
    access: 'admin',
    params: idParams,
    scope: 'session',
    body: z.object({ reason: z.string().trim().min(3).max(500) }),
    handler: async ({ user, params, body, req }) => {
      await endSession(params.id, user, 'ADMIN', body.reason);
      await audit({ actor: user, action: 'tracking.terminate', resourceType: 'tracking_session', resourceId: params.id, reason: body.reason, req });
      return sessionStatus(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/review-request',
    summary: 'Employee requests manual review (e.g. persistently weak GPS)',
    access: 'employee',
    params: idParams,
    body: z.object({ reason: z.string().trim().min(3).max(2000) }),
    handler: async ({ user, params, body }) => {
      await requestManualReview(user.id, params.id, body.reason);
      return sessionStatus(params.id);
    },
  }),
  route({
    method: 'delete',
    path: '/sessions/:id/review-request',
    summary: 'Employee cancels an open manual review request',
    access: 'employee',
    params: idParams,
    handler: async ({ user, params }) => {
      await cancelManualReview(user.id, params.id);
      return sessionStatus(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/breaks/photo',
    summary: 'Reserve a private upload for the break selfie (only while present)',
    access: 'employee',
    params: idParams,
    body: z.object({ contentType: z.enum(['image/jpeg', 'image/png']), sizeBytes: z.number().int().positive() }),
    handler: async ({ user, params, body, req, res }) => {
      res.status(201);
      return reserveBreakPhoto(user.id, params.id, body, requestOrigin(req));
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/breaks',
    summary: 'Start a break from inside the workplace area (type, selfie, fresh GPS fix)',
    access: 'employee',
    params: idParams,
    body: z.object({
      typeKey: z.string().min(1).max(40),
      note: z.string().trim().max(500).optional(),
      photoId: z.uuid().optional(),
      evidence: readingSchema,
    }),
    handler: async ({ user, params, body, res }) => {
      await startBreak(user.id, params.id, body);
      res.status(201);
      return sessionStatus(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/breaks/current/end',
    summary: 'End the current break',
    access: 'employee',
    params: idParams,
    handler: async ({ user, params }) => {
      await endBreak(user.id, params.id);
      return sessionStatus(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/overtime/photo',
    summary: 'Reserve a private upload for the overtime selfie (only after the shift has ended)',
    access: 'employee',
    params: idParams,
    body: z.object({ contentType: z.enum(['image/jpeg', 'image/png']), sizeBytes: z.number().int().positive() }),
    handler: async ({ user, params, body, req, res }) => {
      res.status(201);
      return reserveOvertimePhoto(user.id, params.id, body, requestOrigin(req));
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/overtime',
    summary: 'Start overtime after the shift has ended (selfie, optional note, fresh GPS fix — any place). End it with POST /sessions/:id/end.',
    access: 'employee',
    params: idParams,
    body: z.object({ note: z.string().trim().max(500).optional(), photoId: z.uuid(), evidence: readingSchema }),
    handler: async ({ user, params, body, res }) => {
      await startOvertime(user.id, params.id, body);
      res.status(201);
      return sessionStatus(params.id);
    },
  }),

  // ── admin views ──
  route({
    method: 'get',
    path: '/live',
    summary: 'Live workforce: open sessions plus employees assigned today',
    access: 'admin',
    query: z.object({ workplaceId: z.uuid().optional(), supervisorId: z.uuid().optional(), includeSimulated: z.enum(['true', 'false']).default('true') }),
    handler: async ({ query, user }) => {
      const settings = await getSettings(user.orgId);
      const rows = await q(
        `SELECT s.id, s.employee_id, s.state, s.resume_state, s.state_changed_at, s.shift_date, s.started_at, s.ended_at, s.scheduled_start_at, s.scheduled_end_at,
                s.last_location_at, s.last_location_client_at, s.last_latitude, s.last_longitude, s.last_accuracy_m, s.last_distance_m,
                s.last_classification, s.last_is_mocked, s.last_battery_level, s.last_battery_charging, s.last_low_power_mode, s.last_network, s.last_device_status_at, s.foreground_permission, s.background_permission, s.location_services_enabled, s.is_simulated, s.sim_clock_offset_sec,
                u.full_name, ep.employee_code, w.id AS workplace_id, w.name AS workplace_name, w.radius_m, w.latitude AS wp_lat, w.longitude AS wp_lng,
                sh.name AS shift_name,
                a.started_at AS away_since, a.threshold_minutes AS away_threshold, a.tracking_gap,
                b.id AS break_id, b.type_label AS break_label, b.paid AS break_paid, b.started_at AS break_since, b.max_minutes AS break_max_minutes, b.left_at AS break_left_at, b.overdue_at AS break_overdue_at,
                ot.id AS overtime_id, ot.started_at AS overtime_since, ot.note AS overtime_note,
                ar.id AS attendance_id, ar.recorded_at AS attendance_at, ar.is_late,
                ep.supervisor_id, su.full_name AS supervisor_name
         FROM tracking_sessions s
         JOIN users u ON u.id = s.employee_id
         LEFT JOIN employee_profiles ep ON ep.user_id = u.id
         LEFT JOIN users su ON su.id = ep.supervisor_id
         JOIN workplaces w ON w.id = s.workplace_id
         JOIN shifts sh ON sh.id = s.shift_id
         LEFT JOIN absence_intervals a ON a.session_id = s.id AND a.status = 'OPEN'
         LEFT JOIN session_breaks b ON b.session_id = s.id AND b.ended_at IS NULL
         LEFT JOIN overtime_entries ot ON ot.session_id = s.id AND ot.ended_at IS NULL
         LEFT JOIN attendance_records ar ON ar.employee_id = s.employee_id AND ar.shift_id = s.shift_id AND ar.shift_date = s.shift_date AND ar.verification_status <> 'VOIDED'
         WHERE u.org_id = $3 AND ${siteFilter('s.workplace_id', '$4')} AND (s.ended_at IS NULL OR s.ended_at > now() - interval '12 hours')
           AND ($1::uuid IS NULL OR s.workplace_id = $1) AND ($2 OR NOT s.is_simulated)
           AND ($5::uuid IS NULL OR s.workplace_id = ANY(${SUPERVISOR_SITES('$5')}))
         ORDER BY u.full_name`,
        [query.workplaceId ?? null, query.includeSimulated === 'true', user.orgId, user.sites, query.supervisorId ?? null],
      );
      const now = Date.now();
      return {
        serverTime: new Date(now),
        staleAfterSec: settings.tracking.staleAfterSec,
        sessions: rows.map((r) => {
          const sessionNowMs = now + r.sim_clock_offset_sec * 1000; // simulator clock; 0 offset for real sessions
          return {
            ...r,
            radius_m: Number(r.radius_m),
            is_open: !r.ended_at && OPEN_STATES.includes(r.state),
            is_stale: !r.ended_at && (!r.last_location_at || sessionNowMs - new Date(r.last_location_at).getTime() > settings.tracking.staleAfterSec * 1000),
            away_minutes: r.away_since ? Math.max(0, Math.round((sessionNowMs - new Date(r.away_since).getTime()) / 60000)) : null,
            break_minutes: r.break_since ? Math.max(0, Math.round((sessionNowMs - new Date(r.break_since).getTime()) / 60000)) : null,
            overtime_minutes: r.overtime_since ? Math.max(0, Math.round((sessionNowMs - new Date(r.overtime_since).getTime()) / 60000)) : null,
          };
        }),
      };
    },
  }),
  route({
    method: 'get',
    path: '/sessions',
    summary: 'Sessions by date / workplace / employee',
    access: 'admin',
    query: z.object({ date: isoDate.optional(), workplaceId: z.uuid().optional(), employeeId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
    handler: async ({ query, user }) =>
      q(
        `SELECT s.*, u.full_name, sh.name AS shift_name, w.name AS workplace_name FROM tracking_sessions s
         JOIN users u ON u.id = s.employee_id JOIN shifts sh ON sh.id = s.shift_id JOIN workplaces w ON w.id = s.workplace_id
         WHERE u.org_id = $5 AND ${siteFilter('s.workplace_id', '$6')} AND ($1::date IS NULL OR s.shift_date = $1) AND ($2::uuid IS NULL OR s.workplace_id = $2) AND ($3::uuid IS NULL OR s.employee_id = $3)
         ORDER BY s.started_at DESC LIMIT $4`,
        [query.date ?? null, query.workplaceId ?? null, query.employeeId ?? null, query.limit, user.orgId, user.sites],
      ),
  }),
  route({
    method: 'get',
    path: '/sessions/:id/timeline',
    summary: 'State transitions, geofence events and absences of a session',
    access: 'admin',
    params: idParams,
    scope: 'session',
    handler: async ({ params }) => ({
      transitions: await q('SELECT * FROM session_state_transitions WHERE session_id = $1 ORDER BY at, id', [params.id]),
      geofenceEvents: await q('SELECT * FROM geofence_events WHERE session_id = $1 ORDER BY event_time, id', [params.id]),
      absences: await q('SELECT * FROM absence_intervals WHERE session_id = $1 ORDER BY started_at', [params.id]),
      breaks: await q('SELECT * FROM session_breaks WHERE session_id = $1 ORDER BY started_at', [params.id]),
      overtime: await q('SELECT * FROM overtime_entries WHERE session_id = $1', [params.id]),
      permissions: await q('SELECT * FROM permission_status_events WHERE session_id = $1 ORDER BY received_at', [params.id]),
    }),
  }),
  route({
    method: 'post',
    path: '/sessions/:id/breaks/:breakId/photo-url',
    summary: 'Short-lived link to a break selfie (audited)',
    access: 'admin',
    params: z.object({ id: z.uuid(), breakId: z.uuid() }),
    scope: 'session',
    handler: async ({ params, user, req }) => {
      const p = await one(
        `SELECT p.* FROM session_breaks b JOIN attendance_photos p ON p.id = b.photo_id WHERE b.id = $1 AND b.session_id = $2 AND p.status = 'ATTACHED'`,
        [params.breakId, params.id],
      );
      if (!p) throw notFound('Photo');
      await audit({ actor: user, action: 'break_photo.view', resourceType: 'session_break', resourceId: params.breakId, req });
      return { url: await createDownloadUrl(p.object_key) };
    },
  }),
  route({
    method: 'get',
    path: '/sessions/:id/locations',
    summary: 'Raw location history of a session (access is audited)',
    access: 'admin',
    params: idParams,
    scope: 'session',
    handler: async ({ params, user, req }) => {
      await audit({ actor: user, action: 'location_history.view', resourceType: 'tracking_session', resourceId: params.id, req });
      return q(
        `SELECT id, latitude, longitude, accuracy_m, client_time, received_at, distance_m, classification, validation_status, source, is_mocked, is_simulated
         FROM location_updates WHERE session_id = $1 ORDER BY client_time LIMIT 5000`,
        [params.id],
      );
    },
  }),
]);
