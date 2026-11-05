/** Background jobs: held to one company at a time, safe to repeat, and visible when they fail. */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q, withOrg } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { eachCompany, eachRecord, JobFailures, jobHealth, recoverInterruptedJobs, runJob, throwIfAny } from '../src/modules/jobs/runner.js';
import { JOBS, sweepAbsences, sweepOnce, sweepStale } from '../src/modules/jobs/sweeper.js';
import { sweepOverdueApprovals } from '../src/modules/jobs/escalation.js';
import { sweepNoShows } from '../src/modules/jobs/no-show.js';
import { runRetention } from '../src/modules/jobs/retention.js';
import { senders, sweepDigests } from '../src/modules/digest/digest.js';
import { saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { createEmployee, createTestDatabase, seedBase, testSettings } from './helpers.js';

let app: Express;
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

async function openSession(c: Co, over: { lastLocationAgoMin?: number; state?: string } = {}) {
  const emp = await createEmployee({ workplaceId: c.workplaceId, shiftId: c.shiftId, orgId: c.org });
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, last_location_at)
     VALUES ($1,$2,$3,$4,now() - interval '2 hours',now() + interval '4 hours',$5,now() - interval '2 hours',now() - make_interval(mins => $6)) RETURNING id`,
    [emp.id, c.shiftId, c.workplaceId, DateTime.utc().toISODate(), over.state ?? 'PRESENT', over.lastLocationAgoMin ?? 30],
  );
  return { emp, sessionId: s.id as string };
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp();
  A = await co('Alpha');
  B = await co('Bravo');
});
afterEach(async () => {
  await q(`DELETE FROM job_state`);
  await q(`DELETE FROM job_failures`);
  await q(`DROP TRIGGER IF EXISTS test_fail ON notifications`);
  await q(`DROP FUNCTION IF EXISTS test_fail()`);
});
afterAll(async () => {
  await db.drop();
});

const job = () => `test-${crypto.randomBytes(4).toString('hex')}`;
const state = (j: string) => one(`SELECT * FROM job_state WHERE job = $1`, [j]);

describe('company isolation', () => {
  it('a job runs on the restricted login, one company at a time', async () => {
    const seen: any[] = [];
    await eachCompany(async (orgId) => seen.push({ orgId, ...(await one(`SELECT session_user AS login, current_setting('app.org_id') AS org, (SELECT count(DISTINCT org_id)::int FROM users) AS companies`)) }));
    const mine = seen.filter((s) => s.orgId === A.org || s.orgId === B.org);
    expect(mine).toHaveLength(2);
    for (const s of seen) expect(s).toMatchObject({ login: 'geoattend_tenant', org: s.orgId });
    expect(mine.every((s) => s.companies === 1)).toBe(true);
  });

  it('a query in a job that forgets its filter cannot reach another company', async () => {
    const counts = new Map<string, string[]>();
    await eachCompany(async (orgId) => counts.set(orgId, (await q(`SELECT id FROM workplaces`)).map((w) => w.id)));
    expect(counts.get(A.org)).toEqual([A.workplaceId]);
    expect(counts.get(B.org)).toEqual([B.workplaceId]);
  });

  it('a job cannot write into another company', async () => {
    await expect(withOrg(A.org, () => q(`INSERT INTO notifications (type, severity, title, body, org_id) VALUES ('NO_SHOW','INFO','t','b',$1)`, [B.org]))).rejects.toMatchObject({ code: '42501' });
  });

  it('inside a request it stays on that company', async () => {
    const seen: string[] = [];
    await withOrg(A.org, () => eachCompany(async (o) => seen.push(o)));
    expect(seen).toEqual([A.org]);
  });

  it('every alert a job raises goes to the right company', async () => {
    const a = await openSession(A);
    const b = await openSession(B);
    await sweepStale(new Date());
    for (const [c, s] of [[A, a], [B, b]] as const) {
      const n = await q(`SELECT org_id FROM notifications WHERE employee_id = $1 AND type = 'TRACKING_INTERRUPTED'`, [s.emp.id]);
      expect(n.length).toBeGreaterThan(0);
      expect(n.every((x) => x.org_id === c.org)).toBe(true);
    }
  });

  it('overdue approvals, which query no company at all, stay in their own company', async () => {
    const a = await createEmployee({ workplaceId: A.workplaceId, orgId: A.org });
    const b = await createEmployee({ workplaceId: B.workplaceId, orgId: B.org });
    for (const e of [a, b]) await q(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, requested_by, created_at) VALUES ($1,'SICK','2030-01-01','2030-01-01','Fever',$1,now() - interval '3 days')`, [e.id]);
    await sweepOverdueApprovals();
    expect((await one(`SELECT org_id FROM notifications WHERE type = 'APPROVAL_OVERDUE' AND employee_id = $1`, [a.id])).org_id).toBe(A.org);
    expect((await one(`SELECT org_id FROM notifications WHERE type = 'APPROVAL_OVERDUE' AND employee_id = $1`, [b.id])).org_id).toBe(B.org);
  });

  it('retention touches only the company it runs for', async () => {
    const old = await q(`INSERT INTO notifications (type, severity, title, body, org_id, created_at) VALUES ('NO_SHOW','INFO','old','b',$1,now() - interval '5 years'), ('NO_SHOW','INFO','old','b',$2,now() - interval '5 years') RETURNING id, org_id`, [A.org, B.org]);
    await runRetention(null, A.org);
    const left = await q(`SELECT org_id FROM notifications WHERE id = ANY($1::uuid[])`, [old.map((o) => o.id)]);
    expect(left.map((l) => l.org_id)).toEqual([B.org]);
  });
});

