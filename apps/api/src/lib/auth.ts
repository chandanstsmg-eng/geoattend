/**
 * Authentication.
 *  - Access tokens: short-lived HS256 JWTs.
 *  - Refresh tokens: random 256-bit values stored only as SHA-256 hashes,
 *    rotated on every use; re-use of a rotated token revokes its whole family.
 *  - Web dashboard: tokens in httpOnly SameSite=Strict cookies + a double-submit
 *    CSRF token for state-changing requests.
 *  - Mobile app: Authorization: Bearer header (no cookies, so no CSRF surface).
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { asSystem, one, q, tx } from '../db/pool.js';
import { audit } from './audit.js';
import { HttpError, forbidden, unauthorized } from './errors.js';

export type Role = 'ADMIN' | 'EMPLOYEE';
export interface AuthUser {
  id: string;
  role: Role;
  email: string;
  fullName: string;
  isDemo: boolean;
  /** The company this user belongs to; every admin query is limited to it. */
  orgId: string;
  /** Administrators only: OWNER sees the whole company, SUPERVISOR only `sites`. */
  access?: 'OWNER' | 'SUPERVISOR';
  /** Workplaces a supervisor may see; null = all of the company (owners, employees). */
  sites: string[] | null;
  via: 'cookie' | 'bearer';
  /** The phone this sign-in belongs to, from the token, so a client cannot claim another one. */
  deviceId?: string | null;
  mustChangePassword?: boolean;
}

export const ACCESS_COOKIE = 'ga_at';
export const REFRESH_COOKIE = 'ga_rt';
export const CSRF_COOKIE = 'ga_csrf';

const secret = () => new TextEncoder().encode(config.jwtSecret);
const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export async function signAccessToken(user: { id: string; role: Role }, deviceId?: string | null) {
  return new SignJWT({ role: user.role, ...(deviceId ? { did: deviceId } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer('geoattend')
    .setAudience('geoattend')
    .setExpirationTime(`${config.accessTokenTtlSec}s`)
    .sign(secret());
}

export async function issueRefreshToken(userId: string, client: 'web' | 'mobile', deviceId: string | null, familyId?: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  const row = await one<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, client, device_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id`,
    [userId, sha256(token), familyId ?? crypto.randomUUID(), client, deviceId, config.refreshTokenTtlDays],
  );
  return { token, id: row!.id };
}

/** A rotated token presented again this soon is a retry after a lost response, not theft. */
const REFRESH_GRACE_MS = 60_000;
/** How long a lost refresh answer can be asked for again: a phone offline overnight still recovers; after that it signs in. */
const REDELIVERY_MS = 24 * 3600_000;

/**
 * Re-delivery after a lost answer. The phone sends a one-time request id with each refresh and repeats it
 * only when retrying that same refresh. The new token is kept encrypted with a key derived from the OLD raw
 * token and that id; the database holds only hashes of raw tokens, so a copy of it cannot open the box.
 */
const boxKey = (oldToken: string, requestId: string) => crypto.createHash('sha256').update(`geoattend:refresh-redelivery:${oldToken}:${requestId}`).digest();
function sealSuccessor(fresh: string, oldToken: string, requestId: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', boxKey(oldToken, requestId), iv);
  const body = Buffer.concat([c.update(fresh, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}
function openSuccessor(box: string, oldToken: string, requestId: string): string | null {
  try {
    const [iv, tag, body] = box.split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', boxKey(oldToken, requestId), iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(body!), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Rotates a refresh token under a row lock, so two simultaneous uses cannot both succeed unnoticed.
 * Re-use of a rotated token revokes its family, except a retry inside the grace period: a phone on a
 * poor network that never received the answer must not be signed out mid-shift.
 */
export async function rotateRefreshToken(token: string, requestId?: string) {
  const outcome = await tx(async (db) => {
    const row = await one(
      `SELECT rt.*, u.role, u.is_active, u.org_id FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = $1 FOR UPDATE OF rt`,
      [sha256(token)],
      db,
    );
    if (!row) return { failed: true as const };
    // The same refresh repeated (same old token, same request id) while its new token is still unused:
    // answer again with that same token. No second live token is created. Anything else falls through
    // to the reuse rules below, so a replayed token still revokes the whole family.
    if (row.revoked_at && row.replaced_by && requestId && row.successor_box && row.rotation_key_hash === sha256(requestId) && row.is_active && Date.now() - new Date(row.revoked_at).getTime() < REDELIVERY_MS) {
      const next = await one('SELECT token_hash, revoked_at, expires_at FROM refresh_tokens WHERE id = $1 FOR UPDATE', [row.replaced_by], db);
      const same = next && !next.revoked_at && new Date(next.expires_at) > new Date() ? openSuccessor(row.successor_box, token, requestId) : null;
      if (same && sha256(same) === next.token_hash) return { failed: false as const, row, refreshToken: same };
    }
    if (row.revoked_at) {
      // A retry inside the grace period is allowed only while the sign-in is still alive: after a sign-out,
      // a revoked device or a password change the newer token is revoked too, and the old one must not revive it.
      const alive = row.replaced_by ? await one('SELECT 1 FROM refresh_tokens WHERE id = $1 AND revoked_at IS NULL', [row.replaced_by], db) : null;
      const retry = alive && Date.now() - new Date(row.revoked_at).getTime() < REFRESH_GRACE_MS;
      if (!retry) {
        // A rotated token was presented again: assume theft, kill the family.
        await q('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id], db);
        if (row.replaced_by) await audit({ actor: { id: row.user_id, role: row.role, orgId: row.org_id }, action: 'auth.refresh_reuse', resourceType: 'user', resourceId: row.user_id, after: { client: row.client } }, db);
        return { failed: true as const };
      }
    }
    if (new Date(row.expires_at) < new Date() || !row.is_active) return { failed: true as const };
    const fresh = crypto.randomBytes(32).toString('base64url');
    const next = await one<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, client, device_id, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id`,
      [row.user_id, sha256(fresh), row.family_id, row.client, row.device_id, config.refreshTokenTtlDays],
      db,
    );
    if (!row.revoked_at) {
      await q(
        'UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2, rotation_key_hash = $3, successor_box = $4 WHERE id = $1',
        [row.id, next!.id, requestId ? sha256(requestId) : null, requestId ? sealSuccessor(fresh, token, requestId) : null],
        db,
      );
    }
    return { failed: false as const, row, refreshToken: fresh, used: row.id as string };
  });
  if (outcome.failed) throw unauthorized('Session expired. Please sign in again.');
  // This token is now in use, so the answer that delivered it is no longer needed. Done after the commit, so
  // no transaction holds this row's lock while waiting for the older one (redelivery locks old, then new).
  if ('used' in outcome && outcome.used) await q('UPDATE refresh_tokens SET successor_box = NULL WHERE replaced_by = $1 AND successor_box IS NOT NULL', [outcome.used]).catch(() => undefined);
  const { row, refreshToken } = outcome;
  const accessToken = await signAccessToken({ id: row.user_id, role: row.role }, row.device_id);
  return { userId: row.user_id as string, role: row.role as Role, client: row.client as 'web' | 'mobile', accessToken, refreshToken };
}

