/** scrypt password hashing (Node built-in, no native add-ons). Format: scrypt$N$r$p$salt$hash */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
// OWASP's scrypt option N=2^15, r=8, p=3 (32 MB). Tests hash hundreds of passwords, so they use less.
const light = process.env.NODE_ENV === 'test';
const N = light ? 1024 : 32768;
const R = 8;
const P = light ? 1 : 3;
const LEN = 64;

/** Compared against when the account does not exist, so the answer takes as long as a real check. */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$AAAAAAAAAAAAAAAAAAAAAA==$${'A'.repeat(86)}==`;

/** Hashes made with weaker settings are replaced at the next successful sign-in. */
export const needsRehash = (stored: string) => {
  const [, n, r, p] = stored.split('$');
  return Number(n) !== N || Number(r) !== R || Number(p) !== P;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, LEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** Minimum policy: 10+ chars with at least one letter and one digit. */
export function passwordPolicyError(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}
