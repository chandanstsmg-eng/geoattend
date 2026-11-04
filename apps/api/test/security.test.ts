/** Regression tests for the Phase 1 security findings, through the API and against the database. */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { config, parseTrustProxy, productionConfigErrors } from '../src/config.js';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { DEFAULT_SETTINGS, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { isPushService } from '../src/modules/notifications/notifications.routes.js';
import { addClient, recheckClients } from '../src/modules/notifications/live-hub.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { adminAgent, createEmployee, createTestDatabase, mobileLogin, PASSWORD, seedBase } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
let owner: Awaited<ReturnType<typeof adminAgent>>;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
  owner = await adminAgent(app);
});
afterAll(async () => {
  await db.drop();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const post = (path: string, body: object = {}) => owner.agent.post(`/api/v1${path}`).set('X-CSRF-Token', owner.csrf).send(body);
const binding = (deviceBinding: 'ENFORCE' | 'ALERT' | 'OFF') => saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, faceEnrollment: 'OFF', deviceBinding }, null);
const phoneLogin = (email: string, deviceId: string) => request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD, client: 'mobile', deviceId, platform: 'android', model: 'Test phone' });

async function attended(employeeId: string, status = 'VERIFIED') {
  const date = '2026-03-10';
  const shift = await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week) VALUES ($1,$2,'09:00','17:00','UTC','{1,2,3,4,5,6,7}') RETURNING id`, [base.workplaceId, `S ${crypto.randomUUID().slice(0, 6)}`]);
  await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, effective_to) VALUES ($1,$2,$3,$3)`, [employeeId, shift.id, date]);
  const r = await one(
    `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, shift_date, idempotency_key, radius_m_at_record, verification_status, recorded_at) VALUES ($1,$2,$3,$4,$5,30,$6,$7) RETURNING id`,
    [employeeId, base.workplaceId, shift.id, date, crypto.randomUUID(), status, `${date}T09:00:00Z`],
  );
  return r.id as string;
}
const dispute = (token: string, attendanceId: string) => request(app).post('/api/v1/me/issues').set(bearer(token)).send({ kind: 'DISPUTE', attendanceId, reason: 'I was at work that day' });

