import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { asSystem, one, q, tx } from '../../db/pool.js';
import { config, sampleData } from '../../config.js';
import { HttpError, badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { idParams, mount, route } from '../../lib/http.js';
import { DUMMY_HASH, hashPassword, needsRehash, passwordPolicyError, verifyPassword } from '../../lib/password.js';
import { audit } from '../../lib/audit.js';
import { checkDeviceAtLogin } from '../devices/devices.routes.js';
import { getSettings } from '../settings/settings.service.js';
import { companyUsage, getPlatformSettings, suspendedError } from '../../lib/company.js';
import { consumeAccountToken, findAccountToken, issueAccountToken, resetText, sendAccountMail } from '../../lib/account-tokens.js';import {
  REFRESH_COOKIE,
  sha256,
  clearWebCookies,
  issueRefreshToken,
  revokeAllForUser,
  revokeRefreshToken,
  rotateRefreshToken,
  setWebCookies,
  signAccessToken,
} from '../../lib/auth.js';

const tooMany = { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again in a few minutes.' } };
// Per account and address, so one person's mistakes (or a shared office network) do not block everyone.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}|${String(req.body?.email ?? '').toLowerCase()}`,
  message: tooMany,
});
// Per address across all accounts, against guessing one common password over many accounts.
const loginAddressLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.isTest ? 1000 : 200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooMany,
});
const passwordLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.isTest ? 1000 : 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: config.isTest ? 1000 : 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many sign-ups from this network. Try again later.' } },
});

// Reset and invitation links: per address, against guessing tokens or flooding someone's inbox.
const linkLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.isTest ? 1000 : 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});

const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;

function publicUser(u: any) {
  return { id: u.id, email: u.email, fullName: u.full_name, role: u.role, isDemo: u.is_demo, mustChangePassword: u.must_change_password };
}

