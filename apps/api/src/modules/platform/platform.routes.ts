/**
 * Platform administration: the GeoAttend operator's console API. Only platform super administrators
 * (lib/platform-auth.ts) reach these routes; no company account can, whatever its role.
 *
 * What the platform sees of a company is what running the service needs: its registration details, status,
 * edition, limits and subscription, how many people are active, and its owners' names and addresses (to invite
 * or reach them). It does not read attendance, locations, photos, leave or pay; those stay with the company.
 * Every change is written to the platform audit log, and changes to a company also to that company's own log.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { config } from '../../config.js';
import { one, q, tx, type Queryable } from '../../db/pool.js';
import { HttpError, badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { idParams, isoDate, mount, route } from '../../lib/http.js';
import { DUMMY_HASH, hashPassword, needsRehash, passwordPolicyError, verifyPassword } from '../../lib/password.js';
import { audit } from '../../lib/audit.js';
import { emailTaken } from '../../lib/tenancy.js';
import { tempPassword } from '../employees/employees.routes.js';
import { issueAccountToken, sendInvitation, unusablePassword } from '../../lib/account-tokens.js';
import { FEATURES, STANDING_COLUMNS, getPlatformSettings, invalidatePlatformSettings, normalizeFeatures, standingFromRow } from '../../lib/company.js';
import {
  PLATFORM_REFRESH_COOKIE,
  clearPlatformCookies,
  issuePlatformSession,
  platformAudit,
  revokeAllPlatformSessions,
  revokePlatformSession,
  rotatePlatformSession,
  setPlatformCookies,
  signPlatformAccessToken,
} from '../../lib/platform-auth.js';

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const limiter = (limit: number) =>
  rateLimit({
    windowMs: 15 * 60_000,
    limit: config.isTest ? 1000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
  });
const loginLimiter = limiter(10);

const publicAdmin = (a: any) => ({ id: a.id, email: a.email, fullName: a.full_name, mustChangePassword: a.must_change_password, lastLoginAt: a.last_login_at ?? null });

// ── Platform sign-in ──
export const platformAuthRouter = Router();
mount(platformAuthRouter, '/api/v1/platform/auth', 'platform', [
  route({
    method: 'post',
    path: '/login',
    summary: 'Platform administrator sign-in (sets httpOnly cookies scoped to the platform API)',
    access: 'public',
    pre: [loginLimiter],
    body: z.object({ email: z.email().max(200), password: z.string().min(1).max(200) }),
    handler: async ({ body, req, res }) => {
      const a = await one('SELECT * FROM platform_admins WHERE lower(email) = lower($1)', [body.email]);
      const generic = unauthorized('Incorrect email or password.');
      if (!a) {
        await verifyPassword(body.password, DUMMY_HASH).catch(() => false);
        throw generic;
      }
      const locked = !!a.locked_until && new Date(a.locked_until) > new Date();
      if (!(await verifyPassword(body.password, a.password_hash))) {
        if (!locked) {
          const r = await one(
            `UPDATE platform_admins SET failed_login_count = CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_login_count + 1 END,
               locked_until = CASE WHEN locked_until IS NULL AND failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) END
             WHERE id = $1 RETURNING locked_until`,
            [a.id, LOCK_AFTER, LOCK_MINUTES],
          );
          await platformAudit({ adminId: null, action: r?.locked_until ? 'platform.auth.locked' : 'platform.auth.login_failed', targetType: 'platform_admin', targetId: a.id, req });
        }
        throw generic;
      }
      if (locked) throw new HttpError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
      if (!a.is_active) throw unauthorized('This account is deactivated.');
      await q('UPDATE platform_admins SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [a.id]);
      if (needsRehash(a.password_hash)) await q('UPDATE platform_admins SET password_hash = $2 WHERE id = $1', [a.id, await hashPassword(body.password)]);
      const csrfToken = setPlatformCookies(res, await signPlatformAccessToken(a.id), await issuePlatformSession(a.id, req));
      await platformAudit({ adminId: a.id, action: 'platform.auth.login', targetType: 'platform_admin', targetId: a.id, req });
      return { admin: publicAdmin(a), csrfToken };
    },
  }),
  route({
    method: 'post',
    path: '/refresh',
    summary: 'Rotate the platform session (cookie)',
    access: 'public',
    handler: async ({ req, res }) => {
      const token = req.cookies?.[PLATFORM_REFRESH_COOKIE];
      if (!token) throw unauthorized('No platform session');
      const r = await rotatePlatformSession(token);
      return { ok: true, csrfToken: setPlatformCookies(res, r.accessToken, r.refreshToken) };
    },
  }),
  route({
    method: 'post',
    path: '/logout',
    summary: 'Sign out of the platform console',
    access: 'public',
    handler: async ({ req, res }) => {
      const token = req.cookies?.[PLATFORM_REFRESH_COOKIE];
      const adminId = token ? await revokePlatformSession(token) : null;
      if (adminId) await platformAudit({ adminId, action: 'platform.auth.logout', targetType: 'platform_admin', targetId: adminId, req });
      clearPlatformCookies(res);
      return { ok: true };
    },
  }),
  route({
    method: 'get',
    path: '/me',
    summary: 'The signed-in platform administrator',
    access: 'platform',
    handler: async ({ platform }) => ({ admin: publicAdmin(await one('SELECT * FROM platform_admins WHERE id = $1', [platform.id])) }),
  }),
  route({
    method: 'post',
    path: '/change-password',
    summary: 'Change your own platform password (ends your other platform sign-ins)',
    access: 'platform',
    pre: [limiter(10)],
    body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }),
    handler: async ({ body, platform, req, res }) => {
      const a = await one('SELECT password_hash FROM platform_admins WHERE id = $1', [platform.id]);
      if (!(await verifyPassword(body.currentPassword, a.password_hash))) throw badRequest('WRONG_PASSWORD', 'Current password is incorrect.');
      const policy = passwordPolicyError(body.newPassword);
      if (policy) throw badRequest('WEAK_PASSWORD', policy);
      if (body.newPassword === body.currentPassword) throw badRequest('SAME_PASSWORD', 'Choose a password different from the current one.');
      await q('UPDATE platform_admins SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [platform.id, await hashPassword(body.newPassword)]);
      await revokeAllPlatformSessions(platform.id);
      await platformAudit({ adminId: platform.id, action: 'platform.auth.change_password', targetType: 'platform_admin', targetId: platform.id, req });
      return { ok: true, csrfToken: setPlatformCookies(res, await signPlatformAccessToken(platform.id), await issuePlatformSession(platform.id, req)) };
    },
  }),
]);

// ── Companies, editions, settings ──

const text = (max: number) => z.string().trim().max(max).nullable().optional();
const registrationBody = z
  .object({
    legalName: text(200),
    registrationNumber: text(80),
    taxId: text(80),
    addressLine: text(300),
    city: text(100),
    state: text(100),
    postalCode: text(20),
    country: text(80),
    contactName: text(200),
    contactEmail: z.email().max(200).nullable().optional(),
    contactPhone: text(40),
    website: text(200),
    industry: text(100),
    notes: text(1000),
  })
  .strict();
const featuresBody = z.object(Object.fromEntries(FEATURES.map((f) => [f, z.boolean().optional()])) as Record<(typeof FEATURES)[number], z.ZodOptional<z.ZodBoolean>>).strict();
const limit = z.number().int().min(0).max(1_000_000).nullable();

/** Drops empty values, so the stored registration only holds what is known. */
const cleanRegistration = (r: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(r ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ''));

