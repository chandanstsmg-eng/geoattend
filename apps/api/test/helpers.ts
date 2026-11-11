import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { offsetMeters } from '@geoattend/shared';
import { dropDatabase, ensureDatabase } from '../src/db/postgres.js';
import { closePool, initPool, one, prepareTenantLogin, q } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/lib/password.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { DEFAULT_SETTINGS, invalidateSettings, saveSettingsSection } from '../src/modules/settings/settings.service.js';

export const WP = { lat: 12.9716, lng: 77.5946 };
export const PASSWORD = 'Test-password-123';

/** Test-friendly settings for a company: shorter windows (same rules), phone binding off. */
export async function testSettings(orgId: string) {
  await saveSettingsSection(orgId, 'tracking', { ...DEFAULT_SETTINGS.tracking, entryStabilizationSec: 10, exitStabilizationSec: 20, returnStabilizationSec: 10, staleAfterSec: 120, evidenceMaxAgeSec: 90, entryMinServerSpanSec: 0 }, null);
  // Phone binding is exercised in its own tests; elsewhere test logins have no device id.
  // Face enrollment likewise has its own tests.
  await saveSettingsSection(orgId, 'workforce', { ...DEFAULT_SETTINGS.workforce, deviceBinding: 'OFF', faceEnrollment: 'OFF' }, null);
}

/** A throw-away database on the embedded server, fully migrated. */
export async function createTestDatabase() {
  // ensureDatabase() ignores the requested name when DATABASE_URL is set, so tests would write to that database.
  if (process.env.DATABASE_URL) throw new Error('Refusing to run tests with DATABASE_URL set: they must use a throw-away database.');
  const name =`geoattend_test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const pool = initPool(await ensureDatabase(name));
  await migrate(pool);
  await prepareTenantLogin();
  invalidateSettings();
  await testSettings(DEFAULT_ORG_ID);
  return {
    async drop() {
      await closePool();
      await dropDatabase(name);
      // The photo folder is shared by every test file running in parallel; it is removed once,
      // after all of them, by test/global-setup.ts (removing it here broke files still running).
    },
  };
}

/** An administrator, a workplace and an all-day shift in a company (the default one unless given). */
export async function seedBase(orgId = DEFAULT_ORG_ID, adminEmail = 'admin@test.local') {
  const admin = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) VALUES ($1, $2, 'ADMIN', 'Test Admin', $3) RETURNING id`, [adminEmail, await hashPassword(PASSWORD), orgId]);
  await q('INSERT INTO administrator_profiles (user_id) VALUES ($1)', [admin.id]);
  const wp = await one(
    `INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, absence_threshold_minutes, org_id) VALUES ('Test Site', $1, $2, 30, 'UTC', 5, $3) RETURNING id`,
    [WP.lat, WP.lng, orgId],
  );
  const shift = await one(
    `INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1, 'All day', '00:00', '23:59', 'UTC', '{1,2,3,4,5,6,7}', 240) RETURNING id`,
    [wp.id],
  );
  return { adminId: admin.id as string, adminEmail, workplaceId: wp.id as string, shiftId: shift.id as string, orgId };
}

let counter = 0;
/**
 * Puts employees in a supervisor's team (employee_profiles.supervisor_id). Since the Phase I visibility policy a
 * supervisor sees only their own team at their workplaces, so tests of a supervisor acting on a worker say so.
 */
export async function assignTeam(supervisorId: string, ...employeeIds: string[]) {
  await q('UPDATE employee_profiles SET supervisor_id = $1 WHERE user_id = ANY($2::uuid[])', [supervisorId, employeeIds]);
}

export async function createEmployee(opts: { workplaceId?: string | null; shiftId?: string | null; ack?: boolean; orgId?: string; supervisorId?: string } = {}) {
  const n = ++counter;
  const u = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) VALUES ($1, $2, 'EMPLOYEE', $3, $4) RETURNING id`, [`emp${n}-${crypto.randomUUID()}@test.local`, await hashPassword(PASSWORD), `Employee ${n}`, opts.orgId ?? DEFAULT_ORG_ID]);
  await q(`INSERT INTO employee_profiles (user_id, employee_code) VALUES ($1, $2)`, [u.id, `E-${n}-${crypto.randomBytes(2).toString('hex')}`]);
  if (opts.workplaceId) await q('INSERT INTO workplace_assignments (employee_id, workplace_id) VALUES ($1, $2)', [u.id, opts.workplaceId]);
  if (opts.shiftId) await q('INSERT INTO employee_shift_assignments (employee_id, shift_id) VALUES ($1, $2)', [u.id, opts.shiftId]);
  if (opts.ack !== false) await q('INSERT INTO notice_acknowledgements (user_id, notice_version) VALUES ($1, $2)', [u.id, DEFAULT_SETTINGS.privacy.version]);
  if (opts.supervisorId) await assignTeam(opts.supervisorId, u.id);
  const email = (await one('SELECT email FROM users WHERE id = $1', [u.id])).email;
  return { id: u.id as string, email: email as string };
}

export async function mobileLogin(app: Express, email: string) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD, client: 'mobile' }).expect(200);
  return res.body.accessToken as string;
}

export async function adminAgent(app: Express, email = 'admin@test.local') {
  // Accounts created through the API start on a temporary password; these tests are about something else.
  await q('UPDATE users SET must_change_password = false WHERE lower(email) = lower($1)', [email]);
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD, client: 'web' }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

/** Monotonic device clock starting slightly in the past (readings may not predate the session by > 2 min). */
export function deviceClock(startOffsetSec = -100) {
  let t = Date.now() + startOffsetSec * 1000;
  return (advanceSec = 0) => {
    t += advanceSec * 1000;
    return new Date(t).toISOString();
  };
}

export function reading(northM: number, accuracyM: number, clientTime: string, extra: Record<string, unknown> = {}) {
  const p = offsetMeters(WP, northM, 0);
  return { clientEventId: crypto.randomUUID(), latitude: p.lat, longitude: p.lng, accuracyM, clientTime, ...extra };
}

export const fakeJpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2048)]);
