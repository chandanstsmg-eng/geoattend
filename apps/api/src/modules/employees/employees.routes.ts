import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { one, q, tx, type Queryable } from '../../db/pool.js';
import { localDaySql, orgToday } from '../../lib/dates.js';
import { badRequest, conflict, HttpError, notFound } from '../../lib/errors.js';
import { idParams, isoDate, mount, route } from '../../lib/http.js';
import { hashPassword, passwordPolicyError } from '../../lib/password.js';
import { revokeAllForUser, type AuthUser } from '../../lib/auth.js';
import { assertInOrg, siteFilter, emailTaken } from '../../lib/tenancy.js';
import { audit } from '../../lib/audit.js';
import { assertWithinLimit } from '../../lib/company.js';
import { issueAccountToken, revokeAccountTokens, sendInvitation, unusablePassword } from '../../lib/account-tokens.js';
import { endSession } from '../tracking/tracking.service.js';
import { addRosterEntry, rosterEntryBody } from '../roster/roster.js';
import { defaultDate } from '../reports/reports.routes.js';

const SELECT_EMPLOYEE = `
  SELECT u.id, u.email, u.full_name, u.is_active, u.is_demo, u.last_login_at, u.created_at,
         ep.employee_code, ep.phone, ep.department, ep.designation, ep.joined_on, ep.left_on,
         wa.workplace_id, w.name AS workplace_name, ep.supervisor_id, su.full_name AS supervisor_name,
         (SELECT json_agg(json_build_object('assignmentId', esa.id, 'shiftId', sh.id, 'name', sh.name, 'startTime', sh.start_time, 'endTime', sh.end_time,
                                            'daysOfWeek', sh.days_of_week, 'effectiveFrom', esa.effective_from, 'effectiveTo', esa.effective_to,
                                            'workplaceId', sw.id, 'workplaceName', sw.name, 'managerId', esa.manager_id, 'managerName', mu.full_name, 'notes', esa.notes)
                          ORDER BY esa.effective_from, sh.start_time)
            FROM employee_shift_assignments esa JOIN shifts sh ON sh.id = esa.shift_id JOIN workplaces sw ON sw.id = sh.workplace_id
            LEFT JOIN users mu ON mu.id = esa.manager_id
            WHERE esa.employee_id = u.id AND (esa.effective_to IS NULL OR esa.effective_to >= (now() AT TIME ZONE sh.timezone)::date)) AS shifts,
         (SELECT json_build_object('id', s.id, 'state', s.state) FROM tracking_sessions s WHERE s.employee_id = u.id AND s.ended_at IS NULL LIMIT 1) AS open_session
  FROM users u
  JOIN employee_profiles ep ON ep.user_id = u.id
  LEFT JOIN users su ON su.id = ep.supervisor_id
  LEFT JOIN workplace_assignments wa ON wa.employee_id = u.id AND wa.effective_to IS NULL
  LEFT JOIN workplaces w ON w.id = wa.workplace_id`;

/** A worker's supervisor must be an active supervisor of the company who manages the worker's home workplace. */
export async function assertSupervisorFor(db: Queryable, supervisorId: string, orgId: string, workplaceId: string | null) {
  if (!workplaceId) throw badRequest('NO_WORKPLACE', 'Give the employee a home workplace before choosing their supervisor.');
  const s = await one(
    `SELECT 1 FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id
     WHERE u.id = $1 AND u.org_id = $2 AND u.role = 'ADMIN' AND u.is_active AND ap.access = 'SUPERVISOR' AND $3::uuid = ANY(ap.site_ids)`,
    [supervisorId, orgId, workplaceId],
    db,
  );
  if (!s) throw badRequest('BAD_SUPERVISOR', 'Choose a supervisor who manages this employee’s workplace.');
}

/** Drops supervisor links that no longer hold (the supervisor lost the site, or the worker moved). Returns how many. */
export async function unlinkStaleSupervisors(db: Queryable, orgId: string) {
  const r = await q(
    `UPDATE employee_profiles ep SET supervisor_id = NULL
     FROM users u
     WHERE u.id = ep.user_id AND u.org_id = $1 AND ep.supervisor_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM users s JOIN administrator_profiles ap ON ap.user_id = s.id
         JOIN workplace_assignments wa ON wa.employee_id = ep.user_id AND wa.effective_to IS NULL
         WHERE s.id = ep.supervisor_id AND s.is_active AND ap.access = 'SUPERVISOR' AND wa.workplace_id = ANY(ap.site_ids))
     RETURNING ep.user_id`,
    [orgId],
    db,
  );
  return r.length;
}