const COMPANY_SELECT = `
  SELECT o.id, o.name, o.phone, o.created_at, o.updated_at, o.status_reason, o.status_changed_at, o.registration, o.registration_source,
         e.name AS edition_name, ${STANDING_COLUMNS},
         (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.role = 'EMPLOYEE' AND u.is_active) AS employees,
         (SELECT count(*)::int FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.org_id = o.id AND u.role = 'ADMIN' AND u.is_active AND ap.access = 'SUPERVISOR') AS supervisors,
         (SELECT count(*)::int FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.org_id = o.id AND u.role = 'ADMIN' AND u.is_active AND ap.access = 'OWNER') AS owners,
         (SELECT max(u.last_login_at) FROM users u WHERE u.org_id = o.id) AS last_sign_in_at
  FROM organizations o JOIN editions e ON e.code = o.edition_code`;

async function present(r: any) {
  const s = await standingFromRow(r);
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: s.status,
    statusReason: r.status_reason,
    statusChangedAt: r.status_changed_at,
    edition: { code: s.editionCode, name: r.edition_name },
    limits: { employees: s.employeeLimit, supervisors: s.supervisorLimit },
    usage: { employees: r.employees, supervisors: r.supervisors, owners: r.owners },
    features: s.features,
    subscription: s.subscription,
    registration: r.registration ?? {},
    registrationSource: r.registration_source,
    lastSignInAt: r.last_sign_in_at,
  };
}

