/**
 * Applies the login passwords from .env to existing accounts:
 *   ADMIN_EMAIL / ADMIN_PASSWORD → the administrator account
 *   DEMO_PASSWORD                → demo admin + demo employees (DEMO_MODE only)
 * Also clears lockouts. Usage: npm run set-logins
 */
import { config } from '../src/config.js';
import { ensureDatabase } from '../src/db/postgres.js';
import { closePool, initPool, q } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword, passwordPolicyError } from '../src/lib/password.js';

const pool = initPool(await ensureDatabase());
await migrate(pool);

const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim();
const adminPassword = (process.env.ADMIN_PASSWORD ?? '').trim();
if (adminEmail && adminPassword) {
  const err = passwordPolicyError(adminPassword);
  if (err) throw new Error(`ADMIN_PASSWORD: ${err}`);
  const rows = await q(
    `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, is_active = true
     WHERE lower(email) = lower($1) AND role = 'ADMIN' RETURNING email`,
    [adminEmail, await hashPassword(adminPassword)],
  );
  console.log(rows.length ? `  Administrator ${adminEmail}: password set` : `  No administrator ${adminEmail} — run "npm run db:seed" first`);
}

if (config.demoMode && config.demoPassword) {
  const err = passwordPolicyError(config.demoPassword);
  if (err) throw new Error(`DEMO_PASSWORD: ${err}`);
  const rows = await q(
    `UPDATE users SET password_hash = $1, failed_login_count = 0, locked_until = NULL WHERE is_demo RETURNING email`,
    [await hashPassword(config.demoPassword)],
  );
  for (const r of rows) console.log(`  ${r.email}: demo password set`);
}

await closePool();