describe('one failure stops nothing else', () => {
  it('a company that fails does not stop the next one, and is reported', async () => {
    const reached: string[] = [];
    const err = await eachCompany(async (orgId) => {
      if (orgId === A.org) throw new Error('company A is broken');
      reached.push(orgId);
    }).catch((e) => e);
    expect(reached).toContain(B.org);
    expect(err).toBeInstanceOf(JobFailures);
    expect(err.failures).toEqual([{ orgId: A.org, message: 'company A is broken' }]);
  });

  it('a record that fails does not stop the next one', async () => {
    const done: number[] = [];
    const failures = await eachRecord([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('bad record');
      done.push(n);
    });
    expect(done).toEqual([1, 3]);
    expect(failures).toHaveLength(1);
    expect(() => throwIfAny(failures)).toThrow(JobFailures);
    expect(() => throwIfAny([])).not.toThrow();
  });

  it('a job that fails does not stop the jobs after it', async () => {
    const original = JOBS.map((j) => j.run);
    const ran: string[] = [];
    JOBS.forEach((j, i) => { j.run = async () => { ran.push(j.name); if (i === 0) throw new Error('first job broke'); }; });
    try {
      await sweepOnce();
    } finally {
      JOBS.forEach((j, i) => { j.run = original[i]!; });
    }
    expect(ran).toEqual(JOBS.map((j) => j.name));
    expect((await state(JOBS[0]!.name)).consecutive_failures).toBe(1);
    expect((await state(JOBS[1]!.name)).consecutive_failures).toBe(0);
  });

  it('a record that fails halfway leaves nothing behind, and the others are processed', async () => {
    const good = await openSession(A);
    const bad = await openSession(A);
    // Breaks the alert for one employee: the change of state in the same transaction must not survive.
    await q(`CREATE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.employee_id = '${bad.emp.id}' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await q(`CREATE TRIGGER test_fail BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION test_fail()`);
    await expect(sweepStale(new Date())).rejects.toBeInstanceOf(JobFailures);
    const stateOf = async (id: string) => (await one(`SELECT state FROM tracking_sessions WHERE id = $1`, [id])).state;
    expect(await stateOf(good.sessionId)).toBe('TRACKING_INTERRUPTED');
    expect(await stateOf(bad.sessionId)).toBe('PRESENT');
    expect(await q(`SELECT 1 FROM session_state_transitions WHERE session_id = $1 AND to_state = 'TRACKING_INTERRUPTED'`, [bad.sessionId])).toEqual([]);

    // Once the cause is gone, the retry finishes the work, and only that work.
    await q(`DROP TRIGGER test_fail ON notifications`);
    await sweepStale(new Date());
    expect(await stateOf(bad.sessionId)).toBe('TRACKING_INTERRUPTED');
    expect(await q(`SELECT 1 FROM notifications WHERE employee_id = $1 AND type = 'TRACKING_INTERRUPTED'`, [good.emp.id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM notifications WHERE employee_id = $1 AND type = 'TRACKING_INTERRUPTED'`, [bad.emp.id])).toHaveLength(1);
  });
});

