/**
 * Multi-company accounts (migration 032): platform super administrators, company status and subscriptions,
 * edition limits and modules, invitations, password resets, session management and session expiry.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { SignJWT } from 'jose';
import { asSystem, one, q, withOrg } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';
import { invalidatePlatformSettings } from '../src/lib/company.js';
import { testOutbox } from '../src/lib/account-tokens.js';
import { adminAgent, createEmployee, createTestDatabase, mobileLogin, PASSWORD, seedBase, testSettings } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
type Agent = { agent: ReturnType<typeof request.agent>; csrf: string };

const uid = () => crypto.randomBytes(4).toString('hex');
const today = () => DateTime.utc().toISODate()!;
const days = (n: number) => DateTime.utc().plus({ days: n }).toISODate()!;
const tokenFrom = (to: string) => {
  const m = [...testOutbox].reverse().find((x) => x.to.toLowerCase() === to.toLowerCase());
  return m?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1] ?? null;
};

async function platformAdmin(opts: { mustChange?: boolean } = {}) {
  const email = `platform-${uid()}@geoattend.test`;
  const a = await one(`INSERT INTO platform_admins (email, password_hash, full_name, must_change_password) VALUES ($1, $2, 'Platform Admin', $3) RETURNING id`, [email, await hashPassword(PASSWORD), opts.mustChange ?? false]);
  return { id: a.id as string, email };
}

async function platformAgent(email: string): Promise<Agent> {
  const agent = request.agent(app);
  const r = await agent.post('/api/v1/platform/auth/login').send({ email, password: PASSWORD }).expect(200);
  return { agent, csrf: r.body.csrfToken };
}

const send = (a: Agent, method: 'post' | 'put' | 'patch', url: string, body: unknown = {}) => (a.agent as any)[method](url).set('X-CSRF-Token', a.csrf).send(body);

let P: Agent;

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp();
  P = await platformAgent((await platformAdmin()).email);
});
afterAll(async () => {
  await db.drop();
});

/** A company created by the platform, with its invited owner signed in. */
async function companyViaPlatform(editionCode = 'STARTER', extra: Record<string, unknown> = {}) {
  const ownerEmail = `owner-${uid()}@company.test`;
  const r = await send(P, 'post', '/api/v1/platform/companies', { name: `Company ${uid()}`, editionCode, owner: { fullName: 'First Owner', email: ownerEmail }, ...extra }).expect(201);
  const orgId = r.body.company.id as string;
  await testSettings(orgId);
  const token = tokenFrom(ownerEmail)!;
  await request(app).post('/api/v1/auth/accept-invitation').send({ token, password: PASSWORD }).expect(200);
  const owner = await adminAgent(app, ownerEmail);
  return { orgId, ownerEmail, owner, created: r.body };
}