const employeeBody = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.email().max(200),
  employeeCode: z.string().trim().min(1).max(40),
  phone: z.string().trim().max(40).nullable().optional(),
  department: z.string().trim().max(100).nullable().optional(),
  designation: z.string().trim().max(100).nullable().optional(),
  joinedOn: isoDate.nullable().optional(),
  leftOn: isoDate.nullable().optional(),
});

async function loadEmployee(id: string) {
  const e = await one(`${SELECT_EMPLOYEE} WHERE u.id = $1 AND u.role = 'EMPLOYEE'`, [id]);
  if (!e) throw notFound('Employee');
  return e;
}

export function tempPassword() {
  // 14 chars, guaranteed letters + digits.
  return `${crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z]/g, 'x')}${crypto.randomInt(10000000, 99999999)}`;
}

/** Creates one employee account (and optional workplace / shift assignment) inside `db`. */
async function createEmployee(
  db: Queryable,
  body: z.infer<typeof employeeBody> & { password?: string; workplaceId?: string; shiftId?: string; delivery?: 'temporary-password' | 'invitation' },
  actor: AuthUser,
  req: Request,
  action = 'employee.create',
) {
  const invite = body.delivery === 'invitation';
  if (invite && body.password) throw badRequest('PASSWORD_WITH_INVITATION', 'An invited employee chooses their own password: leave the password empty.');
  // Invited: nobody knows the password until the employee chooses one from the link.
  const password = invite ? unusablePassword() : body.password || tempPassword();
  const policy = passwordPolicyError(password);
  if (policy) throw badRequest('WEAK_PASSWORD', policy);
  await assertWithinLimit('employee', actor.orgId, db);
  if (await emailTaken(body.email)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists.');
  if (await one('SELECT 1 FROM employee_profiles WHERE employee_code = $1 AND org_id = $2', [body.employeeCode, actor.orgId], db)) throw conflict('CODE_TAKEN', 'This employee ID is already in use.');
  if (body.workplaceId) await assertInOrg('workplace', body.workplaceId, actor.orgId);
  const u = await one(
    `INSERT INTO users (email, password_hash, role, full_name, must_change_password, org_id) VALUES ($1,$2,'EMPLOYEE',$3,$4,$5) RETURNING id`,
    [body.email, await hashPassword(password), body.fullName, !body.password && !invite, actor.orgId],
    db,
  );
  await q(`INSERT INTO employee_profiles (user_id, employee_code, phone, department, designation, joined_on) VALUES ($1,$2,$3,$4,$5,$6)`, [u.id, body.employeeCode, body.phone ?? null, body.department ?? null, body.designation ?? null, body.joinedOn ?? null], db);
  if (body.workplaceId) await q(`INSERT INTO workplace_assignments (employee_id, workplace_id, created_by, effective_from) VALUES ($1,$2,$3,(SELECT ${localDaySql('w.timezone')} FROM workplaces w WHERE w.id = $2))`, [u.id, body.workplaceId, actor.id], db);
  if (body.shiftId) await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, created_by, effective_from) VALUES ($1,$2,$3,(SELECT ${localDaySql('sh.timezone')} FROM shifts sh WHERE sh.id = $2))`, [u.id, body.shiftId, actor.id], db);
  await audit({ actor, action, resourceType: 'user', resourceId: u.id, after: { ...body, password: undefined }, req }, db);
  if (invite) return { id: u.id as string, invitation: await issueAccountToken(u.id, 'INVITE', actor.id, db) };
  return { id: u.id as string, temporaryPassword: body.password ? undefined : password };
}

export const employeesRouter = Router();
mount(employeesRouter, '/api/v1/employees', 'employees', [
  route({
    method: 'get',
    path: '/',
    summary: 'List employees',
    access: 'admin',
    query: z.object({
      search: z.string().max(100).optional(),
      workplaceId: z.uuid().optional(),
      /** A supervisor's id, or "none" for workers nobody supervises yet. */
      supervisorId: z.union([z.uuid(), z.literal('none')]).optional(),
      status: z.enum(['active', 'inactive', 'all']).default('active'),
      /** Optional: without it the whole list comes back, as the dashboard's pickers expect. */
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    handler: async ({ query, user }) =>
      q(
        `${SELECT_EMPLOYEE}
         WHERE u.role = 'EMPLOYEE' AND u.org_id = $4 AND ${siteFilter('wa.workplace_id', '$5', 'u.id')}
           AND ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%' OR ep.employee_code ILIKE '%' || $1 || '%')
           AND ($2::uuid IS NULL OR wa.workplace_id = $2)
           AND ($3 = 'all' OR ($3 = 'active') = u.is_active)
           AND ($6::text IS NULL OR ($6 = 'none' AND ep.supervisor_id IS NULL) OR ep.supervisor_id::text = $6)
         ORDER BY u.full_name, u.id LIMIT $7 OFFSET $8`,
        [query.search?.trim() || null, query.workplaceId ?? null, query.status, user.orgId, user.sites, query.supervisorId ?? null, query.limit ?? null, query.offset],
      ),
  }),
  route({
    method: 'post',
    path: '/',
    summary: 'Create an employee: a one-time temporary password (default), or an invitation link to choose their own',
    access: 'admin',
    ownerOnly: true,
    body: employeeBody.extend({
      password: z.string().max(200).optional(),
      workplaceId: z.uuid().optional(),
      delivery: z.enum(['temporary-password', 'invitation']).default('temporary-password'),
    }),
    handler: async ({ body, user, req, res }) => {
      const created = await tx((db) => createEmployee(db, body, user, req));
      res.status(201);
      if (created.invitation) {
        const emailed = await sendInvitation(created.id, created.invitation);
        return { employee: await loadEmployee(created.id), invitation: { url: created.invitation.url, expiresAt: created.invitation.expiresAt, emailed } };
      }
      return { employee: await loadEmployee(created.id), temporaryPassword: created.temporaryPassword };
    },
  }),
  route({
    method: 'post',
    path: '/import',
    summary: 'Bulk-create employees (each row succeeds or fails on its own; temporary passwords are returned once)',
    access: 'admin',
    ownerOnly: true,
    body: z.object({
      rows: z.array(z.object({ fullName: z.string(), email: z.string(), employeeCode: z.string(), phone: z.string().optional(), department: z.string().optional(), designation: z.string().optional() })).min(1).max(500),
      workplaceId: z.uuid().optional(),
      shiftId: z.uuid().optional(),
    }),
    handler: async ({ body, user, req }) => {
      if (body.workplaceId) await assertInOrg('workplace', body.workplaceId, user.orgId);
      if (body.shiftId) {
        const sh = await one('SELECT workplace_id FROM shifts WHERE id = $1', [body.shiftId]);
        if (!sh) throw notFound('Shift');
        if (sh.workplace_id !== body.workplaceId) throw badRequest('WRONG_WORKPLACE', 'Choose the workplace that the shift belongs to.');
      }
      const results = [];
      for (const [i, raw] of body.rows.entries()) {
        const blank = (v?: string) => (v?.trim() ? v.trim() : null);
        const parsed = employeeBody.safeParse({ ...raw, phone: blank(raw.phone), department: blank(raw.department), designation: blank(raw.designation) });
        if (!parsed.success) {
          const fields = Object.keys(z.flattenError(parsed.error).fieldErrors);
          results.push({ row: i + 1, email: raw.email, ok: false, error: `Check ${fields.join(', ') || 'this row'}` });
          continue;
        }
        try {
          const c = await tx((db) => createEmployee(db, { ...parsed.data, workplaceId: body.workplaceId, shiftId: body.shiftId }, user, req, 'employee.import'));
          results.push({ row: i + 1, id: c.id, fullName: parsed.data.fullName, email: parsed.data.email, employeeCode: parsed.data.employeeCode, ok: true, temporaryPassword: c.temporaryPassword });
        } catch (err) {
          results.push({ row: i + 1, email: raw.email, ok: false, error: err instanceof HttpError ? err.message : 'Could not create this employee.' });
        }
      }
      return { created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    },
  }),
  route({
    method: 'get',
    path: '/:id',
    summary: 'Employee details',
    access: 'admin',
    params: idParams,
    scope: 'employee',
    handler: async ({ params }) => loadEmployee(params.id),
  }),
  route({
    method: 'patch',
    path: '/:id',
    summary: 'Update employee profile',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'employee',
    body: employeeBody.partial(),
    handler: async ({ params, body, user, req }) => {
      const before = await loadEmployee(params.id);
      const joined = 'joinedOn' in body ? body.joinedOn : before.joined_on;
      const left = 'leftOn' in body ? body.leftOn : before.left_on;
      if (joined && left && left < joined) throw badRequest('BAD_DATES', 'The last working day cannot be before the joining date.');
      await tx(async (db) => {
        if (body.email && (await emailTaken(body.email, params.id))) throw conflict('EMAIL_TAKEN', 'An account with this email already exists.');
        if (body.employeeCode && (await one('SELECT 1 FROM employee_profiles WHERE employee_code = $1 AND user_id <> $2 AND org_id = $3', [body.employeeCode, params.id, user.orgId], db))) throw conflict('CODE_TAKEN', 'This employee ID is already in use.');
        await q(`UPDATE users SET full_name = COALESCE($2, full_name), email = COALESCE($3, email), updated_at = now() WHERE id = $1`, [params.id, body.fullName ?? null, body.email ?? null], db);
        // A link sent to the old address must not open the account now known by the new one.
        if (body.email) await revokeAccountTokens(params.id, db);
        await q(
          `UPDATE employee_profiles SET employee_code = COALESCE($2, employee_code),
             phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
             department = CASE WHEN $5::boolean THEN $6 ELSE department END,
             designation = CASE WHEN $7::boolean THEN $8 ELSE designation END,
             joined_on = $9, left_on = $10
           WHERE user_id = $1`,
          [params.id, body.employeeCode ?? null, 'phone' in body, body.phone ?? null, 'department' in body, body.department ?? null, 'designation' in body, body.designation ?? null, joined ?? null, left ?? null],
          db,
        );
      });
      const after = await loadEmployee(params.id);
      await audit({ actor: user, action: 'employee.update', resourceType: 'user', resourceId: params.id, before, after, req });
      return after;
    },
  }),
  route({
    method: 'post',
    path: '/:id/deactivate',
    summary: 'Deactivate (ends any open session, revokes sign-ins; history kept)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'employee',
    body: z.object({ reason: z.string().trim().min(3).max(500), lastWorkingDay: isoDate.optional() }),
    handler: async ({ params, body, user, req }) => {
      const e = await loadEmployee(params.id);
      if (e.open_session) await endSession(e.open_session.id, user, 'ADMIN', `employee deactivated: ${body.reason}`);
      // Their past days stay in reports up to this date. Today counts only if they attended, so leaving is not a no-show.
      const today = await defaultDate(user.orgId);
      const workedToday = await one(`SELECT 1 FROM attendance_records WHERE employee_id = $1 AND shift_date = $2 AND verification_status <> 'VOIDED'`, [params.id, today]);
      const lastDay = body.lastWorkingDay ?? (workedToday ? today : DateTime.fromISO(today).minus({ days: 1 }).toISODate());
      await tx(async (db) => {
        await q('UPDATE users SET is_active = false, updated_at = now() WHERE id = $1', [params.id], db);
        await q('UPDATE employee_profiles SET left_on = GREATEST($2::date, joined_on) WHERE user_id = $1', [params.id, lastDay], db);
      });
      await revokeAllForUser(params.id);
      await audit({ actor: user, action: 'employee.deactivate', resourceType: 'user', resourceId: params.id, reason: body.reason, req });
      return loadEmployee(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/:id/reactivate',
    summary: 'Reactivate employee',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'employee',
    handler: async ({ params, user, req }) => {
      const current = await loadEmployee(params.id);
      const ended = await tx(async (db) => {
        if (!current.is_active) await assertWithinLimit('employee', user.orgId, db);
        // The roster in force when they left ends on their last day. Otherwise clearing the leaving date below
        // would make every day away an expected shift, and so an absence. Entries that only began after they
        // left never applied, and are removed. The rows are kept in the audit entry.
        const left = (await one('SELECT left_on::text AS d FROM employee_profiles WHERE user_id = $1', [params.id], db))?.d as string | null;
        const before = left ? await q('SELECT * FROM employee_shift_assignments WHERE employee_id = $1 AND (effective_to IS NULL OR effective_to > $2::date)', [params.id, left], db) : [];
        if (left) {
          await q('DELETE FROM employee_shift_assignments WHERE employee_id = $1 AND effective_from > $2::date', [params.id, left], db);
          await q('UPDATE employee_shift_assignments SET effective_to = $2::date WHERE employee_id = $1 AND (effective_to IS NULL OR effective_to > $2::date)', [params.id, left], db);
        }
        await q('UPDATE users SET is_active = true, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [params.id], db);
        await q('UPDATE employee_profiles SET left_on = NULL WHERE user_id = $1', [params.id], db);
        return { leftOn: left, rosterEnded: before };
      });
      await audit({ actor: user, action: 'employee.reactivate', resourceType: 'user', resourceId: params.id, before: ended, req });
      return loadEmployee(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/:id/reset-password',
    summary: 'Issue a new temporary password (revokes existing sign-ins)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'employee',
    handler: async ({ params, user, req }) => {
      await loadEmployee(params.id);
      const pw = tempPassword();
      await q('UPDATE users SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL WHERE id = $1', [params.id, await hashPassword(pw)]);
      await revokeAllForUser(params.id);
      await audit({ actor: user, action: 'employee.reset_password', resourceType: 'user', resourceId: params.id, req });
      return { temporaryPassword: pw };
    },
  }),
  route({
    method: 'post',
    path: '/:id/invitation',
    summary: 'Send a new invitation link to an employee who has not signed in yet (the previous link stops working)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'employee',
    handler: async ({ params, user, req }) => {
      const e = await loadEmployee(params.id);
      if (!e.is_active) throw conflict('INACTIVE', 'Reactivate this employee first.');
      if (e.last_login_at) throw conflict('ALREADY_SIGNED_IN', 'This employee has already signed in. Use “Reset password” instead.');
      const link = await tx((db) => issueAccountToken(params.id, 'INVITE', user.id, db));
      const emailed = await sendInvitation(params.id, link);
      await audit({ actor: user, action: 'employee.invite', resourceType: 'user', resourceId: params.id, after: { emailed }, req });
      return { invitation: { url: link.url, expiresAt: link.expiresAt, emailed } };
    },
  }),
  route({
    method: 'put',
    path: '/:id/workplace',
    summary: 'Set the employee’s home workplace (roster entries at other workplaces are kept)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'employee',
    body: z.object({ workplaceId: z.uuid().nullable() }),
    handler: async ({ params, body, user, req }) => {
      const before = await loadEmployee(params.id);
      if (before.open_session && before.workplace_id !== body.workplaceId) throw conflict('SESSION_OPEN', 'End the employee’s open shift session before changing the workplace.');
      await tx(async (db) => {
        if (body.workplaceId) await assertInOrg('workplace', body.workplaceId, user.orgId);
        // Assignments that started today are removed (never effective); older ones end yesterday. The audit log keeps the history.
        const today = await orgToday(user.orgId, body.workplaceId ?? before.workplace_id ?? null, new Date(), db);
        await q(`DELETE FROM workplace_assignments WHERE employee_id = $1 AND effective_to IS NULL AND effective_from >= $2::date`, [params.id, today], db);
        await q(`UPDATE workplace_assignments SET effective_to = $2::date - 1 WHERE employee_id = $1 AND effective_to IS NULL`, [params.id, today], db);
        if (body.workplaceId) {
          await q(`INSERT INTO workplace_assignments (employee_id, workplace_id, created_by, effective_from) VALUES ($1,$2,$3,$4)`, [params.id, body.workplaceId, user.id, today], db);
        }
        // A supervisor who does not manage the new workplace stops being this worker's supervisor.
        await unlinkStaleSupervisors(db, user.orgId);
      });
      const after = await loadEmployee(params.id);
      await audit({ actor: user, action: 'employee.assign_workplace', resourceType: 'user', resourceId: params.id, before: { workplaceId: before.workplace_id }, after: { workplaceId: body.workplaceId }, req });
      return after;
    },
  }),
  route({
    method: 'put',
    path: '/:id/supervisor',
    summary: 'Set the supervisor the worker reports to (a supervisor of their home workplace), or none',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'employee',
    body: z.object({ supervisorId: z.uuid().nullable() }),
    handler: async ({ params, body, user, req }) => {
      const before = await loadEmployee(params.id);
      await tx(async (db) => {
        if (body.supervisorId) await assertSupervisorFor(db, body.supervisorId, user.orgId, before.workplace_id);
        await q('UPDATE employee_profiles SET supervisor_id = $2 WHERE user_id = $1', [params.id, body.supervisorId], db);
      });
      const after = await loadEmployee(params.id);
      await audit({ actor: user, action: 'employee.assign_supervisor', resourceType: 'user', resourceId: params.id, before: { supervisorId: before.supervisor_id }, after: { supervisorId: after.supervisor_id }, req });
      return after;
    },
  }),
  route({
    method: 'post',
    path: '/:id/shifts',
    summary: 'Add a roster entry: shift (any workplace), manager, dates and what to work on (supervisors: their workplaces only)',
    access: 'admin',
    params: idParams,
    scope: 'employee',
    body: rosterEntryBody,
    handler: async ({ params, body, user, req }) => {
      await loadEmployee(params.id);
      const row = await tx((db) => addRosterEntry(db, params.id, body, user));
      await audit({ actor: user, action: 'employee.assign_shift', resourceType: 'user', resourceId: params.id, after: { assignmentId: row.id, ...body }, req });
      return loadEmployee(params.id);
    },
  }),
  route({
    method: 'delete',
    path: '/:id/shifts/:assignmentId',
    summary: 'End a roster entry (history kept; supervisors: entries at their workplaces only)',
    access: 'admin',
    params: z.object({ id: z.uuid(), assignmentId: z.uuid() }),
    scope: 'employee',
    handler: async ({ params, user, req }) => {
      const r = await tx(async (db) => {
        const a = await one(
          `SELECT esa.*, sh.workplace_id, (now() AT TIME ZONE sh.timezone)::date AS today FROM employee_shift_assignments esa JOIN shifts sh ON sh.id = esa.shift_id
           WHERE esa.id = $1 AND esa.employee_id = $2 AND (esa.effective_to IS NULL OR esa.effective_to >= (now() AT TIME ZONE sh.timezone)::date) FOR UPDATE OF esa`,
          [params.assignmentId, params.id],
          db,
        );
        if (!a || (user.sites && !user.sites.includes(a.workplace_id))) throw notFound('Shift assignment');
        if (await one('SELECT 1 FROM tracking_sessions WHERE employee_id = $1 AND shift_id = $2 AND ended_at IS NULL', [params.id, a.shift_id], db)) {
          throw conflict('SESSION_OPEN', 'End the open session for this shift first.');
        }
        // Entries not yet started are removed. Started ones end yesterday, whether or not anyone tracked a
        // session: the days already rostered are the record of who was expected (absences, rates, monthly
        // summaries), and manual attendance counts as use too. History and the audit log are kept.
        const started = a.effective_from < a.today;
        if (!started) {
          await q('DELETE FROM employee_shift_assignments WHERE id = $1', [a.id], db);
        } else {
          await q('UPDATE employee_shift_assignments SET effective_to = GREATEST(effective_from, $2::date - 1) WHERE id = $1', [a.id, a.today], db);
        }
        return a;
      });
      await audit({ actor: user, action: 'employee.unassign_shift', resourceType: 'user', resourceId: params.id, before: { assignmentId: r.id, shiftId: r.shift_id }, req });
      return loadEmployee(params.id);
    },
  }),
  route({
    method: 'get',
    path: '/:id/location-history',
    summary: 'Location history in a time range (access is audited)',
    access: 'admin',
    params: idParams,
    scope: 'employee',
    query: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
    handler: async ({ params, query, user, req }) => {
      await audit({ actor: user, action: 'location_history.view', resourceType: 'user', resourceId: params.id, after: query, req });
      return q(
        `SELECT lu.id, lu.session_id, lu.latitude, lu.longitude, lu.accuracy_m, lu.client_time, lu.received_at, lu.distance_m, lu.classification, lu.source, lu.is_mocked, lu.is_simulated, lu.suspect_reason, lu.implied_speed_kmh
         FROM location_updates lu WHERE lu.employee_id = $1 AND lu.client_time BETWEEN $2 AND $3 ORDER BY lu.client_time LIMIT 5000`,
        [params.id, query.from, query.to],
      );
    },
  }),
]);
