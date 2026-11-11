import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { one, q, tx } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { idParams, mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import type { Queryable } from '../../db/pool.js';
import { canonicalTimezone, isValidTimezone } from '../../lib/shift-window.js';
import { assertInOrg, siteFilter } from '../../lib/tenancy.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
const shiftBody = z.object({
  workplaceId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  startTime: time,
  endTime: time,
  timezone: z.string().min(1).max(64).transform(canonicalTimezone),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  arrivalGraceMinutes: z.number().int().min(0).max(240),
  absenceThresholdMinutes: z.number().int().min(1).max(480).nullable().optional(),
  /** Required to save a shift longer than LONG_SHIFT_HOURS (lateness and overtime are measured against it). */
  confirmLongShift: z.boolean().optional(),
});

/** A shift longer than this needs explicit confirmation: an all-day window turns every arrival into hours of lateness. */
export const LONG_SHIFT_HOURS = 16;

/** Length in minutes; an end at or before the start is on the next day (overnight). */
export function shiftMinutes(start: string, end: string) {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const d = m(end) - m(start);
  return d > 0 ? d : d + 24 * 60;
}

function checkLength(start: string, end: string, confirmed?: boolean) {
  if (start === end) throw badRequest('BAD_TIMES', 'Start and end time must differ.');
  const hours = shiftMinutes(start, end) / 60;
  if (hours > LONG_SHIFT_HOURS && !confirmed) {
    throw badRequest('LONG_SHIFT_UNCONFIRMED', `This shift is ${Math.round(hours * 10) / 10} hours long. Lateness and overtime are measured from its start and end, so confirm that a shift over ${LONG_SHIFT_HOURS} hours is intended.`);
  }
}
// Default only on create — zod's .partial() would otherwise re-apply it on every PATCH.
const createBody = shiftBody.extend({ arrivalGraceMinutes: shiftBody.shape.arrivalGraceMinutes.default(10) });

const SELECT = `
  SELECT s.*, w.name AS workplace_name,
    (SELECT count(DISTINCT esa.employee_id)::int FROM employee_shift_assignments esa
     WHERE esa.shift_id = s.id AND esa.effective_from <= (now() AT TIME ZONE s.timezone)::date AND (esa.effective_to IS NULL OR esa.effective_to >= (now() AT TIME ZONE s.timezone)::date)) AS employee_count
  FROM shifts s JOIN workplaces w ON w.id = s.workplace_id`;

/** Keeps the definition being replaced for the days up to yesterday, so editing a shift never changes past days. A second edit the same day has nothing new to keep. */
async function saveRevision(db: Queryable, before: any, actorId: string) {
  const today = DateTime.now().setZone(before.timezone).toISODate();
  await q(
    `INSERT INTO shift_revisions (shift_id, valid_from, valid_to, start_time, end_time, timezone, days_of_week, arrival_grace_minutes, is_active, created_by)
     SELECT s.id, (SELECT max(r.valid_to) + 1 FROM shift_revisions r WHERE r.shift_id = s.id), $2::date - 1, s.start_time, s.end_time, s.timezone, s.days_of_week, s.arrival_grace_minutes, s.is_active, $3
     FROM shifts s WHERE s.id = $1 AND NOT EXISTS (SELECT 1 FROM shift_revisions r WHERE r.shift_id = s.id AND r.valid_to >= $2::date - 1)`,
    [before.id, today, actorId],
    db,
  );
}

export const shiftsRouter = Router();
mount(shiftsRouter, '/api/v1/shifts', 'shifts', [
  route({
    method: 'get',
    path: '/',
    summary: 'List shifts',
    access: 'admin',
    query: z.object({ workplaceId: z.uuid().optional() }),
    handler: async ({ query, user }) =>
      q(`${SELECT} WHERE w.org_id = $2 AND ($1::uuid IS NULL OR s.workplace_id = $1) AND ${siteFilter('s.workplace_id', '$3')} ORDER BY w.name, s.start_time`, [query.workplaceId ?? null, user.orgId, user.sites]),
  }),
  route({
    method: 'post',
    path: '/',
    summary: 'Create a shift',
    access: 'admin',
    ownerOnly: true,
    body: createBody,
    handler: async ({ body, user, req, res }) => {
      if (!isValidTimezone(body.timezone)) throw badRequest('BAD_TIMEZONE', 'Unknown time zone. Use a name such as Asia/Kolkata, not an abbreviation such as IST.');
      checkLength(body.startTime, body.endTime, body.confirmLongShift);
      await assertInOrg('workplace', body.workplaceId, user.orgId);
      const s = await one(
        `INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes, absence_threshold_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [body.workplaceId, body.name, body.startTime, body.endTime, body.timezone, [...new Set(body.daysOfWeek)].sort(), body.arrivalGraceMinutes, body.absenceThresholdMinutes ?? null],
      );
      const created = await one(`${SELECT} WHERE s.id = $1`, [s.id]);
      await audit({ actor: user, action: 'shift.create', resourceType: 'shift', resourceId: s.id, after: created, req });
      res.status(201);
      return created;
    },
  }),
  route({
    method: 'patch',
    path: '/:id',
    summary: 'Edit a shift (open sessions keep their scheduled window)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'shift',
    body: shiftBody.omit({ workplaceId: true }).partial().extend({ isActive: z.boolean().optional() }),
    handler: async ({ params, body, user, req }) => {
      const before = await one(`${SELECT} WHERE s.id = $1`, [params.id]);
      if (!before) throw notFound('Shift');
      if (body.timezone && !isValidTimezone(body.timezone)) throw badRequest('BAD_TIMEZONE', 'Unknown time zone. Use a name such as Asia/Kolkata, not an abbreviation such as IST.');
      const start = body.startTime ?? before.start_time.slice(0, 5);
      const end = body.endTime ?? before.end_time.slice(0, 5);
      if (body.startTime !== undefined || body.endTime !== undefined) checkLength(start, end, body.confirmLongShift);
      const days = body.daysOfWeek ? [...new Set(body.daysOfWeek)].sort() : null;
      const scheduleChanged =
        start !== before.start_time.slice(0, 5) || end !== before.end_time.slice(0, 5) || (body.timezone ?? before.timezone) !== before.timezone
        || (days !== null && days.join() !== before.days_of_week.join()) || (body.arrivalGraceMinutes ?? before.arrival_grace_minutes) !== before.arrival_grace_minutes
        || (body.isActive ?? before.is_active) !== before.is_active;
      await tx(async (db) => {
        if (scheduleChanged) await saveRevision(db, before, user.id);
        await q(
        `UPDATE shifts SET name = COALESCE($2, name), start_time = $3, end_time = $4, timezone = COALESCE($5, timezone),
           days_of_week = COALESCE($6, days_of_week), arrival_grace_minutes = COALESCE($7, arrival_grace_minutes),
           absence_threshold_minutes = CASE WHEN $8::boolean THEN $9 ELSE absence_threshold_minutes END,
           is_active = COALESCE($10, is_active), updated_at = now()
         WHERE id = $1`,
        [params.id, body.name ?? null, start, end, body.timezone ?? null, days, body.arrivalGraceMinutes ?? null, 'absenceThresholdMinutes' in body, body.absenceThresholdMinutes ?? null, body.isActive ?? null],
        db,
        );
      });
      const after = await one(`${SELECT} WHERE s.id = $1`, [params.id]);
      await audit({ actor: user, action: 'shift.update', resourceType: 'shift', resourceId: params.id, before, after, req });
      return after;
    },
  }),
]);