describe('platform super administrators sign in on their own', () => {
  it('refuses a wrong password and an unknown address with the same answer, and locks after five failures', async () => {
    const a = await platformAdmin();
    const wrong = await request(app).post('/api/v1/platform/auth/login').send({ email: a.email, password: 'Wrong-password-1' }).expect(401);
    const unknown = await request(app).post('/api/v1/platform/auth/login').send({ email: `nobody-${uid()}@x.test`, password: 'Wrong-password-1' }).expect(401);
    expect(wrong.body).toEqual(unknown.body);
    for (let i = 0; i < 4; i++) await request(app).post('/api/v1/platform/auth/login').send({ email: a.email, password: 'Wrong-password-1' }).expect(401);
    const locked = await request(app).post('/api/v1/platform/auth/login').send({ email: a.email, password: PASSWORD }).expect(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('on a temporary password can do nothing but change it', async () => {
    const a = await platformAdmin({ mustChange: true });
    const s = await platformAgent(a.email);
    expect((await s.agent.get('/api/v1/platform/auth/me').expect(200)).body.admin.mustChangePassword).toBe(true);
    const blocked = await send(s, 'put', '/api/v1/platform/settings', { support: { email: null, phone: null } }).expect(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await send(s, 'post', '/api/v1/platform/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Another-password-42' }).expect(200);
    s.csrf = changed.body.csrfToken;
    await send(s, 'put', '/api/v1/platform/settings', { support: { email: 'help@geoattend.test', phone: null } }).expect(200);
  });

  it('needs the CSRF token for changes made with its cookie', async () => {
    await P.agent.put('/api/v1/platform/settings').send({ support: { email: null, phone: null } }).expect(403);
  });

  it('rotates its session; a rotated token used again ends that sign-in', async () => {
    const a = await platformAdmin();
    const s = await platformAgent(a.email);
    const first = (await one(`SELECT token_hash FROM platform_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE a.email = $1 AND revoked_at IS NULL`, [a.email])).token_hash;
    const cookieOf = (res: any) => (res.headers['set-cookie'] as string[]).find((c) => c.startsWith('ga_prt='))!.split(';')[0]!;
    const login = await request(app).post('/api/v1/platform/auth/login').send({ email: a.email, password: PASSWORD }).expect(200);
    const old = cookieOf(login);
    const rotated = await request(app).post('/api/v1/platform/auth/refresh').set('Cookie', old).expect(200);
    const fresh = cookieOf(rotated);
    // The old token again: refused, and the fresh one of the same sign-in dies with it.
    await request(app).post('/api/v1/platform/auth/refresh').set('Cookie', old).expect(401);
    await request(app).post('/api/v1/platform/auth/refresh').set('Cookie', fresh).expect(401);
    expect(first).toBeTruthy();
    await s.agent.get('/api/v1/platform/auth/me').expect(200); // a separate sign-in is unaffected
  });

  it('ends a sign-in at its absolute limit, however active', async () => {
    const a = await platformAdmin();
    const login = await request(app).post('/api/v1/platform/auth/login').send({ email: a.email, password: PASSWORD }).expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ga_prt='))!.split(';')[0]!;
    await q(`UPDATE platform_sessions SET family_expires_at = now() - interval '1 second' WHERE admin_id = $1`, [a.id]);
    await request(app).post('/api/v1/platform/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('a deactivated administrator is refused at once', async () => {
    const a = await platformAdmin();
    const s = await platformAgent(a.email);
    await q('UPDATE platform_admins SET is_active = false WHERE id = $1', [a.id]);
    await s.agent.get('/api/v1/platform/auth/me').expect(401);
  });

  it('platform and company tokens are not interchangeable', async () => {
    const base = await seedBase(undefined, `owner-${uid()}@default.test`);
    const owner = await adminAgent(app, base.adminEmail);
    // A company owner has no way into the platform API.
    await owner.agent.get('/api/v1/platform/overview').expect(401);
    await owner.agent.get('/api/v1/platform/companies').expect(401);
    // A platform administrator is not a member of any company.
    await P.agent.get('/api/v1/employees').expect(401);
    await P.agent.get('/api/v1/auth/me').expect(401);
    // A company access token presented as a bearer token to the platform is refused, and the other way round.
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    const t = await mobileLogin(app, emp.email);
    await request(app).get('/api/v1/platform/overview').set('Authorization', `Bearer ${t}`).expect(401);
    const pt = await new SignJWT({ typ: 'platform' }).setProtectedHeader({ alg: 'HS256' }).setSubject(emp.id).setIssuer('geoattend').setAudience('geoattend-platform').setExpirationTime('5m').sign(new TextEncoder().encode(config.jwtSecret));
    await request(app).get('/api/v1/platform/overview').set('Authorization', `Bearer ${pt}`).expect(401); // signed with the company key: wrong key
  });
});

describe('the platform creates and runs companies', () => {
  it('creates a company with its edition and an invited owner, who chooses a password and signs in', async () => {
    const ownerEmail = `owner-${uid()}@new.test`;
    const r = await send(P, 'post', '/api/v1/platform/companies', {
      name: 'Acme Logistics',
      registration: { legalName: 'Acme Logistics Pvt Ltd', registrationNumber: 'U12345KA2026PTC000001', taxId: '29ABCDE1234F1Z5', city: 'Bengaluru', country: 'India' },
      editionCode: 'PROFESSIONAL',
      subscription: { status: 'TRIAL', durationDays: 30 },
      owner: { fullName: 'Asha Owner', email: ownerEmail },
    }).expect(201);
    expect(r.body.company).toMatchObject({ status: 'ACTIVE', edition: { code: 'PROFESSIONAL' }, limits: { employees: 200, supervisors: 10 }, features: { announcements: true, payroll: false }, registrationSource: 'PLATFORM' });
    expect(r.body.company.subscription).toMatchObject({ status: 'TRIAL', startsOn: today(), endsOn: days(29) });
    expect(r.body.owner.invitation.emailed).toBe(true);
    expect(r.body.owner.invitation.url).toContain('/accept-invite#token=');
    expect(r.body.owner.temporaryPassword).toBeUndefined();

    // Before accepting there is no password anyone knows.
    await request(app).post('/api/v1/auth/login').send({ email: ownerEmail, password: PASSWORD, client: 'web' }).expect(401);
    const token = tokenFrom(ownerEmail)!;
    const info = await request(app).post('/api/v1/auth/invitation').send({ token }).expect(200);
    expect(info.body).toMatchObject({ email: ownerEmail, company: 'Acme Logistics', role: 'OWNER' });
    await request(app).post('/api/v1/auth/accept-invitation').send({ token, password: 'short' }).expect(400);
    await request(app).post('/api/v1/auth/accept-invitation').send({ token, password: PASSWORD }).expect(200);
    // The link works once.
    expect((await request(app).post('/api/v1/auth/accept-invitation').send({ token, password: PASSWORD }).expect(400)).body.error.code).toBe('LINK_INVALID');
    const login = await request(app).post('/api/v1/auth/login').send({ email: ownerEmail, password: PASSWORD, client: 'web' }).expect(200);
    expect(login.body.user.mustChangePassword).toBe(false);

    const detail = await P.agent.get(`/api/v1/platform/companies/${r.body.company.id}`).expect(200);
    expect(detail.body.company.registration).toMatchObject({ legalName: 'Acme Logistics Pvt Ltd', taxId: '29ABCDE1234F1Z5' });
    expect(detail.body.owners).toHaveLength(1);
    expect(detail.body.history.map((h: any) => h.action)).toContain('platform.company.create');
    const list = await P.agent.get('/api/v1/platform/companies?search=Acme').expect(200);
    expect(list.body.companies.map((c: any) => c.id)).toContain(r.body.company.id);
    // The company's own audit log records what the platform did to it.
    expect(await one(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND action = 'platform.company.create'`, [r.body.company.id])).toBeTruthy();
  });

  it('an invitation that expired, or was replaced by a newer one, no longer works', async () => {
    const { orgId } = await companyViaPlatform();
    const email = `owner2-${uid()}@company.test`;
    const added = await send(P, 'post', `/api/v1/platform/companies/${orgId}/owners`, { fullName: 'Second Owner', email }).expect(201);
    const first = tokenFrom(email)!;
    await send(P, 'post', `/api/v1/platform/companies/${orgId}/owners/${added.body.owner.id}/invitation`).expect(200);
    const second = tokenFrom(email)!;
    expect(second).not.toBe(first);
    await request(app).post('/api/v1/auth/invitation').send({ token: first }).expect(400);
    await q(`UPDATE account_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [added.body.owner.id]);
    await request(app).post('/api/v1/auth/accept-invitation').send({ token: second, password: PASSWORD }).expect(400);
  });

  it('a company cannot change its own status, edition or subscription, even with its own database login', async () => {
    const { orgId, owner } = await companyViaPlatform();
    for (const sql of [`UPDATE organizations SET status = 'ACTIVE', status_reason = 'x'`, `UPDATE organizations SET edition_code = 'ENTERPRISE'`, `UPDATE organizations SET employee_limit = NULL`, `UPDATE organizations SET subscription_ends_on = '2099-12-31'`, `UPDATE organizations SET features = '{"payroll": true}'`]) {
      await expect(withOrg(orgId, () => q(sql)), sql).rejects.toMatchObject({ code: '42501' });
    }
    // Its name stays its own to change.
    await send(owner, 'patch', '/api/v1/organization', { name: 'Renamed by its owner' }).expect(200);
    // Platform tables are out of reach of the company login altogether.
    for (const t of ['platform_admins', 'platform_sessions', 'platform_settings', 'platform_audit_logs', 'editions']) await expect(withOrg(orgId, () => q(`SELECT 1 FROM ${t}`))).rejects.toMatchObject({ code: '42501' });
  });

  it('edits registration details and edition defaults without touching companies already on the edition', async () => {
    const { orgId } = await companyViaPlatform('STARTER');
    await send(P, 'patch', `/api/v1/platform/companies/${orgId}`, { registration: { legalName: 'Edited Legal Name', city: 'Pune' } }).expect(200);
    const e = await send(P, 'patch', '/api/v1/platform/editions/STARTER', { employeeLimit: 30 }).expect(200);
    expect(e.body.limits.employees).toBe(30);
    const c = (await P.agent.get(`/api/v1/platform/companies/${orgId}`).expect(200)).body.company;
    expect(c.registration).toEqual({ legalName: 'Edited Legal Name', city: 'Pune' });
    expect(c.limits.employees).toBe(25);
    await send(P, 'patch', '/api/v1/platform/editions/STARTER', { employeeLimit: 25 }).expect(200);
  });
});

describe('subscription restrictions', () => {
  it('stops adding employees and supervisors at the limit, and lets nothing past it', async () => {
    const { orgId, owner } = await companyViaPlatform('STARTER');
    await send(P, 'put', `/api/v1/platform/companies/${orgId}/subscription`, { employeeLimit: 2, supervisorLimit: 1 }).expect(200);
    const wp = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Site', 12.97, 77.59, 50, 'UTC', $1) RETURNING id`, [orgId]);
    const add = (n: string) => send(owner, 'post', '/api/v1/employees', { fullName: `Worker ${n}`, email: `w${n}-${uid()}@company.test`, employeeCode: `C-${n}-${uid()}` });
    await add('1').expect(201);
    const second = await add('2').expect(201);
    const third = await add('3').expect(403);
    expect(third.body.error).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { kind: 'employee', limit: 2, used: 2 } });
    const imported = await send(owner, 'post', '/api/v1/employees/import', { rows: [{ fullName: 'Imp', email: `imp-${uid()}@company.test`, employeeCode: `I-${uid()}` }] }).expect(200);
    expect(imported.body).toMatchObject({ created: 0, failed: 1 });
    // Freeing a place makes room; reactivating someone at the limit does not.
    await send(owner, 'post', `/api/v1/employees/${second.body.employee.id}/deactivate`, { reason: 'Left the company' }).expect(200);
    await add('4').expect(201);
    expect((await send(owner, 'post', `/api/v1/employees/${second.body.employee.id}/reactivate`).expect(403)).body.error.code).toBe('PLAN_LIMIT_REACHED');

    await send(owner, 'post', '/api/v1/team', { fullName: 'Sup One', email: `s1-${uid()}@company.test`, access: 'SUPERVISOR', siteIds: [wp.id] }).expect(201);
    const sup2 = await send(owner, 'post', '/api/v1/team', { fullName: 'Sup Two', email: `s2-${uid()}@company.test`, access: 'SUPERVISOR', siteIds: [wp.id] }).expect(403);
    expect(sup2.body.error.code).toBe('PLAN_LIMIT_REACHED');
    // Owners are not counted: another can always be added.
    await send(owner, 'post', '/api/v1/team', { fullName: 'Owner Two', email: `o2-${uid()}@company.test`, access: 'OWNER' }).expect(201);
    // Lowering a limit below what is in use deactivates nobody.
    const lowered = await send(P, 'put', `/api/v1/platform/companies/${orgId}/subscription`, { employeeLimit: 1 }).expect(200);
    expect(lowered.body.warnings.join(' ')).toMatch(/2 employees are active/);
    expect((await owner.agent.get('/api/v1/employees').expect(200)).body).toHaveLength(2);
  });

  it('keeps an optional module closed to administrators until the plan includes it', async () => {
    const { orgId, owner } = await companyViaPlatform('STARTER');
    const me = (await owner.agent.get('/api/v1/auth/me').expect(200)).body;
    expect(me.features).toEqual({ announcements: false, tasks: false, overtime: false, payroll: false });
    expect(me.plan).toMatchObject({ edition: { code: 'STARTER' }, limits: { employees: 25, supervisors: 2 }, usage: { employees: 0 } });
    for (const url of ['/api/v1/broadcasts', '/api/v1/tasks', '/api/v1/overtime']) {
      expect((await owner.agent.get(url).expect(403)).body.error.code, url).toBe('FEATURE_NOT_IN_PLAN');
    }
    await send(P, 'put', `/api/v1/platform/companies/${orgId}/subscription`, { features: { announcements: true } }).expect(200);
    await owner.agent.get('/api/v1/broadcasts').expect(200);
    await owner.agent.get('/api/v1/tasks').expect(403);
    // Moving to Enterprise brings its modules (payroll still also needs the server switch).
    await send(P, 'put', `/api/v1/platform/companies/${orgId}/subscription`, { editionCode: 'ENTERPRISE' }).expect(200);
    await owner.agent.get('/api/v1/tasks').expect(200);
    expect((await owner.agent.get('/api/v1/auth/me').expect(200)).body.plan.limits).toEqual({ employees: null, supervisors: null });
  });

  it('after the grace period administrators can read and export but not change; employees keep recording; nothing is removed', async () => {
    const { orgId, owner } = await companyViaPlatform('STARTER');
    const base = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Site', 12.97, 77.59, 50, 'UTC', $1) RETURNING id`, [orgId]);
    const shift = await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week) VALUES ($1, 'Day', '00:00', '23:59', 'UTC', '{1,2,3,4,5,6,7}') RETURNING id`, [base.id]);
    const emp = await createEmployee({ workplaceId: base.id, shiftId: shift.id, orgId });

    // Inside the grace period: still fully working, with a warning state.
    await send(P, 'put', `/api/v1/platform/companies/${orgId}/subscription`, { endsOn: days(-3), startsOn: days(-40) }).expect(200);
    expect((await owner.agent.get('/api/v1/auth/me').expect(200)).body.plan.subscription).toMatchObject({ state: 'GRACE', readOnly: false, daysLeft: -3 });
    await send(owner, 'post', '/api/v1/holidays', { date: days(20), name: 'Grace holiday' }).expect(201);

    // Past it: read-only for administrators.
    await send(P, 'put', `/api/v1/platform/companies/${orgId}/subscription`, { endsOn: days(-30) }).expect(200);
    const me = (await owner.agent.get('/api/v1/auth/me').expect(200)).body;
    expect(me.plan.subscription).toMatchObject({ state: 'EXPIRED', readOnly: true });
    expect((await owner.agent.get('/api/v1/employees').expect(200)).body.map((e: any) => e.id)).toContain(emp.id);
    await owner.agent.get(`/api/v1/reports/hours.csv?from=${days(-7)}&to=${today()}`).expect(200);
    const blocked = await send(owner, 'post', '/api/v1/employees', { fullName: 'New', email: `n-${uid()}@company.test`, employeeCode: `N-${uid()}` }).expect(403);
    expect(blocked.body.error.code).toBe('SUBSCRIPTION_EXPIRED');
    // Their own password stays theirs to change.
    await send(owner, 'post', '/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD }).expect(200);
    // The employee still signs in and records.
    const t = await mobileLogin(app, emp.email);
    await request(app).post('/api/v1/leave/mine').set('Authorization', `Bearer ${t}`).send({ leaveType: 'SICK', startDate: days(5), endDate: days(5), reason: 'Unwell' }).expect(201);

    // Renewal restores everything at once.
    const renewed = await send(P, 'post', `/api/v1/platform/companies/${orgId}/renew`, { durationDays: 365 }).expect(200);
    expect(renewed.body.subscription).toMatchObject({ status: 'ACTIVE', state: 'ACTIVE', readOnly: false });
    const fresh = await adminAgent(app, (await one(`SELECT u.email FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.org_id = $1 AND ap.access = 'OWNER' LIMIT 1`, [orgId])).email);
    await send(fresh, 'post', '/api/v1/employees', { fullName: 'After renewal', email: `ar-${uid()}@company.test`, employeeCode: `AR-${uid()}` }).expect(201);
  });

  it('lists the subscriptions that need attention', async () => {
    const { orgId } = await companyViaPlatform('STARTER');
    await send(P, 'put', `/api/v1/platform/companies/${orgId}/subscription`, { endsOn: days(5) }).expect(200);
    const o = (await P.agent.get('/api/v1/platform/overview').expect(200)).body;
    expect(o.attention.find((c: any) => c.id === orgId)?.subscription).toMatchObject({ state: 'EXPIRING', daysLeft: 5 });
    const expiring = (await P.agent.get('/api/v1/platform/companies?subscription=EXPIRING').expect(200)).body.companies.map((c: any) => c.id);
    expect(expiring).toContain(orgId);
  });
});

describe('suspension', () => {
  it('closes the company to every account at once, keeps its data, and leaves other companies alone', async () => {
    const { orgId, owner, ownerEmail } = await companyViaPlatform('STARTER');
    const wp = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Site', 12.97, 77.59, 50, 'UTC', $1) RETURNING id`, [orgId]);
    const emp = await createEmployee({ workplaceId: wp.id, orgId });
    const t = await mobileLogin(app, emp.email);
    const refresh = (await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD, client: 'mobile' }).expect(200)).body.refreshToken;
    const other = await companyViaPlatform('STARTER');
    const before = await asSystem(() => one(`SELECT count(*)::int AS n FROM users WHERE org_id = $1`, [orgId]));

    await send(P, 'post', `/api/v1/platform/companies/${orgId}/status`, { status: 'SUSPENDED' }).expect(400); // a reason is required
    await send(P, 'post', `/api/v1/platform/companies/${orgId}/status`, { status: 'SUSPENDED', reason: 'Unpaid invoice' }).expect(200);
    expect((await owner.agent.get('/api/v1/employees').expect(403)).body.error.code).toBe('COMPANY_SUSPENDED');
    expect((await request(app).get('/api/v1/me/assignment').set('Authorization', `Bearer ${t}`)).body.error?.code).toBe('COMPANY_SUSPENDED');
    expect((await request(app).post('/api/v1/auth/login').send({ email: ownerEmail, password: PASSWORD, client: 'web' }).expect(403)).body.error.code).toBe('COMPANY_SUSPENDED');
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: refresh }).expect(401);
    // No reset link is sent to a suspended company's account.
    const sent = testOutbox.length;
    await request(app).post('/api/v1/auth/forgot-password').send({ email: ownerEmail }).expect(202);
    expect(testOutbox.length).toBe(sent);
    await other.owner.agent.get('/api/v1/employees').expect(200);

    await send(P, 'post', `/api/v1/platform/companies/${orgId}/status`, { status: 'ACTIVE', reason: 'Paid' }).expect(200);
    await request(app).post('/api/v1/auth/login').send({ email: ownerEmail, password: PASSWORD, client: 'web' }).expect(200);
    expect(await asSystem(() => one(`SELECT count(*)::int AS n FROM users WHERE org_id = $1`, [orgId]))).toEqual(before);
  });
});