export const authRouter = Router();
mount(authRouter, '/api/v1/auth', 'auth', [
  route({
    method: 'post',
    path: '/login',
    summary: 'Sign in (web: sets httpOnly cookies; mobile: returns tokens)',
    access: 'public',
    pre: [loginAddressLimiter, loginLimiter],
    body: z.object({
      email: z.email().max(200),
      password: z.string().min(1).max(200),
      client: z.enum(['web', 'mobile']),
      deviceId: z.string().min(8).max(128).optional(),
      platform: z.enum(['android', 'ios', 'web', 'simulator', 'unknown']).optional(),
      model: z.string().max(80).optional(),
    }),
    handler: async ({ body, res, req }) => {
      const u = await one('SELECT u.*, o.status AS org_status FROM users u JOIN organizations o ON o.id = u.org_id WHERE lower(u.email) = lower($1)', [body.email]);
      const generic = unauthorized('Incorrect email or password.');
      if (!u) {
        await verifyPassword(body.password, DUMMY_HASH).catch(() => false); // equalise timing
        throw generic;
      }
      const locked = !!u.locked_until && new Date(u.locked_until) > new Date();
      if (!(await verifyPassword(body.password, u.password_hash))) {
        // While locked nothing counts, so the lock cannot be stretched. Once it expires the count starts again.
        if (!locked) {
          const r = await one(
            `UPDATE users SET failed_login_count = CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_login_count + 1 END,
               locked_until = CASE WHEN locked_until IS NULL AND failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) END
             WHERE id = $1 RETURNING locked_until`,
            [u.id, LOCK_AFTER, LOCK_MINUTES],
          );
          await audit({ actor: null, orgId: u.org_id, action: r?.locked_until ? 'auth.locked' : 'auth.login_failed', resourceType: 'user', resourceId: u.id, req });
        }
        throw generic; // the same answer locked or not, so it does not confirm the account
      }
      // Only someone who knows the password learns that the account is locked.
      if (locked) throw new HttpError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
      if (!u.is_active) throw unauthorized('This account is deactivated.');
      if (u.org_status !== 'ACTIVE') {
        await audit({ actor: null, orgId: u.org_id, action: 'auth.login_company_suspended', resourceType: 'user', resourceId: u.id, req });
        throw suspendedError();
      }
      if (body.client === 'web' && u.role !== 'ADMIN') throw new HttpError(403, 'WRONG_APP', 'Employees sign in with the GeoAttend mobile app.');
      if (body.client === 'mobile' && u.role !== 'EMPLOYEE') throw new HttpError(403, 'WRONG_APP', 'Administrators sign in to the web dashboard.');
      if (body.client === 'mobile') await checkDeviceAtLogin(u, body.deviceId, body.platform ?? 'unknown', body.model);
      await q('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
      if (needsRehash(u.password_hash)) await q('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(body.password)]);

      const accessToken = await signAccessToken(u, body.client === 'mobile' ? body.deviceId : null);
      const refresh = await issueRefreshToken(u.id, body.client, body.deviceId ?? null);
      await audit({ actor: { id: u.id, role: u.role, orgId: u.org_id }, action: 'auth.login', resourceType: 'user', resourceId: u.id, after: { client: body.client }, req });
      if (body.client === 'web') {
        const csrfToken = setWebCookies(res, accessToken, refresh.token);
        return { user: publicUser(u), csrfToken };
      }
      return { user: publicUser(u), accessToken, refreshToken: refresh.token, accessTokenExpiresIn: config.accessTokenTtlSec };
    },
  }),
  route({
    method: 'post',
    path: '/refresh',
    summary: 'Rotate refresh token (mobile: body; web: cookie)',
    access: 'public',
    body: z.object({
      refreshToken: z.string().min(20).max(200).optional(),
      /** One-time id for this refresh, repeated only when retrying it after a lost answer. */
      requestId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
    }),
    handler: async ({ body, req, res }) => {
      const token = body.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
      if (!token) throw unauthorized('No refresh token');
      const r = await rotateRefreshToken(token, body.requestId);
      if (r.client === 'web') {
        const csrfToken = setWebCookies(res, r.accessToken, r.refreshToken);
        return { ok: true, csrfToken };
      }
      return { accessToken: r.accessToken, refreshToken: r.refreshToken, accessTokenExpiresIn: config.accessTokenTtlSec };
    },
  }),
  route({
    method: 'post',
    path: '/logout',
    summary: 'Sign out and revoke the refresh token family',
    access: 'public',
    body: z.object({ refreshToken: z.string().max(200).optional() }),
    handler: async ({ body, req, res }) => {
      const token = body.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
      const userId = token ? await revokeRefreshToken(token) : null;
      if (userId) await audit({ actor: null, action: 'auth.logout', resourceType: 'user', resourceId: userId, orgId: (await one('SELECT org_id FROM users WHERE id = $1', [userId]))?.org_id, req });
      clearWebCookies(res);
      return { ok: true };
    },
  }),
  route({
    method: 'get',
    path: '/me',
    summary: 'Current user',
    access: 'authenticated',
    handler: async ({ user }) => {
      const u = await one('SELECT * FROM users WHERE id = $1', [user.id]);
      const org = await one('SELECT id, name FROM organizations WHERE id = $1', [user.orgId]);
      // The simulator only has something to drive in a company that has demo employees.
      const hasDemo = config.demoMode && !!(await one(`SELECT 1 FROM users WHERE org_id = $1 AND is_demo AND role = 'EMPLOYEE' LIMIT 1`, [user.orgId]));
      const access = user.access ? { role: user.access, sites: user.sites, awayUntil: (await one('SELECT away_until FROM administrator_profiles WHERE user_id = $1', [user.id]))?.away_until ?? null } : null;
      // What the dashboard may offer this administrator (the API enforces the same rules).
      const permissions = user.access ? { publishAnnouncements: user.access === 'OWNER' || (await getSettings(user.orgId)).workforce.supervisorAnnouncements } : null;
      const c = user.company!;
      const edition = await asSystem(() => one('SELECT code, name FROM editions WHERE code = $1', [c.editionCode]));
      // Owners see the plan's limits against what is in use; everyone sees which modules are on (to hide what is not).
      const plan = {
        edition: edition ? { code: edition.code, name: edition.name } : { code: c.editionCode, name: c.editionCode },
        subscription: c.subscription,
        ...(user.access === 'OWNER' ? { limits: { employees: c.employeeLimit, supervisors: c.supervisorLimit }, usage: await companyUsage(user.orgId) } : {}),
      };
      const features = { ...c.features, payroll: config.payrollEnabled && c.features.payroll };
      return { user: publicUser(u), organization: org, access, permissions, demoMode: hasDemo && user.access !== 'SUPERVISOR', sampleData, features, plan };
    },
  }),
  route({
    method: 'post',
    path: '/signup',
    summary: 'Create a new company and its first administrator, and sign in',
    access: 'public',
    pre: [signupLimiter],
    body: z.object({
      companyName: z.string().trim().min(2).max(200),
      fullName: z.string().trim().min(1).max(200),
      email: z.email().max(200),
      phone: z.string().trim().max(40).optional(),
      password: z.string().max(200),
    }),
    handler: async ({ body, req, res }) => {
      const signup = (await getPlatformSettings()).signup;
      if (!signup.enabled) throw new HttpError(403, 'SIGNUP_CLOSED', 'New companies are set up by GeoAttend. Contact us to get started.');
      const policy = passwordPolicyError(body.password);
      if (policy) throw badRequest('WEAK_PASSWORD', policy);
      const hash = await hashPassword(body.password);
      const u = await tx(async (db) => {
        if (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [body.email], db)) {
          throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Sign in instead.');
        }
        // A company that signs itself up starts on the platform's sign-up edition, as a trial.
        const edition = await one('SELECT * FROM editions WHERE code = $1 AND is_active', [signup.editionCode], db);
        const org = await one(
          `INSERT INTO organizations (name, phone, registration_source, edition_code, employee_limit, supervisor_limit, features, subscription_status, subscription_starts_on, subscription_ends_on)
           SELECT $1, $2, 'SELF_SIGNUP', e.code, e.employee_limit, e.supervisor_limit, e.features, 'TRIAL', current_date, current_date + $4::int
           FROM editions e WHERE e.code = $3 RETURNING id`,
          [body.companyName, body.phone || null, edition?.code ?? 'STARTER', signup.trialDays],
          db,
        );
        const user = await one(
          `INSERT INTO users (email, password_hash, role, full_name, org_id, last_login_at) VALUES ($1,$2,'ADMIN',$3,$4, now()) RETURNING *`,
          [body.email, hash, body.fullName, org.id],
          db,
        );
        await q('INSERT INTO administrator_profiles (user_id, phone) VALUES ($1, $2)', [user.id, body.phone || null], db);
        await audit({ actor: null, orgId: org.id, action: 'organization.signup', resourceType: 'organization', resourceId: org.id, after: { companyName: body.companyName, adminEmail: body.email }, req }, db);
        return user;
      });
      const accessToken = await signAccessToken(u);
      const refresh = await issueRefreshToken(u.id, 'web', null);
      const csrfToken = setWebCookies(res, accessToken, refresh.token);
      res.status(201);
      return { user: publicUser(u), csrfToken };
    },
  }),
  route({
    method: 'post',
    path: '/change-password',
    summary: 'Change own password (revokes other sessions)',
    access: 'authenticated',
    pre: [passwordLimiter],
    body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }),
    handler: async ({ body, user, req, res }) => {
      const u = await one('SELECT password_hash FROM users WHERE id = $1', [user.id]);
      if (!(await verifyPassword(body.currentPassword, u.password_hash))) throw badRequest('WRONG_PASSWORD', 'Current password is incorrect.');
      const policy = passwordPolicyError(body.newPassword);
      if (policy) throw badRequest('WEAK_PASSWORD', policy);
      await q('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [user.id, await hashPassword(body.newPassword)]);
      await revokeAllForUser(user.id);
      await audit({ actor: user, action: 'auth.change_password', resourceType: 'user', resourceId: user.id, req });
      // The dashboard signs in with cookies: give this browser a fresh sign-in, so it is not logged out minutes later.
      if (req.cookies?.[REFRESH_COOKIE]) {
        const accessToken = await signAccessToken({ id: user.id, role: user.role }, null);
        const refresh = await issueRefreshToken(user.id, 'web', null);
        return { ok: true, csrfToken: setWebCookies(res, accessToken, refresh.token) };
      }
      return { ok: true };
    },
  }),

  // ── Forgotten passwords and invitations (one-time links, lib/account-tokens.ts) ──
  route({
    method: 'post',
    path: '/forgot-password',
    summary: 'E-mail a one-time password-reset link (the answer is the same whether or not the account exists)',
    access: 'public',
    pre: [linkLimiter],
    body: z.object({ email: z.email().max(200) }),
    handler: async ({ body, req, res }) => {
      const work = (async () => {
        const u = await one(`SELECT u.id, u.email, u.full_name, u.org_id, u.is_active, o.status AS org_status FROM users u JOIN organizations o ON o.id = u.org_id WHERE lower(u.email) = lower($1)`, [body.email]);
        if (!u || !u.is_active || u.org_status !== 'ACTIVE') return;
        const link = await tx((db) => issueAccountToken(u.id, 'PASSWORD_RESET', null, db));
        const sent = await sendAccountMail(u.email, 'Reset your GeoAttend password', resetText({ fullName: u.full_name, url: link.url }));
        await audit({ actor: null, orgId: u.org_id, action: sent ? 'auth.password_reset_requested' : 'auth.password_reset_not_delivered', resourceType: 'user', resourceId: u.id, req });
      })();
      // The answer does not wait for the e-mail, so its timing does not reveal whether the account exists.
      if (config.isTest) await work;
      else work.catch((err) => req.log?.error({ err: (err as Error).message }, 'password reset request failed'));
      res.status(202);
      return { ok: true, message: 'If an account uses this address, a reset link is on its way. It works once, for 60 minutes.' };
    },
  }),
  route({
    method: 'post',
    path: '/reset-password',
    summary: 'Choose a new password with a reset link (ends every existing sign-in)',
    access: 'public',
    pre: [linkLimiter],
    body: z.object({ token: z.string().min(20).max(200), newPassword: z.string().max(200) }),
    handler: async ({ body, req }) => {
      const policy = passwordPolicyError(body.newPassword);
      if (policy) throw badRequest('WEAK_PASSWORD', policy);
      const hash = await hashPassword(body.newPassword);
      const done = await consumeAccountToken(body.token, 'PASSWORD_RESET', (row, db) => setChosenPassword(row, hash, 'auth.password_reset', db, req));
      if (!done) throw badRequest('LINK_INVALID', 'This reset link is no longer valid. Ask for a new one.');
      return { ok: true, role: done };
    },
  }),
  route({
    method: 'post',
    path: '/invitation',
    summary: 'Who an invitation link is for (name, company, role), before choosing a password',
    access: 'public',
    pre: [linkLimiter],
    body: z.object({ token: z.string().min(20).max(200) }),
    handler: async ({ body }) => {
      const t = await findAccountToken(body.token, 'INVITE');
      if (!t || !t.is_active || t.org_status !== 'ACTIVE') throw badRequest('LINK_INVALID', 'This invitation is no longer valid. Ask whoever invited you to send a new one.');
      return { email: t.email, fullName: t.full_name, company: t.org_name, role: t.role === 'EMPLOYEE' ? 'EMPLOYEE' : (t.access ?? 'OWNER'), expiresAt: t.expires_at };
    },
  }),
  route({
    method: 'post',
    path: '/accept-invitation',
    summary: 'Accept an invitation by choosing a password; then sign in as usual',
    access: 'public',
    pre: [linkLimiter],
    body: z.object({ token: z.string().min(20).max(200), password: z.string().max(200) }),
    handler: async ({ body, req }) => {
      const policy = passwordPolicyError(body.password);
      if (policy) throw badRequest('WEAK_PASSWORD', policy);
      const hash = await hashPassword(body.password);
      const done = await consumeAccountToken(body.token, 'INVITE', (row, db) => setChosenPassword(row, hash, 'auth.invitation_accepted', db, req));
      if (!done) throw badRequest('LINK_INVALID', 'This invitation is no longer valid. Ask whoever invited you to send a new one.');
      return { ok: true, role: done };
    },
  }),

  // ── Session management: one entry per sign-in (a refresh-token family) ──
  route({
    method: 'get',
    path: '/sessions',
    summary: 'Your active sign-ins: browsers and phones',
    access: 'authenticated',
    handler: async ({ user, req }) => {
      const current = await currentFamily(user, req);
      const rows = await q(
        `SELECT family_id, client, device_id, min(created_at) AS signed_in_at, max(created_at) AS last_active_at, max(expires_at) AS expires_at
         FROM refresh_tokens WHERE user_id = $1 GROUP BY family_id, client, device_id
         HAVING bool_or(revoked_at IS NULL AND expires_at > now()) ORDER BY max(created_at) DESC`,
        [user.id],
      );
      return rows.map((r) => ({ id: r.family_id, client: r.client, deviceId: r.device_id, signedInAt: r.signed_in_at, lastActiveAt: r.last_active_at, expiresAt: r.expires_at, current: current.includes(r.family_id) }));
    },
  }),
  route({
    method: 'post',
    path: '/sessions/:id/revoke',
    summary: 'Sign out one of your sign-ins (that browser or phone must sign in again)',
    access: 'authenticated',
    params: idParams,
    handler: async ({ user, params, req }) => {
      const ended = await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL RETURNING client, device_id`, [user.id, params.id]);
      if (!ended.length) throw notFound('Sign-in');
      for (const d of ended) if (d.client === 'mobile' && d.device_id) await q('UPDATE device_registrations SET push_token = NULL WHERE user_id = $1 AND device_id = $2', [user.id, d.device_id]);
      await audit({ actor: user, action: 'auth.session_revoked', resourceType: 'user', resourceId: user.id, after: { session: params.id }, req });
      return { ok: true };
    },
  }),
  route({
    method: 'post',
    path: '/sessions/revoke-others',
    summary: 'Sign out everywhere except here',
    access: 'authenticated',
    handler: async ({ user, req }) => {
      const keep = await currentFamily(user, req);
      const ended = await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND NOT (family_id = ANY($2::uuid[])) RETURNING family_id`, [user.id, keep]);
      const count = new Set(ended.map((r) => r.family_id)).size;
      await audit({ actor: user, action: 'auth.sessions_revoked_others', resourceType: 'user', resourceId: user.id, after: { ended: count }, req });
      return { ok: true, ended: count };
    },
  }),
]);

/** Sets the password a person chose from a one-time link, ends their sign-ins and records it. Returns their role. */
async function setChosenPassword(row: { user_id: string; org_id: string; role: string }, hash: string, action: string, db: any, req: any) {
  await q('UPDATE users SET password_hash = $2, must_change_password = false, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [row.user_id, hash], db);
  await q('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id], db);
  // Any other open link for this person (an older invitation, a reset) stops working too.
  await q('UPDATE account_tokens SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [row.user_id], db);
  await audit({ actor: null, orgId: row.org_id, action, resourceType: 'user', resourceId: row.user_id, req }, db);
  return row.role;
}

/** The sign-in this request belongs to: the browser's refresh cookie, or the phone the access token was issued to. */
async function currentFamily(user: { id: string; deviceId?: string | null }, req: any): Promise<string[]> {
  const cookie = req.cookies?.[REFRESH_COOKIE];
  if (cookie) return (await q('SELECT family_id FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2', [user.id, sha256(cookie)])).map((r) => r.family_id);
  if (user.deviceId) return (await q('SELECT DISTINCT family_id FROM refresh_tokens WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL', [user.id, user.deviceId])).map((r) => r.family_id);
  return [];
}