async function loadCompany(id: string, db?: Queryable) {
  const r = await one(`${COMPANY_SELECT} WHERE o.id = $1`, [id], db);
  if (!r) throw notFound('Company');
  return present(r);
}

/** Locks a company's row for the rest of the transaction, so two platform changes cannot overwrite each other. */
async function lockCompany(id: string, db: Queryable) {
  if (!(await one('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [id], db))) throw notFound('Company');
  return loadCompany(id, db);
}

async function loadEdition(code: string, db?: Queryable) {
  const e = await one('SELECT * FROM editions WHERE code = $1', [code], db);
  if (!e) throw badRequest('UNKNOWN_EDITION', 'Choose one of the editions.');
  return e;
}

const presentEdition = (e: any) => ({
  code: e.code,
  name: e.name,
  description: e.description,
  limits: { employees: e.employee_limit, supervisors: e.supervisor_limit },
  features: normalizeFeatures(e.features),
  defaultDurationDays: e.default_duration_days,
  isActive: e.is_active,
  sortOrder: e.sort_order,
  updatedAt: e.updated_at,
});

/** Records a platform change in the platform log and, when it concerns a company, in that company's own log. */
async function record(platform: { id: string }, req: any, e: { action: string; orgId?: string; targetType: string; targetId?: string; before?: unknown; after?: unknown; reason?: string | null }, db?: Queryable) {
  await platformAudit({ adminId: platform.id, req, ...e }, db);
  if (e.orgId) await audit({ actor: null, orgId: e.orgId, action: e.action, resourceType: e.targetType, resourceId: e.targetId ?? e.orgId, before: e.before, after: e.after, reason: e.reason ?? 'Changed by GeoAttend platform administration', req }, db);
}

const today = () => DateTime.utc().toISODate()!;

const ownerBody = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.email().max(200),
  phone: z.string().trim().max(40).optional(),
  delivery: z.enum(['invitation', 'temporary-password']).default('invitation'),
});

/** Adds an owner to a company in `db`: an invitation link (default) or a one-time temporary password. */
async function addOwner(orgId: string, body: z.infer<typeof ownerBody>, db: Queryable) {
  if (await emailTaken(body.email)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists.');
  const invite = body.delivery === 'invitation';
  const password = invite ? unusablePassword() : tempPassword();
  const u = await one(
    `INSERT INTO users (email, password_hash, role, full_name, must_change_password, org_id) VALUES ($1, $2, 'ADMIN', $3, $4, $5) RETURNING id`,
    [body.email, await hashPassword(password), body.fullName, !invite, orgId],
    db,
  );
  await q(`INSERT INTO administrator_profiles (user_id, phone, access) VALUES ($1, $2, 'OWNER')`, [u.id, body.phone || null], db);
  return { id: u.id as string, link: invite ? await issueAccountToken(u.id, 'INVITE', null, db) : null, temporaryPassword: invite ? null : password };
}

async function deliver(owner: { id: string; link: { url: string; expiresAt: string } | null; temporaryPassword: string | null }) {
  if (owner.link) return { invitation: { url: owner.link.url, expiresAt: owner.link.expiresAt, emailed: await sendInvitation(owner.id, owner.link) } };
  return { temporaryPassword: owner.temporaryPassword };
}

export const platformRouter = Router();
mount(platformRouter, '/api/v1/platform', 'platform', [
  route({
    method: 'get',
    path: '/overview',
    summary: 'Platform totals and the subscriptions that need attention',
    access: 'platform',
    handler: async () => {
      const rows = await Promise.all((await q(`${COMPANY_SELECT} ORDER BY o.created_at DESC`)).map(present));
      const by = <K extends string>(f: (c: (typeof rows)[number]) => K) => rows.reduce<Record<string, number>>((m, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {});
      const attention = rows
        .filter((c) => c.status === 'SUSPENDED' || ['EXPIRING', 'GRACE', 'EXPIRED'].includes(c.subscription.state))
        .sort((a, b) => (a.subscription.daysLeft ?? 99999) - (b.subscription.daysLeft ?? 99999))
        .slice(0, 50);
      return {
        companies: rows.length,
        byStatus: by((c) => c.status),
        byEdition: by((c) => c.edition.code),
        bySubscription: by((c) => c.subscription.state),
        activeEmployees: rows.reduce((n, c) => n + c.usage.employees, 0),
        activeSupervisors: rows.reduce((n, c) => n + c.usage.supervisors, 0),
        attention,
        settings: (await getPlatformSettings()).subscriptions,
      };
    },
  }),
  route({
    method: 'get',
    path: '/companies',
    summary: 'Companies, with status, edition, usage against limits and subscription',
    access: 'platform',
    query: z.object({
      search: z.string().trim().max(100).optional(),
      status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
      edition: z.string().max(40).optional(),
      subscription: z.enum(['ACTIVE', 'TRIAL', 'EXPIRING', 'GRACE', 'EXPIRED']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    handler: async ({ query }) => {
      const rows = await q(
        `${COMPANY_SELECT}
         WHERE ($1::text IS NULL OR o.name ILIKE '%' || $1 || '%' OR o.registration->>'legalName' ILIKE '%' || $1 || '%'
                OR EXISTS (SELECT 1 FROM users u WHERE u.org_id = o.id AND u.role = 'ADMIN' AND u.email ILIKE '%' || $1 || '%'))
           AND ($2::text IS NULL OR o.status = $2) AND ($3::text IS NULL OR o.edition_code = $3)
         ORDER BY o.name, o.id`,
        [query.search || null, query.status ?? null, query.edition ?? null],
      );
      const all = (await Promise.all(rows.map(present))).filter((c) => !query.subscription || c.subscription.state === query.subscription);
      return { total: all.length, companies: all.slice(query.offset, query.offset + query.limit) };
    },
  }),
  route({
    method: 'post',
    path: '/companies',
    summary: 'Create a company with its edition, subscription and first owner (invited by default)',
    access: 'platform',
    body: z.object({
      name: z.string().trim().min(2).max(200),
      phone: z.string().trim().max(40).optional(),
      registration: registrationBody.optional(),
      editionCode: z.string().max(40),
      subscription: z
        .object({ status: z.enum(['TRIAL', 'ACTIVE']).default('ACTIVE'), startsOn: isoDate.optional(), endsOn: isoDate.nullable().optional(), durationDays: z.number().int().min(1).max(3660).optional() })
        .default({ status: 'ACTIVE' }),
      owner: ownerBody,
    }),
    handler: async ({ body, platform, req, res }) => {
      const out = await tx(async (db) => {
        const e = await loadEdition(body.editionCode, db);
        if (!e.is_active) throw badRequest('EDITION_INACTIVE', 'This edition is no longer offered.');
        const startsOn = body.subscription.startsOn ?? today();
        const endsOn =
          body.subscription.endsOn !== undefined ? body.subscription.endsOn : DateTime.fromISO(startsOn).plus({ days: (body.subscription.durationDays ?? e.default_duration_days) - 1 }).toISODate();
        if (endsOn && endsOn < startsOn) throw badRequest('BAD_DATES', 'The renewal date must be on or after the start date.');
        const org = await one(
          `INSERT INTO organizations (name, phone, registration, registration_source, edition_code, employee_limit, supervisor_limit, features, subscription_status, subscription_starts_on, subscription_ends_on)
           VALUES ($1, $2, $3, 'PLATFORM', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [body.name, body.phone || null, JSON.stringify(cleanRegistration(body.registration)), e.code, e.employee_limit, e.supervisor_limit, JSON.stringify(normalizeFeatures(e.features)), body.subscription.status, startsOn, endsOn],
          db,
        );
        const owner = await addOwner(org.id, body.owner, db);
        const company = await loadCompany(org.id, db);
        await record(platform, req, { action: 'platform.company.create', orgId: org.id, targetType: 'organization', targetId: org.id, after: { ...company, owner: { email: body.owner.email, delivery: body.owner.delivery } } }, db);
        return { company, owner };
      });
      res.status(201);
      return { company: out.company, owner: { id: out.owner.id, email: body.owner.email, ...(await deliver(out.owner)) } };
    },
  }),
  route({
    method: 'get',
    path: '/companies/:id',
    summary: 'One company: registration, status, subscription, usage, owners and recent platform changes',
    access: 'platform',
    params: idParams,
    handler: async ({ params }) => {
      const company = await loadCompany(params.id);
      const owners = await q(
        `SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at, u.created_at,
                EXISTS (SELECT 1 FROM account_tokens t WHERE t.user_id = u.id AND t.purpose = 'INVITE' AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()) AS invitation_open
         FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.org_id = $1 AND u.role = 'ADMIN' AND ap.access = 'OWNER' ORDER BY u.created_at`,
        [params.id],
      );
      const history = await q(
        `SELECT l.id, l.action, l.before_data, l.after_data, l.reason, l.created_at, a.full_name AS admin_name
         FROM platform_audit_logs l LEFT JOIN platform_admins a ON a.id = l.admin_id WHERE l.org_id = $1 ORDER BY l.created_at DESC LIMIT 50`,
        [params.id],
      );
      return { company, owners, history };
    },
  }),
  route({
    method: 'patch',
    path: '/companies/:id',
    summary: 'Edit a company’s name, phone and registration details',
    access: 'platform',
    params: idParams,
    body: z.object({ name: z.string().trim().min(2).max(200).optional(), phone: z.string().trim().max(40).nullable().optional(), registration: registrationBody.optional() }),
    handler: async ({ params, body, platform, req }) =>
      tx(async (db) => {
        const before = await lockCompany(params.id, db);
        await q(
          `UPDATE organizations SET name = COALESCE($2, name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
             registration = CASE WHEN $5::jsonb IS NULL THEN registration ELSE $5::jsonb END, updated_at = now() WHERE id = $1`,
          [params.id, body.name ?? null, 'phone' in body, body.phone ?? null, body.registration ? JSON.stringify(cleanRegistration(body.registration)) : null],
          db,
        );
        const after = await loadCompany(params.id, db);
        await record(platform, req, { action: 'platform.company.update', orgId: params.id, targetType: 'organization', targetId: params.id, before: { name: before.name, phone: before.phone, registration: before.registration }, after: { name: after.name, phone: after.phone, registration: after.registration } }, db);
        return after;
      }),
  }),
  route({
    method: 'post',
    path: '/companies/:id/status',
    summary: 'Suspend or reactivate a company (suspension signs out every account of it; nothing is deleted)',
    access: 'platform',
    params: idParams,
    body: z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(3).max(500) }),
    handler: async ({ params, body, platform, req }) => {
      await tx(async (db) => {
        const before = await lockCompany(params.id, db);
        if (before.status === body.status) throw conflict('NO_CHANGE', `This company is already ${body.status === 'ACTIVE' ? 'active' : 'suspended'}.`);
        await q('UPDATE organizations SET status = $2, status_reason = $3, status_changed_at = now(), updated_at = now() WHERE id = $1', [params.id, body.status, body.reason], db);
        // Sign-ins end now: refreshing is refused anyway, this also stops phones from trying.
        if (body.status === 'SUSPENDED') await q('UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE org_id = $1)', [params.id], db);
        await record(platform, req, { action: body.status === 'SUSPENDED' ? 'platform.company.suspend' : 'platform.company.activate', orgId: params.id, targetType: 'organization', targetId: params.id, before: { status: before.status }, after: { status: body.status }, reason: body.reason }, db);
      });
      return loadCompany(params.id);
    },
  }),
  route({
    method: 'put',
    path: '/companies/:id/subscription',
    summary: 'Change a company’s edition, limits, modules and subscription dates (existing data is never removed)',
    access: 'platform',
    params: idParams,
    body: z
      .object({
        editionCode: z.string().max(40).optional(),
        /** With a new edition: take its limits and modules first, then apply any given below. */
        applyEditionDefaults: z.boolean().default(true),
        employeeLimit: limit.optional(),
        supervisorLimit: limit.optional(),
        features: featuresBody.optional(),
        subscriptionStatus: z.enum(['TRIAL', 'ACTIVE', 'CANCELLED']).optional(),
        startsOn: isoDate.nullable().optional(),
        endsOn: isoDate.nullable().optional(),
        reason: z.string().trim().max(500).optional(),
      })
      .strict(),
    handler: async ({ params, body, platform, req }) => {
      await tx(async (db) => {
      const before = await lockCompany(params.id, db);
      const next = {
        editionCode: before.edition.code,
        employeeLimit: before.limits.employees,
        supervisorLimit: before.limits.supervisors,
        features: { ...before.features },
        subscriptionStatus: before.subscription.status,
        startsOn: before.subscription.startsOn,
        endsOn: before.subscription.endsOn,
      };
      if (body.editionCode && body.editionCode !== before.edition.code) {
        const e = await loadEdition(body.editionCode, db);
        next.editionCode = e.code;
        if (body.applyEditionDefaults) Object.assign(next, { employeeLimit: e.employee_limit, supervisorLimit: e.supervisor_limit, features: normalizeFeatures(e.features) });
      }
      if (body.employeeLimit !== undefined) next.employeeLimit = body.employeeLimit;
      if (body.supervisorLimit !== undefined) next.supervisorLimit = body.supervisorLimit;
      if (body.features) next.features = { ...next.features, ...Object.fromEntries(Object.entries(body.features).filter(([, v]) => v !== undefined)) };
      if (body.subscriptionStatus) next.subscriptionStatus = body.subscriptionStatus;
      if (body.startsOn !== undefined) next.startsOn = body.startsOn;
      if (body.endsOn !== undefined) next.endsOn = body.endsOn;
      if (next.startsOn && next.endsOn && next.endsOn < next.startsOn) throw badRequest('BAD_DATES', 'The renewal date must be on or after the start date.');
      // Cancelled means "ends on a date": without one it would never end.
      if (next.subscriptionStatus === 'CANCELLED' && !next.endsOn) throw badRequest('END_DATE_REQUIRED', 'A cancelled subscription needs the date it ends (the last day it covers).');
        await q(
          `UPDATE organizations SET edition_code = $2, employee_limit = $3, supervisor_limit = $4, features = $5, subscription_status = $6, subscription_starts_on = $7, subscription_ends_on = $8, updated_at = now() WHERE id = $1`,
          [params.id, next.editionCode, next.employeeLimit, next.supervisorLimit, JSON.stringify(next.features), next.subscriptionStatus, next.startsOn, next.endsOn],
          db,
        );
        await record(platform, req, { action: 'platform.company.subscription', orgId: params.id, targetType: 'organization', targetId: params.id, before: { edition: before.edition.code, limits: before.limits, features: before.features, subscription: before.subscription }, after: next, reason: body.reason ?? null }, db);
      });
      const after = await loadCompany(params.id);
      // Lowering a limit never deactivates anyone: the people already active stay, and no more can be added.
      const warnings = [
        ...(after.limits.employees !== null && after.usage.employees > after.limits.employees ? [`${after.usage.employees} employees are active, above the new limit of ${after.limits.employees}. They stay active; no more can be added.`] : []),
        ...(after.limits.supervisors !== null && after.usage.supervisors > after.limits.supervisors ? [`${after.usage.supervisors} supervisors are active, above the new limit of ${after.limits.supervisors}. They stay active; no more can be added.`] : []),
      ];
      return { company: after, warnings };
    },
  }),
  route({
    method: 'post',
    path: '/companies/:id/renew',
    summary: 'Renew a subscription: extend it from its renewal date (or today, if already ended) by the edition’s term or a given number of days',
    access: 'platform',
    params: idParams,
    body: z.object({ durationDays: z.number().int().min(1).max(3660).optional(), endsOn: isoDate.optional() }),
    handler: async ({ params, body, platform, req }) => {
      await tx(async (db) => {
        const before = await lockCompany(params.id, db);
        // A subscription with no end date never expires; renewing it would give it one.
        if (!before.subscription.endsOn && !body.endsOn) throw badRequest('NO_END_DATE', 'This subscription has no end date, so there is nothing to renew. To set one, give the new renewal date.');
        const e = await loadEdition(before.edition.code, db);
        const from = before.subscription.endsOn && before.subscription.endsOn >= today() ? before.subscription.endsOn : DateTime.utc().minus({ days: 1 }).toISODate()!;
        const endsOn = body.endsOn ?? DateTime.fromISO(from).plus({ days: body.durationDays ?? e.default_duration_days }).toISODate()!;
        if (endsOn < today()) throw badRequest('BAD_DATES', 'The new renewal date must be today or later.');
        await q(`UPDATE organizations SET subscription_status = 'ACTIVE', subscription_ends_on = $2, subscription_starts_on = COALESCE(subscription_starts_on, current_date), updated_at = now() WHERE id = $1`, [params.id, endsOn], db);
        await record(platform, req, { action: 'platform.company.renew', orgId: params.id, targetType: 'organization', targetId: params.id, before: { subscription: before.subscription }, after: { endsOn, status: 'ACTIVE' } }, db);
      });
      return loadCompany(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/companies/:id/owners',
    summary: 'Add an owner to a company (invited by default), for example when the first owner has left',
    access: 'platform',
    params: idParams,
    body: ownerBody,
    handler: async ({ params, body, platform, req, res }) => {
      await loadCompany(params.id);
      const owner = await tx(async (db) => {
        const o = await addOwner(params.id, body, db);
        await record(platform, req, { action: 'platform.company.add_owner', orgId: params.id, targetType: 'user', targetId: o.id, after: { email: body.email, delivery: body.delivery } }, db);
        return o;
      });
      res.status(201);
      return { owner: { id: owner.id, email: body.email, ...(await deliver(owner)) } };
    },
  }),
  route({
    method: 'post',
    path: '/companies/:id/owners/:userId/invitation',
    summary: 'Send an owner who has not signed in yet a new invitation link (the previous one stops working)',
    access: 'platform',
    params: z.object({ id: z.uuid(), userId: z.uuid() }),
    handler: async ({ params, platform, req }) => {
      const u = await one(
        `SELECT u.id, u.is_active, u.last_login_at FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.id = $1 AND u.org_id = $2 AND u.role = 'ADMIN' AND ap.access = 'OWNER'`,
        [params.userId, params.id],
      );
      if (!u) throw notFound('Owner');
      if (!u.is_active) throw conflict('INACTIVE', 'This owner is deactivated.');
      if (u.last_login_at) throw conflict('ALREADY_SIGNED_IN', 'This owner has already signed in; they can use “Forgot password” on the sign-in page.');
      const link = await tx((db) => issueAccountToken(u.id, 'INVITE', null, db));
      const out = await deliver({ id: u.id, link, temporaryPassword: null });
      await record(platform, req, { action: 'platform.company.invite_owner', orgId: params.id, targetType: 'user', targetId: u.id, after: { emailed: out.invitation?.emailed } });
      return out;
    },
  }),

  route({
    method: 'get',
    path: '/editions',
    summary: 'Editions: the limits and modules a company gets when assigned one',
    access: 'platform',
    handler: async () => {
      const rows = await q(`SELECT e.*, (SELECT count(*)::int FROM organizations o WHERE o.edition_code = e.code) AS companies FROM editions e ORDER BY e.sort_order, e.code`);
      return rows.map((e) => ({ ...presentEdition(e), companies: e.companies }));
    },
  }),
  route({
    method: 'patch',
    path: '/editions/:code',
    summary: 'Change an edition’s name, limits, modules or term (companies that already have it keep their own values)',
    access: 'platform',
    params: z.object({ code: z.string().max(40) }),
    body: z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        employeeLimit: limit.optional(),
        supervisorLimit: limit.optional(),
        features: featuresBody.optional(),
        defaultDurationDays: z.number().int().min(1).max(3660).optional(),
        isActive: z.boolean().optional(),
      })
      .strict(),
    handler: async ({ params, body, platform, req }) =>
      tx(async (db) => {
      const before = await one('SELECT * FROM editions WHERE code = $1 FOR UPDATE', [params.code], db);
      if (!before) throw badRequest('UNKNOWN_EDITION', 'Choose one of the editions.');
      const features = body.features ? { ...normalizeFeatures(before.features), ...Object.fromEntries(Object.entries(body.features).filter(([, v]) => v !== undefined)) } : normalizeFeatures(before.features);
      const e = await one(
        `UPDATE editions SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           employee_limit = CASE WHEN $5::boolean THEN $6::int ELSE employee_limit END, supervisor_limit = CASE WHEN $7::boolean THEN $8::int ELSE supervisor_limit END,
           features = $9, default_duration_days = COALESCE($10, default_duration_days), is_active = COALESCE($11, is_active), updated_at = now()
         WHERE code = $1 RETURNING *`,
        [params.code, body.name ?? null, 'description' in body, body.description ?? null, 'employeeLimit' in body, body.employeeLimit ?? null, 'supervisorLimit' in body, body.supervisorLimit ?? null, JSON.stringify(features), body.defaultDurationDays ?? null, body.isActive ?? null],
        db,
      );
      await platformAudit({ adminId: platform.id, action: 'platform.edition.update', targetType: 'edition', targetId: params.code, before: presentEdition(before), after: presentEdition(e), req }, db);
      return presentEdition(e);
      }),
  }),

  route({
    method: 'get',
    path: '/settings',
    summary: 'Platform-level settings: self sign-up, subscription grace and warning periods, support contact',
    access: 'platform',
    handler: async () => {
      invalidatePlatformSettings();
      return getPlatformSettings();
    },
  }),
  route({
    method: 'put',
    path: '/settings',
    summary: 'Change platform-level settings (each section given replaces that section)',
    access: 'platform',
    body: z
      .object({
        signup: z.object({ enabled: z.boolean(), editionCode: z.string().max(40), trialDays: z.number().int().min(1).max(365) }).strict().optional(),
        subscriptions: z.object({ graceDays: z.number().int().min(0).max(90), warningDays: z.number().int().min(0).max(120) }).strict().optional(),
        support: z.object({ email: z.email().max(200).nullable(), phone: z.string().trim().max(40).nullable() }).strict().optional(),
      })
      .strict(),
    handler: async ({ body, platform, req }) => {
      if (body.signup) await loadEdition(body.signup.editionCode);
      invalidatePlatformSettings();
      const before = await getPlatformSettings();
      const after = structuredClone(before);
      await tx(async (db) => {
        for (const [key, value] of Object.entries(body)) {
          if (!value) continue;
          await q(`INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, JSON.stringify(value), platform.id], db);
          (after as any)[key] = { ...(after as any)[key], ...value };
        }
        await platformAudit({ adminId: platform.id, action: 'platform.settings.update', targetType: 'platform_settings', before, after, req }, db);
      });
      invalidatePlatformSettings();
      return getPlatformSettings();
    },
  }),
  route({
    method: 'get',
    path: '/audit',
    summary: 'The platform audit log (newest first)',
    access: 'platform',
    query: z.object({ orgId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }),
    handler: async ({ query }) =>
      q(
        `SELECT l.id, l.action, l.org_id, o.name AS org_name, l.target_type, l.target_id, l.before_data, l.after_data, l.reason, l.ip, l.created_at, a.email AS admin_email, a.full_name AS admin_name
         FROM platform_audit_logs l LEFT JOIN platform_admins a ON a.id = l.admin_id LEFT JOIN organizations o ON o.id = l.org_id
         WHERE ($1::uuid IS NULL OR l.org_id = $1) ORDER BY l.created_at DESC, l.id DESC LIMIT $2 OFFSET $3`,
        [query.orgId ?? null, query.limit, query.offset],
      ),
  }),
]);
