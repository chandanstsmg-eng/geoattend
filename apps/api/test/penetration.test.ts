/**
 * Attacks from one real company on another, through the public API. Two companies sign up through
 * the real sign-up route, with owners, supervisors and employees of their own. Company B then tries
 * everything against company A. Every route is taken from the registry, so a new route is attacked
 * automatically. An attack passes when it is refused cleanly, reveals nothing and changes nothing.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { registry } from '../src/lib/http.js';
import { signToken, writeLocalObject } from '../src/lib/storage.js';
import { createEmployee, createTestDatabase, fakeJpeg, mobileLogin, PASSWORD, testSettings, WP } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
type Agent = { agent: ReturnType<typeof request.agent>; csrf: string };

async function company(name: string) {
  const tag = `${name}-${crypto.randomBytes(5).toString('hex')}`;
  const agent = request.agent(app);
  const email = `owner-${tag}@${name.toLowerCase()}.test`;
  const signup = await agent.post('/api/v1/auth/signup').send({ companyName: `Company ${tag}`, fullName: `Owner ${tag}`, email, password: PASSWORD }).expect(201);
  const me = (await agent.get('/api/v1/auth/me').expect(200)).body;
  const orgId = me.organization.id as string;
  await testSettings(orgId);
  const owner: Agent = { agent, csrf: signup.body.csrfToken };
  const post = (url: string, body: object) => owner.agent.post(url).set('X-CSRF-Token', owner.csrf).send(body);
  const wp = (await post('/api/v1/workplaces', { name: `Site ${tag}`, latitude: WP.lat, longitude: WP.lng, radiusM: 50, timezone: 'Asia/Kolkata' }).expect(201)).body;
  const shift = (await post('/api/v1/shifts', { workplaceId: wp.id, name: `Shift ${tag}`, startTime: '00:00', endTime: '23:59', timezone: 'Asia/Kolkata', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], arrivalGraceMinutes: 10, confirmLongShift: true }).expect(201)).body;
  const supEmail = `sup-${tag}@${name.toLowerCase()}.test`;
  const team = await post('/api/v1/team', { fullName: `Supervisor ${tag}`, email: supEmail, access: 'SUPERVISOR', siteIds: [wp.id] }).expect(201);
  await q('UPDATE users SET must_change_password = false WHERE email = $1', [supEmail]);
  const supAgent = request.agent(app);
  const supLogin = await supAgent.post('/api/v1/auth/login').send({ email: supEmail, password: team.body.temporaryPassword, client: 'web' }).expect(200);
  const supervisor: Agent = { agent: supAgent, csrf: supLogin.body.csrfToken };

  const emp = await createEmployee({ workplaceId: wp.id, shiftId: shift.id, orgId });
  await q('UPDATE users SET full_name = $2 WHERE id = $1', [emp.id, `Employee ${tag}`]);
  const token = await mobileLogin(app, emp.email);
  const today = DateTime.now().setZone('Asia/Kolkata').toISODate()!;
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, last_latitude, last_longitude)
     VALUES ($1,$2,$3,$4,now() - interval '1 hour',now() + interval '4 hours','PRESENT',now() - interval '1 hour',12.97,77.59) RETURNING id`,
    [emp.id, shift.id, wp.id, today],
  );
  const key = `attendance/2026/11/${emp.id}/${crypto.randomUUID()}.jpg`;
  await writeLocalObject(key, fakeJpeg());
  const photo = await one(
    `INSERT INTO attendance_photos (employee_id, session_id, object_key, content_type, declared_bytes, status, idempotency_key, upload_expires_at) VALUES ($1,$2,$3,'image/jpeg',100,'ATTACHED',$4,now()) RETURNING id`,
    [emp.id, s.id, key, crypto.randomUUID()],
  );
  const att = await one(
    `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, photo_id, is_late, late_by_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,30,'VERIFIED',$7,true,5) RETURNING id`,
    [emp.id, wp.id, shift.id, s.id, today, `i-${crypto.randomUUID()}`, photo.id],
  );
  await q(`INSERT INTO absence_intervals (session_id, employee_id, workplace_id, started_at, threshold_minutes) VALUES ($1,$2,$3,now(),15)`, [s.id, emp.id, wp.id]);
  const review = await one(`INSERT INTO review_requests (kind, employee_id, attendance_id, reason, requested_by) VALUES ('DISPUTE',$1,$2,$3,$1) RETURNING id`, [emp.id, att.id, `Dispute ${tag}`]);
  const device = await one(`INSERT INTO device_registrations (user_id, device_id, platform, status) VALUES ($1,$2,'android','PENDING') RETURNING id`, [emp.id, `dev-${tag}`]);
  const holiday = await one(`INSERT INTO holidays (org_id, workplace_id, holiday_date, name) VALUES ($1,$2,$3,$4) RETURNING id`, [orgId, wp.id, today, `Holiday ${tag}`]);
  const leave = await one(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, requested_by) VALUES ($1,'SICK',$2,$2,$3,$1) RETURNING id`, [emp.id, today, `Leave ${tag}`]);
  const notification = await one(`INSERT INTO notifications (type, audience, severity, title, body, employee_id, org_id) VALUES ('NO_SHOW','ADMIN','INFO',$1,'b',$2,$3) RETURNING id`, [`Note ${tag}`, emp.id, orgId]);
  await q(`INSERT INTO employee_pay (employee_id, pay_type, amount) VALUES ($1, 'MONTHLY', 12345)`, [emp.id]);
  const adjustment = await one(`INSERT INTO pay_adjustments (employee_id, month, kind, amount, note) VALUES ($1, '2020-01', 'ADVANCE', 500, $2) RETURNING id`, [emp.id, `Advance ${tag}`]);
  const run = await one(`INSERT INTO payroll_runs (org_id, month, status, total_net, employees) VALUES ($1, '2020-01', 'APPROVED', 12345, 1) RETURNING id`, [orgId]);
  const payslip = await one(`INSERT INTO payslips (run_id, employee_id, month, net_amount, data) VALUES ($1, $2, '2020-01', 12345, '{}') RETURNING id`, [run.id, emp.id]);
  const task = await one(`INSERT INTO tasks (org_id, assignee_id, workplace_id, title, status) VALUES ($1, $2, $3, $4, 'SUBMITTED') RETURNING id`, [orgId, emp.id, wp.id, `Task ${tag}`]);
  const sos = await one(`INSERT INTO sos_alerts (org_id, employee_id, workplace_id, message) VALUES ($1, $2, $3, $4) RETURNING id`, [orgId, emp.id, wp.id, `SOS ${tag}`]);
  const broadcast = await one(`INSERT INTO broadcasts (org_id, workplace_id, title, body, recipients) VALUES ($1, $2, $3, 'x', 1) RETURNING id`, [orgId, wp.id, `Message ${tag}`]);
  await q(`INSERT INTO broadcast_recipients (broadcast_id, employee_id) VALUES ($1, $2)`, [broadcast.id, emp.id]);
  const overtime = await one(
    `INSERT INTO overtime_entries (session_id, attendance_id, employee_id, workplace_id, shift_date, note, started_at, ended_at, end_reason, start_latitude, start_longitude, start_accuracy_m, start_distance_m)
     VALUES ($1,$2,$3,$4,$5,$6, now() - interval '1 hour', now(), 'EMPLOYEE', 12.97, 77.59, 10, 0) RETURNING id`,
    [s.id, att.id, emp.id, wp.id, today, `Overtime ${tag}`],
  );
  const adminId = (await one(`SELECT id FROM users WHERE email = $1`, [email])).id as string;
  const ids: Record<string, string> = {
    employee: emp.id, workplace: wp.id, shift: shift.id, session: s.id, attendance: att.id, review: review.id, leave: leave.id, device: device.id, holiday: holiday.id,
    notification: notification.id, payslip: payslip.id, adjustment: adjustment.id, admin: adminId, task: task.id, sos: sos.id, broadcast: broadcast.id, overtime: overtime.id,
  };
  return { tag, orgId, owner, supervisor, emp, token, ids, key, today, wpId: wp.id as string, shiftId: shift.id as string, attendanceId: att.id as string, sessionId: s.id as string, adminId, supEmail };
}

let A: Awaited<ReturnType<typeof company>>;
let B: Awaited<ReturnType<typeof company>>;

/** Every row of company A that an attack could change, so "nothing changed" can be proved. */
async function fingerprint() {
  const tables = ['users', 'workplaces', 'shifts', 'tracking_sessions', 'attendance_records', 'attendance_photos', 'leave_requests', 'review_requests', 'overtime_entries', 'tasks', 'sos_alerts', 'broadcasts', 'employee_pay', 'pay_adjustments', 'holidays', 'device_registrations', 'employee_shift_assignments', 'workplace_assignments', 'employee_profiles'];
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = (await one(`SELECT md5(COALESCE(string_agg(x::text, '' ORDER BY x::text), '')) AS h FROM "${t}" x`)).h;
  return out;
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp();
  A = await company('Alpha');
  B = await company('Bravo');
}, 120_000);
afterAll(async () => {
  await db.drop();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const call = (agent: any, method: string, url: string, csrf?: string) => {
  const r = agent[method](url);
  if (csrf) r.set('X-CSRF-Token', csrf);
  return method === 'get' ? r : r.send({});
};
/** Anything of company A's in a response. An id alone is no leak where B's own audit log records the id B itself typed. */
const leaks = (res: { text?: string; body?: unknown }, opts: { idsAreEchoed?: boolean } = {}) => {
  const text = (res.text ?? '') + JSON.stringify(res.body ?? '');
  return text.includes(A.tag) || text.includes(A.emp.email) || (!opts.idsAreEchoed && text.includes(A.emp.id));
};
const filled = (path: string, id: string) => path.replace(':id', id).replace(':month', '2020-01').replace(/:(\w+)/g, () => crypto.randomUUID());

describe('unauthorized resource access, every route, every role of company B', () => {
  const attackers = () => [
    { who: 'owner', go: (m: string, u: string) => call(B.owner.agent, m, u, B.owner.csrf) },
    { who: 'supervisor', go: (m: string, u: string) => call(B.supervisor.agent, m, u, B.supervisor.csrf) },
    { who: 'employee', go: (m: string, u: string) => (m === 'get' ? (request(app) as any).get(u).set(bearer(B.token)) : (request(app) as any)[m](u).set(bearer(B.token)).send({})) },
  ];

  it('company A\'s record ids get a clean refusal from every route with an id, and change nothing', async () => {
    const before = await fingerprint();
    const problems: string[] = [];
    let attempts = 0;
    const routes = registry.filter((r) => r.fullPath.includes(':id') && !r.fullPath.startsWith('/probe') && !r.fullPath.includes('/demo/'));
    expect(routes.length).toBeGreaterThan(60);
    for (const a of attackers()) {
      for (const r of routes) {
        // Without a declared scope the id could be anything, so all of them are tried.
        const candidates = r.def.scope ? [A.ids[r.def.scope]!] : Object.values(A.ids);
        for (const id of candidates) {
          attempts++;
          const res = await a.go(r.def.method, filled(r.fullPath, id));
          if (res.status < 400 || res.status >= 500) problems.push(`${a.who} ${r.def.method} ${r.fullPath} → ${res.status}`);
          if (leaks(res)) problems.push(`${a.who} ${r.def.method} ${r.fullPath} leaked`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(attempts).toBeGreaterThan(300);
    expect(await fingerprint()).toEqual(before);
  }, 180_000);

  it('a record of another company looks exactly like one that does not exist', async () => {
    for (const r of registry.filter((x) => x.def.scope && x.def.method === 'get' && x.def.access === 'admin' && !x.def.ownerOnly)) {
      const foreign = await B.owner.agent.get(filled(r.fullPath, A.ids[r.def.scope!]!));
      const missing = await B.owner.agent.get(filled(r.fullPath, crypto.randomUUID()));
      expect([foreign.status, foreign.body], r.fullPath).toEqual([missing.status, missing.body]);
    }
  }, 60_000);

  it('no list, report or export of any role of company B contains company A', async () => {
    const qs = `?from=2000-01-01&to=2100-01-01&date=${A.today}&month=${A.today.slice(0, 7)}&includeSimulated=true&limit=500`;
    const lists = registry.filter((r) => r.def.method === 'get' && !r.fullPath.replace(':month', '').includes(':') && !r.fullPath.endsWith('/stream') && !r.fullPath.includes('/demo/'));
    expect(lists.length).toBeGreaterThan(50);
    const problems: string[] = [];
    for (const a of attackers()) {
      for (const r of lists) {
        const res = await a.go('get', r.fullPath.replace(':month', A.today.slice(0, 7)) + qs);
        if (res.status >= 500) problems.push(`${a.who} ${r.fullPath} → ${res.status}`);
        if (leaks(res, { idsAreEchoed: r.fullPath.includes('audit-logs') })) problems.push(`${a.who} ${r.fullPath} leaked`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it('filtering by company A\'s ids returns nothing', async () => {
    const filter = `?from=2000-01-01&to=2100-01-01&date=${A.today}&month=${A.today.slice(0, 7)}&employeeId=${A.emp.id}&workplaceId=${A.wpId}&shiftId=${A.shiftId}&supervisorId=${A.adminId}&includeSimulated=true`;
    for (const r of registry.filter((x) => x.def.method === 'get' && x.def.access === 'admin' && !x.fullPath.replace(':month', '').includes(':') && !x.fullPath.endsWith('/stream'))) {
      const res = await B.owner.agent.get(r.fullPath.replace(':month', A.today.slice(0, 7)) + filter);
      expect(res.status, r.fullPath).toBeLessThan(500);
      expect(leaks(res, { idsAreEchoed: r.fullPath.includes('audit-logs') }), r.fullPath).toBe(false);
    }
  }, 60_000);
});

describe('company A\'s ids inside request bodies', () => {
  const send = (url: string, body: object) => B.owner.agent.post(url).set('X-CSRF-Token', B.owner.csrf).send(body);
  const label = (r: unknown) => String((r as any).req?.path ?? '');

  it('are refused wherever a record of company B would point at them', async () => {
    const before = await fingerprint();
    const results = await Promise.all([
      send('/api/v1/shifts', { workplaceId: A.wpId, name: 'Stolen', startTime: '09:00', endTime: '17:00', timezone: 'Asia/Kolkata', daysOfWeek: [1], arrivalGraceMinutes: 10 }),
      send(`/api/v1/employees/${B.emp.id}/shifts`, { shiftId: A.shiftId }),
      send('/api/v1/attendance/manual', { employeeId: A.emp.id, shiftId: B.shiftId, shiftDate: B.today, recordedAt: new Date().toISOString(), reason: 'Injecting into company A' }),
      send('/api/v1/attendance/manual', { employeeId: B.emp.id, shiftId: A.shiftId, shiftDate: B.today, recordedAt: new Date().toISOString(), reason: 'Using company A shift' }),
      send('/api/v1/leave', { employeeId: A.emp.id, leaveType: 'SICK', startDate: B.today, endDate: B.today, reason: 'On behalf of company A' }),
      send('/api/v1/tasks', { assigneeId: A.emp.id, title: 'Do this for us', workplaceId: B.wpId }),
      send('/api/v1/broadcasts', { workplaceId: A.wpId, title: 'Hello', body: 'From company B' }),
      send('/api/v1/team', { fullName: 'Spy', email: `spy-${crypto.randomUUID()}@b.test`, access: 'SUPERVISOR', siteIds: [A.wpId] }),
      send('/api/v1/holidays', { workplaceId: A.wpId, date: '2031-01-01', name: 'Fake holiday' }),
      send('/api/v1/attendance/photo-thumbnails', { ids: [A.attendanceId] }),
    ]);
    for (const r of results) {
      expect(r.status, label(r)).toBeLessThan(500);
      expect(leaks(r), label(r)).toBe(false);
    }
    // The only allowed success is the thumbnail call, which answers with nothing.
    const created = results.filter((r) => r.status < 300 && !label(r).includes('photo-thumbnails'));
    expect(created.map((r) => `${label(r)} ${r.status}`)).toEqual([]);
    expect(Object.keys(results.at(-1)!.body ?? {}).length === 0 || JSON.stringify(results.at(-1)!.body).indexOf(A.attendanceId) < 0).toBe(true);
    expect(await fingerprint()).toEqual(before);
  });

  it('a supervisor of the same company is held to their own sites too', async () => {
    const other = await B.owner.agent.post('/api/v1/workplaces').set('X-CSRF-Token', B.owner.csrf).send({ name: 'Elsewhere', latitude: WP.lat + 1, longitude: WP.lng, radiusM: 50, timezone: 'Asia/Kolkata' }).expect(201);
    const res = await B.supervisor.agent.get(`/api/v1/workplaces/${other.body.id}`);
    expect(res.status).toBe(404);
  });
});

describe('attendance corrections', () => {
  const correct = (who: Agent, id: string) => who.agent.post(`/api/v1/attendance/${id}/corrections`).set('X-CSRF-Token', who.csrf).send({ reason: 'Trying to change this record', verificationStatus: 'VOIDED' });

  it('another company cannot correct, void, verify or override a record', async () => {
    const before = await one(`SELECT * FROM attendance_records WHERE id = $1`, [A.attendanceId]);
    expect((await correct(B.owner, A.attendanceId)).status).toBe(404);
    expect((await correct(B.supervisor, A.attendanceId)).status).toBe(404);
    expect((await B.owner.agent.post(`/api/v1/attendance/${A.attendanceId}/verification`).set('X-CSRF-Token', B.owner.csrf).send({ decision: 'APPROVE', note: 'Approving from outside' })).status).toBe(404);
    expect((await B.owner.agent.post(`/api/v1/faces/reviews/${A.attendanceId}/override`).set('X-CSRF-Token', B.owner.csrf).send({ note: 'Override from outside' })).status).toBe(404);
    expect(await one(`SELECT * FROM attendance_records WHERE id = $1`, [A.attendanceId])).toEqual(before);
  });

  it('an employee cannot use any correction route, even on their own record', async () => {
    for (const path of ['corrections', 'verification']) {
      const res = await request(app).post(`/api/v1/attendance/${B.attendanceId}/${path}`).set(bearer(B.token)).send({ reason: 'Marking myself present', decision: 'APPROVE', note: 'Self approved' });
      expect(res.status, path).toBe(403);
    }
  });

  it('a supervisor of the right company can only ask: the record stays as it was', async () => {
    const before = await one(`SELECT verification_status, recorded_at FROM attendance_records WHERE id = $1`, [B.attendanceId]);
    const res = await B.supervisor.agent.post(`/api/v1/attendance/${B.attendanceId}/corrections`).set('X-CSRF-Token', B.supervisor.csrf).send({ reason: 'Asking for a correction', verificationStatus: 'CORRECTED' });
    expect(res.status).toBe(202);
    expect(await one(`SELECT verification_status, recorded_at FROM attendance_records WHERE id = $1`, [B.attendanceId])).toEqual(before);
  });
});

describe('files and photos', () => {
  const storage = (token: string) => request(app).get(`/api/v1/storage/object?token=${encodeURIComponent(token)}`);
  const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

  it('photo links are refused for another company\'s records', async () => {
    for (const path of ['photo-url', 'end-photo-url', 'reference-photo-url']) {
      expect((await B.owner.agent.get(`/api/v1/attendance/${A.attendanceId}/${path}`)).status, path).toBe(404);
    }
    expect((await B.owner.agent.post(`/api/v1/attendance/${A.attendanceId}/photo/delete`).set('X-CSRF-Token', B.owner.csrf).send({ reason: 'Deleting from outside' })).status).toBe(404);
  });

  it('a photo cannot be fetched without a valid signed link', async () => {
    const good = signToken({ op: 'get', key: A.key, exp: inAnHour() });
    expect((await storage(good)).status).toBe(200); // the check below means something only if this works
    const [body, sig] = good.split('.');
    const forged = `${Buffer.from(JSON.stringify({ op: 'get', key: A.key, exp: inAnHour() + 1 })).toString('base64url')}.${sig}`;
    const expired = signToken({ op: 'get', key: A.key, exp: 1000 });
    const upload = signToken({ op: 'put', key: A.key, exp: inAnHour(), ct: 'image/jpeg' });
    for (const t of [forged, `${body}.${'A'.repeat(sig!.length)}`, `${body}.`, 'nonsense', '', expired, upload]) {
      const res = await storage(t);
      expect(res.status, t).toBe(403);
      expect(res.body?.length ?? 0).toBeLessThan(2000);
    }
  });

  it('a signed link cannot be pointed outside the photo folder', async () => {
    for (const key of ['../.env', '../../.env', 'attendance/../../secret.jpg', '/etc/passwd', 'C:\\Windows\\win.ini', 'attendance/x.exe']) {
      expect((await storage(signToken({ op: 'get', key, exp: inAnHour() }))).status, key).toBe(403);
    }
  });

  it('a download link cannot upload, and an upload needs an open slot', async () => {
    const get = signToken({ op: 'get', key: A.key, exp: inAnHour() });
    expect((await request(app).put(`/api/v1/storage/upload?token=${encodeURIComponent(get)}`).set('Content-Type', 'image/jpeg').send(fakeJpeg())).status).toBe(403);
    const put = signToken({ op: 'put', key: A.key, exp: inAnHour(), ct: 'image/jpeg', max: 100000 });
    expect((await request(app).put(`/api/v1/storage/upload?token=${encodeURIComponent(put)}`).set('Content-Type', 'image/jpeg').send(fakeJpeg())).status).toBe(409);
  });
});

describe('reports and exports', () => {
  const csv = () => registry.filter((r) => r.fullPath.endsWith('.csv') || r.def.raw).filter((r) => !r.fullPath.endsWith('/stream') && r.def.method === 'get');
  const qs = () => `?from=2000-01-01&to=2100-01-01&date=${A.today}&month=${A.today.slice(0, 7)}&includeSimulated=true`;

  it('every export is refused without signing in', async () => {
    for (const r of csv()) expect((await request(app).get(filled(r.fullPath, crypto.randomUUID()) + qs())).status, r.fullPath).toBe(401);
  });

  it('employees get no export', async () => {
    for (const r of csv().filter((x) => x.def.access === 'admin')) expect((await request(app).get(filled(r.fullPath, crypto.randomUUID()) + qs()).set(bearer(B.token))).status, r.fullPath).toBe(403);
  });

  it('owner-only exports are refused to supervisors', async () => {
    for (const r of csv().filter((x) => x.def.ownerOnly)) expect((await B.supervisor.agent.get(filled(r.fullPath, crypto.randomUUID()) + qs())).status, r.fullPath).toBe(403);
  });

  it('each company\'s export contains its own rows and nobody else\'s', async () => {
    const own = (await A.owner.agent.get(`/api/v1/reports/attendance.csv${qs()}`).expect(200)).text;
    expect(own).toContain(A.tag); // the export really has data, so the next line proves something
    expect(own).not.toContain(B.tag);
    const theirs = (await B.owner.agent.get(`/api/v1/reports/attendance.csv${qs()}`).expect(200)).text;
    expect(theirs).toContain(B.tag);
    expect(theirs).not.toContain(A.tag);
  });
});

describe('forged and stolen credentials', () => {
  const sign = (claims: object, sub: string, key: Uint8Array, opts: { exp?: string } = {}) =>
    new SignJWT({ ...claims }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuedAt().setIssuer('geoattend').setAudience('geoattend').setExpirationTime(opts.exp ?? '10m').sign(key);
  const real = () => new TextEncoder().encode(config.jwtSecret);

  it('a token signed with the wrong key, or with no signature, is refused', async () => {
    const wrong = await sign({ role: 'ADMIN' }, A.adminId, new TextEncoder().encode('x'.repeat(40)));
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: A.adminId, role: 'ADMIN', iss: 'geoattend', aud: 'geoattend', exp: 9999999999 })).toString('base64url')}.`;
    for (const t of [wrong, none, 'abc.def.ghi']) expect((await request(app).get('/api/v1/employees').set(bearer(t))).status).toBe(401);
  });

  it('an expired token is refused', async () => {
    expect((await request(app).get('/api/v1/me/attendance').set(bearer(await sign({ role: 'EMPLOYEE' }, B.emp.id, real(), { exp: '-1m' })))).status).toBe(401);
  });

  it('a role claimed in the token means nothing: the database decides', async () => {
    const t = await sign({ role: 'ADMIN' }, B.emp.id, real());
    expect((await request(app).get('/api/v1/employees').set(bearer(t))).status).toBe(403);
  });

  it('a token of a user who does not exist reaches nothing', async () => {
    expect((await request(app).get('/api/v1/employees').set(bearer(await sign({ role: 'ADMIN' }, crypto.randomUUID(), real())))).status).toBe(401);
  });

  it('nothing is reachable without signing in', async () => {
    const problems: string[] = [];
    for (const r of registry.filter((x) => x.def.access !== 'public' && !x.fullPath.startsWith('/probe'))) {
      const res = await (request(app) as any)[r.def.method](filled(r.fullPath, crypto.randomUUID()));
      if (res.status !== 401) problems.push(`${r.def.method} ${r.fullPath} → ${res.status}`);
    }
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('SQL injection', () => {
  const payloads = [
    `' OR '1'='1`,
    `'; DROP TABLE users; --`,
    `' UNION SELECT id, email, password_hash FROM users --`,
    `1) OR (1=1`,
    `%' OR 1=1 --`,
    `'; SET ROLE geoattend_owner; --`,
    `'; SELECT set_config('app.org_id', '00000000-0000-0000-0000-000000000000', false); --`,
    `2026-01-01'::date; DELETE FROM attendance_records; --`,
  ];
  const sqlError = /syntax error|unterminated|pg_|column .* does not exist|relation .* does not exist|invalid input syntax/i;

  it('in every query parameter of every route: refused or harmless, never an error, never a leak', async () => {
    const before = await fingerprint();
    const problems: string[] = [];
    let attempts = 0;
    const routes = registry.filter((r) => r.def.method === 'get' && r.def.query && !r.fullPath.endsWith('/stream') && !r.fullPath.replace(':month', '').includes(':') && !r.fullPath.includes('/demo/'));
    expect(routes.length).toBeGreaterThan(25);
    for (const r of routes) {
      const keys = Object.keys((r.def.query as any).shape ?? {});
      for (const key of keys) {
        for (const p of payloads) {
          attempts++;
          const res = await B.owner.agent.get(r.fullPath.replace(':month', '2020-01')).query({ [key]: p });
          if (res.status >= 500) problems.push(`${r.fullPath}?${key} → ${res.status}`);
          if (sqlError.test(res.text ?? '')) problems.push(`${r.fullPath}?${key} showed a database error`);
          if (leaks(res)) problems.push(`${r.fullPath}?${key} leaked`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(attempts).toBeGreaterThan(300);
    expect(await fingerprint()).toEqual(before);
  }, 180_000);

  it('in the sign-in form', async () => {
    for (const p of payloads) {
      const res = await request(app).post('/api/v1/auth/login').send({ email: `${p}@x.test`, password: p, client: 'web' });
      expect(res.status, p).toBeGreaterThanOrEqual(400);
      expect(res.status, p).toBeLessThan(500);
      expect(res.body.accessToken, p).toBeUndefined();
    }
    const asEmail = await request(app).post('/api/v1/auth/login').send({ email: `' OR 1=1 --`, password: 'x', client: 'web' });
    expect(asEmail.status).toBe(400);
  });

  it('in path ids', async () => {
    for (const p of payloads) {
      const res = await B.owner.agent.get(`/api/v1/employees/${encodeURIComponent(p)}`);
      expect(res.status, p).toBe(400);
    }
  });

  it('stored as data and shown again, it stays data', async () => {
    const name = `Robert'); DROP TABLE users;-- ${crypto.randomBytes(3).toString('hex')}`;
    const h = await B.owner.agent.post('/api/v1/holidays').set('X-CSRF-Token', B.owner.csrf).send({ workplaceId: B.wpId, date: '2033-01-01', name });
    expect(h.status).toBeLessThan(300);
    const list = await B.owner.agent.get('/api/v1/holidays?from=2033-01-01&to=2033-01-01').expect(200);
    expect(list.body.map((x: any) => x.name)).toContain(name);
    expect((await one(`SELECT count(*)::int AS n FROM users`)).n).toBeGreaterThan(0);
  });

  it('if it ever did run, the database would still hold the line', async () => {
    const { withOrg } = await import('../src/db/pool.js');
    // What an injected statement could attempt on a request's connection.
    await expect(withOrg(B.orgId, () => q(`SET ROLE geoattend_owner`))).rejects.toThrow();
    await expect(withOrg(B.orgId, () => q(`DROP TABLE users`))).rejects.toThrow();
    await expect(withOrg(B.orgId, () => q(`SELECT * FROM schema_migrations`))).rejects.toThrow();
    expect(await withOrg(B.orgId, () => q(`SELECT id FROM users WHERE id = $1`, [A.emp.id]))).toEqual([]);
  });
});
