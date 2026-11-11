/**
 * One-time links for invitations (the person chooses their own first password) and password resets.
 *
 * A token is 256 random bits, given out once and stored only as its SHA-256 hash. It works once, until it expires,
 * and a newer one of the same kind for the same person cancels the older. The link carries it after `#`, so it is
 * never sent to the server in a page request, never written to access logs and never passed on as a referrer.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { asSystem, one, q, tx, type Queryable } from '../db/pool.js';
import { logger } from './logger.js';
import { mailer } from './mailer.js';

export type TokenPurpose = 'INVITE' | 'PASSWORD_RESET';
export const TOKEN_TTL_MINUTES: Record<TokenPurpose, number> = { INVITE: 7 * 24 * 60, PASSWORD_RESET: 60 };
const PAGE: Record<TokenPurpose, string> = { INVITE: '/accept-invite', PASSWORD_RESET: '/reset-password' };

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export const accountLink = (purpose: TokenPurpose, token: string) => `${config.dashboardUrl.replace(/\/+$/, '')}${PAGE[purpose]}#token=${token}`;

/** Issues a token for `userId` (cancelling earlier unused ones of the same kind) inside `db`. Returns the raw token once. */
export async function issueAccountToken(userId: string, purpose: TokenPurpose, createdBy: string | null, db: Queryable) {
  await q(`UPDATE account_tokens SET revoked_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND revoked_at IS NULL`, [userId, purpose], db);
  const token = crypto.randomBytes(32).toString('base64url');
  const row = await one<{ expires_at: string }>(
    `INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at, created_by) VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5) RETURNING expires_at`,
    [userId, purpose, sha256(token), TOKEN_TTL_MINUTES[purpose], createdBy],
    db,
  );
  return { token, url: accountLink(purpose, token), expiresAt: row!.expires_at };
}

/**
 * Cancels every open link of a person. Called whenever a link could otherwise outlive its purpose: the address
 * it was sent to changed, the password was set some other way, the person signed in, or was deactivated.
 */
export async function revokeAccountTokens(userId: string, db?: Queryable) {
  await q('UPDATE account_tokens SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [userId], db);
}

/** The open token behind `raw`, with its user and company, or null (unknown, used, cancelled or expired). Nobody is signed in yet, so this looks past companies. */
export async function findAccountToken(raw: string, purpose: TokenPurpose) {
  return asSystem(() =>
    one(
      `SELECT t.id, t.user_id, t.expires_at, u.email, u.full_name, u.role, u.is_active, u.org_id, o.name AS org_name, o.status AS org_status, ap.access
       FROM account_tokens t JOIN users u ON u.id = t.user_id JOIN organizations o ON o.id = u.org_id LEFT JOIN administrator_profiles ap ON ap.user_id = u.id
       WHERE t.token_hash = $1 AND t.purpose = $2 AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()`,
      [sha256(raw), purpose],
    ),
  );
}

/**
 * Uses the token once: `apply` runs in the same transaction as marking it used, under a row lock, so two
 * simultaneous uses cannot both succeed. Returns null if the token is no longer open.
 */
export async function consumeAccountToken<T>(raw: string, purpose: TokenPurpose, apply: (row: any, db: Queryable) => Promise<T>): Promise<T | null> {
  return asSystem(() =>
    tx(async (db) => {
      const row = await one(
        `SELECT t.id, t.user_id, u.org_id, u.role, u.is_active, o.status AS org_status FROM account_tokens t JOIN users u ON u.id = t.user_id JOIN organizations o ON o.id = u.org_id
         WHERE t.token_hash = $1 AND t.purpose = $2 AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now() FOR UPDATE OF t`,
        [sha256(raw), purpose],
        db,
      );
      if (!row || !row.is_active || row.org_status !== 'ACTIVE') return null;
      await q('UPDATE account_tokens SET used_at = now() WHERE id = $1', [row.id], db);
      return apply(row, db);
    }),
  );
}

// ── Delivery ──

/** Messages "sent" while running tests, so tests can follow a link without a mail server. */
export const testOutbox: Array<{ to: string; subject: string; text: string }> = [];

/**
 * E-mails an account message. Without SMTP it is not sent: in development the message is written to the API
 * log so the link can be followed; in production nothing is logged (the link is a password) and false comes back.
 */
export async function sendAccountMail(to: string, subject: string, text: string): Promise<boolean> {
  if (config.isTest) {
    testOutbox.push({ to, subject, text });
    return true;
  }
  if (!config.email.smtpUrl) {
    if (!config.isProduction) logger.warn({ to, subject, text }, 'Development only: no SMTP_URL, so this account e-mail was not sent. Its text is shown here instead.');
    return false;
  }
  try {
    await mailer().sendMail({ from: config.email.from, to, subject, text });
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message, subject }, 'Account e-mail could not be sent');
    return false;
  }
}

/** A password nobody knows, for an invited account until the person chooses theirs. */
export const unusablePassword = () => crypto.randomBytes(32).toString('base64url') + 'A1';

/**
 * E-mails an invitation issued with issueAccountToken (after its transaction committed). The answer to whoever
 * invited also carries the link, so they can pass it on themselves when e-mail is not set up.
 */
export async function sendInvitation(userId: string, link: { url: string; expiresAt: string }) {
  const u = await asSystem(() =>
    one(`SELECT u.email, u.full_name, u.role, o.name AS org_name FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`, [userId]),
  );
  if (!u) return false;
  return sendAccountMail(u.email, `You are invited to ${u.org_name} on GeoAttend`, invitationText({ fullName: u.full_name, company: u.org_name, role: u.role, url: link.url, expiresAt: link.expiresAt }));
}

export function invitationText(o: { fullName: string; company: string; role: string; url: string; expiresAt: string }) {
  const where = o.role === 'EMPLOYEE' ? 'Then sign in to the GeoAttend mobile app with this e-mail address and your new password.' : 'Then sign in to the GeoAttend dashboard.';
  return `Hello ${o.fullName},\n\nYou have been invited to ${o.company} on GeoAttend. Choose your password here:\n\n${o.url}\n\n${where}\n\nThis link works once and expires on ${new Date(o.expiresAt).toUTCString()}. If you were not expecting it, ignore this e-mail.\n`;
}

export function resetText(o: { fullName: string; url: string }) {
  return `Hello ${o.fullName},\n\nSomeone asked to reset the password of your GeoAttend account. Choose a new password here:\n\n${o.url}\n\nThis link works once and expires in ${TOKEN_TTL_MINUTES.PASSWORD_RESET} minutes. If you did not ask for it, ignore this e-mail: your password stays as it is.\n`;
}