describe('passwords, invitations and sessions for company accounts', () => {
  it('a forgotten password: the same answer for any address, a one-time link, and every old sign-in ends', async () => {
    const { ownerEmail } = await companyViaPlatform();
    const sent = testOutbox.length;
    const unknown = await request(app).post('/api/v1/auth/forgot-password').send({ email: `nobody-${uid()}@x.test` }).expect(202);
    expect(testOutbox.length).toBe(sent);
    const known = await request(app).post('/api/v1/auth/forgot-password').send({ email: ownerEmail.toUpperCase() }).expect(202);
    expect(known.body).toEqual(unknown.body);
    const token = tokenFrom(ownerEmail)!;
    expect(token).toBeTruthy();
    const oldRefresh = (await request(app).post('/api/v1/auth/login').send({ email: ownerEmail, password: PASSWORD, client: 'web' }).expect(200)).headers['set-cookie'] as unknown as string[];
    const rt = oldRefresh.find((c) => c.startsWith('ga_rt='))!.split(';')[0]!;
    await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'weak' }).expect(400);
    await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'Brand-new-password-7' }).expect(200);
    await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'Brand-new-password-8' }).expect(400);
    await request(app).post('/api/v1/auth/login').send({ email: ownerEmail, password: PASSWORD, client: 'web' }).expect(401);
    await request(app).post('/api/v1/auth/login').send({ email: ownerEmail, password: 'Brand-new-password-7', client: 'web' }).expect(200);
    await request(app).post('/api/v1/auth/refresh').set('Cookie', rt).send({}).expect(401);
    // An expired link is refused.
    await request(app).post('/api/v1/auth/forgot-password').send({ email: ownerEmail }).expect(202);
    const t2 = tokenFrom(ownerEmail)!;
    await q(`UPDATE account_tokens SET expires_at = now() - interval '1 second' WHERE purpose = 'PASSWORD_RESET' AND used_at IS NULL`);
    await request(app).post('/api/v1/auth/reset-password').send({ token: t2, newPassword: 'Brand-new-password-9' }).expect(400);
  });

  it('an owner invites a supervisor and an employee; each chooses their own password; employees use the phone app', async () => {
    const { orgId, owner } = await companyViaPlatform('PROFESSIONAL');
    const wp = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Site', 12.97, 77.59, 50, 'UTC', $1) RETURNING id`, [orgId]);
    const supEmail = `sup-${uid()}@company.test`;
    const s = await send(owner, 'post', '/api/v1/team', { fullName: 'Invited Sup', email: supEmail, access: 'SUPERVISOR', siteIds: [wp.id], delivery: 'invitation' }).expect(201);
    expect(s.body.temporaryPassword).toBeUndefined();
    expect(s.body.invitation).toMatchObject({ emailed: true });
    expect((await request(app).post('/api/v1/auth/invitation').send({ token: tokenFrom(supEmail) }).expect(200)).body.role).toBe('SUPERVISOR');
    await request(app).post('/api/v1/auth/accept-invitation').send({ token: tokenFrom(supEmail), password: PASSWORD }).expect(200);
    await request(app).post('/api/v1/auth/login').send({ email: supEmail, password: PASSWORD, client: 'web' }).expect(200);

    const empEmail = `emp-${uid()}@company.test`;
    const e = await send(owner, 'post', '/api/v1/employees', { fullName: 'Invited Emp', email: empEmail, employeeCode: `E-${uid()}`, workplaceId: wp.id, delivery: 'invitation' }).expect(201);
    // Sent again: the first link stops working.
    const first = tokenFrom(empEmail)!;
    await send(owner, 'post', `/api/v1/employees/${e.body.employee.id}/invitation`).expect(200);
    await request(app).post('/api/v1/auth/invitation').send({ token: first }).expect(400);
    const accepted = await request(app).post('/api/v1/auth/accept-invitation').send({ token: tokenFrom(empEmail), password: PASSWORD }).expect(200);
    expect(accepted.body.role).toBe('EMPLOYEE');
    await request(app).post('/api/v1/auth/login').send({ email: empEmail, password: PASSWORD, client: 'web' }).expect(403); // WRONG_APP
    await request(app).post('/api/v1/auth/login').send({ email: empEmail, password: PASSWORD, client: 'mobile' }).expect(200);
    // Once signed in, a new invitation is not the way back in.
    expect((await send(owner, 'post', `/api/v1/employees/${e.body.employee.id}/invitation`).expect(409)).body.error.code).toBe('ALREADY_SIGNED_IN');
  });

  it('a supervisor cannot invite, and another company\'s employee cannot be invited', async () => {
    const a = await companyViaPlatform('PROFESSIONAL');
    const b = await companyViaPlatform('PROFESSIONAL');
    const wp = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Site', 12.97, 77.59, 50, 'UTC', $1) RETURNING id`, [a.orgId]);
    const emp = await createEmployee({ workplaceId: wp.id, orgId: a.orgId });
    expect((await send(b.owner, 'post', `/api/v1/employees/${emp.id}/invitation`).expect(404)).body.error.code).toBe('NOT_FOUND');
    const supEmail = `sup-${uid()}@company.test`;
    await send(a.owner, 'post', '/api/v1/team', { fullName: 'Sup', email: supEmail, access: 'SUPERVISOR', siteIds: [wp.id], delivery: 'invitation' }).expect(201);
    await request(app).post('/api/v1/auth/accept-invitation').send({ token: tokenFrom(supEmail), password: PASSWORD }).expect(200);
    const sup = await adminAgent(app, supEmail);
    await q('UPDATE employee_profiles SET supervisor_id = (SELECT id FROM users WHERE email = $1) WHERE user_id = $2', [supEmail, emp.id]);
    expect((await send(sup, 'post', `/api/v1/employees/${emp.id}/invitation`).expect(403)).body.error.code).toBe('OWNER_ONLY');
  });

  it('lists your sign-ins and signs out the others', async () => {
    const { ownerEmail, owner } = await companyViaPlatform();
    const laptop = await adminAgent(app, ownerEmail);
    const list = (await owner.agent.get('/api/v1/auth/sessions').expect(200)).body;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.filter((s: any) => s.current)).toHaveLength(1);
    const ended = await send(owner, 'post', '/api/v1/auth/sessions/revoke-others').expect(200);
    expect(ended.body.ended).toBeGreaterThanOrEqual(1);
    expect((await owner.agent.get('/api/v1/auth/sessions').expect(200)).body).toHaveLength(1);
    await laptop.agent.post('/api/v1/auth/refresh').send({}).expect(401);
    // Someone else's sign-in cannot be ended from here.
    const other = await companyViaPlatform();
    const theirs = (await other.owner.agent.get('/api/v1/auth/sessions').expect(200)).body[0].id;
    await send(owner, 'post', `/api/v1/auth/sessions/${theirs}/revoke`).expect(404);
    await other.owner.agent.get('/api/v1/auth/me').expect(200);
  });

  it('expired access and refresh tokens are refused', async () => {
    const { orgId } = await companyViaPlatform();
    const wp = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, org_id) VALUES ('Site', 12.97, 77.59, 50, 'UTC', $1) RETURNING id`, [orgId]);
    const emp = await createEmployee({ workplaceId: wp.id, orgId });
    const expired = await new SignJWT({ role: 'EMPLOYEE' }).setProtectedHeader({ alg: 'HS256' }).setSubject(emp.id).setIssuedAt(Math.floor(Date.now() / 1000) - 3600).setIssuer('geoattend').setAudience('geoattend').setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(new TextEncoder().encode(config.jwtSecret));
    expect((await request(app).get('/api/v1/me/assignment').set('Authorization', `Bearer ${expired}`).expect(401)).body.error.code).toBe('TOKEN_EXPIRED');
    const login = (await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD, client: 'mobile' }).expect(200)).body;
    await q(`UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [emp.id]);
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: login.refreshToken }).expect(401);
  });
});

