/**
 * Leave requests. Employees apply from the app; administrators approve, reject
 * or record leave on an employee's behalf (auto-approved). Approved leave
 * suppresses no-show alerts and shows as "On leave" on the overview roster.
 */
import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { LEAVE_STATUSES, LEAVE_TYPES, LEAVE_TYPE_LABELS } from '@geoattend/shared';
import { one, q, tx, type Queryable } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { idParams, isoDate, mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../notifications/notify.js';
import { assertInOrg, employeeSite, siteFilter } from '../../lib/tenancy.js';
import { Outbox } from '../notifications/live-hub.js';

const SELECT = `
  SELECT l.*, (l.end_date - l.start_date + 1)::int AS days, u.full_name, ep.employee_code, w.name AS workplace_name,
         rb.full_name AS requested_by_name, db.full_name AS decided_by_name
  FROM leave_requests l
  JOIN users u ON u.id = l.employee_id
  LEFT JOIN employee_profiles ep ON ep.user_id = u.id
  LEFT JOIN workplace_assignments wa ON wa.employee_id = u.id AND wa.effective_to IS NULL
  LEFT JOIN workplaces w ON w.id = wa.workplace_id
  LEFT JOIN users rb ON rb.id = l.requested_by
  LEFT JOIN users db ON db.id = l.decided_by`;

const leaveBody = z.object({
  leaveType: z.enum(LEAVE_TYPES),
  startDate: isoDate,
  endDate: isoDate,
  halfDay: z.boolean().default(false),
  reason: z.string().trim().min(3).max(1000),
});

function fmtRange(start: string, end: string) {
  const s = DateTime.fromISO(start).toFormat('d LLL');
  return start === end ? s : `${s} – ${DateTime.fromISO(end).toFormat('d LLL')}`;
}

/** Shared checks for a new leave request; returns the dates as ISO strings. */
async function validate(employeeId: string, body: z.infer<typeof leaveBody>, db: Queryable, opts: { allowPastDays: number }) {
  if (body.endDate < body.startDate) throw badRequest('BAD_RANGE', 'The end date is before the start date.');
  if (body.halfDay && body.startDate !== body.endDate) throw badRequest('BAD_RANGE', 'A half day must start and end on the same date.');
  const days = DateTime.fromISO(body.endDate).diff(DateTime.fromISO(body.startDate), 'days').days + 1;
  if (days > 60) throw badRequest('TOO_LONG', 'A single request can cover at most 60 days.');
  const earliest = DateTime.now().minus({ days: opts.allowPastDays }).toISODate()!;
  if (body.startDate < earliest) throw badRequest('TOO_OLD', `Leave can start at most ${opts.allowPastDays} days in the past.`);
  const overlap = await one(
    `SELECT id, start_date, end_date FROM leave_requests
     WHERE employee_id = $1 AND status IN ('PENDING', 'APPROVED') AND start_date <= $3 AND end_date >= $2 LIMIT 1`,
    [employeeId, body.startDate, body.endDate],
    db,
  );
  if (overlap) throw conflict('LEAVE_OVERLAP', 'These dates overlap a leave request that is already pending or approved.');
}

async function loadLeave(id: string, db?: Queryable) {
  const l = await one(`${SELECT} WHERE l.id = $1`, [id], db);
  if (!l) throw notFound('Leave request');
  return l;
}

export const leaveRouter = Router();
mount(leaveRouter, '/api/v1/leave', 'leave', [
  // ── employee ──
  route({
    method: 'get',
    path: '/mine',
    summary: 'Own leave requests (newest first)',
    access: 'employee',
    handler: async ({ user }) => q(`${SELECT} WHERE l.employee_id = $1 ORDER BY l.start_date DESC, l.created_at DESC LIMIT 100`, [user.id]),
  }),
  route({
    method: 'post',
    path: '/mine',
    summary: 'Apply for leave',
    access: 'employee',
    body: leaveBody,
    handler: async ({ user, body, req, res }) => {
      const outbox = new Outbox();
      const id = await tx(async (db) => {
        await q('SELECT pg_advisory_xact_lock(hashtext($1))', [`leave:${user.id}`], db); // serialise overlap checks per employee
        await validate(user.id, body, db, { allowPastDays: 7 });
        const row = await one(
          `INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, half_day, reason, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$1) RETURNING id`,
          [user.id, body.leaveType, body.startDate, body.endDate, body.halfDay, body.reason],
          db,
        );
        await audit({ actor: user, action: 'leave.request', resourceType: 'leave_request', resourceId: row.id, after: body, req }, db);
        await notify(db, outbox, {
          type: 'LEAVE_REQUESTED',
          severity: 'INFO',
          body: `${user.fullName} asked for ${LEAVE_TYPE_LABELS[body.leaveType].toLowerCase()}${body.halfDay ? ' (half day)' : ''}, ${fmtRange(body.startDate, body.endDate)}: “${body.reason}”`,
          employeeId: user.id,
          data: { leaveId: row.id },
          dedupeKey: `leave-requested:${row.id}`,
        });
        return row.id as string;
      });
      outbox.flush();
      res.status(201);
      return loadLeave(id);
    },
  }),
  route({
    method: 'post',
    path: '/mine/:id/cancel',
    summary: 'Withdraw a pending request, or cancel approved leave that has not started',
    access: 'employee',
    params: idParams,
    handler: async ({ user, params, req }) => {
      const outbox = new Outbox();
      await tx(async (db) => {
        const l = await one('SELECT * FROM leave_requests WHERE id = $1 AND employee_id = $2 FOR UPDATE', [params.id, user.id], db);
        if (!l) throw notFound('Leave request');
        const today = DateTime.now().toISODate()!;
        if (l.status === 'APPROVED' && l.start_date <= today) throw conflict('LEAVE_STARTED', 'This leave has already started. Ask your administrator to change it.');
        if (l.status !== 'PENDING' && l.status !== 'APPROVED') throw conflict('LEAVE_CLOSED', 'This request is already closed.');
        await q(`UPDATE leave_requests SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [params.id], db);
        await audit({ actor: user, action: 'leave.cancel', resourceType: 'leave_request', resourceId: params.id, before: { status: l.status }, req }, db);
        if (l.status === 'APPROVED') {
          await notify(db, outbox, {
            type: 'LEAVE_REQUESTED',
            severity: 'INFO',
            title: 'Approved leave cancelled',
            body: `${user.fullName} cancelled approved leave for ${fmtRange(l.start_date, l.end_date)}. They are expected at work on those days.`,
            employeeId: user.id,
            data: { leaveId: params.id },
            dedupeKey: `leave-cancelled:${params.id}`,
          });
        }
      });
      outbox.flush();
      return loadLeave(params.id);
    },
  }),

  // ── administrator ──
  route({
    method: 'get',
    path: '/',
    summary: 'Leave requests (filter by status, employee or dates)',
    access: 'admin',
    query: z.object({
      status: z.enum([...LEAVE_STATUSES, 'ALL']).default('ALL'),
      employeeId: z.uuid().optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
    handler: async ({ query, user }) =>
      q(
        `${SELECT}
         WHERE u.org_id = $6 AND ${siteFilter(employeeSite('u.id'), '$7')} AND ($1 = 'ALL' OR l.status = $1) AND ($2::uuid IS NULL OR l.employee_id = $2)
           AND ($3::date IS NULL OR l.end_date >= $3) AND ($4::date IS NULL OR l.start_date <= $4)
         ORDER BY (l.status = 'PENDING') DESC, l.start_date DESC, l.created_at DESC LIMIT $5`,
        [query.status, query.employeeId ?? null, query.from ?? null, query.to ?? null, query.limit, user.orgId, user.sites],
      ),
  }),
  route({
    method: 'post',
    path: '/',
    summary: 'Record leave for an employee (approved immediately)',
    access: 'admin',
    body: leaveBody.extend({ employeeId: z.uuid() }),
    handler: async ({ user, body, req, res }) => {
      const outbox = new Outbox();
      const id = await tx(async (db) => {
        const e = await one(`SELECT id, full_name FROM users WHERE id = $1 AND role = 'EMPLOYEE' AND org_id = $2`, [body.employeeId, user.orgId], db);
        if (!e) throw notFound('Employee');
        await assertInOrg('employee', body.employeeId, user.orgId, user.sites);
        await q('SELECT pg_advisory_xact_lock(hashtext($1))', [`leave:${body.employeeId}`], db);
        await validate(body.employeeId, body, db, { allowPastDays: 62 });
        const row = await one(
          `INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, half_day, reason, requested_by, status, decided_by, decided_at, decision_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'APPROVED',$7,now(),'Recorded by administrator') RETURNING id`,
          [body.employeeId, body.leaveType, body.startDate, body.endDate, body.halfDay, body.reason, user.id],
          db,
        );
        await audit({ actor: user, action: 'leave.record', resourceType: 'leave_request', resourceId: row.id, after: body, req }, db);
        await notify(db, outbox, {
          type: 'LEAVE_DECIDED',
          severity: 'INFO',
          audience: 'EMPLOYEE',
          title: 'Leave recorded',
          body: `${user.fullName} recorded ${LEAVE_TYPE_LABELS[body.leaveType].toLowerCase()} for you: ${fmtRange(body.startDate, body.endDate)}.`,
          employeeId: body.employeeId,
          data: { leaveId: row.id, status: 'APPROVED' },
          dedupeKey: `leave-decided:${row.id}`,
        });
        return row.id as string;
      });
      outbox.flush();
      res.status(201);
      return loadLeave(id);
    },
  }),
  route({
    method: 'post',
    path: '/:id/decide',
    summary: 'Approve or reject a pending request',
    access: 'admin',
    params: idParams,
    scope: 'leave',
    body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().trim().max(500).optional() }),
    handler: async ({ user, params, body, req }) => {
      if (body.decision === 'REJECTED' && !body.note) throw badRequest('NOTE_REQUIRED', 'Give the employee a reason when rejecting leave.');
      const outbox = new Outbox();
      await tx(async (db) => {
        const l = await one('SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE', [params.id], db);
        if (!l) throw notFound('Leave request');
        if (l.status !== 'PENDING') throw conflict('LEAVE_CLOSED', `This request is already ${l.status.toLowerCase()}.`);
        await q(`UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now() WHERE id = $1`, [params.id, body.decision, user.id, body.note ?? null], db);
        await audit({ actor: user, action: body.decision === 'APPROVED' ? 'leave.approve' : 'leave.reject', resourceType: 'leave_request', resourceId: params.id, before: { status: l.status }, after: { status: body.decision }, reason: body.note, req }, db);
        const range = fmtRange(l.start_date, l.end_date);
        await notify(db, outbox, {
          type: 'LEAVE_DECIDED',
          severity: 'INFO',
          audience: 'EMPLOYEE',
          title: body.decision === 'APPROVED' ? 'Leave approved' : 'Leave not approved',
          body: body.decision === 'APPROVED' ? `Your leave for ${range} is approved.${body.note ? ` Note: ${body.note}` : ''}` : `Your leave for ${range} was not approved: ${body.note}`,
          employeeId: l.employee_id,
          data: { leaveId: params.id, status: body.decision },
          dedupeKey: `leave-decided:${params.id}`,
        });
      });
      outbox.flush();
      return loadLeave(params.id);
    },
  }),
]);

/** Approved leave covering `date` for these employees (employee_id → leave row). */
export async function approvedLeaveOn(date: string, employeeIds: string[], db?: Queryable) {
  if (!employeeIds.length) return new Map<string, { id: string; leave_type: string; half_day: boolean }>();
  const rows = await q(
    `SELECT DISTINCT ON (employee_id) employee_id, id, leave_type, half_day FROM leave_requests
     WHERE status = 'APPROVED' AND employee_id = ANY($1::uuid[]) AND start_date <= $2 AND end_date >= $2
     ORDER BY employee_id, half_day`,
    [employeeIds, date],
    db,
  );
  return new Map(rows.map((r) => [r.employee_id as string, { id: r.id as string, leave_type: r.leave_type as string, half_day: r.half_day as boolean }]));
}
