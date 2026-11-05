/** Employee self-service. Every query is scoped to the signed-in employee's own id. */
import { Router } from 'express';
import { z } from 'zod';
import { one, q } from '../../db/pool.js';
import { DEFAULT_TIMEZONE, orgToday } from '../../lib/dates.js';
import { pendingMinutes } from '../../lib/tenancy.js';
import { DateTime } from 'luxon';
import { badRequest, notFound } from '../../lib/errors.js';
import { mount, route } from '../../lib/http.js';
import { currentInstance, nextInstance, todayIn } from '../../lib/shift-window.js';
import { getSettings, photoDeletionAllowed, hasAcknowledgedNotice } from '../settings/settings.service.js';
import { employeeAssignment, sessionStatus } from '../tracking/tracking.service.js';
import { reportIssue } from '../attendance/attendance.service.js';
import { workFlags } from '../reports/reports.routes.js';
import { computeMonth } from '../payroll/payroll.routes.js';
import { assertPayrollEnabled } from '../payroll/guard.js';
import { config } from '../../config.js';
import { audit } from '../../lib/audit.js';

export const meRouter = Router();
mount(meRouter, '/api/v1/me', 'me', [
  route({
    method: 'get',
    path: '/assignment',
    summary: 'Assigned workplace, shifts with current/next windows, and the open session',
    access: 'employee',
    handler: async ({ user }) => {
      const settings = await getSettings(user.orgId);
      const { workplace: home, shifts } = await employeeAssignment(user.id);
      const profile = await one(
        `SELECT ep.employee_code, ep.department, ep.designation, su.id AS supervisor_id, su.full_name AS supervisor_name, sp.phone AS supervisor_phone
         FROM employee_profiles ep LEFT JOIN users su ON su.id = ep.supervisor_id AND su.is_active LEFT JOIN administrator_profiles sp ON sp.user_id = su.id
         WHERE ep.user_id = $1`,
        [user.id],
      );
      const now = new Date();
      const open = await one('SELECT id FROM tracking_sessions WHERE employee_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', [user.id]);
      const siteOf = (sh: any) => ({
        id: sh.workplace_id,
        name: sh.wp_name,
        address: sh.wp_address,
        latitude: sh.wp_latitude,
        longitude: sh.wp_longitude,
        radius_m: sh.wp_radius_m,
        timezone: sh.wp_timezone,
        is_active: sh.wp_is_active,
        is_demo: sh.wp_is_demo,
        absence_threshold_minutes: sh.wp_absence_threshold,
      });
      const shiftViews = await Promise.all(
        shifts.map(async (sh) => {
          const cur = currentInstance(sh, now, settings.tracking.earlyStartMinutes, settings.tracking.endGraceMinutes, sh.ranges);
          const next = nextInstance(sh, now, settings.tracking.earlyStartMinutes, settings.tracking.endGraceMinutes, sh.ranges);
          const done = cur ? await one('SELECT id, state, ended_at FROM tracking_sessions WHERE employee_id = $1 AND shift_id = $2 AND shift_date = $3', [user.id, sh.id, cur.shiftDate]) : null;
          return {
            id: sh.id,
            name: sh.name,
            startTime: sh.start_time.slice(0, 5),
            endTime: sh.end_time.slice(0, 5),
            timezone: sh.timezone,
            daysOfWeek: sh.days_of_week,
            arrivalGraceMinutes: sh.arrival_grace_minutes,
            absenceThresholdMinutes: sh.absence_threshold_minutes ?? sh.wp_absence_threshold,
            isActive: sh.is_active && sh.wp_is_active,
            workplace: { id: sh.workplace_id, name: sh.wp_name },
            ranges: sh.ranges,
            current: cur && { ...cur, sessionId: done?.id ?? null, completed: !!done?.ended_at },
            next,
          };
        }),
      );
      // The workplace shown on the phone: where the current (or else the next) rostered shift is, otherwise home.
      const live = shifts.find((sh, i) => shiftViews[i]!.current) ?? shifts
        .map((sh, i) => ({ sh, next: shiftViews[i]!.next }))
        .filter((x) => x.next)
        .sort((a, b) => a.next!.startsAt.getTime() - b.next!.startsAt.getTime())[0]?.sh;
      const workplace = live ? siteOf(live) : home;
      return {
        employee: { id: user.id, fullName: user.fullName, email: user.email, isDemo: user.isDemo, ...(profile ? { employeeCode: profile.employee_code, department: profile.department, designation: profile.designation } : {}) },
        supervisor: profile?.supervisor_id ? { id: profile.supervisor_id, fullName: profile.supervisor_name, phone: profile.supervisor_phone ?? null } : null,
        workplace: workplace && {
          id: workplace.id,
          name: workplace.name,
          address: workplace.address,
          latitude: workplace.latitude,
          longitude: workplace.longitude,
          radiusM: Number(workplace.radius_m),
          timezone: workplace.timezone,
          isActive: workplace.is_active,
          isDemo: workplace.is_demo,
        },
        shifts: shiftViews,
        leaveToday: await one(
          `SELECT id, leave_type, half_day, start_date, end_date FROM leave_requests
           WHERE employee_id = $1 AND status = 'APPROVED' AND start_date <= $2 AND end_date >= $2 LIMIT 1`,
          [user.id, todayIn(workplace?.timezone ?? DEFAULT_TIMEZONE, now)],
        ),
        holidays: workplace
          ? await q(
              `SELECT holiday_date, name FROM holidays WHERE org_id = $3 AND (workplace_id IS NULL OR workplace_id = $1) AND holiday_date BETWEEN $2::date AND $2::date + 60
               ORDER BY holiday_date`,
              [workplace.id, todayIn(workplace.timezone, now), user.orgId],
            )
          : [],
        openSession: open ? await sessionStatus(open.id) : null,
        noticeAcknowledged: await hasAcknowledgedNotice(user.id, user.orgId),
        faceEnrollment: { required: settings.workforce.faceEnrollment === 'REQUIRED', enrolled: !!(await one('SELECT 1 FROM employee_face_profiles WHERE employee_id = $1', [user.id])) },
        // What the phone must allow before a shift can be tracked (the server enforces it too).
        locationRules: { requireBackground: settings.tracking.requireBackgroundLocation, requirePrecise: settings.tracking.requirePreciseLocation },
        serverTime: now,
      };
    },
  }),
  route({
    method: 'get',
    path: '/attendance',
    summary: 'Own attendance history',
    access: 'employee',
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) }),
    handler: async ({ user, query }) => {
      const rows = await q(
        `SELECT ar.id, ar.shift_date, ar.recorded_at, ar.verification_status, ar.is_late, ar.late_by_minutes, ar.evidence_distance_m,
                ar.evidence_accuracy_m, w.name AS workplace_name, sh.name AS shift_name, ar.is_simulated, ar.face_review, ar.face_review_note, ar.risk_flags,
                (SELECT r.resolution_note FROM review_requests r WHERE r.attendance_id = ar.id AND r.reason LIKE 'Offline record rejected:%' ORDER BY r.created_at DESC LIMIT 1) AS rejection_note,
                (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, now()) - a.started_at)) / 60), 0)::int
                   FROM absence_intervals a WHERE a.session_id = ar.session_id) AS away_minutes,
                aw.worked_minutes, aw.scheduled_minutes, aw.ended_early_minutes, aw.in_progress,
                aw.overtime_minutes, aw.overtime_claimed_minutes, aw.overtime_status, ${pendingMinutes()} AS pending_minutes
         FROM attendance_records ar JOIN workplaces w ON w.id = ar.workplace_id JOIN shifts sh ON sh.id = ar.shift_id
         LEFT JOIN attendance_work aw ON aw.attendance_id = ar.id
         WHERE ar.employee_id = $1 ORDER BY ar.shift_date DESC, ar.recorded_at DESC LIMIT $2`,
        [user.id, query.limit],
      );
      const { workforce } = await getSettings(user.orgId);
      for (const r of rows) Object.assign(r, workFlags(r, workforce));
      const sessions = await q(
        `SELECT s.id, s.shift_date, s.state, s.started_at, s.ended_at, s.termination_reason, sh.name AS shift_name
         FROM tracking_sessions s JOIN shifts sh ON sh.id = s.shift_id WHERE s.employee_id = $1 ORDER BY s.started_at DESC LIMIT $2`,
        [user.id, query.limit],
      );
      return { attendance: rows, sessions };
    },
  }),
  route({
    method: 'get',
    path: '/earnings',
    summary: 'This month so far (estimate) and approved payslips',
    access: 'employee',
    handler: async ({ user }) => {
      const month = (await orgToday(user.orgId)).slice(0, 7);
      if (!config.payrollEnabled) return { month, estimate: null, payslips: [] };
      const [current] = await computeMonth(user.orgId, month, user.id);
      const payslips = await q(
        `SELECT p.id, p.month, p.net_amount::float AS net_amount, r.status, r.paid_at FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
         WHERE p.employee_id = $1 AND r.superseded_at IS NULL ORDER BY p.month DESC LIMIT 24`,
        [user.id],
      );
      const locked = await one(`SELECT 1 FROM payroll_runs WHERE org_id = $1 AND month = $2 AND superseded_at IS NULL`, [user.orgId, month]);
      return { month, estimate: current?.result && !locked ? { attendance: current.attendance, result: current.result, adjustments: current.adjustments, payType: current.pay!.payType } : null, payslips };
    },
  }),
  route({
    method: 'get',
    path: '/payslips/:id',
    summary: 'One of my payslips',
    access: 'employee',
    params: z.object({ id: z.uuid() }),
    handler: async ({ user, params }) => {
      assertPayrollEnabled();
      const p = await one(
        `SELECT p.id, p.month, p.net_amount::float AS net_amount, p.data, r.status, r.paid_at, o.name AS company_name FROM payslips p
         JOIN payroll_runs r ON r.id = p.run_id JOIN organizations o ON o.id = r.org_id WHERE p.id = $1 AND p.employee_id = $2 AND r.superseded_at IS NULL`,
        [params.id, user.id],
      );
      if (!p) throw notFound('Payslip');
      return p;
    },
  }),
  route({
    method: 'get',
    path: '/privacy-notice',
    summary: 'Tracking and photo notice with retention periods',
    access: 'authenticated',
    handler: async ({ user }) => {
      const s = await getSettings(user.orgId);
      return {
        version: s.privacy.version,
        controller: s.privacy.controller,
        contact: s.privacy.contact,
        text: s.privacy.text,
        retention: { locationDays: s.retention.locationDays, photoDays: s.retention.photoDays, photoAutoDelete: photoDeletionAllowed(s) },
        tracking: { updateIntervalSec: s.tracking.updateIntervalSec, earlyStartMinutes: s.tracking.earlyStartMinutes, endGraceMinutes: s.tracking.endGraceMinutes },
        acknowledged: user.role === 'EMPLOYEE' ? await hasAcknowledgedNotice(user.id, user.orgId) : true,
      };
    },
  }),
  route({
    method: 'post',
    path: '/privacy-notice/ack',
    summary: 'Acknowledge the current notice version',
    access: 'employee',
    body: z.object({ version: z.number().int().min(1) }),
    handler: async ({ user, body }) => {
      const s = await getSettings(user.orgId);
      if (body.version !== s.privacy.version) throw badRequest('NOTICE_OUTDATED', 'The notice has changed. Please review the latest version.');
      await q('INSERT INTO notice_acknowledgements (user_id, notice_version) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, body.version]);
      return { ok: true };
    },
  }),
  route({
    method: 'post',
    path: '/devices',
    summary: 'Register / refresh this device (push token, app version)',
    access: 'employee',
    body: z.object({
      deviceId: z.string().min(8).max(128),
      platform: z.enum(['android', 'ios', 'web', 'simulator']),
      osVersion: z.string().max(40).optional(),
      model: z.string().max(80).optional(),
      appVersion: z.string().max(40).optional(),
      pushToken: z.string().max(300).nullable().optional(),
    }),
    handler: async ({ user, body }) => {
      // Details only: a new row is PENDING until an owner or supervisor approves it.
      const reg = await one(
        `INSERT INTO device_registrations (user_id, device_id, platform, os_version, model, app_version, push_token, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')
         ON CONFLICT (user_id, device_id) DO UPDATE SET platform = EXCLUDED.platform, os_version = EXCLUDED.os_version, model = EXCLUDED.model,
           app_version = EXCLUDED.app_version, push_token = COALESCE(EXCLUDED.push_token, device_registrations.push_token), last_seen_at = now()
         RETURNING id, (xmax = 0) AS created`,
        [user.id, body.deviceId, body.platform, body.osVersion ?? null, body.model ?? null, body.appVersion ?? null, body.pushToken ?? null],
      );
      if (reg?.created) await audit({ actor: user, action: 'device.register', resourceType: 'device', resourceId: reg.id, after: { platform: body.platform, model: body.model } });
      return { ok: true };
    },
  }),
  route({
    method: 'post',
    path: '/issues',
    summary: 'Report a technical issue or dispute an attendance record',
    access: 'employee',
    body: z.object({
      kind: z.enum(['TECHNICAL_ISSUE', 'DISPUTE']),
      sessionId: z.uuid().nullable().optional(),
      attendanceId: z.uuid().nullable().optional(),
      reason: z.string().trim().min(3).max(2000),
    }),
    handler: async ({ user, body }) => reportIssue(user.id, body),
  }),
  route({
    method: 'get',
    path: '/reviews',
    summary: 'Own review requests, issues and disputes',
    access: 'employee',
    handler: async ({ user }) =>
      q(
        `SELECT id, kind, status, reason, resolution_note, created_at, resolved_at, attendance_id, session_id
         FROM review_requests WHERE employee_id = $1 AND kind <> 'ADMIN_CORRECTION' ORDER BY created_at DESC LIMIT 50`,
        [user.id],
      ),
  }),
]);
