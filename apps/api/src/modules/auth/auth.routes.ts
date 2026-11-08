import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { one, q, tx } from '../../db/pool.js';
import { config, sampleData } from '../../config.js';
import { HttpError, badRequest, unauthorized } from '../../lib/errors.js';
import { mount, route } from '../../lib/http.js';
import { DUMMY_HASH, hashPassword, needsRehash, passwordPolicyError, verifyPassword } from '../../lib/password.js';
import { audit } from '../../lib/audit.js';
import { checkDeviceAtLogin } from '../devices/devices.routes.js';
import { getSettings } from '../settings/settings.service.js';
import {
  REFRESH_COOKIE,
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
      const u = await one('SELECT * FROM users WHERE lower(email) = lower($1)', [body.email]);
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
      return { user: publicUser(u), organization: org, access, permissions, demoMode: hasDemo && user.access !== 'SUPERVISOR', sampleData, features: { payroll: config.payrollEnabled } };
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
      const policy = passwordPolicyError(body.password);
      if (policy) throw badRequest('WEAK_PASSWORD', policy);
      const hash = await hashPassword(body.password);
      const u = await tx(async (db) => {
        if (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [body.email], db)) {
          throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Sign in instead.');
        }
        const org = await one('INSERT INTO organizations (name, phone) VALUES ($1, $2) RETURNING id', [body.companyName, body.phone || null], db);
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
    handler: async ({ body, user, req }) => {
      const u = await one('SELECT password_hash FROM users WHERE id = $1', [user.id]);
      if (!(await verifyPassword(body.currentPassword, u.password_hash))) throw badRequest('WRONG_PASSWORD', 'Current password is incorrect.');
      const policy = passwordPolicyError(body.newPassword);
      if (policy) throw badRequest('WEAK_PASSWORD', policy);
      await q('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [user.id, await hashPassword(body.newPassword)]);
      await revokeAllForUser(user.id);
      await audit({ actor: user, action: 'auth.change_password', resourceType: 'user', resourceId: user.id, req });
      return { ok: true };
    },
  }),
]);
