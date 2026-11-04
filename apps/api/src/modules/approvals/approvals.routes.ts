/**
 * One inbox for everything waiting on an administrator: leave requests, attendance
 * reviews / disputes / technical issues, face checks that did not match, new phones and overtime. The actions
 * themselves live in their own modules (leave, attendance reviews, devices, overtime).
 */
import { Router } from 'express';
import { one, q } from '../../db/pool.js';
import { mount, route } from '../../lib/http.js';
import { employeeSite, overtimeCounts, siteFilter } from '../../lib/tenancy.js';

// $1 = the administrator's company, $2 = a supervisor's sites (null for owners).
const SITE = siteFilter(employeeSite('u.id'), '$2');
// A supervisor's correction waits for an owner, so it is in owners' lists only.
const REVIEW_KINDS = `(r.kind IN ('MANUAL_REVIEW', 'DISPUTE', 'TECHNICAL_ISSUE') OR (r.kind = 'ADMIN_CORRECTION' AND $2::uuid[] IS NULL))`;
const COUNTS = `
  SELECT (SELECT count(*)::int FROM leave_requests l JOIN users u ON u.id = l.employee_id WHERE l.status = 'PENDING' AND u.org_id = $1 AND ${SITE}) AS leave,
         (SELECT count(*)::int FROM review_requests r JOIN users u ON u.id = r.employee_id
            WHERE r.status = 'OPEN' AND ${REVIEW_KINDS} AND u.org_id = $1 AND ${SITE}) AS reviews,
         (SELECT count(*)::int FROM device_registrations d JOIN users u ON u.id = d.user_id WHERE d.status = 'PENDING' AND u.is_active AND u.org_id = $1 AND ${SITE}) AS devices,
         -- Face checks follow the rostered workplace of the record, like attendance itself.
         (SELECT count(*)::int FROM attendance_records ar JOIN users u ON u.id = ar.employee_id
            WHERE ar.face_review = 'PENDING' AND u.org_id = $1 AND ${siteFilter('ar.workplace_id', '$2')}) AS faces,
         -- Finished overtime waiting for a decision, by the workplace where it was worked.
         (SELECT count(*)::int FROM overtime_entries o JOIN users u ON u.id = o.employee_id
            WHERE o.status = 'PENDING' AND o.ended_at IS NOT NULL AND u.org_id = $1 AND ${siteFilter('o.workplace_id', '$2')} AND ${overtimeCounts()}) AS overtime`;

export const approvalsRouter = Router();
mount(approvalsRouter, '/api/v1/approvals', 'approvals', [
  route({
    method: 'get',
    path: '/count',
    summary: 'How many items are waiting (for the navigation badge)',
    access: 'admin',
    handler: async ({ user }) => {
      const c = await one(COUNTS, [user.orgId, user.sites]);
      return { ...c, total: c.leave + c.reviews + c.devices + c.faces + c.overtime };
    },
  }),
  route({
    method: 'get',
    path: '/',
    summary: 'Everything waiting for an administrator, oldest first',
    access: 'admin',
    handler: async ({ user }) => {
      const org = [user.orgId, user.sites];
      const [leave, reviews, devices, counts] = await Promise.all([
        q(
          `SELECT l.*, (l.end_date - l.start_date + 1)::int AS days, u.full_name, ep.employee_code,
                  (SELECT count(*)::int FROM leave_requests o WHERE o.employee_id = l.employee_id AND o.status = 'APPROVED'
                     AND o.start_date >= date_trunc('year', now())::date) AS approved_this_year
           FROM leave_requests l JOIN users u ON u.id = l.employee_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id
           WHERE l.status = 'PENDING' AND u.org_id = $1 AND ${SITE} ORDER BY l.start_date, l.created_at`,
          org,
        ),
        q(
          `SELECT r.*, u.full_name, rq.full_name AS requested_by_name, ep.employee_code, sh.name AS shift_name, COALESCE(ar.shift_date, s.shift_date) AS shift_date,
                  ar.recorded_at, ar.verification_status, s.state AS session_state, s.last_distance_m, s.last_accuracy_m
           FROM review_requests r JOIN users u ON u.id = r.employee_id JOIN users rq ON rq.id = r.requested_by LEFT JOIN employee_profiles ep ON ep.user_id = u.id
           LEFT JOIN attendance_records ar ON ar.id = r.attendance_id LEFT JOIN tracking_sessions s ON s.id = r.session_id
           LEFT JOIN shifts sh ON sh.id = COALESCE(ar.shift_id, s.shift_id)
           WHERE r.status = 'OPEN' AND ${REVIEW_KINDS} AND u.org_id = $1 AND ${SITE} ORDER BY r.created_at`,
          org,
        ),
        q(
          `SELECT d.id, d.user_id, d.platform, COALESCE(d.model, d.model_hint) AS model, d.created_at, d.last_seen_at, u.full_name, ep.employee_code,
                  (SELECT json_build_object('model', COALESCE(o.model, o.model_hint), 'platform', o.platform, 'lastSeenAt', o.last_seen_at)
                     FROM device_registrations o WHERE o.user_id = d.user_id AND o.status = 'APPROVED' ORDER BY o.last_seen_at DESC LIMIT 1) AS current_phone
           FROM device_registrations d JOIN users u ON u.id = d.user_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id
           WHERE d.status = 'PENDING' AND u.is_active AND u.org_id = $1 AND ${SITE} ORDER BY d.created_at`,
          org,
        ),
        one(COUNTS, org),
      ]);
      return { leave, reviews, devices, counts: { ...counts, total: counts.leave + counts.reviews + counts.devices + counts.faces + counts.overtime } };
    },
  }),
]);
