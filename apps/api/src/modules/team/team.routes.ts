/**
 * The company's administrators: owners (everything) and supervisors (their sites only).
 * Owners add, change and deactivate administrators; anyone can mark themselves away.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getPool, one, q, tx } from '../../db/pool.js';
import { unlinkStaleSupervisors } from '../employees/employees.routes.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { idParams, isoDate, mount, route } from '../../lib/http.js';
import { hashPassword } from '../../lib/password.js';
import { revokeAllForUser } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { emailTaken } from '../../lib/tenancy.js';
import { assertWithinLimit } from '../../lib/company.js';
import { issueAccountToken, sendInvitation, unusablePassword } from '../../lib/account-tokens.js';

const SELECT = `
  SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at, ap.access, ap.site_ids, ap.away_until, ap.phone,
         (SELECT json_agg(w.name ORDER BY w.name) FROM workplaces w WHERE w.id = ANY(ap.site_ids)) AS site_names,
         (SELECT count(*)::int FROM employee_profiles ep JOIN users e ON e.id = ep.user_id WHERE ep.supervisor_id = u.id AND e.is_active) AS reports_count,
         (SELECT count(*)::int FROM workplace_assignments wa JOIN users e ON e.id = wa.employee_id
           WHERE wa.effective_to IS NULL AND e.is_active AND e.role = 'EMPLOYEE' AND wa.workplace_id = ANY(ap.site_ids)) AS site_workers_count
  FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id`;

const tempPassword = () => `${crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z]/g, 'x')}${crypto.randomInt(10000000, 99999999)}`;

async function checkSites(orgId: string, siteIds: string[]) {
  if (!siteIds.length) return;
  const n = await one(`SELECT count(*)::int AS n FROM workplaces WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, siteIds]);
  if (n.n !== new Set(siteIds).size) throw badRequest('BAD_SITES', 'Choose workplaces of your company.');
}

/** The company must always keep at least one active owner. */
async function assertAnotherOwner(orgId: string, exceptUserId: string, db?: any) {
  const other = await one(
    `SELECT 1 FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.org_id = $1 AND u.role = 'ADMIN' AND u.is_active AND ap.access = 'OWNER' AND u.id <> $2 LIMIT 1`,
    [orgId, exceptUserId],
    db,
  );
  if (!other) throw conflict('LAST_OWNER', 'The company needs at least one active owner.');
}