describe('no duplicates', () => {
  it('two instances starting together: only one runs the job', async () => {
    const name = job();
    let runs = 0;
    // The winner holds the job until both others have been refused: no timing involved, so a
    // busy machine cannot let a late caller in after the winner has properly finished.
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const work = async () => {
      runs++;
      await held;
    };
    let refused = 0;
    const outcomes = await Promise.all([1, 2, 3].map(() => runJob(name, work).then((o) => {
      if (o === 'SKIPPED' && ++refused === 2) release();
      return o;
    })));
    expect(runs).toBe(1);
    expect(outcomes.sort()).toEqual(['OK', 'SKIPPED', 'SKIPPED']);
  });

  it('a job held by a live instance is left alone', async () => {
    const name = job();
    await q(`INSERT INTO job_state (job, holder, lease_until, running_since) VALUES ($1, 'another-instance', now() + interval '5 minutes', now())`, [name]);
    let ran = false;
    expect(await runJob(name, async () => { ran = true; })).toBe('SKIPPED');
    expect(ran).toBe(false);
  });

  it('sweeps repeated, or run by two instances at once, alert once', async () => {
    const emp = await createEmployee({ workplaceId: A.workplaceId, orgId: A.org });
    await q(`UPDATE shifts SET start_time = '00:00', end_time = '23:59' WHERE id = $1`, [A.shiftId]);
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2020-01-01')`, [emp.id, A.shiftId]);
    const noon = DateTime.utc().set({ hour: 12, minute: 0 }).toJSDate();
    await Promise.all([sweepNoShows(noon), sweepNoShows(noon), sweepNoShows(noon)]);
    await sweepNoShows(noon);
    expect(await q(`SELECT 1 FROM notifications WHERE employee_id = $1 AND type = 'NO_SHOW' AND audience = 'ADMIN'`, [emp.id])).toHaveLength(1);
  });

  it('an absence reaches prolonged once however often it is swept', async () => {
    const s = await openSession(A, { state: 'TEMPORARILY_AWAY', lastLocationAgoMin: 1 });
    await q(`INSERT INTO absence_intervals (session_id, employee_id, workplace_id, started_at, threshold_minutes) VALUES ($1,$2,$3,now() - interval '30 minutes',15)`, [s.sessionId, s.emp.id, A.workplaceId]);
    await Promise.all([sweepAbsences(), sweepAbsences()]);
    await sweepAbsences();
    expect(await q(`SELECT 1 FROM notifications WHERE employee_id = $1 AND type = 'PROLONGED_ABSENCE' AND dedupe_key NOT LIKE '%:r%'`, [s.emp.id])).toHaveLength(1);
  });
});

describe('retries and recovery', () => {
  it('a failure is recorded, backs off, and clears on success', async () => {
    const name = job();
    expect(await runJob(name, async () => { throw new Error('temporary problem'); })).toBe('FAILED');
    const s = await state(name);
    expect(s).toMatchObject({ consecutive_failures: 1, runs_failed: 1, last_error: 'temporary problem', running_since: null });
    expect(new Date(s.next_run_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect((await q(`SELECT message FROM job_failures WHERE job = $1`, [name])).map((f) => f.message)).toEqual(['temporary problem']);

    let ran = false;
    expect(await runJob(name, async () => { ran = true; })).toBe('SKIPPED'); // still waiting
    expect(ran).toBe(false);

    await q(`UPDATE job_state SET next_run_at = now() WHERE job = $1`, [name]);
    expect(await runJob(name, async () => undefined)).toBe('OK');
    expect(await state(name)).toMatchObject({ consecutive_failures: 0, last_error: null, runs_ok: 1 });
  });

  it('the wait doubles, up to fifteen minutes', async () => {
    const name = job();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      await q(`UPDATE job_state SET next_run_at = now() WHERE job = $1`, [name]);
      await runJob(name, async () => { throw new Error('still broken'); });
      const s = await state(name);
      waits.push(Math.round((new Date(s.next_run_at).getTime() - Date.now()) / 1000 / 30) * 30);
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 900, 900]);
  });

  it('each company\'s failure is recorded against that company', async () => {
    const name = job();
    await runJob(name, () => eachCompany(async (orgId) => { if (orgId === B.org) throw new Error('only B'); }));
    expect(await q(`SELECT org_id, message FROM job_failures WHERE job = $1`, [name])).toEqual([{ org_id: B.org, message: 'only B' }]);
  });

  it('a job the server died in the middle of is detected and run again', async () => {
    const name = job();
    await q(`INSERT INTO job_state (job, holder, lease_until, running_since) VALUES ($1, 'dead-process', now() - interval '1 minute', now() - interval '6 minutes')`, [name]);
    expect(await recoverInterruptedJobs()).toEqual([name]);
    expect(await state(name)).toMatchObject({ running_since: null, consecutive_failures: 1 });
    expect((await q(`SELECT message FROM job_failures WHERE job = $1`, [name]))[0].message).toContain('server stopped');
    expect(await runJob(name, async () => undefined)).toBe('OK');
  });

  it('an interval survives a restart, because it is kept in the database', async () => {
    const name = job();
    expect(await runJob(name, async () => undefined, { everyMs: 3600_000 })).toBe('OK');
    expect(await runJob(name, async () => undefined, { everyMs: 3600_000 })).toBe('SKIPPED');
  });

  it('every real job has a name, and the whole sweep runs clean with two companies', async () => {
    expect(new Set(JOBS.map((j) => j.name)).size).toBe(JOBS.length);
    await sweepOnce();
    const all = await q(`SELECT job, consecutive_failures, last_error FROM job_state`);
    expect(all.filter((j) => j.consecutive_failures > 0)).toEqual([]);
    expect(all.map((j) => j.job).sort()).toEqual(JOBS.map((j) => j.name).sort());
  });
});

