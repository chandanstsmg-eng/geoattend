/**
 * Platform super administrators, managed by whoever runs the server (there is deliberately no way to become
 * one from the web):
 *
 *   npm run platform:admin -w @geoattend/api -- create <email> "<Full name>"
 *   npm run platform:admin -w @geoattend/api -- reset-password <email>
 *   npm run platform:admin -w @geoattend/api -- deactivate <email>
 *   npm run platform:admin -w @geoattend/api -- activate <email>
 *   npm run platform:admin -w @geoattend/api -- list
 *
 * create and reset-password print a random temporary password once; it must be changed at the first sign-in
 * (/platform/login). Nothing is hard-coded and nothing is written to disk. Every action is in the platform audit log.
 */
import { ensureDatabase } from '../src/db/postgres.js';
import { asSystem, closePool, initPool, one, q } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { tempPassword } from '../src/modules/employees/employees.routes.js';

const [command, email, ...rest] = process.argv.slice(2);
const usage = () => {
  console.log('Usage: npm run platform:admin -w @geoattend/api -- <create <email> "<Full name>" | reset-password <email> | deactivate <email> | activate <email> | list>');
  process.exit(1);
};
if (!command || (command !== 'list' && !email)) usage();

initPool(await ensureDatabase());
// Never migrates on its own: a database without migration 032 is refused, so this cannot change a schema by surprise.
if (!(await asSystem(() => one(`SELECT 1 FROM schema_migrations WHERE version = '032_platform_and_subscriptions'`)))) {
  console.log('This database does not have migration 032_platform_and_subscriptions yet. Apply migrations first (npm run db:migrate), after a backup.');
  await closePool();
  process.exit(1);
}
const log = (action: string, id: string) => q(`INSERT INTO platform_audit_logs (admin_id, action, target_type, target_id, reason) VALUES (NULL, $1, 'platform_admin', $2, 'Run from the server by an operator')`, [action, id]);

let exitCode = 0;
await asSystem(async () => {
  if (command === 'list') {
    const rows = await q('SELECT email, full_name, is_active, must_change_password, last_login_at FROM platform_admins ORDER BY created_at');
    if (!rows.length) console.log('No platform administrators yet.');
    for (const r of rows) console.log(`${r.email}  ${r.full_name}  ${r.is_active ? 'active' : 'DEACTIVATED'}${r.must_change_password ? '  (temporary password)' : ''}  last sign-in: ${r.last_login_at ? new Date(r.last_login_at).toISOString() : 'never'}`);
    return;
  }
  if (command === 'create') {
    const fullName = rest.join(' ').trim();
    if (!fullName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email!)) usage();
    if (await one('SELECT 1 FROM platform_admins WHERE lower(email) = lower($1)', [email])) {
      console.log(`A platform administrator ${email} already exists. Use reset-password.`);
      exitCode = 1;
      return;
    }
    const pw = tempPassword();
    const a = await one(`INSERT INTO platform_admins (email, password_hash, full_name, must_change_password) VALUES ($1, $2, $3, true) RETURNING id`, [email, await hashPassword(pw), fullName]);
    await log('platform.admin.create', a.id);
    console.log(`Platform administrator ${email} created.\nTemporary password (shown once): ${pw}\nSign in at <dashboard>/platform/login and choose a new password.`);
    return;
  }
  const a = await one('SELECT id FROM platform_admins WHERE lower(email) = lower($1)', [email]);
  if (!a) {
    console.log(`No platform administrator with the e-mail ${email}.`);
    exitCode = 1;
    return;
  }
  if (command === 'reset-password') {
    const pw = tempPassword();
    await q('UPDATE platform_admins SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [a.id, await hashPassword(pw)]);
    await q('UPDATE platform_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL', [a.id]);
    await log('platform.admin.reset_password', a.id);
    console.log(`Temporary password for ${email} (shown once): ${pw}\nEvery existing platform sign-in of this account has ended.`);
  } else if (command === 'deactivate' || command === 'activate') {
    await q('UPDATE platform_admins SET is_active = $2, updated_at = now() WHERE id = $1', [a.id, command === 'activate']);
    if (command === 'deactivate') await q('UPDATE platform_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL', [a.id]);
    await log(`platform.admin.${command}`, a.id);
    console.log(`${email} ${command}d.`);
  } else usage();
});
await closePool();
process.exit(exitCode);