describe('voided attendance', () => {
  it('cannot be lifted back into reports by a dispute', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const id = await attended(emp.id, 'VOIDED');
    const token = await mobileLogin(app, emp.email);
    const res = await dispute(token, id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTENDANCE_VOIDED');
    expect((await one(`SELECT verification_status FROM attendance_records WHERE id = $1`, [id])).verification_status).toBe('VOIDED');
    const roster = (await owner.agent.get('/api/v1/reports/monthly?month=2026-03').expect(200)).body.rows.find((r: any) => r.employee_id === emp.id);
    expect(roster.present).toBe(0);
  });

  it('cannot be changed by a correction, and the refusal leaves it voided', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const id = await attended(emp.id, 'VOIDED');
    expect((await post(`/attendance/${id}/corrections`, { reason: 'Try to approve it', verificationStatus: 'MANUAL_APPROVED' }).expect(409)).body.error.code).toBe('ATTENDANCE_VOIDED');
  });

  it('is final in the database too, whatever code runs', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const id = await attended(emp.id, 'VOIDED');
    await expect(q(`UPDATE attendance_records SET verification_status = 'VERIFIED' WHERE id = $1`, [id])).rejects.toThrow(/cannot be restored/);
  });

  it('allows one open dispute, audited, and restores the true status on rejection', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const id = await attended(emp.id);
    const token = await mobileLogin(app, emp.email);
    expect((await dispute(token, id)).status).toBeLessThan(300);
    expect((await dispute(token, id).then((r) => r)).body.error.code).toBe('DISPUTE_OPEN');
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'attendance.dispute' AND resource_id = $1`, [id])).toHaveLength(1);
    const review = await one(`SELECT id FROM review_requests WHERE attendance_id = $1 AND kind = 'DISPUTE'`, [id]);
    await post(`/attendance/reviews/${review.id}/resolve`, { decision: 'REJECT', note: 'Gate log shows otherwise' }).expect(200);
    expect((await one(`SELECT verification_status FROM attendance_records WHERE id = $1`, [id])).verification_status).toBe('VERIFIED');
  });

  it('a record voided during a dispute stays voided when the dispute is rejected', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const id = await attended(emp.id);
    await dispute(await mobileLogin(app, emp.email), id);
    await post(`/attendance/${id}/corrections`, { reason: 'Fraud confirmed', verificationStatus: 'VOIDED' }).expect(200);
    const review = await one(`SELECT id, status FROM review_requests WHERE attendance_id = $1 AND kind = 'DISPUTE'`, [id]);
    expect(review.status).toBe('APPROVED');
    expect((await one(`SELECT verification_status FROM attendance_records WHERE id = $1`, [id])).verification_status).toBe('VOIDED');
  });

  it('does not count in hours', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const id = await attended(emp.id, 'VOIDED');
    expect(await q(`SELECT 1 FROM attendance_work WHERE attendance_id = $1`, [id])).toHaveLength(0);
  });
});

describe('phone approval', () => {
  afterEach(() => binding('OFF'));

  it('never approves a phone by itself, including the first or one registered from the app', async () => {
    await binding('ENFORCE');
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const phone = `first-${crypto.randomUUID()}`;
    expect((await phoneLogin(emp.email, phone).expect(403)).body.error.code).toBe('DEVICE_PENDING');
    expect((await one(`SELECT status FROM device_registrations WHERE user_id = $1`, [emp.id])).status).toBe('PENDING');

    await binding('OFF');
    const token = await mobileLogin(app, emp.email);
    const spare = `spare-${crypto.randomUUID()}`;
    await request(app).post('/api/v1/me/devices').set(bearer(token)).send({ deviceId: spare, platform: 'android' }).expect(200);
    expect((await one(`SELECT status FROM device_registrations WHERE user_id = $1 AND device_id = $2`, [emp.id, spare])).status).toBe('PENDING');
    await request(app).post('/api/v1/me/devices').set(bearer(token)).send({ deviceId: spare, platform: 'android', model: 'Again' }).expect(200);
    expect((await one(`SELECT status FROM device_registrations WHERE user_id = $1 AND device_id = $2`, [emp.id, spare])).status).toBe('PENDING');
    expect((await one(`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'device_registrations' AND column_name = 'status'`)).d).toContain('PENDING');
  });

  it('lets an owner approve, then reject, keeping each step in the history', async () => {
    await binding('ENFORCE');
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const phone = `hist-${crypto.randomUUID()}`;
    await phoneLogin(emp.email, phone).expect(403);
    const d = await one(`SELECT id FROM device_registrations WHERE user_id = $1`, [emp.id]);
    await post(`/devices/${d.id}/approve`, { note: 'New joiner' }).expect(200);
    await phoneLogin(emp.email, phone).expect(200);
    await post(`/devices/${d.id}/revoke`, { note: 'Phone lost' }).expect(200);
    expect((await phoneLogin(emp.email, phone).expect(403)).body.error.code).toBe('DEVICE_REVOKED');
    const h = (await owner.agent.get(`/api/v1/devices/${d.id}/history`).expect(200)).body;
    expect(h.map((x: any) => [x.from_status, x.to_status, x.note])).toEqual([[null, 'PENDING', null], ['PENDING', 'APPROVED', 'New joiner'], ['APPROVED', 'REVOKED', 'Phone lost']]);
    expect(h[1].changed_by_name).toBe('Test Admin');
  });

  it('refuses attendance actions the moment a phone stops being approved, using the phone in the token', async () => {
    await binding('ENFORCE');
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const phone = `live-${crypto.randomUUID()}`;
    await phoneLogin(emp.email, phone).expect(403);
    const d = await one(`SELECT id FROM device_registrations WHERE user_id = $1`, [emp.id]);
    await post(`/devices/${d.id}/approve`).expect(200);
    const token = (await phoneLogin(emp.email, phone).expect(200)).body.accessToken;
    await post(`/devices/${d.id}/revoke`, { note: 'Stolen' }).expect(200);
    const start = await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: base.shiftId, deviceId: phone });
    expect(start.status).toBe(403);
    expect(start.body.error.code).toBe('DEVICE_NOT_APPROVED');
    const uuid = crypto.randomUUID();
    const intent = await request(app).post('/api/v1/attendance/intents').set(bearer(token)).send({ sessionId: uuid, idempotencyKey: crypto.randomUUID(), contentType: 'image/jpeg', sizeBytes: 100 });
    expect(intent.body.error.code).toBe('DEVICE_NOT_APPROVED');
  });

  it('is not fooled by a client naming an approved phone in the request', async () => {
    await binding('OFF');
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const approved = `real-${crypto.randomUUID()}`;
    await q(`INSERT INTO device_registrations (user_id, device_id, platform, status) VALUES ($1,$2,'android','APPROVED')`, [emp.id, approved]);
    const token = (await phoneLogin(emp.email, `other-${crypto.randomUUID()}`).expect(200)).body.accessToken;
    await binding('ENFORCE');
    const res = await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: base.shiftId, deviceId: approved });
    expect(res.body.error.code).toBe('DEVICE_NOT_APPROVED');
  });

  it('a supervisor can decide only for their own workplaces', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const d = await one(`INSERT INTO device_registrations (user_id, device_id, platform, status) VALUES ($1,$2,'android','PENDING') RETURNING id`, [emp.id, `sup-${crypto.randomUUID()}`]);
    const elsewhere = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, absence_threshold_minutes, org_id) VALUES ('Other', 1, 1, 100, 'UTC', 5, $1) RETURNING id`, [DEFAULT_ORG_ID]);
    const s = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) SELECT $1, password_hash, 'ADMIN', 'Sup', org_id FROM users WHERE id = $2 RETURNING id, email`, [`sup-${crypto.randomUUID()}@test.local`, base.adminId]);
    await q(`INSERT INTO administrator_profiles (user_id, access, site_ids) VALUES ($1,'SUPERVISOR',$2)`, [s.id, [elsewhere.id]]);
    const sup = await adminAgent(app, s.email);
    await sup.agent.post(`/api/v1/devices/${d.id}/approve`).set('X-CSRF-Token', sup.csrf).send({}).expect(404);
    await q(`UPDATE administrator_profiles SET site_ids = $2 WHERE user_id = $1`, [s.id, [base.workplaceId]]);
    await sup.agent.post(`/api/v1/devices/${d.id}/approve`).set('X-CSRF-Token', sup.csrf).send({}).expect(200);
  });
});

describe('client addresses behind a proxy', () => {
  const seenIp = async (trust: typeof config.trustProxy, forwarded: string) => {
    const before = config.trustProxy;
    config.trustProxy = trust;
    try {
      const a = createApp();
      const email = (await createEmployee({ workplaceId: base.workplaceId })).email;
      await request(a).post('/api/v1/auth/login').set('X-Forwarded-For', forwarded).send({ email, password: PASSWORD, client: 'mobile' }).expect(200);
      const row = await one(`SELECT l.ip FROM audit_logs l JOIN users u ON u.id = l.resource_id::uuid WHERE l.action = 'auth.login' AND u.email = $1`, [email]);
      return row.ip as string;
    } finally {
      config.trustProxy = before;
    }
  };

  it('parses TRUST_PROXY into what Express needs (the old code passed "1" as an address)', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('10.0.0.1, 10.0.0.0/8')).toEqual(['10.0.0.1', '10.0.0.0/8']);
    expect(parseTrustProxy('loopback')).toEqual(['loopback']);
  });

  it('takes the address the one trusted proxy saw, ignoring anything the client added', async () => {
    expect(await seenIp(1, '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('ignores the header altogether when no proxy is trusted', async () => {
    expect(await seenIp(false, '6.6.6.6')).not.toBe('6.6.6.6');
  });

  it('ignores the header from a connection that is not a listed proxy', async () => {
    expect(await seenIp(['10.9.9.9'], '6.6.6.6')).not.toBe('6.6.6.6');
  });
});

describe('sign-in', () => {
  const attempt = (email: string, password: string) => request(app).post('/api/v1/auth/login').send({ email, password, client: 'mobile' });

  it('locks after repeated failures without confirming the account, and records it', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    for (let i = 0; i < 8; i++) await attempt(emp.email, 'wrong-password-1').expect(401);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'auth.locked' AND resource_id = $1`, [emp.id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'auth.login_failed' AND resource_id = $1`, [emp.id])).toHaveLength(7);
    await attempt(emp.email, 'wrong-password-1').expect(401); // not 423: a wrong guess learns nothing
    expect((await attempt(emp.email, PASSWORD).expect(423)).body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('cannot be kept locked by one guess after each expiry', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    await q(`UPDATE users SET failed_login_count = 8, locked_until = now() - interval '1 minute' WHERE id = $1`, [emp.id]);
    await attempt(emp.email, 'wrong-password-1').expect(401);
    expect(await one(`SELECT failed_login_count, locked_until FROM users WHERE id = $1`, [emp.id])).toEqual({ failed_login_count: 1, locked_until: null });
    await attempt(emp.email, PASSWORD).expect(200);
  });

  it('holds a temporary password to changing it before anything else is written', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    await q(`UPDATE users SET must_change_password = true WHERE id = $1`, [emp.id]);
    const token = await mobileLogin(app, emp.email);
    const res = await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: base.shiftId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await request(app).get('/api/v1/auth/me').set(bearer(token)).expect(200);
    await request(app).post('/api/v1/auth/change-password').set(bearer(token)).send({ currentPassword: PASSWORD, newPassword: 'New-password-123' }).expect(200);
    expect((await one(`SELECT must_change_password FROM users WHERE id = $1`, [emp.id])).must_change_password).toBe(false);
  });

  it('upgrades an old password hash at sign-in', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const crypto2 = await import('node:crypto');
    const salt = crypto2.randomBytes(16);
    const old = crypto2.scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [emp.id, `scrypt$16384$8$1$${salt.toString('base64')}$${old.toString('base64')}`]);
    await attempt(emp.email, PASSWORD).expect(200);
    expect((await one(`SELECT password_hash FROM users WHERE id = $1`, [emp.id])).password_hash).not.toContain('scrypt$16384$8$1$');
  });
});

describe('refresh tokens', () => {
  const login = async (email: string) => (await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD, client: 'mobile' }).expect(200)).body.refreshToken as string;
  const refresh = (refreshToken: string) => request(app).post('/api/v1/auth/refresh').send({ refreshToken });

  it('survives a retry after a lost response', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await login(emp.email);
    const first = (await refresh(token).expect(200)).body;
    const retry = (await refresh(token).expect(200)).body; // the phone never received `first`
    await refresh(retry.refreshToken).expect(200);
    expect(first.refreshToken).not.toBe(retry.refreshToken);
  });

  it('treats re-use after the grace period as theft: the family dies and it is audited', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await login(emp.email);
    const next = (await refresh(token).expect(200)).body.refreshToken;
    await q(`UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE user_id = $1 AND revoked_at IS NOT NULL`, [emp.id]);
    await refresh(token).expect(401);
    await refresh(next).expect(401);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'auth.refresh_reuse' AND resource_id = $1`, [emp.id])).toHaveLength(1);
  });

  it('never revives a token ended by sign-out', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await login(emp.email);
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: token }).expect(200);
    await refresh(token).expect(401);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'auth.logout' AND resource_id = $1`, [emp.id])).toHaveLength(1);
  });

  it('survives two refreshes at the same moment without an error', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await login(emp.email);
    const [a, b] = await Promise.all([refresh(token), refresh(token)]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});

describe('other findings', () => {
  it('accepts only browser push services as web-push addresses', async () => {
    expect(isPushService('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isPushService('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushService('https://web.push.apple.com/abc')).toBe(true);
    for (const bad of ['https://169.254.169.254/latest', 'https://internal.service:8443/x', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.test/x', 'https://localhost/x']) expect(isPushService(bad)).toBe(false);
    const res = await post('/notifications/web-push/subscriptions', { endpoint: 'https://10.0.0.5/hook', keys: { p256dh: 'a', auth: 'b' } });
    expect(res.status).toBe(400);
  });

  it('does not let someone take over another person’s push subscription', async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    await q(`INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh, auth) SELECT id, $1, 'a', 'b' FROM users WHERE role = 'ADMIN' AND id <> $2 LIMIT 1`, [endpoint, base.adminId]);
    const other = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) SELECT $1, password_hash, 'ADMIN', 'Other', org_id FROM users WHERE id = $2 RETURNING id`, [`o-${crypto.randomUUID()}@test.local`, base.adminId]);
    await q(`INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,'a','b') ON CONFLICT (endpoint) DO NOTHING`, [other.id, endpoint]);
    const holder = (await one(`SELECT user_id FROM web_push_subscriptions WHERE endpoint = $1`, [endpoint])).user_id;
    await post('/notifications/web-push/subscriptions', { endpoint, keys: { p256dh: 'x', auth: 'y' } }).expect(200);
    expect((await one(`SELECT user_id FROM web_push_subscriptions WHERE endpoint = $1`, [endpoint])).user_id).toBe(holder);
  });

  it('limits test summaries, which send real messages', async () => {
    await post('/digest/test').expect(200);
    expect((await post('/digest/test').expect(429)).body.error.code).toBe('RATE_LIMITED');
  });

  it('closes a live stream when its user is deactivated', async () => {
    const s = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) SELECT $1, password_hash, 'ADMIN', 'Stream', org_id FROM users WHERE id = $2 RETURNING id`, [`s-${crypto.randomUUID()}@test.local`, base.adminId]);
    let ended = false;
    const res: any = { on: () => undefined, end: () => { ended = true; }, write: () => true };
    addClient(res, DEFAULT_ORG_ID, null, s.id);
    await recheckClients();
    expect(ended).toBe(false);
    await q(`UPDATE users SET is_active = false WHERE id = $1`, [s.id]);
    await recheckClients();
    expect(ended).toBe(true);
  });

  it('records views of location history', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const s = await one(`INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at) VALUES ($1,$2,$3,'2026-03-11','2026-03-11T09:00:00Z','2026-03-11T17:00:00Z','SHIFT_COMPLETED','2026-03-11T09:00:00Z') RETURNING id`, [emp.id, base.shiftId, base.workplaceId]);
    await owner.agent.get(`/api/v1/tracking/sessions/${s.id}/timeline`).expect(200);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'location.view' AND resource_id = $1`, [s.id])).toHaveLength(1);
  });

  it('tells outsiders nothing from the health check', async () => {
    expect(Object.keys((await request(app).get('/health').expect(200)).body).sort()).toEqual(['database', 'status']);
  });

  it('does not read an upload body without a valid slot', async () => {
    const res = await request(app).put('/api/v1/storage/upload?token=nonsense').set('Content-Type', 'image/jpeg').send(Buffer.alloc(100));
    expect(res.status).toBe(403);
  });
});

