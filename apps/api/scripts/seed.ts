/**
 * Seeds the database. Idempotent — safe to run repeatedly.
 *  - Always: the initial administrator from ADMIN_EMAIL / ADMIN_PASSWORD, if no admin exists yet.
 *  - Everything seeded here belongs to the default organisation; companies that sign up later start empty.
 *  - DEMO_MODE=true only: a clearly labelled fictional workplace, shift, demo admin
 *    and three fictional demo employees. No real personal data is ever seeded.
 */
import { config } from '../src/config.js';
import { ensureDatabase } from '../src/db/postgres.js';
import { closePool, initPool, one, q } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword, passwordPolicyError } from '../src/lib/password.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';

const pool = initPool(await ensureDatabase());
await migrate(pool);

const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim();
const adminPassword = (process.env.ADMIN_PASSWORD ?? '').trim();
const hasAdmin = await one(`SELECT 1 FROM users WHERE role = 'ADMIN' AND NOT is_demo`);
if (!hasAdmin && adminEmail && adminPassword) {
  const policy = passwordPolicyError(adminPassword);
  if (policy) throw new Error(`ADMIN_PASSWORD: ${policy}`);
  const u = await one(
    `INSERT INTO users (email, password_hash, role, full_name, org_id) VALUES ($1,$2,'ADMIN',$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
    [adminEmail, await hashPassword(adminPassword), process.env.ADMIN_NAME?.trim() || 'Administrator', DEFAULT_ORG_ID],
  );
  if (u) {
    await q('INSERT INTO administrator_profiles (user_id) VALUES ($1)', [u.id]);
    console.log(`  Created administrator ${adminEmail}`);
  }
} else if (!hasAdmin) {
  console.log('  No administrator exists. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env and run "npm run db:seed".');
}

if (config.demoMode) {
  if (!config.demoPassword) throw new Error('DEMO_PASSWORD must be set when DEMO_MODE=true');
  const demoHash = await hashPassword(config.demoPassword);

  async function demoUser(email: string, role: 'ADMIN' | 'EMPLOYEE', name: string) {
    const existing = await one('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
    if (existing) return { id: existing.id as string, created: false };
    const u = await one(`INSERT INTO users (email, password_hash, role, full_name, is_demo, org_id) VALUES ($1,$2,$3,$4,true,$5) RETURNING id`, [email, demoHash, role, name, DEFAULT_ORG_ID]);
    return { id: u.id as string, created: true };
  }

  const admin = await demoUser('demo.admin@example.test', 'ADMIN', 'Demo Administrator');
  if (admin.created) await q('INSERT INTO administrator_profiles (user_id, title) VALUES ($1, $2)', [admin.id, 'Demo account']);

  let wp = await one(`SELECT id FROM workplaces WHERE is_demo AND name = 'Demo Workplace (fictional)'`);
  if (!wp) {
    // Fictional workplace at sample coordinates (central Bengaluru). Not a real employer site.
    wp = await one(
      `INSERT INTO workplaces (name, address, latitude, longitude, radius_m, timezone, default_grace_minutes, absence_threshold_minutes, is_demo, created_by, org_id)
       VALUES ('Demo Workplace (fictional)', 'Sample coordinates for demonstration only', 12.971599, 77.594566, 30, 'Asia/Kolkata', 10, 10, true, $1, $2) RETURNING id`,
      [admin.id, DEFAULT_ORG_ID],
    );
  }
  let shift = await one(`SELECT id FROM shifts WHERE is_demo AND workplace_id = $1`, [wp.id]);
  if (!shift) {
    shift = await one(
      `INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes, absence_threshold_minutes, is_demo)
       VALUES ($1, 'Demo all-day shift', '00:00', '23:59', 'Asia/Kolkata', '{1,2,3,4,5,6,7}', 10, 10, true) RETURNING id`,
      [wp.id],
    );
  }

  const employees = [
    ['demo.asha@example.test', 'Asha Rao (Demo)', 'DEMO-001', 'Operations'],
    ['demo.vikram@example.test', 'Vikram Shetty (Demo)', 'DEMO-002', 'Facilities'],
    ['demo.meera@example.test', 'Meera Iyer (Demo)', 'DEMO-003', 'Front desk'],
  ] as const;
  for (const [email, name, code, dept] of employees) {
    const u = await demoUser(email, 'EMPLOYEE', name);
    if (u.created) {
      await q(`INSERT INTO employee_profiles (user_id, employee_code, department, designation) VALUES ($1,$2,$3,'Demo employee')`, [u.id, code, dept]);
      await q(`INSERT INTO workplace_assignments (employee_id, workplace_id, created_by) VALUES ($1,$2,$3)`, [u.id, wp.id, admin.id]);
      await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, created_by) VALUES ($1,$2,$3)`, [u.id, shift.id, admin.id]);
    }
  }
  console.log('  Demo data ready: Demo Workplace (fictional), Demo all-day shift, demo.admin@example.test + 3 demo employees (password = DEMO_PASSWORD).');
}

await closePool();