describe('self sign-up follows the platform settings', () => {
  it('starts a self-registered company on a Starter trial, and can be switched off', async () => {
    await send(P, 'put', '/api/v1/platform/settings', { signup: { enabled: true, editionCode: 'STARTER', trialDays: 14 } }).expect(200);
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/signup').send({ companyName: `Self ${uid()}`, fullName: 'Self Owner', email: `self-${uid()}@x.test`, password: PASSWORD }).expect(201);
    const me = (await agent.get('/api/v1/auth/me').expect(200)).body;
    expect(me.plan).toMatchObject({ edition: { code: 'STARTER' }, subscription: { status: 'TRIAL', endsOn: days(14) }, limits: { employees: 25, supervisors: 2 } });
    await send(P, 'put', '/api/v1/platform/settings', { signup: { enabled: false, editionCode: 'STARTER', trialDays: 14 } }).expect(200);
    expect((await request(app).post('/api/v1/auth/signup').send({ companyName: 'Closed', fullName: 'X', email: `closed-${uid()}@x.test`, password: PASSWORD }).expect(403)).body.error.code).toBe('SIGNUP_CLOSED');
    // Back to what the rest of the tests expect.
    await q(`UPDATE platform_settings SET value = '{"enabled": true, "editionCode": "ENTERPRISE", "trialDays": 30}' WHERE key = 'signup'`);
    invalidatePlatformSettings();
  });

  it('every change made on the platform is in its audit log', async () => {
    const log = (await P.agent.get('/api/v1/platform/audit?limit=500').expect(200)).body.map((l: any) => l.action);
    for (const a of ['platform.company.create', 'platform.company.subscription', 'platform.company.suspend', 'platform.company.activate', 'platform.company.renew', 'platform.edition.update', 'platform.settings.update', 'platform.auth.login']) expect(log, a).toContain(a);
    await expect(q(`UPDATE platform_audit_logs SET action = 'x'`)).rejects.toThrow(/append-only/);
  });
});