export async function revokeRefreshToken(token: string) {
  const row = await one('SELECT family_id, user_id, client, device_id FROM refresh_tokens WHERE token_hash = $1', [sha256(token)]);
  if (row) await q('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
  // Signed out on a phone: that phone stops receiving this person's notifications.
  if (row?.client === 'mobile' && row.device_id) await q('UPDATE device_registrations SET push_token = NULL WHERE user_id = $1 AND device_id = $2', [row.user_id, row.device_id]);
  return (row?.user_id as string | undefined) ?? null;
}

export async function revokeAllForUser(userId: string) {
  await q('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export function setWebCookies(res: Response, accessToken: string, refreshToken: string) {
  const base = { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict' as const, path: '/' };
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, maxAge: config.accessTokenTtlSec * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base, path: '/api/v1/auth', maxAge: config.refreshTokenTtlDays * 86400_000 });
  const csrf = crypto.randomBytes(24).toString('base64url');
  res.cookie(CSRF_COOKIE, csrf, { httpOnly: false, secure: config.cookieSecure, sameSite: 'strict', path: '/' });
  return csrf;
}

export function clearWebCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

async function resolveUser(req: Request): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  let token: string | undefined;
  let via: AuthUser['via'] = 'bearer';
  if (header?.startsWith('Bearer ')) token = header.slice(7);
  else if (req.cookies?.[ACCESS_COOKIE]) {
    token = req.cookies[ACCESS_COOKIE];
    via = 'cookie';
  }
  if (!token) return null;
  let sub: string;
  let deviceId: string | null = null;
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: 'geoattend', audience: 'geoattend' });
    sub = payload.sub as string;
    deviceId = typeof payload.did === 'string' ? payload.did : null;
  } catch {
    throw new HttpError(401, 'TOKEN_EXPIRED', 'Access token expired or invalid');
  }
  // Re-read the user so deactivation and role changes take effect immediately.
  const u = await one(
    `SELECT u.id, u.role, u.email, u.full_name, u.is_active, u.is_demo, u.org_id, u.must_change_password, ap.access, ap.site_ids
     FROM users u LEFT JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.id = $1`,
    [sub],
  );
  if (!u || !u.is_active) throw unauthorized('Account is inactive');
  const access = u.role === 'ADMIN' ? (u.access ?? 'OWNER') : undefined;
  return { id: u.id, role: u.role, email: u.email, fullName: u.full_name, isDemo: u.is_demo, orgId: u.org_id, access, sites: access === 'SUPERVISOR' ? (u.site_ids ?? []) : null, via, deviceId, mustChangePassword: u.must_change_password };
}

/** What someone on a temporary password may still do: read, sign in and out, change it, register their phone. */
const allowedOnTemporaryPassword = (url: string) => url.startsWith('/api/v1/auth/') || url.startsWith('/api/v1/me/devices');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireAuth(role?: Role) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      // The company is not known until the user has been read.
      const user = await asSystem(() => resolveUser(req));
      if (!user) throw unauthorized();
      if (user.via === 'cookie' && !SAFE_METHODS.has(req.method)) {
        const header = req.headers['x-csrf-token'];
        const cookie = req.cookies?.[CSRF_COOKIE];
        if (!cookie || typeof header !== 'string' || header.length !== cookie.length || !crypto.timingSafeEqual(Buffer.from(header), Buffer.from(cookie))) {
          throw new HttpError(403, 'CSRF_FAILED', 'Missing or invalid CSRF token');
        }
      }
      if (user.mustChangePassword && !SAFE_METHODS.has(req.method) && !allowedOnTemporaryPassword(req.originalUrl)) {
        throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password first (Account › Change password).');
      }
      if (role && user.role !== role) throw forbidden();
      (req as any).user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
