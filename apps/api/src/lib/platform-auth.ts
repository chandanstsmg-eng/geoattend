/**
 * Platform super administrators: the people who run GeoAttend itself (create and suspend companies, manage
 * editions and subscriptions). They are not members of any company and sign in separately:
 *  - their own table (platform_admins), so no company owner can be promoted into one and none can see them;
 *  - access tokens signed with a key derived for the platform alone, and a different audience, so a company
 *    token is never accepted here and a platform token is never accepted by company routes;
 *  - their own cookies, scoped to /api/v1/platform, with their own CSRF token;
 *  - short sessions: refresh tokens rotate on use, re-use of a rotated one ends the sign-in, and every sign-in
 *    ends PLATFORM_SESSION_MAX_HOURS after it started, however active.
 * Platform work spans companies, so its routes run on the owner database login (asSystem); see
 * docs/COMPANY-ISOLATION.md.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { asSystem, one, q, tx, type Queryable } from '../db/pool.js';
import { HttpError, unauthorized } from './errors.js';

export interface PlatformAdmin {
  id: string;
  email: string;
  fullName: string;
  mustChangePassword: boolean;
  via: 'cookie' | 'bearer';
}

export const PLATFORM_ACCESS_COOKIE = 'ga_pat';
export const PLATFORM_REFRESH_COOKIE = 'ga_prt';
export const PLATFORM_CSRF_COOKIE = 'ga_pcsrf';
export const PLATFORM_ACCESS_TTL_SEC = 10 * 60;
/** A refresh token unused this long expires (the dashboard was left alone). */
export const PLATFORM_IDLE_HOURS = 2;
/** No platform sign-in lasts longer than this. */
export const PLATFORM_SESSION_MAX_HOURS = 12;
const AUDIENCE = 'geoattend-platform';