describe('summaries', () => {
  const original = { ...senders };
  afterEach(() => {
    Object.assign(senders, original);
  });
  const at = () => DateTime.utc().set({ hour: 10, minute: 20, second: 0, millisecond: 0 }).toJSDate();
  const setup = () => saveSettingsSection(A.org, 'digest', { times: ['10:00'], whatsappNumbers: [], emailRecipients: ['a@test.local'], monthlyReport: false }, null);
  const clear = () => q(`DELETE FROM digest_runs WHERE org_id = $1`, [A.org]);

  it('one that could not be sent is retried, limited times, and shows as a failure', async () => {
    await setup();
    await clear();
    await q(`UPDATE workplaces SET timezone = 'UTC' WHERE org_id = $1`, [A.org]);
    let tries = 0;
    senders.email = async () => { tries++; throw new Error('mail server down'); };
    await expect(sweepDigests(at())).rejects.toBeInstanceOf(JobFailures);
    await sweepDigests(at()).catch(() => undefined); // too soon: not tried again
    expect(tries).toBe(1);
    expect(await one(`SELECT attempts, failed FROM digest_runs WHERE org_id = $1`, [A.org])).toEqual({ attempts: 1, failed: true });

    const later = () => q(`UPDATE digest_runs SET sent_at = now() - interval '6 minutes' WHERE org_id = $1`, [A.org]);
    await later();
    let sent = 0;
    senders.email = async () => (sent++, 'sent');
    await sweepDigests(at());
    expect(sent).toBe(1);
    expect(await one(`SELECT attempts, failed FROM digest_runs WHERE org_id = $1`, [A.org])).toEqual({ attempts: 2, failed: false });
    await later();
    await sweepDigests(at());
    expect(sent).toBe(1); // delivered: never again
  });

  it('gives up after three tries', async () => {
    await setup();
    await clear();
    let tries = 0;
    senders.email = async () => { tries++; throw new Error('mail server down'); };
    for (let i = 0; i < 5; i++) {
      await sweepDigests(at()).catch(() => undefined);
      await q(`UPDATE digest_runs SET sent_at = now() - interval '6 minutes' WHERE org_id = $1`, [A.org]);
    }
    expect(tries).toBe(3);
  });

  it('a server that died before recording the result tries again', async () => {
    await setup();
    await clear();
    const slot = `${DateTime.utc().toISODate()} 10:00`;
    await q(`INSERT INTO digest_runs (org_id, slot, sent_at) VALUES ($1,$2,now() - interval '6 minutes')`, [A.org, slot]); // claimed, no result recorded
    let sent = 0;
    senders.email = async () => (sent++, 'sent');
    await sweepDigests(at());
    expect(sent).toBe(1);
  });
});

describe('monitoring', () => {
  it('counts failing and interrupted jobs', async () => {
    const name = job();
    await runJob(name, async () => { throw new Error('x'); });
    await q(`INSERT INTO job_state (job, holder, lease_until, running_since) VALUES ($1,'dead',now() - interval '1 minute',now())`, [job()]);
    expect(await jobHealth()).toMatchObject({ failing: 1, interrupted: 1 });
  });

  it('the status page needs its token and is off without one, and says nothing about any company', async () => {
    const name = job();
    await runJob(name, () => eachCompany(async () => { throw new Error('secret company detail'); }));
    const before = config.opsToken;
    try {
      config.opsToken = '';
      await request(app).get('/health/jobs').expect(404);
      config.opsToken = 'a-long-test-token-for-monitoring-only';
      await request(app).get('/health/jobs').expect(404);
      await request(app).get('/health/jobs').set('Authorization', 'Bearer wrong').expect(404);
      const res = await request(app).get('/health/jobs').set('Authorization', `Bearer ${config.opsToken}`).expect(200);
      expect(res.body.failing).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(res.body)).not.toContain('secret company detail');
      expect(JSON.stringify(res.body)).not.toContain(A.org);
    } finally {
      config.opsToken = before;
    }
  });
});
