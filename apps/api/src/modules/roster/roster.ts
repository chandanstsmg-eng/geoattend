/**
 * Dated roster: which shift, at which workplace, under which manager, on which dates.
 *
 * Roster entries are rows of employee_shift_assignments (shift + manager_id + effective_from/to).
 * The shift fixes the workplace and the times; a custom time is a new shift at that workplace.
 * An employee can be rostered at several workplaces, but never twice at the same time.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one, q, tx, type Queryable } from '../../db/pool.js';
import { badRequest, conflict, HttpError, notFound } from '../../lib/errors.js';
import { isoDate, mount, route } from '../../lib/http.js';
import { assertInOrg, employeeSite, siteFilter } from '../../lib/tenancy.js';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';

const DAY_MS = 86400_000;
const toDay = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const isoOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const isoWeekday = (day: number) => ((new Date(day * DAY_MS).getUTCDay() + 6) % 7) + 1; // 1 = Monday
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const dateStr = (d: Date | string | null) => (d == null ? null : typeof d === 'string' ? d.slice(0, 10) : isoOf(Math.floor(d.getTime() / DAY_MS)));

interface ShiftTimes {
  start_time: string;
  end_time: string;
  days_of_week: number[];
}

/** Absolute minute ranges (since the epoch day) the shift occupies on `day`, or none if it does not run that day. */
function occupies(sh: ShiftTimes, day: number): [number, number] | null {
  if (!sh.days_of_week.includes(isoWeekday(day))) return null;
  const s = minutesOf(sh.start_time);
  let e = minutesOf(sh.end_time);
  if (e <= s) e += 1440; // overnight
  return [day * 1440 + s, day * 1440 + e];
}

/** True when two shifts would have the employee in two places at once on some date both cover. */
export function shiftsClash(a: ShiftTimes, aFrom: string, aTo: string | null, b: ShiftTimes, bFrom: string, bTo: string | null) {
  const from = Math.max(toDay(aFrom), toDay(bFrom));
  const to = Math.min(aTo ? toDay(aTo) : Infinity, bTo ? toDay(bTo) : Infinity);
  if (from > to) return false;
  // The weekly pattern repeats, so two weeks of the overlap (plus the day before, for overnight
  // shifts spilling in) cover every case.
  const last = Math.min(to, from + 14);
  for (let d = from - 1; d <= last; d++) {
    for (let d2 = d - 1; d2 <= d + 1; d2++) {
      const inA = d >= toDay(aFrom) && (!aTo || d <= toDay(aTo));
      const inB = d2 >= toDay(bFrom) && (!bTo || d2 <= toDay(bTo));
      if (!inA || !inB) continue;
      const x = occupies(a, d);
      const y = occupies(b, d2);
      if (x && y && x[0] < y[1] && y[0] < x[1]) return true;
    }
  }
  return false;
}

/** Refuses an entry that clashes with another of the employee's entries (409 ROSTER_CLASH). */
export async function assertNoClash(db: Queryable, employeeId: string, shift: ShiftTimes & { id: string }, from: string, to: string | null, excludeId?: string) {
  const others = await q(
    `SELECT esa.id, esa.effective_from, esa.effective_to, sh.name, sh.start_time, sh.end_time, sh.days_of_week, w.name AS workplace_name
     FROM employee_shift_assignments esa JOIN shifts sh ON sh.id = esa.shift_id JOIN workplaces w ON w.id = sh.workplace_id
     WHERE esa.employee_id = $1 AND ($2::uuid IS NULL OR esa.id <> $2)
       AND (esa.effective_to IS NULL OR esa.effective_to >= $3::date) AND ($4::date IS NULL OR esa.effective_from <= $4::date)`,
    [employeeId, excludeId ?? null, from, to],
    db,
  );
  for (const o of others) {
    if (shiftsClash(shift, from, to, o, dateStr(o.effective_from)!, dateStr(o.effective_to))) {
      const until = o.effective_to ? ` to ${dateStr(o.effective_to)}` : ' onwards';
      throw conflict(
        'ROSTER_CLASH',
        `This overlaps “${o.name}” at ${o.workplace_name} (${String(o.start_time).slice(0, 5)}–${String(o.end_time).slice(0, 5)}, from ${dateStr(o.effective_from)}${until}). Change the dates or end that entry first.`,
        { assignmentId: o.id },
      );
    }
  }
}

/** A manager must be an active administrator of the company who can see the workplace: an owner, or a supervisor of that site. */
export async function assertManager(db: Queryable, managerId: string, orgId: string, workplaceId: string) {
  const m = await one(
    `SELECT 1 FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id
     WHERE u.id = $1 AND u.org_id = $2 AND u.role = 'ADMIN' AND u.is_active AND (ap.access = 'OWNER' OR $3::uuid = ANY(ap.site_ids))`,
    [managerId, orgId, workplaceId],
    db,
  );
  if (!m) throw badRequest('BAD_MANAGER', 'Choose an owner, or a supervisor who manages this workplace.');
}