const key = () => crypto.createHmac('sha256', config.jwtSecret).update('geoattend:platform-access-token').digest();
const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export async function signPlatformAccessToken(adminId: string) {
  return new SignJWT({ typ: 'platform' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(adminId)
    .setIssuedAt()
    .setIssuer('geoattend')
    .setAudience(AUDIENCE)
    .setExpirationTime(`${PLATFORM_ACCESS_TTL_SEC}s`)
    .sign(key());
}

export async function issuePlatformSession(adminId: string, req: Request) {
  const token = crypto.randomBytes(32).toString('base64url');
  await asSystem(() =>
    q(
      `INSERT INTO platform_sessions (admin_id, token_hash, family_id, expires_at, family_expires_at, ip, user_agent)
       VALUES ($1, $2, gen_random_uuid(), LEAST(now() + make_interval(hours => $3), now() + make_interval(hours => $4)), now() + make_interval(hours => $4), $5, $6)`,
      [adminId, sha256(token), PLATFORM_IDLE_HOURS, PLATFORM_SESSION_MAX_HOURS, req.ip ?? null, req.headers['user-agent']?.slice(0, 300) ?? null],
    ),
  );
  return token;
}

/** Rotates a platform refresh token. A rotated token presented again ends that whole sign-in. */
export async function rotatePlatformSession(token: string) {
  const out = await asSystem(() =>
    tx(async (db) => {
      const row = await one(
        `SELECT s.*, a.is_active FROM platform_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE s.token_hash = $1 FOR UPDATE OF s`,
        [sha256(token)],
        db,
      );
      if (!row) return null;
      if (row.revoked_at) {
        await q('UPDATE platform_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id], db);
        await q(`INSERT INTO platform_audit_logs (admin_id, action, target_type, target_id) VALUES ($1, 'platform.auth.refresh_reuse', 'platform_admin', $2)`, [row.admin_id, row.admin_id], db);
        return null;
      }
      if (!row.is_active || new Date(row.expires_at) <= new Date() || new Date(row.family_expires_at) <= new Date()) return null;
      const fresh = crypto.randomBytes(32).toString('base64url');
      const next = await one(
        `INSERT INTO platform_sessions (admin_id, token_hash, family_id, expires_at, family_expires_at, ip, user_agent)
         VALUES ($1, $2, $3, LEAST(now() + make_interval(hours => $4), $5::timestamptz), $5, $6, $7) RETURNING id`,
        [row.admin_id, sha256(fresh), row.family_id, PLATFORM_IDLE_HOURS, row.family_expires_at, row.ip, row.user_agent],
        db,
      );
      await q('UPDATE platform_sessions SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [row.id, next.id], db);
      return { adminId: row.admin_id as string, refreshToken: fresh };
    }),
  );
  if (!out) throw unauthorized('Your platform session has ended. Please sign in again.');
  return { ...out, accessToken: await signPlatformAccessToken(out.adminId) };
}

export async function revokePlatformSession(token: string) {
  return asSystem(async () => {
    const row = await one('SELECT family_id, admin_id FROM platform_sessions WHERE token_hash = $1', [sha256(token)]);
    if (row) await q('UPDATE platform_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
    return (row?.admin_id as string | undefined) ?? null;
  });
}

export const revokeAllPlatformSessions = (adminId: string) =>
  asSystem(() => q('UPDATE platform_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL', [adminId]));

const base = () => ({ httpOnly: true, secure: config.cookieSecure, sameSite: 'strict' as const });

export function setPlatformCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(PLATFORM_ACCESS_COOKIE, accessToken, { ...base(), path: '/api/v1/platform', maxAge: PLATFORM_ACCESS_TTL_SEC * 1000 });
  res.cookie(PLATFORM_REFRESH_COOKIE, refreshToken, { ...base(), path: '/api/v1/platform/auth', maxAge: PLATFORM_SESSION_MAX_HOURS * 3600_000 });
  const csrf = crypto.randomBytes(24).toString('base64url');
  res.cookie(PLATFORM_CSRF_COOKIE, csrf, { httpOnly: false, secure: config.cookieSecure, sameSite: 'strict', path: '/' });
  return csrf;
}

export function clearPlatformCookies(res: Response) {
  res.clearCookie(PLATFORM_ACCESS_COOKIE, { path: '/api/v1/platform' });
  res.clearCookie(PLATFORM_REFRESH_COOKIE, { path: '/api/v1/platform/auth' });
  res.clearCookie(PLATFORM_CSRF_COOKIE, { path: '/' });
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** On a temporary password: sign-in, sign-out, the session and changing it only. */
const allowedOnTemporaryPassword = (url: string) => url.startsWith('/api/v1/platform/auth/');

/** Guard for platform routes. Re-reads the administrator each time, so deactivation takes effect at once. */
export function requirePlatform() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      let token: string | undefined;
      let via: PlatformAdmin['via'] = 'bearer';
      if (header?.startsWith('Bearer ')) token = header.slice(7);
      else if (req.cookies?.[PLATFORM_ACCESS_COOKIE]) {
        token = req.cookies[PLATFORM_ACCESS_COOKIE];
        via = 'cookie';
      }
      if (!token) throw unauthorized();
      let sub: string;
      try {
        const { payload } = await jwtVerify(token, key(), { issuer: 'geoattend', audience: AUDIENCE });
        if (payload.typ !== 'platform') throw new Error('not a platform token');
        sub = payload.sub as string;
      } catch {
        throw new HttpError(401, 'TOKEN_EXPIRED', 'Access token expired or invalid');
      }
      const a = await asSystem(() => one('SELECT id, email, full_name, is_active, must_change_password FROM platform_admins WHERE id = $1', [sub]));
      if (!a || !a.is_active) throw unauthorized('Account is inactive');
      if (via === 'cookie' && !SAFE.has(req.method)) {
        const h = req.headers['x-csrf-token'];
        const c = req.cookies?.[PLATFORM_CSRF_COOKIE];
        if (!c || typeof h !== 'string' || h.length !== c.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(c))) throw new HttpError(403, 'CSRF_FAILED', 'Missing or invalid CSRF token');
      }
      if (a.must_change_password && !SAFE.has(req.method) && !allowedOnTemporaryPassword(req.originalUrl)) {
        throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password first.');
      }
      (req as any).platformAdmin = { id: a.id, email: a.email, fullName: a.full_name, mustChangePassword: a.must_change_password, via } satisfies PlatformAdmin;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Appends to the platform audit log (append-only at the database level). Pass `db` to write inside that transaction. */
export async function platformAudit(e: { adminId: string | null; action: string; orgId?: string | null; targetType: string; targetId?: string | null; before?: unknown; after?: unknown; reason?: string | null; req?: Request }, db?: Queryable) {
  await asSystem(() =>
    q(
      `INSERT INTO platform_audit_logs (admin_id, action, org_id, target_type, target_id, before_data, after_data, reason, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        e.adminId,
        e.action,
        e.orgId ?? null,
        e.targetType,
        e.targetId ?? null,
        e.before === undefined ? null : JSON.stringify(e.before),
        e.after === undefined ? null : JSON.stringify(e.after),
        e.reason ?? null,
        e.req?.ip ?? null,
        e.req?.headers['user-agent']?.slice(0, 300) ?? null,
      ],
      db,
    ),
  );
}