describe('production configuration', () => {
  const good: Record<string, string> = {
    NODE_ENV: 'production',
    JWT_SECRET: 'k3Vq9xPz1LmT7wRb2YcN8dFh4JsG6aUe0QoZ',
    STORAGE_SIGNING_KEY: 'Yt5Rn2Kd8WqB3vLx7PzH1cMf9SgJ4aEu6ToI',
    DATABASE_URL: 'postgresql://geoattend:Str0ngPass@db.internal:5432/geoattend?sslmode=require',
    PUBLIC_API_URL: 'https://api.geoattend.in',
    DASHBOARD_URL: 'https://app.geoattend.in',
    CORS_ORIGINS: 'https://app.geoattend.in',
    TRUST_PROXY: '1',
    COOKIE_SECURE: 'true',
    DEMO_MODE: 'false',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'geoattend-photos',
  };
  const errors = (over: Record<string, string | undefined>) => productionConfigErrors({ ...good, ...over });

  it('accepts a complete production environment', () => {
    expect(productionConfigErrors(good)).toEqual([]);
  });

  it('rejects the placeholders shipped in .env.example, which are long enough to pass a length check', () => {
    expect(errors({ JWT_SECRET: 'change-me-at-least-32-characters-long-random' }).join()).toContain('JWT_SECRET is still a placeholder');
    expect(errors({ STORAGE_SIGNING_KEY: 'change-me-at-least-32-characters-long-random' }).join()).toContain('STORAGE_SIGNING_KEY is still a placeholder');
  });

  it.each([
    [{ JWT_SECRET: 'short' }, 'JWT_SECRET must be at least 32'],
    [{ STORAGE_SIGNING_KEY: good.JWT_SECRET }, 'must be different'],
    [{ DATABASE_URL: '' }, 'DATABASE_URL is required'],
    [{ DATABASE_URL: 'postgresql://u:change-me@db/x' }, 'DATABASE_URL still contains'],
    [{ PUBLIC_API_URL: '' }, 'PUBLIC_API_URL'],
    [{ PUBLIC_API_URL: 'http://localhost:4400' }, 'PUBLIC_API_URL'],
    [{ DASHBOARD_URL: 'http://localhost:3400' }, 'DASHBOARD_URL'],
    [{ DASHBOARD_URL: 'https://app.example.com' }, 'DASHBOARD_URL'],
    [{ CORS_ORIGINS: 'http://localhost:3400' }, 'CORS_ORIGINS'],
    [{ TRUST_PROXY: '' }, 'TRUST_PROXY is required'],
    [{ TRUST_PROXY: 'true' }, 'TRUST_PROXY=true'],
    [{ COOKIE_SECURE: 'false' }, 'COOKIE_SECURE'],
    [{ DEMO_MODE: 'true' }, 'DEMO_MODE'],
    [{ PAYROLL_ENABLED: 'true' }, 'PAYROLL_ENABLED'],
    [{ STORAGE_DRIVER: 'local' }, 'STORAGE_DRIVER'],
    [{ S3_BUCKET: '' }, 'S3_BUCKET'],
    [{ S3_ACCESS_KEY_ID: 'abc' }, 'set together'],
    [{ S3_ENDPOINT: 'http://minio:9000' }, 'S3_PUBLIC_ENDPOINT'],
  ])('rejects %j', (over, message) => {
    expect(errors(over as Record<string, string>).join(' ')).toContain(message);
  });
});
