/**
 * Company isolation enforced by the database (migration 025), checked underneath the application:
 * these tests run deliberately careless queries as a company and show the database refuses them.
 * test/tenancy.test.ts checks the same boundary from the outside, route by route.
 */
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { asSystem, currentOrg, getPool, one, q, tx, withOrg } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/auth.js';
import { HttpError } from '../src/lib/errors.js';
import { mount, registry, route } from '../src/lib/http.js';
import { adminAgent, createEmployee, createTestDatabase, mobileLogin, PASSWORD, seedBase, testSettings } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;

type Company = Awaited<ReturnType<typeof company>>;
let A: Company;
let B: Company;

/** Tables with no company in them, which requests must not be able to touch at all. */
const NOT_TENANT_DATA = ['schema_migrations'];

async function company(name: string, orgId?: string) {
  const org = orgId ?? (await one(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [name])).id;
  const base = await seedBase(org, `${name.toLowerCase()}-${crypto.randomUUID()}@test.local`);
  await testSettings(org);
  const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId, orgId: org });
  const today = DateTime.utc().toISODate()!;
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at)
     VALUES ($1,$2,$3,$4,now() - interval '1 hour',now() + interval '1 hour','PRESENT',now() - interval '1 hour') RETURNING id`,
    [emp.id, base.shiftId, base.workplaceId, today],
  );
  const photo = await one(`INSERT INTO attendance_photos (employee_id, session_id, object_key, content_type, declared_bytes, status, idempotency_key, upload_expires_at) VALUES ($1,$2,$3,'image/jpeg',100,'ATTACHED',$4,now()) RETURNING id`, [emp.id, s.id, `k/${crypto.randomUUID()}.jpg`, crypto.randomUUID()]);
  const att = await one(
    `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, photo_id)
     VALUES ($1,$2,$3,$4,$5,$6,30,'VERIFIED',$7) RETURNING id`,
    [emp.id, base.workplaceId, base.shiftId, s.id, today, `i-${crypto.randomUUID()}`, photo.id],
  );
  await q(`INSERT INTO session_state_transitions (session_id, to_state, reason, actor) VALUES ($1,'PRESENT','test','SYSTEM')`, [s.id]);
  await q(`INSERT INTO location_updates (session_id, employee_id, client_event_id, latitude, longitude, accuracy_m, client_time, source, distance_m, classification, validation_status, workplace_config_version) VALUES ($1,$2,$3,12.97,77.59,5,now(),'FOREGROUND',1,'INSIDE','EVALUATED',1)`, [s.id, emp.id, crypto.randomUUID()]);
  await q(`INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, org_id) VALUES ($1,'ADMIN','test.seed','test',$2)`, [base.adminId, org]);
  const notification = await one(`INSERT INTO notifications (type, audience, severity, title, body, employee_id, org_id) VALUES ('NO_SHOW','ADMIN','INFO','t','b',$1,$2) RETURNING id`, [emp.id, org]);
  await q(`INSERT INTO notification_reads (notification_id, user_id) VALUES ($1,$2)`, [notification.id, base.adminId]);
  const device = await one(`INSERT INTO device_registrations (user_id, device_id, platform, status) VALUES ($1,$2,'android','APPROVED') RETURNING id`, [emp.id, `dev-${crypto.randomUUID()}`]);
  const run = await one(`INSERT INTO payroll_runs (org_id, month, status, total_net, employees) VALUES ($1,'2020-01','APPROVED',100,1) RETURNING id`, [org]);
  await q(`INSERT INTO payslips (run_id, employee_id, month, net_amount, data) VALUES ($1,$2,'2020-01',100,'{}')`, [run.id, emp.id]);
  await q(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, requested_by) VALUES ($1,'SICK',$2,$2,'Seed leave',$1)`, [emp.id, today]);
  await q(`INSERT INTO holidays (org_id, holiday_date, name) VALUES ($1,$2,'H')`, [org, today]);
  return { ...base, org, emp, sessionId: s.id as string, attendanceId: att.id as string, photoId: photo.id as string, notificationId: notification.id as string, deviceId: device.id as string, today };
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp();
  A = await company('Alpha');
  B = await company('Bravo');
});
afterAll(async () => {
  await db.drop();
});

