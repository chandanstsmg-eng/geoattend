/**
 * DEVELOPMENT ONLY. Creates "GeoAttend Demo Company": one owner, two supervisors and ten employees (five in
 * each supervisor's team), one workplace and one day shift, on the Professional edition.
 *
 *   npm run demo:provision -w @geoattend/api -- --confirm-development
 *   npm run demo:provision -w @geoattend/api -- --confirm-development --reset-passwords
 *
 * Every account gets its own random temporary password and must choose a new one at its first sign-in.
 * Passwords are never printed: they are written once to a file readable only by you, under
 * <DATA_DIR>/demo-credentials/ (data/ is not in git). Delete that file once the passwords have been handed out.
 *
 * Refuses to run when NODE_ENV=production, without --confirm-development, or on an external database unless
 * ALLOW_DEMO_ON_EXTERNAL_DB=1. Nothing runs this automatically: not migrations, not setup, not the server.
 * The addresses end in .test, which never delivers e-mail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from '../src/config.js';
import { ensureDatabase } from '../src/db/postgres.js';
import { asSystem, closePool, initPool, one, q, tx } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { audit } from '../src/lib/audit.js';
import { tempPassword } from '../src/modules/employees/employees.routes.js';

const args = new Set(process.argv.slice(2));
const refuse = (why: string) => {
  console.error(`Refusing to provision the demo company: ${why}`);
  process.exit(1);
};
if (config.isProduction || process.env.NODE_ENV === 'production') refuse('NODE_ENV is production. Demo accounts are never created on a production server.');
if (!args.has('--confirm-development')) refuse('add --confirm-development to confirm this is a development database.');
if (config.externalDatabaseUrl && process.env.ALLOW_DEMO_ON_EXTERNAL_DB !== '1') refuse('DATABASE_URL points at an external database. Set ALLOW_DEMO_ON_EXTERNAL_DB=1 only if it is a disposable development database.');

const COMPANY = 'GeoAttend Demo Company';
const DOMAIN = 'demo-company.test';
const people = [
  { key: 'owner', email: `owner@${DOMAIN}`, name: 'Demo Owner', role: 'OWNER' as const },
  { key: 'sup1', email: `supervisor1@${DOMAIN}`, name: 'Demo Supervisor One', role: 'SUPERVISOR' as const },
  { key: 'sup2', email: `supervisor2@${DOMAIN}`, name: 'Demo Supervisor Two', role: 'SUPERVISOR' as const },
  ...Array.from({ length: 10 }, (_, i) => ({
    key: `emp${i + 1}`,
    email: `employee${String(i + 1).padStart(2, '0')}@${DOMAIN}`,
    name: `Demo Employee ${String(i + 1).padStart(2, '0')}`,
    role: 'EMPLOYEE' as const,
    supervisor: i < 5 ? 'sup1' : 'sup2',
    code: `DEMO-${String(i + 1).padStart(3, '0')}`,
  })),
];

initPool(await ensureDatabase());
if (!(await asSystem(() => one(`SELECT 1 FROM schema_migrations WHERE version = '032_platform_and_subscriptions'`)))) {
  await closePool();
  refuse('this database does not have migration 032_platform_and_subscriptions. Apply migrations first (npm run db:migrate).');
}

const credentials: Array<{ role: string; email: string; password: string; team?: string }> = [];
const result = await asSystem(() =>
  tx(async (db) => {
    const existing = await one(`SELECT id FROM organizations WHERE name = $1 AND registration_source = 'DEMO'`, [COMPANY], db);
    if (existing && !args.has('--reset-passwords')) return { orgId: existing.id as string, created: false, reset: false };
    if (existing) {
      // New temporary passwords for the same thirteen accounts; their sign-ins end.
      for (const p of people) {
        const u = await one('SELECT id FROM users WHERE lower(email) = lower($1) AND org_id = $2', [p.email, existing.id], db);
        if (!u) continue;
        const pw = tempPassword();
        await q('UPDATE users SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL, is_active = true, updated_at = now() WHERE id = $1', [u.id, await hashPassword(pw)], db);
        await q('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id], db);
        credentials.push({ role: p.role, email: p.email, password: pw });
      }
      await audit({ actor: null, orgId: existing.id, action: 'demo.passwords_reset', resourceType: 'organization', resourceId: existing.id, reason: 'Development demo: temporary passwords reissued from the server' }, db);
      return { orgId: existing.id as string, created: false, reset: true };
    }
    for (const p of people) if (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [p.email], db)) throw new Error(`${p.email} already belongs to another company.`);

    const org = await one(
      `INSERT INTO organizations (name, phone, registration, registration_source, edition_code, employee_limit, supervisor_limit, features, subscription_status, subscription_starts_on, subscription_ends_on)
       SELECT $1, NULL, $2, 'DEMO', e.code, e.employee_limit, e.supervisor_limit, e.features, 'ACTIVE', current_date, current_date + 364 FROM editions e WHERE e.code = 'PROFESSIONAL' RETURNING id`,
      [COMPANY, JSON.stringify({ legalName: `${COMPANY} (development only)`, city: 'Bengaluru', country: 'India', notes: 'Development demo. Not a real company; every person in it is fictional.' })],
      db,
    );
    const ids: Record<string, string> = {};
    for (const p of people) {
      const pw = tempPassword();
      const u = await one(
        `INSERT INTO users (email, password_hash, role, full_name, must_change_password, org_id) VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
        [p.email, await hashPassword(pw), p.role === 'EMPLOYEE' ? 'EMPLOYEE' : 'ADMIN', p.name, org.id],
        db,
      );
      ids[p.key] = u.id;
      credentials.push({ role: p.role, email: p.email, password: pw, ...('supervisor' in p ? { team: people.find((s) => s.key === p.supervisor)!.email } : {}) });
    }
    const wp = await one(
      `INSERT INTO workplaces (name, address, latitude, longitude, radius_m, timezone, default_grace_minutes, absence_threshold_minutes, created_by, org_id)
       VALUES ('Demo Office (fictional)', 'MG Road, Bengaluru (sample coordinates)', 12.975526, 77.606919, 100, 'Asia/Kolkata', 10, 15, $1, $2) RETURNING id`,
      [ids.owner, org.id],
      db,
    );
    const shift = await one(
      `INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes, absence_threshold_minutes)
       VALUES ($1, 'Day shift', '09:00', '18:00', 'Asia/Kolkata', '{1,2,3,4,5,6}', 10, 15) RETURNING id`,
      [wp.id],
      db,
    );
    for (const p of people) {
      if (p.role !== 'EMPLOYEE') {
        await q(`INSERT INTO administrator_profiles (user_id, access, site_ids, title) VALUES ($1, $2, $3, $4)`, [ids[p.key], p.role, p.role === 'SUPERVISOR' ? [wp.id] : [], p.role === 'OWNER' ? 'Owner (demo)' : 'Supervisor (demo)'], db);
        continue;
      }
      await q(`INSERT INTO employee_profiles (user_id, employee_code, department, designation, supervisor_id) VALUES ($1, $2, 'Operations', 'Field associate (demo)', $3)`, [ids[p.key], p.code, ids[p.supervisor!]], db);
      await q(`INSERT INTO workplace_assignments (employee_id, workplace_id, created_by) VALUES ($1, $2, $3)`, [ids[p.key], wp.id, ids.owner], db);
      await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, created_by) VALUES ($1, $2, $3)`, [ids[p.key], shift.id, ids.owner], db);
    }
    await audit({ actor: null, orgId: org.id, action: 'demo.company_provisioned', resourceType: 'organization', resourceId: org.id, after: { owner: 1, supervisors: 2, employees: 10 }, reason: 'Development demo company created from the server' }, db);
    return { orgId: org.id as string, created: true, reset: false };
  }),
);
await closePool();

if (!result.created && !result.reset) {
  console.log(`${COMPANY} already exists. To issue new temporary passwords, run again with --reset-passwords.`);
  process.exit(0);
}
const dir = path.join(DATA_DIR, 'demo-credentials');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `demo-company-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
const lines = [
  `${COMPANY}: temporary sign-in details (development only)`,
  `Created ${new Date().toISOString()} on database ${config.dbName}. Every password works once: each person must choose a new one at first sign-in.`,
  'Owners and supervisors sign in to the dashboard; employees sign in to the GeoAttend mobile app.',
  'Delete this file after handing the passwords out.',
  '',
  ...credentials.map((c) => `${c.role.padEnd(10)} ${c.email.padEnd(36)} ${c.password}${c.team ? `   team of ${c.team}` : ''}`),
  '',
];
fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
console.log(`${COMPANY} ${result.created ? 'created' : 'passwords reissued'}: ${credentials.filter((c) => c.role === 'OWNER').length} owner, ${credentials.filter((c) => c.role === 'SUPERVISOR').length} supervisors, ${credentials.filter((c) => c.role === 'EMPLOYEE').length} employees.`);
console.log(`Temporary passwords were written to ${file} (not printed here).`);
