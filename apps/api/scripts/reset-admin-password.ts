/**
 * For whoever runs the server, when an administrator cannot get back in and no other owner can reset them
 * (for example, a company's only owner forgot their password):
 *   npm run admin:reset-password -w @geoattend/api -- owner@company.example
 * Prints a temporary password once. The person must choose a new one at sign-in, every existing sign-in
 * ends, and the reset is written to that company's audit log. Confirm who is asking before running it.
 */
import { ensureDatabase } from '../src/db/postgres.js';
import { asSystem, closePool, initPool, one, q } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { revokeAllForUser } from '../src/lib/auth.js';
import { audit } from '../src/lib/audit.js';
import { tempPassword } from '../src/modules/employees/employees.routes.js';

const email = process.argv[2]?.trim();
if (!email) {
  console.log('Usage: npm run admin:reset-password -w @geoattend/api -- <administrator e-mail>');
  process.exit(1);
}
initPool(await ensureDatabase());
const pw = await asSystem(async () => {
  const u = await one(`SELECT id, org_id, is_active FROM users WHERE lower(email) = lower($1) AND role = 'ADMIN'`, [email]);
  if (!u) return null;
  const pw = tempPassword();
  await q('UPDATE users SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [u.id, await hashPassword(pw)]);
  await revokeAllForUser(u.id);
  await audit({ actor: null, orgId: u.org_id, action: 'team.reset_password_by_operator', resourceType: 'user', resourceId: u.id, reason: 'Reset from the server by an operator' });
  if (!u.is_active) console.log('Note: this account is deactivated. Another owner must reactivate it before it can sign in.');
  return pw;
});
await closePool();
if (!pw) {
  console.log(`No administrator with the e-mail ${email}.`);
  process.exit(1);
}
console.log(`Temporary password for ${email}: ${pw}`);
console.log('Pass it on privately. They must choose a new password when they sign in.');
