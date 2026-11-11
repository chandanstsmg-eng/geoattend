/** Phase F: what jobs do to attendance, notifications, summaries and photos, and what they must never do. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { one, q, tx, withOrg } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { resetMailer } from '../src/lib/mailer.js';
import { JobFailures, runJob } from '../src/modules/jobs/runner.js';
import { sweepExpiredWindows } from '../src/modules/jobs/sweeper.js';
import { sweepOverdueApprovals } from '../src/modules/jobs/escalation.js';
import { sweepNoShows } from '../src/modules/jobs/no-show.js';
import { runRetention } from '../src/modules/jobs/retention.js';
import { processDeliveries } from '../src/modules/notifications/delivery.js';
import { notify } from '../src/modules/notifications/notify.js';
import { Outbox } from '../src/modules/notifications/live-hub.js';
import { senders, sweepDigests, weekLine } from '../src/modules/digest/digest.js';
import { DEFAULT_SETTINGS, invalidateSettings, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { createEmployee, createTestDatabase, seedBase, testSettings } from './helpers.js';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
type Co = Awaited<ReturnType<typeof co>>;
let A: Co;
let B: Co;

async function co(name: string) {
  const org = (await one(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [name])).id as string;
  const base = await seedBase(org, `${name}-${crypto.randomUUID()}@test.local`);
  await testSettings(org);
  return { ...base, org };
}

let day = 0;
const nextDate = () => DateTime.fromISO('2026-03-02').plus({ days: day++ }).toISODate()!;

async function session(c: Co, over: { hoursAgoEnd?: number; state?: string } = {}) {
  const emp = await createEmployee({ workplaceId: c.workplaceId, shiftId: c.shiftId, orgId: c.org });
  const date = nextDate();
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, last_location_at)
     VALUES ($1,$2,$3,$4,now() - interval '12 hours',now() - make_interval(hours => $6),$5,now() - interval '12 hours',now() - interval '5 hours') RETURNING id`,
    [emp.id, c.shiftId, c.workplaceId, date, over.state ?? 'PRESENT', over.hoursAgoEnd ?? 2],
  );
  return { emp, sessionId: s.id as string, date };
}

async function attendance(c: Co, s: Awaited<ReturnType<typeof session>>, status = 'VERIFIED', photoId: string | null = null, over = '') {
  const r = await one(
    `INSERT INTO attendance_records (session_id, employee_id, workplace_id, shift_id, shift_date, recorded_at, idempotency_key, evidence_latitude, evidence_longitude, evidence_accuracy_m, evidence_distance_m, evidence_client_time, radius_m_at_record, verification_status, photo_id)
     VALUES ($1,$2,$3,$4,$5,now() - interval '30 hours',$8,12.97,77.59,10,5,now() - interval '30 hours',100,$6,$7) RETURNING id`,
    [s.sessionId, s.emp.id, c.workplaceId, c.shiftId, s.date, status, photoId, crypto.randomUUID()],
  );
  if (over) await q(`UPDATE attendance_records SET ${over} WHERE id = $1`, [r.id]);
  return r.id as string;
}

async function overtime(c: Co, s: Awaited<ReturnType<typeof session>>, attendanceId: string, photoId: string | null = null) {
  await q(
    `INSERT INTO overtime_entries (session_id, attendance_id, employee_id, workplace_id, shift_date, started_at, start_photo_id, start_latitude, start_longitude, start_accuracy_m, start_distance_m, ended_at, end_reason, created_at)
     VALUES ($1,$2,$3,$4,$5,now() - interval '3 days',$6,12.97,77.59,10,5,now() - interval '3 days' + interval '1 hour','EMPLOYEE',now() - interval '3 days')`,
    [s.sessionId, attendanceId, s.emp.id, c.workplaceId, s.date, photoId],
  );
}

const old = (id: string) => q(`UPDATE attendance_records SET created_at = now() - interval '3 days' WHERE id = $1`, [id]);

beforeAll(async () => {
  db = await createTestDatabase();
  A = await co('Alpha');
  B = await co('Bravo');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await q(`DELETE FROM job_state`);
});
afterAll(async () => {
  await db.drop();
});

describe('attendance jobs', () => {
  it('a shift nobody ended is closed and raises a missing check-out alert, once', async () => {
    const s = await session(A);
    await attendance(A, s);
    await sweepExpiredWindows();
    await sweepExpiredWindows();
    expect((await one(`SELECT authorization_status FROM tracking_sessions WHERE id = $1`, [s.sessionId])).authorization_status).toBe('EXPIRED');
    const alerts = await q(`SELECT severity, org_id FROM notifications WHERE employee_id = $1 AND type = 'MISSING_CHECKOUT'`, [s.emp.id]);
    expect(alerts).toEqual([{ severity: 'WARNING', org_id: A.org }]);
  });

  it('no missing check-out alert when there was no attendance to check out of', async () => {
    const s = await session(A);
    await sweepExpiredWindows();
    expect(await q(`SELECT 1 FROM notifications WHERE employee_id = $1 AND type = 'MISSING_CHECKOUT'`, [s.emp.id])).toEqual([]);
  });

  it('closing a shift changes nothing about its attendance record', async () => {
    const s = await session(A);
    const id = await attendance(A, s, 'PENDING_VERIFICATION');
    const before = await one(`SELECT recorded_at, verification_status, evidence_client_time, evidence_latitude FROM attendance_records WHERE id = $1`, [id]);
    await sweepExpiredWindows();
    expect(await one(`SELECT recorded_at, verification_status, evidence_client_time, evidence_latitude FROM attendance_records WHERE id = $1`, [id])).toEqual(before);
  });

  it('a voided record does not stop the no-show alert: it is not attendance', async () => {
    const emp = await createEmployee({ workplaceId: A.workplaceId, orgId: A.org });
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2020-01-01')`, [emp.id, A.shiftId]);
    const noon = DateTime.utc().set({ hour: 12, minute: 0 }).toJSDate();
    const date = DateTime.utc().toISODate()!;
    await q(
      `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, shift_date, recorded_at, idempotency_key, radius_m_at_record, verification_status)
       VALUES ($1,$2,$3,$4,now(),$5,100,'VOIDED')`,
      [emp.id, A.workplaceId, A.shiftId, date, crypto.randomUUID()],
    );
    await sweepNoShows(noon);
    expect(await q(`SELECT 1 FROM notifications WHERE employee_id = $1 AND type = 'NO_SHOW' AND audience = 'ADMIN'`, [emp.id])).toHaveLength(1);
  });
});

describe('pending attendance', () => {
  it('a record waiting over a day is raised to the owners, once, and is not approved', async () => {
    const s = await session(A);
    const id = await attendance(A, s, 'PENDING_VERIFICATION');
    await old(id);
    await sweepOverdueApprovals();
    await sweepOverdueApprovals();
    const n = await q(`SELECT data, org_id FROM notifications WHERE type = 'APPROVAL_OVERDUE' AND employee_id = $1`, [s.emp.id]);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ org_id: A.org, data: { kind: 'verification', id } });
    expect((await one(`SELECT verification_status FROM attendance_records WHERE id = $1`, [id])).verification_status).toBe('PENDING_VERIFICATION');
  });

  it('an item already raised is not handed to the next run again (the job no longer re-sends its whole backlog)', async () => {
    const s = await session(A);
    const id = await attendance(A, s, 'PENDING_VERIFICATION');
    await old(id);
    const { overdueItems } = await import('../src/modules/jobs/escalation.js');
    const { withOrg } = await import('../src/db/pool.js');
    const pending = () => withOrg(A.org, () => overdueItems()).then((items) => items.filter((i: any) => i.id === id));
    expect(await pending()).toHaveLength(1);
    await sweepOverdueApprovals();
    expect(await pending()).toHaveLength(0);
    expect(await q(`SELECT 1 FROM notifications WHERE type = 'APPROVAL_OVERDUE' AND data->>'id' = $1`, [id])).toHaveLength(1);
  });

  it('no job anywhere turns a pending record into a verified one', async () => {
    const s = await session(A);
    const id = await attendance(A, s, 'PENDING_VERIFICATION');
    await old(id);
    const { JOBS } = await import('../src/modules/jobs/sweeper.js');
    for (const j of JOBS) await runJob(j.name, () => j.run(new Date(Date.now() + 30 * 86400_000)), { everyMs: 0 });
    expect((await one(`SELECT verification_status FROM attendance_records WHERE id = $1`, [id])).verification_status).toBe('PENDING_VERIFICATION');
  });

  it('a photo check, a correction and overtime waiting over a day are raised too', async () => {
    const s = await session(A);
    const id = await attendance(A, s, 'VERIFIED', null, `face_review = 'PENDING'`);
    await old(id);
    const r = await one(`INSERT INTO review_requests (kind, employee_id, attendance_id, reason, requested_by, created_at) VALUES ('ADMIN_CORRECTION',$1,$2,'Wrong time',$3,now() - interval '3 days') RETURNING id`, [s.emp.id, id, A.adminId]);
    await overtime(A, s, id);
    await sweepOverdueApprovals();
    const kinds = (await q(`SELECT data->>'kind' AS kind FROM notifications WHERE type = 'APPROVAL_OVERDUE' AND employee_id = $1 ORDER BY 1`, [s.emp.id])).map((n) => n.kind);
    expect(kinds).toEqual(['correction', 'overtime', 'photo-check']);
    await q(`UPDATE review_requests SET status = 'CANCELLED' WHERE id = $1`, [r.id]);
  });

  it('a voided record with a pending photo check is left alone', async () => {
    const s = await session(A);
    const id = await attendance(A, s, 'VOIDED', null, `face_review = 'PENDING'`);
    await old(id);
    await sweepOverdueApprovals();
    expect(await q(`SELECT 1 FROM notifications WHERE type = 'APPROVAL_OVERDUE' AND employee_id = $1`, [s.emp.id])).toEqual([]);
  });

  it('stays in its own company', async () => {
    const s = await session(B);
    const id = await attendance(B, s, 'PENDING_VERIFICATION');
    await old(id);
    await sweepOverdueApprovals();
    expect((await one(`SELECT org_id FROM notifications WHERE type = 'APPROVAL_OVERDUE' AND employee_id = $1`, [s.emp.id])).org_id).toBe(B.org);
  });
});

describe('delivering notifications', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function delivery(c: Co, target = `ExponentPushToken[${crypto.randomUUID()}]`) {
    const n = await one(`INSERT INTO notifications (type, severity, title, body, org_id) VALUES ('NO_SHOW','INFO','t','b',$1) RETURNING id`, [c.org]);
    return (await one(`INSERT INTO notification_deliveries (notification_id, channel, target) VALUES ($1,'EXPO_PUSH',$2) RETURNING id`, [n.id, target])).id as string;
  }
  const row = (id: string) => one(`SELECT * FROM notification_deliveries WHERE id = $1`, [id]);
  const answer = (status: number, body: unknown = { data: { status: 'ok' } }) => new Response(JSON.stringify(body), { status });
  const due = (id: string) => q(`UPDATE notification_deliveries SET next_attempt_at = now() WHERE id = $1`, [id]);
  const clear = () => q(`DELETE FROM notification_deliveries`);

  it('sends once and records it', async () => {
    await clear();
    const id = await delivery(A);
    const send = vi.fn(async () => answer(200));
    globalThis.fetch = send as any;
    await processDeliveries();
    await processDeliveries();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await row(id)).toMatchObject({ status: 'SENT', attempts: 1 });
  });

  it('runners racing each other send it once', async () => {
    await clear();
    await delivery(A);
    const send = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return answer(200);
    });
    globalThis.fetch = send as any;
    await Promise.all([processDeliveries(), processDeliveries(), processDeliveries()]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('two runners that both listed a delivery cannot both send it', async () => {
    await clear();
    const id = await delivery(A);
    const send = vi.fn(async () => answer(200));
    globalThis.fetch = send as any;
    // A held row lock keeps both runners at the claim, after each has listed the delivery as due.
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const lock = tx(async (c) => {
      await q(`SELECT 1 FROM notification_deliveries WHERE id = $1 FOR UPDATE`, [id], c);
      await gate;
    });
    await new Promise((r) => setTimeout(r, 100));
    const runners = Promise.all([processDeliveries(), processDeliveries()]);
    await new Promise((r) => setTimeout(r, 500));
    release();
    await lock;
    await runners;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a failure is retried with growing waits, then gives up and says why, with no address in it', async () => {
    await clear();
    const id = await delivery(A);
    globalThis.fetch = (async () => answer(500, { data: { status: 'error', message: 'refused for ravi@company.in' } })) as any;
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await due(id);
      await processDeliveries();
      const r = await row(id);
      expect(r.attempts).toBe(i + 1);
      waits.push(Math.round((new Date(r.next_attempt_at).getTime() - Date.now()) / 1000));
    }
    expect(waits.slice(0, 3).map((w) => Math.round(w / 30) * 30)).toEqual([30, 60, 120]);
    const r = await row(id);
    expect(r.status).toBe('GAVE_UP');
    expect(r.last_error).toContain('refused for');
    expect(r.last_error).not.toContain('ravi@company.in');
    await due(id);
    let again = 0;
    globalThis.fetch = (async () => (again++, answer(200))) as any;
    await processDeliveries();
    expect(again).toBe(0);
  });

  it('a phone no longer registered is dropped without retries', async () => {
    await clear();
    const id = await delivery(A);
    globalThis.fetch = (async () => answer(200, { data: { status: 'error', details: { error: 'DeviceNotRegistered' } } })) as any;
    await processDeliveries();
    expect(await row(id)).toMatchObject({ status: 'GAVE_UP', last_error: 'target no longer registered' });
  });

  it('one company\'s failing delivery does not stop another company\'s', async () => {
    await clear();
    const bad = await delivery(A, 'ExponentPushToken[bad]');
    const good = await delivery(B, 'ExponentPushToken[good]');
    globalThis.fetch = (async (_u: string, init: any) => (init.body.includes('[bad]') ? answer(500) : answer(200))) as any;
    await processDeliveries();
    expect((await row(bad)).status).toBe('FAILED');
    expect((await row(good)).status).toBe('SENT');
  });

  it('a process that dies after claiming leaves the delivery to come back, not lost', async () => {
    await clear();
    const id = await delivery(A);
    await q(`UPDATE notification_deliveries SET next_attempt_at = now() + interval '2 minutes' WHERE id = $1`, [id]); // what a claim leaves behind
    let sent = 0;
    globalThis.fetch = (async () => (sent++, answer(200))) as any;
    await processDeliveries();
    expect(sent).toBe(0);
    await due(id);
    await processDeliveries();
    expect(sent).toBe(1);
  });
});

describe('e-mail over a real connection', () => {
  // A small SMTP server on this machine. It proves what the code sends over the wire, not that a provider accepts it.
  let server: net.Server;
  let received: string[];
  const smtp = config.email.smtpUrl;
  beforeAll(async () => {
    server = net.createServer((sock) => {
      let data = false;
      let body = '';
      sock.write('220 local ESMTP\r\n');
      sock.on('data', (chunk) => {
        const text = chunk.toString();
        if (data) {
          body += text;
          if (body.includes('\r\n.\r\n')) {
            data = false;
            received.push(body);
            sock.write('250 queued\r\n');
          }
          return;
        }
        for (const line of text.split('\r\n').filter(Boolean)) {
          if (/^DATA/i.test(line)) { data = true; body = ''; sock.write('354 go\r\n'); }
          else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
      sock.on('error', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    config.email.smtpUrl = smtp;
    resetMailer();
    await new Promise((r) => server.close(r));
  });
  async function mail(to: string) {
    await q(`DELETE FROM notification_deliveries`);
    const n = await one(`INSERT INTO notifications (type, severity, title, body, org_id) VALUES ('NO_SHOW','WARNING','Shift not started','Body text',$1) RETURNING id`, [A.org]);
    return (await one(`INSERT INTO notification_deliveries (notification_id, channel, target) VALUES ($1,'EMAIL',$2) RETURNING id`, [n.id, to])).id as string;
  }

  it('the delivery job sends a real SMTP message and records it', async () => {
    received = [];
    config.email.smtpUrl = `smtp://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    resetMailer();
    const id = await mail('owner@test.local');
    await processDeliveries();
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('owner@test.local');
    expect(received[0]).toContain('[GeoAttend] Shift not started');
    expect(await one(`SELECT status FROM notification_deliveries WHERE id = $1`, [id])).toEqual({ status: 'SENT' });
  });

  it('a mail server that refuses the connection is a recorded failure to retry, not a send', async () => {
    config.email.smtpUrl = 'smtp://127.0.0.1:1';
    resetMailer();
    const id = await mail('owner@test.local');
    await processDeliveries();
    const r = await one(`SELECT status, attempts, last_error FROM notification_deliveries WHERE id = $1`, [id]);
    expect(r).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(r.last_error).toBeTruthy();
  });
});

describe('who an alert goes to', () => {
  const smtp = config.email.smtpUrl;
  let supervisor: any;
  let otherWorkplace: string;
  beforeAll(async () => {
    config.email.smtpUrl = 'smtp://127.0.0.1:1';
    otherWorkplace = (await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, absence_threshold_minutes, org_id) VALUES ('Elsewhere',12.9,77.5,100,'UTC',5,$1) RETURNING id`, [A.org])).id;
    await saveSettingsSection(A.org, 'alerts', { ...DEFAULT_SETTINGS.alerts, emailTypes: ['NO_SHOW', 'APPROVAL_OVERDUE'] }, null);
    supervisor = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) VALUES ($1,'x','ADMIN','Supervisor',$2) RETURNING id, email`, [`sup-${crypto.randomUUID()}@test.local`, A.org]);
    await q(`INSERT INTO administrator_profiles (user_id, access, site_ids) VALUES ($1,'SUPERVISOR',$2)`, [supervisor.id, [A.workplaceId]]);
  });
  afterAll(() => {
    config.email.smtpUrl = smtp;
  });
  const targets = async (id: string) => (await q(`SELECT target FROM notification_deliveries WHERE notification_id = $1 ORDER BY 1`, [id])).map((r) => r.target);
  const raise = (over: any) => withOrg(A.org, async () => notify((await import('../src/db/pool.js')).getPool(), new Outbox(), { severity: 'WARNING', body: 'b', dedupeKey: crypto.randomUUID(), ...over }));

  it('the owner and the supervisor of that site are told', async () => {
    const n = await raise({ type: 'NO_SHOW', workplaceId: A.workplaceId });
    expect(await targets(n.id)).toEqual([A.adminEmail, supervisor.email].sort());
  });

  it('a supervisor of another site is not', async () => {
    const n = await raise({ type: 'NO_SHOW', workplaceId: otherWorkplace });
    expect(await targets(n.id)).toEqual([A.adminEmail]);
  });

  it('an overdue approval goes to owners only', async () => {
    const n = await raise({ type: 'APPROVAL_OVERDUE', workplaceId: A.workplaceId });
    expect(await targets(n.id)).toEqual([A.adminEmail]);
  });

  it('an administrator of another company is never told', async () => {
    const n = await raise({ type: 'NO_SHOW', workplaceId: A.workplaceId });
    expect(await targets(n.id)).not.toContain(B.adminEmail);
  });

  it('the same key never raises a second alert', async () => {
    const key = crypto.randomUUID();
    expect(await raise({ type: 'NO_SHOW', workplaceId: A.workplaceId, dedupeKey: key })).not.toBeNull();
    expect(await raise({ type: 'NO_SHOW', workplaceId: A.workplaceId, dedupeKey: key })).toBeNull();
  });
});

describe('summaries', () => {
  const original = { ...senders };
  afterEach(async () => {
    Object.assign(senders, original);
    await q(`DELETE FROM digest_runs`);
    for (const c of [A, B]) await saveSettingsSection(c.org, 'digest', { ...DEFAULT_SETTINGS.digest, times: [] }, null);
  });
  const monday = (zone = 'UTC') => DateTime.fromISO('2026-11-02T09:30:00', { zone }).toJSDate(); // a Monday
  const digest = (c: Co, over: object) => saveSettingsSection(c.org, 'digest', { ...DEFAULT_SETTINGS.digest, times: [], monthlyReport: false, emailRecipients: ['owner@test.local'], ...over }, null);
  const captured = () => {
    const mail: Array<{ to: string[]; subject: string; csv: string }> = [];
    senders.email = async (to, subject, _text, attachments = []) => {
      mail.push({ to, subject, csv: attachments[0]?.content ?? '' });
      return 'sent';
    };
    return mail;
  };

  it('weekly reports are off unless a company chooses them', async () => {
    await digest(A, {});
    const mail = captured();
    await sweepDigests(monday());
    expect(mail).toEqual([]);
  });

  it('a chosen weekly report goes once, for the week that ended', async () => {
    await digest(A, { weeklyReport: true });
    const mail = captured();
    await sweepDigests(monday());
    await sweepDigests(monday());
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toContain('26 Oct to 1 Nov 2026');
    expect(mail[0]!.csv).toContain('Pending hours (not counted)');
    expect(await one(`SELECT slot FROM digest_runs WHERE org_id = $1`, [A.org])).toEqual({ slot: 'weekly 2026-10-26' });
  });

  it('it is timed in the company\'s own zone', async () => {
    await digest(A, { weeklyReport: true });
    await q(`UPDATE workplaces SET timezone = 'Asia/Kolkata' WHERE org_id = $1`, [A.org]);
    const mail = captured();
    await sweepDigests(DateTime.fromISO('2026-11-02T03:00:00Z').toJSDate()); // 08:30 in India
    expect(mail).toEqual([]);
    await sweepDigests(DateTime.fromISO('2026-11-02T04:00:00Z').toJSDate()); // 09:30 in India
    expect(mail).toHaveLength(1);
    await q(`UPDATE workplaces SET timezone = 'UTC' WHERE org_id = $1`, [A.org]);
  });

  it('a server that was down on Monday catches up by Wednesday, and not after', async () => {
    await digest(A, { weeklyReport: true });
    const mail = captured();
    await sweepDigests(DateTime.fromISO('2026-11-05T10:00:00Z').toJSDate()); // Thursday
    expect(mail).toEqual([]);
    await sweepDigests(DateTime.fromISO('2026-11-04T10:00:00Z').toJSDate()); // Wednesday
    expect(mail).toHaveLength(1);
  });

  it('a monthly report missed on the 1st goes on the 2nd, once', async () => {
    await digest(A, { monthlyReport: true });
    const mail = captured();
    const second = DateTime.fromISO('2026-12-02T10:00:00Z').toJSDate();
    await sweepDigests(second);
    await sweepDigests(second);
    expect(mail.map((m) => m.subject)).toEqual([expect.stringContaining('November 2026')]);
  });

  it('a supervisor gets their own sites and nobody else\'s', async () => {
    const other = (await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, absence_threshold_minutes, org_id) VALUES ('Second Site',12.9,77.5,100,'UTC',5,$1) RETURNING id`, [B.org])).id;
    const otherShift = (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'Day','09:00','17:00','UTC','{1,2,3,4,5,6,7}',10) RETURNING id`, [other])).id;
    const mine = await createEmployee({ workplaceId: B.workplaceId, orgId: B.org });
    const theirs = await createEmployee({ workplaceId: other, orgId: B.org });
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2020-01-01'), ($3,$4,'2020-01-01')`, [mine.id, B.shiftId, theirs.id, otherShift]);
    const names = (await q(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`, [[mine.id, theirs.id]]));
    const nameOf = (id: string) => names.find((n) => n.id === id)!.full_name;
    const sup = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) VALUES ($1,'x','ADMIN','Sup',$2) RETURNING id, email`, [`sup-${crypto.randomUUID()}@test.local`, B.org]);
    await q(`INSERT INTO administrator_profiles (user_id, access, site_ids) VALUES ($1,'SUPERVISOR',$2)`, [sup.id, [B.workplaceId]]);
    await digest(B, { supervisorSummaries: true, emailRecipients: [] });
    const mail = captured();
    await sweepDigests(monday());
    const forSup = mail.filter((m) => m.to.includes(sup.email));
    expect(forSup).toHaveLength(1);
    expect(forSup[0]!.csv).toContain(nameOf(mine.id));
    expect(forSup[0]!.csv).not.toContain(nameOf(theirs.id));
  });

  it('an employee\'s summary keeps pending days out of the count and says so', () => {
    const line = weekLine({ present: 3, scheduled: 5, worked_minutes: 1500, late: 1, pending_days: 2 });
    expect(line).toBe('Last week: present 3 of 5 days, 25.0 hours. Late 1. 2 days waiting for verification, not counted yet.');
  });

  it('employees are told their own week, once, only if the company chose it', async () => {
    const emp = await createEmployee({ workplaceId: A.workplaceId, shiftId: A.shiftId, orgId: A.org });
    await q(`UPDATE employee_shift_assignments SET effective_from = '2020-01-01' WHERE employee_id = $1`, [emp.id]);
    await digest(A, { emailRecipients: [] });
    await sweepDigests(monday());
    expect(await q(`SELECT 1 FROM notifications WHERE employee_id = $1 AND type = 'WEEKLY_SUMMARY'`, [emp.id])).toEqual([]);
    await digest(A, { employeeSummaries: true, emailRecipients: [] });
    await sweepDigests(monday());
    await q(`UPDATE digest_runs SET results = '{}', failed = true, sent_at = now() - interval '6 minutes'`);
    await sweepDigests(monday());
    const told = await q(`SELECT audience, org_id FROM notifications WHERE employee_id = $1 AND type = 'WEEKLY_SUMMARY'`, [emp.id]);
    expect(told).toEqual([{ audience: 'EMPLOYEE', org_id: A.org }]);
  });

  it('a report that cannot be built shows as a failure, is tried again, and another company still gets theirs', async () => {
    await digest(A, { weeklyReport: true });
    await digest(B, { weeklyReport: true, emailRecipients: ['b@test.local'] });
    const mail = captured();
    const reports = await import('../src/modules/reports/reports.routes.js');
    const real = reports.periodSummary;
    const build = vi.spyOn(reports, 'periodSummary').mockImplementation(async (orgId, ...rest) => {
      if (orgId === A.org) throw new Error('report generation failed');
      return real(orgId, ...rest);
    });
    const err = await sweepDigests(monday()).catch((e) => e);
    expect(err).toBeInstanceOf(JobFailures);
    expect(err.failures).toEqual([{ orgId: A.org, message: 'report generation failed' }]);
    expect(await one(`SELECT failed, attempts FROM digest_runs WHERE org_id = $1`, [A.org])).toEqual({ failed: true, attempts: 1 });
    expect(mail.map((m) => m.to[0])).toEqual(['b@test.local']);

    build.mockRestore();
    await q(`UPDATE digest_runs SET sent_at = now() - interval '6 minutes' WHERE org_id = $1`, [A.org]);
    await sweepDigests(monday());
    expect(mail.map((m) => m.to[0]).sort()).toEqual(['b@test.local', 'owner@test.local']);
    expect(await one(`SELECT failed, attempts FROM digest_runs WHERE org_id = $1`, [A.org])).toEqual({ failed: false, attempts: 2 });
  });

  it('one summary failing does not hold up the next in the same company', async () => {
    await digest(A, { weeklyReport: true, monthlyReport: true });
    const sent: string[] = [];
    senders.email = async (_to, subject) => {
      if (subject.includes('November')) throw new Error('monthly failed');
      sent.push(subject);
      return 'sent';
    };
    // 1 December 2026 is a Tuesday: both are due.
    await expect(sweepDigests(DateTime.fromISO('2026-12-01T10:00:00Z').toJSDate())).rejects.toBeInstanceOf(JobFailures);
    expect(sent).toEqual([expect.stringContaining('23 Nov to 29 Nov 2026')]);
  });
});

describe('photo retention', () => {
  const on = config.photoAutoDeleteEnabled;
  afterEach(async () => {
    config.photoAutoDeleteEnabled = on;
    await saveSettingsSection(A.org, 'retention', { ...DEFAULT_SETTINGS.retention }, null);
    invalidateSettings();
  });
  const allow = async () => {
    config.photoAutoDeleteEnabled = true;
    await saveSettingsSection(A.org, 'retention', { ...DEFAULT_SETTINGS.retention, photoAutoDelete: true }, null);
  };
  const file = (key: string) => path.join(config.storage.localDir, key);

  async function photo(c: Co, employeeId: string, sessionId: string, over: { retention?: string | null; status?: string } = {}) {
    const key = `attendance/test/${crypto.randomUUID()}.jpg`;
    fs.mkdirSync(path.dirname(file(key)), { recursive: true });
    fs.writeFileSync(file(key), 'jpeg');
    const p = await one(
      `INSERT INTO attendance_photos (employee_id, session_id, object_key, content_type, declared_bytes, status, idempotency_key, upload_expires_at, retention_until) VALUES ($1,$2,$3,'image/jpeg',4,$4,$5,now(),$6) RETURNING id`,
      [employeeId, sessionId, key, over.status ?? 'ATTACHED', crypto.randomUUID(), over.retention === undefined ? new Date(Date.now() - 86400_000) : over.retention],
    );
    return { id: p.id as string, key };
  }
  const gone = async (p: { id: string; key: string }) => ({ row: (await one(`SELECT status FROM attendance_photos WHERE id = $1`, [p.id])).status, file: fs.existsSync(file(p.key)) });
  const kept = { row: 'ATTACHED', file: true };

  it('both switches off, or either one: nothing is deleted, however overdue, and the count says so', async () => {
    const s = await session(A);
    const p = await photo(A, s.emp.id, s.sessionId);
    expect((await runRetention(null, A.org))?.photosHeld).toBeGreaterThan(0);
    expect(await gone(p)).toEqual(kept);
    config.photoAutoDeleteEnabled = true; // server yes, company no
    await runRetention(null, A.org);
    expect(await gone(p)).toEqual(kept);
    config.photoAutoDeleteEnabled = false; // company yes, server no
    await saveSettingsSection(A.org, 'retention', { ...DEFAULT_SETTINGS.retention, photoAutoDelete: true }, null);
    await runRetention(null, A.org);
    expect(await gone(p)).toEqual(kept);
  });

  it('when both allow it, the file and row go and each deletion is in the audit log', async () => {
    await allow();
    const s = await session(A);
    const p = await photo(A, s.emp.id, s.sessionId);
    const r = await runRetention(null, A.org);
    expect(r?.photosDeleted).toBeGreaterThan(0);
    expect(await gone(p)).toEqual({ row: 'DELETED', file: false });
    const a = await one(`SELECT actor_role, reason, org_id FROM audit_logs WHERE action = 'attendance_photo.delete' AND resource_id = $1`, [p.id]);
    expect(a).toEqual({ actor_role: 'SYSTEM', reason: 'retention policy', org_id: A.org });
  });

  it('a photo with no end date is never touched', async () => {
    await allow();
    const s = await session(A);
    const p = await photo(A, s.emp.id, s.sessionId, { retention: null });
    await runRetention(null, A.org);
    expect(await gone(p)).toEqual(kept);
  });

  it.each([
    ['waiting for verification', 'PENDING_VERIFICATION', ''],
    ['disputed', 'DISPUTED', ''],
    ['under a photo check', 'VERIFIED', `face_review = 'PENDING'`],
  ])('evidence for a record %s stays until it is decided', async (_label, status, over) => {
    await allow();
    const s = await session(A);
    const p = await photo(A, s.emp.id, s.sessionId);
    await attendance(A, s, status, p.id, over);
    await runRetention(null, A.org);
    expect(await gone(p)).toEqual(kept);
  });

  it('evidence for an open request stays, and goes once it is closed', async () => {
    await allow();
    const s = await session(A);
    const p = await photo(A, s.emp.id, s.sessionId);
    const id = await attendance(A, s, 'VERIFIED', p.id);
    const r = await one(`INSERT INTO review_requests (kind, employee_id, attendance_id, reason, requested_by) VALUES ('MANUAL_REVIEW',$1,$2,'Please check',$1) RETURNING id`, [s.emp.id, id]);
    await runRetention(null, A.org);
    expect(await gone(p)).toEqual(kept);
    await q(`UPDATE review_requests SET status = 'CANCELLED' WHERE id = $1`, [r.id]);
    await runRetention(null, A.org);
    expect((await gone(p)).row).toBe('DELETED');
  });

  it('an active face reference stays even with a date in the past', async () => {
    await allow();
    const s = await session(A);
    const p = await photo(A, s.emp.id, s.sessionId);
    await q(`INSERT INTO employee_face_profiles (employee_id, poses, photo_ids, embeddings, model) VALUES ($1,'{front}',$2,'[]','test')`, [s.emp.id, [p.id]]);
    await runRetention(null, A.org);
    expect(await gone(p)).toEqual(kept);
  });

  it('the older single face reference stays too', async () => {
    await allow();
    const s = await session(A);
    const p = await photo(A, s.emp.id, s.sessionId);
    await q(`INSERT INTO employee_faces (employee_id, photo_id) VALUES ($1,$2)`, [s.emp.id, p.id]);
    await runRetention(null, A.org);
    expect(await gone(p)).toEqual(kept);
  });

  it('evidence for overtime not yet decided stays, and goes once it is', async () => {
    await allow();
    const s = await session(A);
    const p = await photo(A, s.emp.id, s.sessionId);
    const id = await attendance(A, s);
    await overtime(A, s, id, p.id);
    await runRetention(null, A.org);
    expect(await gone(p)).toEqual(kept);
    await q(`UPDATE overtime_entries SET status = 'REJECTED', decided_at = now() WHERE attendance_id = $1`, [id]);
    await runRetention(null, A.org);
    expect((await gone(p)).row).toBe('DELETED');
  });

  it('storage failing changes nothing, shows as a failing job, and the next run finishes it', async () => {
    await allow();
    const s = await session(A);
    const good = await photo(A, s.emp.id, s.sessionId);
    const storage = await import('../src/lib/storage.js');
    const down = vi.spyOn(storage, 'deleteObject').mockRejectedValue(new Error('storage unavailable'));
    await expect(runRetention(null, A.org)).rejects.toBeInstanceOf(JobFailures);
    down.mockRestore();
    expect(await gone(good)).toEqual(kept);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'attendance_photo.delete' AND resource_id = $1`, [good.id])).toEqual([]); // nothing claims it went
    const run = await one(`SELECT after_data FROM audit_logs WHERE action = 'retention.run' AND org_id = $1 ORDER BY created_at DESC LIMIT 1`, [A.org]);
    expect(run.after_data.photosFailed).toBeGreaterThan(0);
    await runRetention(null, A.org);
    expect(await gone(good)).toEqual({ row: 'DELETED', file: false });
  });

  it('never touches another company\'s photos', async () => {
    await allow();
    const s = await session(B);
    const p = await photo(B, s.emp.id, s.sessionId);
    await runRetention(null, A.org);
    expect(await gone(p)).toEqual(kept);
  });

  it('attendance records survive retention with their history', async () => {
    await allow();
    const s = await session(A);
    const p = await photo(A, s.emp.id, s.sessionId);
    const id = await attendance(A, s, 'VERIFIED', p.id);
    await runRetention(null, A.org);
    expect((await one(`SELECT verification_status FROM attendance_records WHERE id = $1`, [id])).verification_status).toBe('VERIFIED');
  });
});