const allTables = async () => (await q(`SELECT c.relname AS t, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`)) as Array<{ t: string; rls: boolean }>;

describe('how the database is set up', () => {
  it('every table is protected, including any added later', async () => {
    const open = (await allTables()).filter((x) => !x.rls && !NOT_TENANT_DATA.includes(x.t)).map((x) => x.t);
    expect(open).toEqual([]);
    const withoutPolicy = await q(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`);
    expect(withoutPolicy).toEqual([]);
  });

  it('the role requests run as cannot get around it', async () => {
    const r = await one(`SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'geoattend_tenant'`);
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false, rolcreaterole: false, rolcreatedb: false });
    expect(await q(`SELECT 1 FROM pg_class c WHERE c.relowner = 'geoattend_tenant'::regrole`)).toEqual([]);
  });

  it('no view reads with its owner\'s rights', async () => {
    const views = await q(`SELECT c.relname, c.reloptions FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v'`);
    expect(views.length).toBeGreaterThanOrEqual(2);
    for (const v of views) expect(v.reloptions ?? []).toContain('security_invoker=true');
  });

  it('a request cannot touch tables outside company data', async () => {
    await expect(withOrg(A.org, () => q(`SELECT * FROM schema_migrations`))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('a query that forgets its company filter', () => {
  it('in any table, sees only its own company: the two companies never overlap and nothing is missing', async () => {
    for (const { t } of await allTables()) {
      if (NOT_TENANT_DATA.includes(t)) continue;
      const pk = (await one(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = $1::regclass AND i.indisprimary`, [t]))?.attname;
      if (!pk) throw new Error(`${t} has no primary key`);
      const ids = (rows: any[]) => rows.map((r) => String(r.k));
      const sql = `SELECT "${pk}" AS k FROM "${t}"`;
      const a = ids(await withOrg(A.org, () => q(sql)));
      const b = ids(await withOrg(B.org, () => q(sql)));
      expect(a.filter((x) => b.includes(x)), `${t} shared between companies`).toEqual([]);
      // Company-less system audit entries and the default company's rows are the only rows either may lack.
      const everything = ids(await q(sql));
      const seen = new Set([...a, ...b]);
      const rest = everything.filter((x) => !seen.has(x));
      if (t !== 'audit_logs' && t !== 'organizations' && t !== 'application_settings') expect(rest, `${t} rows visible to nobody`).toEqual([]);
    }
  });

  it('cannot read through the attendance views', async () => {
    const seen = await withOrg(B.org, () => q(`SELECT attendance_id FROM attendance_work`));
    expect(seen.map((r) => r.attendance_id)).toEqual([B.attendanceId]);
    const all = await withOrg(B.org, () => q(`SELECT attendance_id FROM attendance_work_all`));
    expect(all.map((r) => r.attendance_id)).toEqual([B.attendanceId]);
  });

  it('cannot find another company\'s record even by its exact id', async () => {
    expect(await withOrg(B.org, () => one(`SELECT 1 FROM attendance_records WHERE id = $1`, [A.attendanceId]))).toBeNull();
    expect(await withOrg(B.org, () => one(`SELECT 1 FROM users WHERE id = $1`, [A.emp.id]))).toBeNull();
    expect(await withOrg(B.org, () => one(`SELECT 1 FROM attendance_records ar JOIN users u ON u.id = ar.employee_id WHERE u.id = $1`, [A.emp.id]))).toBeNull();
  });

  it('with no company set, sees nothing at all', async () => {
    const client = await getPool().connect();
    try {
      await client.query(`SELECT set_config('app.org_id', '', false), set_config('role', 'geoattend_tenant', false)`);
      for (const t of ['users', 'attendance_records', 'organizations', 'payslips', 'tracking_sessions']) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      }
    } finally {
      await client.query(`SELECT set_config('role', 'none', false)`);
      client.release(new Error('do not reuse')); // its scope is unknown to the pool's bookkeeping
    }
  });
});

describe('a write aimed at another company', () => {
  it('cannot change or delete its rows: they are simply not there', async () => {
    const r = await withOrg(B.org, async () => ({
      upd: (await getScopedCount(`UPDATE users SET full_name = 'hacked' WHERE id = '${A.emp.id}' RETURNING 1`)),
      del: (await getScopedCount(`DELETE FROM holidays WHERE org_id = '${A.org}' RETURNING 1`)),
    }));
    expect(r).toEqual({ upd: 0, del: 0 });
    expect((await one(`SELECT full_name FROM users WHERE id = $1`, [A.emp.id])).full_name).not.toBe('hacked');
    expect(await q(`SELECT 1 FROM holidays WHERE org_id = $1`, [A.org])).toHaveLength(1);
  });

  it('cannot create a row in it', async () => {
    const refused = { code: '42501' };
    await expect(withOrg(B.org, () => q(`INSERT INTO holidays (org_id, holiday_date, name) VALUES ($1,'2030-01-01','x')`, [A.org]))).rejects.toMatchObject(refused);
    await expect(withOrg(B.org, () => q(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, requested_by) VALUES ($1,'SICK','2030-01-01','2030-01-01','Spy leave',$1)`, [A.emp.id]))).rejects.toMatchObject(refused);
    await expect(withOrg(B.org, () => q(`INSERT INTO users (email, password_hash, role, full_name, org_id) VALUES ($1,'x','EMPLOYEE','Spy',$2)`, [`spy-${crypto.randomUUID()}@t.local`, A.org]))).rejects.toMatchObject(refused);
  });

  it('cannot move its own rows into it', async () => {
    await expect(withOrg(B.org, () => q(`UPDATE holidays SET org_id = $1 WHERE org_id = $2`, [A.org, B.org]))).rejects.toMatchObject({ code: '42501' });
    await expect(withOrg(B.org, () => q(`UPDATE users SET org_id = $1 WHERE id = $2`, [A.org, B.emp.id]))).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot link its own record to another company\'s', async () => {
    const refused = { code: '42501' };
    // Own employee, other company's workplace / shift / supervisor / photo.
    await expect(withOrg(B.org, () => q(`INSERT INTO workplace_assignments (employee_id, workplace_id, effective_from) VALUES ($1,$2,'2031-01-01')`, [B.emp.id, A.workplaceId]))).rejects.toMatchObject(refused);
    await expect(withOrg(B.org, () => q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2031-01-01')`, [B.emp.id, A.shiftId]))).rejects.toMatchObject(refused);
    await expect(withOrg(B.org, () => q(`UPDATE employee_profiles SET supervisor_id = $1 WHERE user_id = $2`, [A.adminId, B.emp.id]))).rejects.toMatchObject(refused);
    await expect(withOrg(B.org, () => q(`UPDATE attendance_records SET photo_id = $1 WHERE id = $2`, [A.photoId, B.attendanceId]))).rejects.toMatchObject(refused);
    await expect(withOrg(B.org, () => q(`INSERT INTO notification_reads (notification_id, user_id) VALUES ($1,$2)`, [A.notificationId, B.adminId]))).rejects.toMatchObject(refused);
  });

  it('an ordinary write inside the company still works, in and out of a transaction', async () => {
    const row = await withOrg(B.org, () => one(`INSERT INTO holidays (org_id, holiday_date, name) VALUES ($1,'2032-01-01','Own') RETURNING id`, [B.org]));
    expect(row.id).toBeTruthy();
    await withOrg(B.org, () => tx(async (c) => {
      await q(`UPDATE holidays SET name = 'Own 2' WHERE id = $1`, [row.id], c);
    }));
    expect((await one(`SELECT name FROM holidays WHERE id = $1`, [row.id])).name).toBe('Own 2');
  });
});

async function getScopedCount(sql: string) {
  return (await q(sql)).length;
}

describe('pooled connections', () => {
  it('never carry one company\'s setting into another\'s request, under load', async () => {
    const check = (org: string, expected: string) => withOrg(org, async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      return (await q(`SELECT id FROM organizations`)).map((r) => r.id).join() === expected;
    });
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => (i % 2 ? check(A.org, A.org) : check(B.org, B.org))));
    expect(results.every(Boolean)).toBe(true);
  });

  it('go back to full access for background work after serving a company', async () => {
    for (let i = 0; i < 40; i++) await withOrg(A.org, () => q(`SELECT 1 FROM users`));
    const counts = await Promise.all(Array.from({ length: 40 }, () => one(`SELECT count(DISTINCT org_id)::int AS n, current_user AS u FROM users`)));
    expect(counts.every((c) => c.n >= 2 && c.u !== 'geoattend_tenant')).toBe(true);
  });

  it('keep the right setting after an error and after a rolled-back transaction', async () => {
    await expect(withOrg(A.org, () => q(`SELECT 1/0`))).rejects.toMatchObject({ code: '22012' });
    await expect(withOrg(A.org, () => tx(async (c) => { await q(`SELECT 1/0`, [], c); }))).rejects.toMatchObject({ code: '22012' });
    const seen = await Promise.all(Array.from({ length: 30 }, (_, i) => withOrg(i % 2 ? A.org : B.org, () => one(`SELECT id FROM organizations`))));
    seen.forEach((r, i) => expect(r.id).toBe(i % 2 ? A.org : B.org));
  });

  it('are kept after an ordinary refusal inside a transaction, and left unchanged by it', async () => {
    const pid = async () => (await one(`SELECT pg_backend_pid() AS p`)).p;
    const before = await pid();
    for (let i = 0; i < 10; i++) {
      await expect(tx(async () => { throw new HttpError(409, 'NOT_PENDING', 'no'); })).rejects.toMatchObject({ code: 'NOT_PENDING' });
    }
    expect(await pid()).toBe(before);
    expect((await one(`SELECT pg_current_xact_id_if_assigned() IS NULL AS clean`)).clean).toBe(true);
  });

  it('the company survives awaited work, and a nested system lookup does not leak out of it', async () => {
    await withOrg(A.org, async () => {
      expect(currentOrg()).toBe(A.org);
      await new Promise((r) => setTimeout(r, 5));
      expect(currentOrg()).toBe(A.org);
      expect(await asSystem(async () => currentOrg())).toBeNull();
      expect(currentOrg()).toBe(A.org);
    });
  });
});

describe('every route', () => {
  const who = `SELECT current_user AS role, current_setting('app.org_id', true) AS org`;
  const probeApp = () => {
    const r = Router();
    mount(r, '/probe', 'probe', [
      route({ method: 'get', path: '/admin', summary: 'x', access: 'admin', handler: () => one(who) }),
      route({ method: 'get', path: '/employee', summary: 'x', access: 'employee', handler: () => one(who) }),
      route({ method: 'get', path: '/any', summary: 'x', access: 'authenticated', handler: () => one(who) }),
      route({ method: 'get', path: '/public', summary: 'x', access: 'public', handler: () => one(who) }),
    ]);
    registry.splice(registry.findIndex((x) => x.fullPath === '/probe/admin'), 4); // not part of the real API
    const a = express();
    a.use((req, _res, next) => { (req as any).cookies = {}; next(); });
    a.use('/probe', r);
    return a;
  };

  it('of a signed-in user runs as the restricted role with their company set', async () => {
    const a = probeApp();
    const adminToken = await signAccessToken({ id: A.adminId, role: 'ADMIN' });
    const empToken = await mobileLogin(app, B.emp.email);
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    expect((await request(a).get('/probe/admin').set(bearer(adminToken)).expect(200)).body).toEqual({ role: 'geoattend_tenant', org: A.org });
    expect((await request(a).get('/probe/employee').set(bearer(empToken)).expect(200)).body).toEqual({ role: 'geoattend_tenant', org: B.org });
    expect((await request(a).get('/probe/any').set(bearer(empToken)).expect(200)).body).toEqual({ role: 'geoattend_tenant', org: B.org });
  });

  it('that is public runs with no company, because nobody is known yet', async () => {
    const r = (await request(probeApp()).get('/probe/public').expect(200)).body;
    expect(r.role).not.toBe('geoattend_tenant');
    expect(r.org || null).toBeNull();
  });

  it('the only public routes are the four that work before sign-in', () => {
    const open = registry.filter((r) => r.def.access === 'public').map((r) => r.fullPath).filter((p) => !p.includes('/demo/')).sort();
    expect(open).toEqual(['/api/v1/auth/login', '/api/v1/auth/logout', '/api/v1/auth/refresh', '/api/v1/auth/signup']);
  });
});

describe('direct API attempts from another company', () => {
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('an employee cannot use another company\'s ids on any employee route', async () => {
    const token = await mobileLogin(app, B.emp.email);
    const foreign = [A.sessionId, A.attendanceId, A.emp.id, A.notificationId, A.deviceId];
    const leaks: string[] = [];
    const routes = registry.filter((r) => (r.def.access === 'employee' || r.def.access === 'authenticated') && r.fullPath.includes(':id'));
    expect(routes.length).toBeGreaterThan(5);
    for (const r of routes) {
      for (const id of foreign) {
        const url = r.fullPath.replace(':id', id).replace(/:(\w+)/g, () => crypto.randomUUID());
        const call = (request(app) as any)[r.def.method](url).set(bearer(token));
        const res = r.def.method === 'get' ? await call : await call.send({});
        // Refused cleanly: a crash is not isolation, it is a bug that happens to return nothing.
        if (res.status < 400 || res.status >= 500) leaks.push(`${r.def.method} ${r.fullPath} with ${id} → ${res.status}`);
        expect(JSON.stringify(res.body ?? {})).not.toContain(A.emp.email);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('an employee cannot send a location or a check-in into another company\'s session', async () => {
    const token = await mobileLogin(app, B.emp.email);
    const reading = { clientEventId: crypto.randomUUID(), latitude: 12.97, longitude: 77.59, accuracyM: 5, clientTime: new Date().toISOString() };
    expect((await request(app).post('/api/v1/tracking/locations').set(bearer(token)).send({ sessionId: A.sessionId, source: 'FOREGROUND', readings: [reading] })).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).post('/api/v1/attendance/intents').set(bearer(token)).send({ sessionId: A.sessionId, idempotencyKey: crypto.randomUUID(), contentType: 'image/jpeg', sizeBytes: 100 })).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).post(`/api/v1/tracking/sessions/${A.sessionId}/end`).set(bearer(token)).send({})).status).toBeGreaterThanOrEqual(400);
    expect(await q(`SELECT 1 FROM location_updates WHERE client_event_id = $1`, [reading.clientEventId])).toEqual([]);
  });

  it('a stolen token of a deactivated employee reaches nothing', async () => {
    const emp = await createEmployee({ workplaceId: A.workplaceId, orgId: A.org });
    const token = await mobileLogin(app, emp.email);
    await q(`UPDATE users SET is_active = false WHERE id = $1`, [emp.id]);
    await request(app).get('/api/v1/me/attendance').set(bearer(token)).expect(401);
  });
});

describe('what must stay global', () => {
  it('an e-mail used by another company is still refused, by name, for employees and team members', async () => {
    const owner = await adminAgent(app, B.adminEmail);
    const taken = (await one(`SELECT email FROM users WHERE id = $1`, [A.emp.id])).email;
    const res = await owner.agent.post('/api/v1/employees').set('X-CSRF-Token', owner.csrf).send({ fullName: 'New', email: taken.toUpperCase(), employeeCode: `C-${crypto.randomBytes(3).toString('hex')}`, password: PASSWORD, workplaceId: B.workplaceId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
    const team = await owner.agent.post('/api/v1/team').set('X-CSRF-Token', owner.csrf).send({ fullName: 'New', email: taken, access: 'OWNER' });
    expect(team.status).toBe(409);
    expect(team.body.error.code).toBe('EMAIL_TAKEN');
    expect(JSON.stringify(res.body)).not.toContain(A.org);
  });

  it('signing in, refreshing and signing out work before a company is known', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: A.emp.email, password: PASSWORD, client: 'mobile' }).expect(200);
    const next = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: res.body.refreshToken }).expect(200);
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: next.body.refreshToken }).expect((r) => { expect(r.status).toBeLessThan(300); });
  });

  it('a new company signs up through the public route and is isolated at once', async () => {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/signup').send({ companyName: 'Charlie', fullName: 'C Owner', email: `c-${crypto.randomUUID()}@t.local`, password: PASSWORD }).expect(201);
    const me = (await agent.get('/api/v1/auth/me').expect(200)).body;
    const ids = (await withOrg(me.organization.id, () => q(`SELECT id FROM users`))).map((r) => r.id);
    expect(ids).toHaveLength(1);
    expect((await agent.get('/api/v1/employees').expect(200)).body.items ?? []).toEqual([]);
  });
});
