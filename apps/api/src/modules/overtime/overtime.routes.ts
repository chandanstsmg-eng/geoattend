/**
 * Overtime approvals and the overtime dashboard. Overtime itself is started and ended from the
 * employee app (tracking/overtime.service.ts). Owners see every workplace; supervisors only
 * their sites (they approve for the workplace where the overtime was worked).
 *
 * Only APPROVED minutes count: attendance_work.overtime_minutes feeds the roster, the monthly
 * report, exports and payroll. Changing a decision is allowed (audited); a payroll month that
 * was already approved keeps its frozen payslips.
 */
import { Router } from 'express';
import { assertPayrollMonthOpen } from '../payroll/guard.js';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { getPool, one, q, tx } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { idParams, isoDate, mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { overtimeCounts, siteFilter } from '../../lib/tenancy.js';
import { createDownloadUrl } from '../../lib/storage.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { defaultDate } from '../reports/reports.routes.js';
import { fmtMinutes } from '../tracking/overtime.service.js';

/** Minutes worked on overtime (so far, while it runs). */
const CLAIMED = `ROUND(EXTRACT(EPOCH FROM (COALESCE(o.ended_at, now()) - o.started_at)) / 60)::int`;

const LIST_SQL = `
  SELECT o.id, o.session_id, o.attendance_id, o.employee_id, o.workplace_id, o.shift_date, o.note, o.started_at, o.ended_at, o.end_reason,
         o.start_latitude, o.start_longitude, o.start_accuracy_m, o.start_distance_m,
         o.start_face_status, o.start_face_score, o.end_face_status, o.end_face_score,
         CASE WHEN o.ended_at IS NULL THEN 'RUNNING' ELSE o.status END AS status, o.approved_minutes,
         o.decided_at, o.decision_note, d.full_name AS decided_by_name, o.is_simulated,
         ${CLAIMED} AS claimed_minutes,
         u.full_name, ep.employee_code, u.is_demo, w.name AS workplace_name, w.radius_m::float AS radius_m,
         sh.name AS shift_name, s.scheduled_end_at, s.state AS session_state, s.last_location_at, s.last_distance_m,
         (sp.status = 'ATTACHED') AS has_start_photo, (xp.status = 'ATTACHED') AS has_end_photo,
         loc.readings, loc.inside_readings, loc.max_distance_m
  FROM overtime_entries o
  JOIN users u ON u.id = o.employee_id
  LEFT JOIN employee_profiles ep ON ep.user_id = u.id
  JOIN workplaces w ON w.id = o.workplace_id
  JOIN tracking_sessions s ON s.id = o.session_id
  JOIN shifts sh ON sh.id = s.shift_id
  LEFT JOIN attendance_photos sp ON sp.id = o.start_photo_id
  LEFT JOIN attendance_photos xp ON xp.id = o.end_photo_id
  LEFT JOIN users d ON d.id = o.decided_by
  -- Where the overtime was worked: readings during it (device time, with the 2 min clock skew the
  -- server accepts, so the start fix is included), how many inside the workplace area, the farthest one.
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS readings, count(*) FILTER (WHERE lu.distance_m <= w.radius_m)::int AS inside_readings, MAX(lu.distance_m)::float AS max_distance_m
    FROM location_updates lu
    WHERE lu.session_id = o.session_id AND lu.client_time >= o.started_at - interval '2 minutes' AND (o.ended_at IS NULL OR lu.client_time <= o.ended_at + interval '2 minutes')
  ) loc ON true`;

const decisionBody = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    /** Approve fewer minutes than were worked (default: all of them). */
    minutes: z.number().int().min(0).max(1440).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((b) => b.decision === 'APPROVE' || (b.note?.length ?? 0) >= 3, { message: 'Give a reason for rejecting (at least 3 characters).', path: ['note'] });

async function tellEmployee(o: any, outbox: Outbox) {
  const approved = o.status === 'APPROVED';
  const partial = approved && o.approved_minutes < o.claimed_minutes;
  await notify(getPool(), outbox, {
    type: 'OVERTIME_DECIDED',
    audience: 'EMPLOYEE',
    severity: approved ? 'INFO' : 'WARNING',
    title: approved ? 'Overtime approved' : 'Overtime not approved',
    body: approved
      ? `${fmtMinutes(o.approved_minutes)} overtime on ${String(o.shift_date).slice(0, 10)} approved${partial ? ` (of ${fmtMinutes(o.claimed_minutes)} worked)` : ''}${o.decision_note ? `: ${o.decision_note}` : ''}.`
      : `Your overtime on ${String(o.shift_date).slice(0, 10)} (${fmtMinutes(o.claimed_minutes)}) was not approved: ${o.decision_note}`,
    employeeId: o.employee_id,
    data: { overtimeId: o.id, status: o.status, approvedMinutes: o.approved_minutes },
    // A changed decision is a new message.
    dedupeKey: `ot-decided:${o.id}:${o.status}:${o.approved_minutes ?? ''}:${new Date(o.decided_at).getTime()}`,
    simulated: o.is_simulated,
  });
}

export const overtimeRouter = Router();
mount(overtimeRouter, '/api/v1/overtime', 'overtime', [
  route({
    method: 'get',
    path: '/',
    summary: 'Overtime entries (filter by dates, status, workplace, employee), newest first',
    access: 'admin',
    query: z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      status: z.enum(['RUNNING', 'PENDING', 'APPROVED', 'REJECTED']).optional(),
      workplaceId: z.uuid().optional(),
      employeeId: z.uuid().optional(),
      includeSimulated: z.enum(['true', 'false']).default('true'),
    }),
    handler: async ({ query, user }) =>
      q(
        `${LIST_SQL}
         WHERE u.org_id = $1 AND ${siteFilter('o.workplace_id', '$2')}
           AND ($3::date IS NULL OR o.shift_date >= $3) AND ($4::date IS NULL OR o.shift_date <= $4)
           AND ($5::text IS NULL OR ($5 = 'RUNNING' AND o.ended_at IS NULL) OR (o.ended_at IS NOT NULL AND o.status = $5))
           AND ($6::uuid IS NULL OR o.workplace_id = $6) AND ($7::uuid IS NULL OR o.employee_id = $7) AND ($8 OR NOT o.is_simulated)
           AND (o.status <> 'PENDING' OR ${overtimeCounts()})
         ORDER BY o.started_at DESC LIMIT 1000`,
        [user.orgId, user.sites, query.from ?? null, query.to ?? null, query.status ?? null, query.workplaceId ?? null, query.employeeId ?? null, query.includeSimulated === 'true'],
      ),
  }),
  route({
    method: 'get',
    path: '/summary',
    summary: "Overtime totals for a date (default today), waiting approvals, and the month's approved hours",
    access: 'admin',
    query: z.object({ date: isoDate.optional(), workplaceId: z.uuid().optional() }),
    handler: async ({ query, user }) => {
      const date = query.date ?? (await defaultDate(user.orgId, query.workplaceId));
      const params = [user.orgId, user.sites, date, query.workplaceId ?? null];
      const where = `u.org_id = $1 AND ${siteFilter('o.workplace_id', '$2')} AND ($4::uuid IS NULL OR o.workplace_id = $4) AND ${overtimeCounts()}`;
      const totals = await one(
        `SELECT count(*) FILTER (WHERE o.ended_at IS NULL)::int AS running,
                count(DISTINCT o.employee_id) FILTER (WHERE o.shift_date = $3)::int AS workers,
                COALESCE(SUM(c.claimed) FILTER (WHERE o.shift_date = $3), 0)::int AS claimed_minutes,
                COALESCE(SUM(o.approved_minutes) FILTER (WHERE o.shift_date = $3 AND o.status = 'APPROVED'), 0)::int AS approved_minutes,
                count(*) FILTER (WHERE o.status = 'PENDING' AND o.ended_at IS NOT NULL)::int AS pending,
                COALESCE(SUM(c.claimed) FILTER (WHERE o.status = 'PENDING' AND o.ended_at IS NOT NULL), 0)::int AS pending_minutes,
                COALESCE(SUM(o.approved_minutes) FILTER (WHERE o.status = 'APPROVED' AND o.shift_date >= date_trunc('month', $3::date) AND o.shift_date <= $3), 0)::int AS month_approved_minutes
         FROM overtime_entries o JOIN users u ON u.id = o.employee_id
         CROSS JOIN LATERAL (SELECT ${CLAIMED} AS claimed) c
         WHERE ${where}`,
        params,
      );
      const byWorkplace = await q(
        `SELECT w.id AS workplace_id, w.name AS workplace_name, count(DISTINCT o.employee_id)::int AS workers,
                count(*) FILTER (WHERE o.ended_at IS NULL)::int AS running,
                COALESCE(SUM(c.claimed), 0)::int AS claimed_minutes,
                COALESCE(SUM(o.approved_minutes) FILTER (WHERE o.status = 'APPROVED'), 0)::int AS approved_minutes,
                count(*) FILTER (WHERE o.status = 'PENDING' AND o.ended_at IS NOT NULL)::int AS pending
         FROM overtime_entries o JOIN users u ON u.id = o.employee_id JOIN workplaces w ON w.id = o.workplace_id
         CROSS JOIN LATERAL (SELECT ${CLAIMED} AS claimed) c
         WHERE ${where} AND o.shift_date = $3
         GROUP BY w.id, w.name ORDER BY claimed_minutes DESC, w.name`,
        params,
      );
      return { date, month: DateTime.fromISO(date).toFormat('yyyy-MM'), ...totals, byWorkplace };
    },
  }),
  route({
    method: 'post',
    path: '/:id/decision',
    summary: 'Approve (optionally fewer minutes) or reject one overtime entry',
    access: 'admin',
    params: idParams,
    scope: 'overtime',
    body: decisionBody,
    handler: async ({ params, body, user, req }) => {
      const outbox = new Outbox();
      const o = await tx(async (db) => {
        const before = await one(`SELECT o.*, ${CLAIMED} AS claimed_minutes FROM overtime_entries o WHERE o.id = $1 FOR UPDATE`, [params.id], db);
        if (!before) throw notFound('Overtime');
        await assertPayrollMonthOpen(user.orgId, before.shift_date, db);
        if (!before.ended_at) throw conflict('OVERTIME_RUNNING', 'This overtime is still running. It can be approved once the employee ends it.');
        if (body.decision === 'APPROVE' && !(await one(`SELECT ${overtimeCounts()} AS counts FROM overtime_entries o WHERE o.id = $1`, [params.id], db)).counts) {
          throw conflict('ATTENDANCE_VOIDED', "This shift's attendance was voided, so its overtime cannot be approved.");
        }
        const minutes = body.decision === 'APPROVE' ? (body.minutes ?? before.claimed_minutes) : null;
        if (minutes != null && minutes > before.claimed_minutes) {
          throw badRequest('MINUTES_TOO_HIGH', `At most ${fmtMinutes(before.claimed_minutes)} can be approved — the time recorded between the overtime photos.`);
        }
        const after = await one(
          `UPDATE overtime_entries o SET status = $2, approved_minutes = $3, decided_by = $4, decided_at = now(), decision_note = $5 WHERE o.id = $1
           RETURNING o.*, ${CLAIMED} AS claimed_minutes`,
          [params.id, body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', minutes, user.id, body.note || null],
          db,
        );
        await audit(
          {
            actor: user,
            action: body.decision === 'APPROVE' ? 'overtime.approve' : 'overtime.reject',
            resourceType: 'overtime_entry',
            resourceId: params.id,
            before: { status: before.status, approvedMinutes: before.approved_minutes, claimedMinutes: before.claimed_minutes },
            after: { status: after.status, approvedMinutes: after.approved_minutes },
            reason: body.note ?? null,
            req,
          },
          db,
        );
        return after;
      });
      await tellEmployee(o, outbox);
      outbox.flush();
      return o;
    },
  }),
  route({
    method: 'post',
    path: '/decisions',
    summary: 'Approve several finished overtime entries in full',
    access: 'admin',
    body: z.object({ ids: z.array(z.uuid()).min(1).max(200) }),
    handler: async ({ body, user, req }) => {
      const outbox = new Outbox();
      const rows = await tx(async (db) => {
        for (const o of await q(`SELECT DISTINCT o.shift_date FROM overtime_entries o WHERE o.id = ANY($1::uuid[])`, [body.ids], db)) await assertPayrollMonthOpen(user.orgId, o.shift_date, db);
        const done = await q(
          `UPDATE overtime_entries o SET status = 'APPROVED', approved_minutes = ${CLAIMED}, decided_by = $3, decided_at = now(), decision_note = NULL
           FROM users u
           WHERE u.id = o.employee_id AND o.id = ANY($1::uuid[]) AND u.org_id = $2 AND ${siteFilter('o.workplace_id', '$4')}
             AND o.status = 'PENDING' AND o.ended_at IS NOT NULL AND ${overtimeCounts()}
           RETURNING o.*, o.approved_minutes AS claimed_minutes`,
          [body.ids, user.orgId, user.id, user.sites],
          db,
        );
        if (done.length) {
          await audit({ actor: user, action: 'overtime.approve_bulk', resourceType: 'overtime_entry', after: { ids: done.map((r) => r.id), minutes: done.reduce((n, r) => n + r.approved_minutes, 0) }, req }, db);
        }
        return done;
      });
      for (const o of rows) await tellEmployee(o, outbox);
      outbox.flush();
      return { approved: rows.length, skipped: body.ids.length - rows.length };
    },
  }),
  route({
    method: 'post',
    path: '/:id/photo-url',
    summary: 'Short-lived link to an overtime start or end selfie (audited)',
    access: 'admin',
    params: idParams,
    scope: 'overtime',
    body: z.object({ which: z.enum(['start', 'end']) }),
    handler: async ({ params, body, user, req }) => {
      const p = await one(
        `SELECT p.object_key FROM overtime_entries o JOIN attendance_photos p ON p.id = ${body.which === 'start' ? 'o.start_photo_id' : 'o.end_photo_id'}
         WHERE o.id = $1 AND p.status = 'ATTACHED'`,
        [params.id],
      );
      if (!p) throw notFound('Photo');
      await audit({ actor: user, action: 'overtime_photo.view', resourceType: 'overtime_entry', resourceId: params.id, after: { which: body.which }, req });
      return { url: await createDownloadUrl(p.object_key) };
    },
  }),

  // ── employee ──
  route({
    method: 'get',
    path: '/mine',
    summary: "The employee's own overtime for a month (default: this month) with the approval status",
    access: 'employee',
    query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM').optional() }),
    handler: async ({ query, user }) => {
      const month = query.month ?? DateTime.now().toFormat('yyyy-MM');
      const rows = await q(
        `SELECT o.id, o.shift_date, o.note, o.started_at, o.ended_at, CASE WHEN o.ended_at IS NULL THEN 'RUNNING' ELSE o.status END AS status,
                o.approved_minutes, o.decision_note, o.decided_at, ${CLAIMED} AS claimed_minutes, sh.name AS shift_name, w.name AS workplace_name, ${overtimeCounts()} AS counts
         FROM overtime_entries o JOIN tracking_sessions s ON s.id = o.session_id JOIN shifts sh ON sh.id = s.shift_id JOIN workplaces w ON w.id = o.workplace_id
         WHERE o.employee_id = $1 AND to_char(o.shift_date, 'YYYY-MM') = $2
         ORDER BY o.started_at DESC`,
        [user.id, month],
      );
      const counted = rows.filter((r) => r.counts);
      return {
        month,
        totals: {
          claimedMinutes: counted.reduce((n, r) => n + r.claimed_minutes, 0),
          approvedMinutes: counted.reduce((n, r) => n + (r.status === 'APPROVED' ? r.approved_minutes : 0), 0),
          pending: counted.filter((r) => r.status === 'PENDING' || r.status === 'RUNNING').length,
        },
        rows,
      };
    },
  }),
]);