export const teamRouter = Router();
mount(teamRouter, '/api/v1/team', 'team', [
  route({
    method: 'get',
    path: '/',
    summary: "The company's administrators",
    access: 'admin',
    ownerOnly: true,
    handler: async ({ user }) => q(`${SELECT} WHERE u.org_id = $1 AND u.role = 'ADMIN' ORDER BY u.is_active DESC, ap.access, u.full_name`, [user.orgId]),
  }),
  route({
    method: 'post',
    path: '/',
    summary: 'Add an owner or a supervisor: a one-time temporary password (default), or an invitation link to choose their own',
    access: 'admin',
    ownerOnly: true,
    body: z.object({
      fullName: z.string().trim().min(1).max(200),
      email: z.email().max(200),
      phone: z.string().trim().max(40).optional(),
      access: z.enum(['OWNER', 'SUPERVISOR']),
      siteIds: z.array(z.uuid()).max(200).default([]),
      delivery: z.enum(['temporary-password', 'invitation']).default('temporary-password'),
    }),
    handler: async ({ body, user, req, res }) => {
      if (body.access === 'SUPERVISOR' && !body.siteIds.length) throw badRequest('SITES_REQUIRED', 'Choose at least one workplace for a supervisor.');
      await checkSites(user.orgId, body.siteIds);
      const invite = body.delivery === 'invitation';
      const password = invite ? unusablePassword() : tempPassword();
      const hash = await hashPassword(password);
      const created = await tx(async (db) => {
        if (body.access === 'SUPERVISOR') await assertWithinLimit('supervisor', user.orgId, db);
        if (await emailTaken(body.email)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists.');
        const u = await one(`INSERT INTO users (email, password_hash, role, full_name, must_change_password, org_id) VALUES ($1,$2,'ADMIN',$3,$4,$5) RETURNING id`, [body.email, hash, body.fullName, !invite, user.orgId], db);
        await q(`INSERT INTO administrator_profiles (user_id, phone, access, site_ids) VALUES ($1,$2,$3,$4)`, [u.id, body.phone || null, body.access, body.access === 'OWNER' ? [] : body.siteIds], db);
        await audit({ actor: user, action: 'team.add', resourceType: 'user', resourceId: u.id, after: { ...body }, req }, db);
        return { id: u.id as string, link: invite ? await issueAccountToken(u.id, 'INVITE', user.id, db) : null };
      });
      res.status(201);
      const admin = await one(`${SELECT} WHERE u.id = $1`, [created.id]);
      if (created.link) return { admin, invitation: { url: created.link.url, expiresAt: created.link.expiresAt, emailed: await sendInvitation(created.id, created.link) } };
      return { admin, temporaryPassword: password };
    },
  }),
  route({
    method: 'post',
    path: '/:id/invitation',
    summary: 'Send a new invitation link to an administrator who has not signed in yet (the previous link stops working)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'admin',
    handler: async ({ params, user, req }) => {
      const a = await one('SELECT is_active, last_login_at FROM users WHERE id = $1', [params.id]);
      if (!a.is_active) throw conflict('INACTIVE', 'Reactivate this administrator first.');
      if (a.last_login_at) throw conflict('ALREADY_SIGNED_IN', 'This administrator has already signed in. Use “Reset password” instead.');
      const link = await tx((db) => issueAccountToken(params.id, 'INVITE', user.id, db));
      const emailed = await sendInvitation(params.id, link);
      await audit({ actor: user, action: 'team.invite', resourceType: 'user', resourceId: params.id, after: { emailed }, req });
      return { invitation: { url: link.url, expiresAt: link.expiresAt, emailed } };
    },
  }),
  route({
    method: 'patch',
    path: '/:id',
    summary: "Change an administrator's role, sites or away date",
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'admin',
    body: z.object({ access: z.enum(['OWNER', 'SUPERVISOR']).optional(), siteIds: z.array(z.uuid()).max(200).optional(), awayUntil: isoDate.nullable().optional() }),
    handler: async ({ params, body, user, req }) => {
      const before = await one(`${SELECT} WHERE u.id = $1`, [params.id]);
      const access = body.access ?? before.access;
      const sites = access === 'OWNER' ? [] : (body.siteIds ?? before.site_ids);
      if (access === 'SUPERVISOR' && !sites.length) throw badRequest('SITES_REQUIRED', 'Choose at least one workplace for a supervisor.');
      if (before.access === 'OWNER' && access === 'SUPERVISOR') await assertAnotherOwner(user.orgId, params.id);
      await checkSites(user.orgId, sites);
      await tx(async (db) => {
        // An active owner becoming a supervisor takes up a supervisor place.
        if (before.access !== 'SUPERVISOR' && access === 'SUPERVISOR' && before.is_active) await assertWithinLimit('supervisor', user.orgId, db);
        await q(
          `UPDATE administrator_profiles SET access = $2, site_ids = $3, away_until = CASE WHEN $4::boolean THEN $5::date ELSE away_until END WHERE user_id = $1`,
          [params.id, access, sites, 'awayUntil' in body, body.awayUntil ?? null],
          db,
        );
        // Workers outside the new sites (or of a supervisor who became an owner) are no longer theirs.
        await unlinkStaleSupervisors(db, user.orgId);
      });
      const after = await one(`${SELECT} WHERE u.id = $1`, [params.id]);
      await audit({ actor: user, action: 'team.update', resourceType: 'user', resourceId: params.id, before, after, req });
      return after;
    },
  }),
  route({
    method: 'post',
    path: '/:id/reset-password',
    summary: 'Issue another administrator a new temporary password (signs them out; audited)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'admin',
    handler: async ({ params, user, req }) => {
      if (params.id === user.id) throw badRequest('SELF', 'Change your own password from your account menu.');
      // Taking over another owner's account is not a supervisor reset: that needs the server operator (admin:reset-password).
      if ((await one('SELECT access FROM administrator_profiles WHERE user_id = $1', [params.id]))?.access === 'OWNER') {
        throw badRequest('OWNER_ACCOUNT', 'Another owner’s password is reset by whoever runs the server, not from the dashboard.');
      }
      const pw = tempPassword();
      await q('UPDATE users SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [params.id, await hashPassword(pw)]);
      await revokeAllForUser(params.id);
      await audit({ actor: user, action: 'team.reset_password', resourceType: 'user', resourceId: params.id, req });
      return { temporaryPassword: pw };
    },
  }),
  route({
    method: 'post',
    path: '/:id/status',
    summary: 'Deactivate or reactivate an administrator (signs them out)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'admin',
    body: z.object({ isActive: z.boolean() }),
    handler: async ({ params, body, user, req }) => {
      if (!body.isActive) {
        if (params.id === user.id) throw badRequest('SELF', 'You cannot deactivate yourself.');
        await assertAnotherOwner(user.orgId, params.id);
      }
      await tx(async (db) => {
        const was = await one('SELECT u.is_active, ap.access FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.id = $1', [params.id], db);
        if (body.isActive && !was.is_active && was.access === 'SUPERVISOR') await assertWithinLimit('supervisor', user.orgId, db);
        await q('UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1', [params.id, body.isActive], db);
      });
      if (!body.isActive) {
        await revokeAllForUser(params.id);
        await unlinkStaleSupervisors(getPool(), user.orgId);
      }
      await audit({ actor: user, action: body.isActive ? 'team.reactivate' : 'team.deactivate', resourceType: 'user', resourceId: params.id, req });
      return one(`${SELECT} WHERE u.id = $1`, [params.id]);
    },
  }),
  route({
    method: 'put',
    path: '/me/away',
    summary: 'Mark yourself away until a date (no push / e-mail alerts meanwhile), or back (null)',
    access: 'admin',
    body: z.object({ awayUntil: isoDate.nullable() }),
    handler: async ({ body, user, req }) => {
      await q('UPDATE administrator_profiles SET away_until = $2 WHERE user_id = $1', [user.id, body.awayUntil]);
      await audit({ actor: user, action: 'team.away', resourceType: 'user', resourceId: user.id, after: body, req });
      return one(`${SELECT} WHERE u.id = $1`, [user.id]);
    },
  }),
]);