export const rosterEntryBody = z.object({
  shiftId: z.uuid(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.nullable().optional(),
  managerId: z.uuid().nullable().optional(),
  /** What the worker is assigned to do (shown in their app). */
  notes: z.string().trim().max(500).nullable().optional(),
});

/**
 * Adds one roster entry inside `db`. The shift's workplace must belong to the company and, for a
 * supervisor, be one of their sites; the manager must be able to manage it; the entry must not
 * clash with the employee's other entries. The caller checks the employee is visible to `user`.
 */
export async function addRosterEntry(db: Queryable, employeeId: string, body: z.infer<typeof rosterEntryBody>, user: AuthUser) {
  const sh = await one('SELECT * FROM shifts WHERE id = $1', [body.shiftId], db);
  if (!sh) throw notFound('Shift');
  await assertInOrg('workplace', sh.workplace_id, user.orgId, user.sites);
  if (!sh.is_active) throw badRequest('SHIFT_DISABLED', 'This shift is disabled.');
  const from = body.effectiveFrom ?? (await one(`SELECT CURRENT_DATE::text AS d`, [], db)).d;
  const to = body.effectiveTo ?? null;
  if (to && to < from) throw badRequest('BAD_RANGE', 'The end date is before the start date.');
  if (body.managerId) await assertManager(db, body.managerId, user.orgId, sh.workplace_id);
  // Serialise roster changes for this employee so two admins cannot create clashing entries at once.
  await q('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [employeeId], db);
  await assertNoClash(db, employeeId, sh, from, to);
  const row = await one(
    `INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, effective_to, manager_id, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [employeeId, sh.id, from, to, body.managerId ?? null, body.notes || null, user.id],
    db,
  );
  return { id: row.id as string, workplaceId: sh.workplace_id as string };
}

/** Roster entries overlapping [from, to] that the user may see. */
async function entries(user: AuthUser, from: string, to: string, workplaceId: string | null, managerId: string | null) {
  return q(
    `SELECT esa.id, esa.employee_id, esa.shift_id, esa.manager_id, esa.effective_from, esa.effective_to, esa.notes,
            u.full_name, ep.employee_code, sh.name AS shift_name, sh.start_time, sh.end_time, sh.days_of_week, sh.timezone,
            w.id AS workplace_id, w.name AS workplace_name, m.full_name AS manager_name, ${employeeSite('u.id')} AS home_workplace_id
     FROM employee_shift_assignments esa
     JOIN users u ON u.id = esa.employee_id
     LEFT JOIN employee_profiles ep ON ep.user_id = u.id
     JOIN shifts sh ON sh.id = esa.shift_id
     JOIN workplaces w ON w.id = sh.workplace_id
     LEFT JOIN users m ON m.id = esa.manager_id
     WHERE u.org_id = $1 AND u.is_active AND ${siteFilter('w.id', '$2')}
       AND esa.effective_from <= $4::date AND (esa.effective_to IS NULL OR esa.effective_to >= $3::date)
       AND ($5::uuid IS NULL OR w.id = $5) AND ($6::uuid IS NULL OR esa.manager_id = $6)
     ORDER BY u.full_name, esa.effective_from, sh.start_time
     LIMIT 5000`,
    [user.orgId, user.sites, from, to, workplaceId, managerId],
  );
}

function weekRange(q0: { from?: string; to?: string }) {
  // Default: the current week, Monday to Sunday.
  const today = Math.floor(Date.now() / DAY_MS);
  const from = q0.from ?? isoOf(today - (isoWeekday(today) - 1));
  const to = q0.to ?? isoOf(toDay(from) + 6);
  if (toDay(to) < toDay(from)) throw badRequest('BAD_RANGE', 'The end date is before the start date.');
  return { from, to };
}

export const rosterRouter = Router();
mount(rosterRouter, '/api/v1/roster', 'roster', [
  route({
    method: 'get',
    path: '/',
    summary: 'Roster entries overlapping a date range (who works where, under whom)',
    access: 'admin',
    query: z.object({ from: isoDate.optional(), to: isoDate.optional(), workplaceId: z.uuid().optional(), managerId: z.uuid().optional() }),
    handler: async ({ query: q0, user }) => {
      const { from, to } = weekRange(q0);
      return entries(user, from, to, q0.workplaceId ?? null, q0.managerId ?? null);
    },
  }),
  route({
    method: 'get',
    path: '/staffing',
    summary: 'People rostered per workplace and day against the workplace target, plus active workers with no roster entry',
    access: 'admin',
    query: z.object({ from: isoDate.optional(), to: isoDate.optional(), workplaceId: z.uuid().optional() }),
    handler: async ({ query, user }) => {
      const range = weekRange(query);
      const from = range.from;
      const to = isoOf(Math.min(toDay(range.to), toDay(from) + 62)); // at most 9 weeks of columns
      const rows = await entries(user, from, to, query.workplaceId ?? null, null);
      const sites = await q(
        `SELECT id, name, min_staff FROM workplaces WHERE org_id = $1 AND is_active AND ${siteFilter('id', '$2')} AND ($3::uuid IS NULL OR id = $3) ORDER BY name`,
        [user.orgId, user.sites, query.workplaceId ?? null],
      );
      const days: string[] = [];
      for (let d = toDay(from); d <= toDay(to); d++) days.push(isoOf(d));
      const workplaces = sites.map((w) => ({
        id: w.id,
        name: w.name,
        minStaff: w.min_staff,
        days: days.map((date) => {
          const d = toDay(date);
          const people = new Set(
            rows
              .filter((r) => r.workplace_id === w.id && toDay(dateStr(r.effective_from)!) <= d && (!r.effective_to || toDay(dateStr(r.effective_to)!) >= d) && r.days_of_week.includes(isoWeekday(d)))
              .map((r) => r.employee_id),
          ).size;
          return { date, rostered: people, shortage: w.min_staff != null ? Math.max(0, w.min_staff - people) : 0 };
        }),
      }));
      const rostered = new Set(rows.map((r) => r.employee_id));
      const unassigned = (
        await q(
          `SELECT u.id, u.full_name, ep.employee_code, w.id AS workplace_id, w.name AS workplace_name
           FROM users u JOIN employee_profiles ep ON ep.user_id = u.id
           LEFT JOIN workplace_assignments wa ON wa.employee_id = u.id AND wa.effective_to IS NULL LEFT JOIN workplaces w ON w.id = wa.workplace_id
           WHERE u.org_id = $1 AND u.role = 'EMPLOYEE' AND u.is_active AND ${siteFilter('wa.workplace_id', '$2')} AND ($3::uuid IS NULL OR wa.workplace_id = $3)
           ORDER BY u.full_name`,
          [user.orgId, user.sites, query.workplaceId ?? null],
        )
      ).filter((e) => !rostered.has(e.id));
      return { from, to, workplaces, unassigned };
    },
  }),
  route({
    method: 'post',
    path: '/bulk',
    summary: 'Roster several workers on one shift and date range; each worker succeeds or fails on its own (clashes, scope)',
    access: 'admin',
    body: rosterEntryBody.extend({ employeeIds: z.array(z.uuid()).min(1).max(200) }),
    handler: async ({ body, user, req }) => {
      const { employeeIds, ...entry } = body;
      const results: Array<{ employeeId: string; ok: boolean; assignmentId?: string; warning?: string; code?: string; error?: string }> = [];
      for (const employeeId of [...new Set(employeeIds)]) {
        try {
          // Supervisors may roster only workers of their own sites (404, like every other route).
          await assertInOrg('employee', employeeId, user.orgId, user.sites);
          const emp = await one(`SELECT u.role, u.is_active, ${employeeSite('u.id')} AS home FROM users u WHERE u.id = $1`, [employeeId]);
          if (emp.role !== 'EMPLOYEE') throw notFound('Employee');
          if (!emp.is_active) throw badRequest('EMPLOYEE_INACTIVE', 'This employee is deactivated.');
          const row = await tx((db) => addRosterEntry(db, employeeId, entry, user));
          results.push({ employeeId, ok: true, assignmentId: row.id, warning: emp.home && emp.home !== row.workplaceId ? 'OUTSIDE_HOME_WORKPLACE' : undefined });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          results.push({ employeeId, ok: false, code: err.code, error: err.message });
        }
      }
      const created = results.filter((r) => r.ok).length;
      if (created) await audit({ actor: user, action: 'roster.bulk_assign', resourceType: 'shift', resourceId: body.shiftId, after: { ...entry, created, failed: results.length - created, employeeIds }, req });
      return { created, failed: results.length - created, results };
    },
  }),
  route({
    method: 'get',
    path: '/managers',
    summary: 'Administrators who can manage a workplace (owners and its supervisors)',
    access: 'admin',
    query: z.object({ workplaceId: z.uuid().optional() }),
    handler: async ({ query, user }) =>
      q(
        `SELECT u.id, u.full_name, ap.access FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id
         WHERE u.org_id = $1 AND u.role = 'ADMIN' AND u.is_active
           AND (ap.access = 'OWNER' OR $2::uuid IS NULL OR $2::uuid = ANY(ap.site_ids))
         ORDER BY (ap.access = 'SUPERVISOR') DESC, u.full_name`,
        [user.orgId, query.workplaceId ?? null],
      ),
  }),
]);
