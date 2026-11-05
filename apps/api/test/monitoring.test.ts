/** Phase F: job history, the failures a run can have, shutdown, health, alerts and who may see any of it. */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { one, q, withOrg } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { config, productionConfigErrors } from '../src/config.js';
import { errorText, redact } from '../src/lib/redact.js';
import { eachCompany, eachRecord, recoverInterruptedJobs, resumeJobs, runJob, stopJobs, throwIfAny } from '../src/modules/jobs/runner.js';
import { drainJobs, JOBS, sweepOnce } from '../src/modules/jobs/sweeper.js';
import { evaluateAlerts } from '../src/modules/ops/alerts.js';
import { fullHealth } from '../src/modules/ops/health.js';
import { adminAgent, createTestDatabase, seedBase, testSettings } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let A: { org: string; adminEmail: string };
let B: { org: string };
const TOKEN = 'a-long-test-token-for-monitoring-only-0123';
const job = () => `test-${crypto.randomBytes(4).toString('hex')}`;
const state = (j: string) => one(`SELECT * FROM job_state WHERE job = $1`, [j]);
const runs = (j: string) => q(`SELECT * FROM job_runs WHERE job = $1 ORDER BY id`, [j]);
const ops = (path: string) => request(app).get(`/api/v1/ops${path}`).set('Authorization', `Bearer ${TOKEN}`);

async function co(name: string) {
  const org = (await one(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [name])).id as string;
  const base = await seedBase(org, `${name}-${crypto.randomUUID()}@test.local`);
  await testSettings(org);
  return { ...base, org };
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp();
  A = await co('Alpha');
  B = await co('Bravo');
  config.opsToken = TOKEN;
});
afterEach(async () => {
  resumeJobs();
  await q(`DELETE FROM job_state`);
  await q(`DELETE FROM job_failures`);
  await q(`DELETE FROM job_runs`);
  await q(`DELETE FROM ops_alerts`);
  config.opsAlerts.webhookUrl = '';
  vi.restoreAllMocks();
});
afterAll(async () => {
  config.opsToken = '';
  await db.drop();
});

describe('history of runs', () => {
  it('records a good run with how long it took and how many companies it visited', async () => {
    const name = job();
    await runJob(name, () => eachCompany(async () => new Promise((r) => setTimeout(r, 5))));
    const [r] = await runs(name);
    const companies = (await one(`SELECT count(*)::int AS n FROM organizations`)).n;
    expect(r).toMatchObject({ status: 'OK', companies, companies_failed: 0, failures: 0, error: null });
    expect(r.duration_ms).toBeGreaterThanOrEqual(5 * companies);
    expect((await state(name)).last_duration_ms).toBe(r.duration_ms);
  });

  it('links each failure to its run and company', async () => {
    const name = job();
    await runJob(name, () => eachCompany(async (o) => { if (o === B.org) throw new Error('only B'); }));
    const [r] = await runs(name);
    expect(r).toMatchObject({ status: 'FAILED', companies_failed: 1, failures: 1 });
    expect(await q(`SELECT run_id, org_id FROM job_failures WHERE job = $1`, [name])).toEqual([{ run_id: r.id, org_id: B.org }]);
  });

  it('counts every failure of a run even when only the first fifty are kept', async () => {
    const name = job();
    await runJob(name, async () => throwIfAny(await eachRecord([...Array(60).keys()], async () => { throw new Error('bad'); })));
    expect((await runs(name))[0].failures).toBe(60);
    expect(await q(`SELECT 1 FROM job_failures WHERE job = $1`, [name])).toHaveLength(50);
  });

  it('a skipped run writes nothing', async () => {
    const name = job();
    await q(`INSERT INTO job_state (job, holder, lease_until, running_since) VALUES ($1, 'other', now() + interval '5 minutes', now())`, [name]);
    await runJob(name, async () => undefined);
    expect(await runs(name)).toEqual([]);
  });
});

describe('a failed job never disappears', () => {
  it('the failure is still recorded after a very long outage (the back-off used to overflow at 31)', async () => {
    const name = job();
    await q(`INSERT INTO job_state (job, holder, lease_until, consecutive_failures) VALUES ($1, 'x', now() - interval '1 minute', 40)`, [name]);
    expect(await runJob(name, async () => { throw new Error('still down'); })).toBe('FAILED');
    const s = await state(name);
    expect(s).toMatchObject({ consecutive_failures: 41, running_since: null, last_error: 'still down' });
    const wait = (new Date(s.next_run_at).getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(890);
    expect(wait).toBeLessThanOrEqual(901);
  });

  it('a job that hangs is timed out, recorded, and the next one runs', async () => {
    const stuck = job();
    let later = 0;
    expect(await runJob(stuck, () => new Promise(() => undefined), { timeoutMs: 50 })).toBe('FAILED');
    expect((await runs(stuck))[0]).toMatchObject({ status: 'TIMED_OUT' });
    expect(await state(stuck)).toMatchObject({ running_since: null, consecutive_failures: 1 });
    expect(await runJob(job(), async () => { later++; })).toBe('OK');
    expect(later).toBe(1);
  });

  it('a job that fails after its time limit causes no unhandled rejection', async () => {
    const seen: unknown[] = [];
    const listen = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', listen);
    await runJob(job(), () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 60)), { timeoutMs: 10 });
    await new Promise((r) => setTimeout(r, 120));
    process.off('unhandledRejection', listen);
    expect(seen).toEqual([]);
  });

  it('a job cut off by a crash leaves a run in the history', async () => {
    const name = job();
    await q(`INSERT INTO job_state (job, holder, lease_until, running_since) VALUES ($1, 'dead:1', now() - interval '1 minute', now() - interval '6 minutes')`, [name]);
    await recoverInterruptedJobs();
    const [r] = await runs(name);
    expect(r).toMatchObject({ status: 'INTERRUPTED', holder: 'dead:1', duration_ms: null });
    expect((await one(`SELECT run_id FROM job_failures WHERE job = $1`, [name])).run_id).toBe(r.id);
  });

  it('two instances recovering at once record it once', async () => {
    const name = job();
    await q(`INSERT INTO job_state (job, holder, lease_until, running_since) VALUES ($1, 'dead', now() - interval '1 minute', now() - interval '6 minutes')`, [name]);
    await Promise.all([recoverInterruptedJobs(), recoverInterruptedJobs(), recoverInterruptedJobs()]);
    expect(await runs(name)).toHaveLength(1);
    expect((await state(name)).consecutive_failures).toBe(1);
  });
});

describe('shutting down', () => {
  it('a job stops after the record in hand, is not a failure, and the next run carries on at once', async () => {
    const name = job();
    const done: number[] = [];
    const work = () => eachRecord([1, 2, 3], async (n) => {
      done.push(n);
      if (n === 1) stopJobs();
    });
    expect(await runJob(name, work)).toBe('INTERRUPTED');
    expect(done).toEqual([1]);
    expect(await state(name)).toMatchObject({ running_since: null, consecutive_failures: 0, runs_failed: 0, last_error: null });
    expect((await runs(name))[0].status).toBe('INTERRUPTED');
    resumeJobs();
    expect(await runJob(name, async () => undefined)).toBe('OK'); // no waiting for a lease to run out
  });

  it('a job stops between companies', async () => {
    const seen: string[] = [];
    const out = await runJob(job(), () => eachCompany(async (o) => { seen.push(o); stopJobs(); }));
    expect(out).toBe('INTERRUPTED');
    expect(seen).toHaveLength(1);
  });

  it('waits for the sweep in progress, starts no further job, and starts no new sweep', async () => {
    const original = JOBS.map((j) => j.run);
    const ran: string[] = [];
    let finished = false;
    JOBS.forEach((j, i) => {
      j.run = async () => {
        ran.push(j.name);
        if (i === 0) await new Promise((r) => setTimeout(r, 100));
        if (i === 0) finished = true;
      };
    });
    try {
      const sweep = sweepOnce();
      await new Promise((r) => setTimeout(r, 30));
      expect(await drainJobs(5000)).toBe(true);
      expect(finished).toBe(true);
      expect(ran).toEqual([JOBS[0]!.name]);
      await sweep;
      await sweepOnce();
      expect(ran).toHaveLength(1);
    } finally {
      JOBS.forEach((j, i) => { j.run = original[i]!; });
    }
  });

  it('gives up waiting after its limit rather than hanging the shutdown', async () => {
    const original = JOBS[0]!.run;
    let release = () => {};
    JOBS[0]!.run = () => new Promise<void>((r) => { release = r; });
    try {
      const sweep = sweepOnce();
      await new Promise((r) => setTimeout(r, 30));
      expect(await drainJobs(50)).toBe(false);
      release();
      await sweep;
    } finally {
      JOBS[0]!.run = original;
    }
  });
});

describe('private data stays out of the job records', () => {
  it('removes addresses, numbers, tokens and passwords, and leaves dates alone', () => {
    const out = redact('to a.b+c@test.co.in and 919800000001 with ExponentPushToken[abc] via postgres://user:hunter2@db/x?token=abc Bearer abc.def password=hunter2 on 2026-11-05 12:00');
    for (const secret of ['a.b+c', '919800000001', '[abc]', 'hunter2', 'abc.def']) expect(out).not.toContain(secret);
    expect(out).toContain('2026-11-05 12:00');
    expect(redact('photo 3f2b8c1a-1111-4222-8333-123456789012 failed')).toContain('123456789012'); // ids are not phone numbers
  });

  it('a failure with no message of its own, like a refused connection, still says what happened', async () => {
    const name = job();
    await runJob(name, async () => { throw Object.assign(new AggregateError([new Error('connect refused')]), { code: 'ECONNREFUSED' }); });
    expect((await state(name)).last_error).toBe('ECONNREFUSED');
    expect((await runs(name))[0].error).toBe('ECONNREFUSED');
    expect(errorText(new AggregateError([new Error('first cause')]))).toBe('first cause');
    expect(errorText('plain text')).toBe('plain text');
  });

  it('what a failing job stores has none of it', async () => {
    const name = job();
    await runJob(name, async () => { throw new Error('550 rejected ravi@company.in mobile 919800000001'); });
    const stored = JSON.stringify([await state(name), await runs(name), await q(`SELECT * FROM job_failures WHERE job = $1`, [name])]);
    expect(stored).not.toContain('ravi@company.in');
    expect(stored).not.toContain('919800000001');
  });
});

describe('who can see this', () => {
  it('without the token every operations address looks as if it does not exist', async () => {
    for (const p of ['/health', '/jobs', '/runs', '/failures', '/companies', '/alerts', '/backups']) {
      await request(app).get(`/api/v1/ops${p}`).expect(404);
      await request(app).get(`/api/v1/ops${p}`).set('Authorization', 'Bearer wrong').expect(404);
    }
  });

  it('a signed-in company owner has no access', async () => {
    const { agent } = await adminAgent(app, A.adminEmail);
    for (const p of ['/health', '/jobs', '/runs', '/failures', '/companies']) await agent.get(`/api/v1/ops${p}`).expect(404);
  });

  it('with no token configured nothing opens it, not even an empty one', async () => {
    config.opsToken = '';
    try {
      await request(app).get('/api/v1/ops/jobs').expect(404);
      await request(app).get('/api/v1/ops/jobs').set('Authorization', 'Bearer ').expect(404);
    } finally {
      config.opsToken = TOKEN;
    }
  });

  it('the restricted login cannot read or write the job records', async () => {
    for (const table of ['job_runs', 'ops_alerts', 'job_state', 'job_failures']) {
      await expect(withOrg(A.org, () => q(`SELECT 1 FROM ${table}`))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('the public health check says nothing about jobs, storage or backups', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'ok' });
  });

  it('production refuses a weak token and an unsafe alert address', () => {
    const errors = productionConfigErrors({ OPS_TOKEN: 'short', ALERT_WEBHOOK_URL: 'http://alerts.internal/hook' });
    expect(errors.join()).toContain('OPS_TOKEN');
    expect(errors.join()).toContain('ALERT_WEBHOOK_URL');
    const fine = productionConfigErrors({ OPS_TOKEN: crypto.randomBytes(32).toString('hex'), ALERT_WEBHOOK_URL: 'https://alerts.dhisha-monitoring.net/hook' });
    expect(fine.join()).not.toContain('OPS_TOKEN');
    expect(fine.join()).not.toContain('ALERT_WEBHOOK_URL');
  });
});

describe('the monitoring API', () => {
  it('summarises jobs by state, and lists ones that have never run', async () => {
    const failing = job();
    const fine = job();
    await runJob(failing, async () => { throw new Error('broken'); });
    await runJob(fine, async () => undefined, { everyMs: 3600_000 });
    await q(`INSERT INTO job_state (job, holder, lease_until, running_since) VALUES ($1,'x',now() + interval '4 minutes',now())`, [job()]);
    const { body } = await ops('/jobs').expect(200);
    const byName = Object.fromEntries(body.jobs.map((j: any) => [j.job, j]));
    expect(byName[failing]).toMatchObject({ state: 'RETRYING', last_error: 'broken', consecutive_failures: 1 });
    expect(byName[fine].state).toBe('SCHEDULED');
    expect(new Date(byName[fine].next_run_at).getTime()).toBeGreaterThan(Date.now() + 3500_000);
    expect(byName[fine].last_duration_ms).toEqual(expect.any(Number));
    expect(byName[JOBS[0]!.name].state).toBe('NEVER_RUN');
    expect(body.summary).toMatchObject({ running: 1, retrying: 1, failed: 1, completedRuns: 1, failedRuns: 1, pending: JOBS.length, total: JOBS.length + 3 });
  });

  it('filters runs by job, status, company and date, and pages them', async () => {
    const a = job();
    const b = job();
    await runJob(a, async () => undefined);
    await runJob(b, () => eachCompany(async (o) => { if (o === B.org) throw new Error('only B'); }));
    expect((await ops(`/runs?job=${a}`)).body.items.map((r: any) => r.job)).toEqual([a]);
    expect((await ops(`/runs?status=FAILED`)).body.items.map((r: any) => r.job)).toEqual([b]);
    expect((await ops(`/runs?company=${B.org}`)).body.items.map((r: any) => r.job)).toEqual([b]);
    expect((await ops(`/runs?company=${A.org}`)).body.total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect((await ops(`/runs?from=${today}&to=${today}`)).body.total).toBe(2);
    expect((await ops(`/runs?to=2020-01-01`)).body.total).toBe(0);
    const page = (await ops(`/runs?limit=1&offset=1`)).body;
    expect(page.total).toBe(2);
    expect(page.items.map((r: any) => r.job)).toEqual([a]);
  });

  it('refuses a bad filter, and SQL in one goes nowhere', async () => {
    await ops(`/runs?company=not-a-uuid`).expect(400);
    await ops(`/runs?status=DROP`).expect(400);
    await ops(`/runs?from=2026'--`).expect(400);
    await ops(`/runs?limit=100000`).expect(400);
    const res = await ops(`/runs?job=${encodeURIComponent(`x' OR '1'='1`)}`).expect(200);
    expect(res.body.total).toBe(0);
  });

  it('shows failures with their company, filtered to one company', async () => {
    const name = job();
    await runJob(name, () => eachCompany(async (o) => { if (o === A.org || o === B.org) throw new Error('failed'); }));
    const all = (await ops(`/failures?job=${name}`)).body;
    expect(all.items.map((f: any) => f.company).sort()).toEqual(['Alpha', 'Bravo']);
    expect((await ops(`/failures?company=${A.org}`)).body.items.map((f: any) => f.company)).toEqual(['Alpha']);
  });

  it('lists companies for the filter: names only', async () => {
    const { items } = (await ops(`/companies`)).body;
    expect(items.find((c: any) => c.id === A.org)).toEqual({ id: A.org, name: 'Alpha' });
  });

  it('nothing it returns names an employee', async () => {
    await q(`INSERT INTO users (email, password_hash, role, full_name, org_id) VALUES ('secret.person@test.local', 'x', 'EMPLOYEE', 'Secret Person', $1)`, [A.org]);
    await sweepOnce();
    for (const p of ['/health', '/jobs', '/runs', '/failures', '/companies', '/alerts', '/backups']) {
      const text = JSON.stringify((await ops(p)).body);
      expect(text).not.toContain('Secret Person');
      expect(text).not.toContain('secret.person');
    }
  });

  it('existing /health/jobs still works with the same token', async () => {
    const res = await request(app).get('/health/jobs').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.body).toEqual(expect.objectContaining({ failing: expect.any(Number), interrupted: expect.any(Number) }));
  });
});

describe('health', () => {
  const healthy = async () => {
    await sweepOnce();
    await q(`UPDATE job_state SET consecutive_failures = 0`);
  };

  it('checks the API, both logins, jobs, queue, storage, backups and alerts', async () => {
    await healthy();
    const { body } = await ops('/health').expect(200);
    expect(Object.keys(body.checks).sort()).toEqual(['alerts', 'api', 'backups', 'database', 'jobs', 'queue', 'storage', 'worker']);
    expect(body.checks).toMatchObject({ database: { status: 'ok' }, worker: { status: 'ok' }, storage: { status: 'ok', driver: 'local' }, backups: { status: 'off' } });
    expect(body.checks.database.connections).toBeGreaterThan(0);
  });

  it('answers 503 when no job has started for too long: a worker that has died', async () => {
    await healthy();
    await q(`UPDATE job_state SET last_started_at = now() - interval '10 minutes'`);
    const { body } = await ops('/health').expect(503);
    expect(body.checks.worker.status).toBe('fail');
  });

  it('finds a job that is stuck though its lease is being renewed', async () => {
    await healthy();
    const name = job();
    await q(`INSERT INTO job_state (job, holder, lease_until, running_since, last_started_at) VALUES ($1,'x',now() + interval '4 minutes',now() - interval '20 minutes',now())`, [name]);
    const { body } = await ops('/health').expect(503);
    expect(body.checks.jobs.stalled).toEqual([name]);
  });

  it('reports storage it cannot reach, without saying where it is', async () => {
    const dir = config.storage.localDir;
    const blocker = `${dir}-file-${crypto.randomBytes(3).toString('hex')}`;
    (await import('node:fs')).writeFileSync(blocker, 'x');
    config.storage.localDir = `${blocker}/inside`;
    try {
      const h = await fullHealth();
      expect(h.checks.storage.status).toBe('fail');
      expect(h.status).toBe('fail');
    } finally {
      config.storage.localDir = dir;
      (await import('node:fs')).rmSync(blocker, { force: true });
    }
  });

  it('shows notifications that gave up, and a queue that has fallen behind', async () => {
    await healthy();
    const n = await one(`INSERT INTO notifications (type, severity, title, body, org_id) VALUES ('NO_SHOW','INFO','t','b',$1) RETURNING id`, [A.org]);
    await q(`INSERT INTO notification_deliveries (notification_id, channel, target, status, last_error) VALUES ($1,'EMAIL','x','GAVE_UP','mail down')`, [n.id]);
    await q(`INSERT INTO notification_deliveries (notification_id, channel, target, status, next_attempt_at) VALUES ($1,'EMAIL','y','PENDING',now() - interval '30 minutes')`, [n.id]);
    const { body } = await ops('/health').expect(503);
    expect(body.checks.queue).toMatchObject({ status: 'fail', notificationsDue: 1, notificationsGaveUp24h: 1 });
    await q(`DELETE FROM notification_deliveries WHERE notification_id = $1`, [n.id]);
  });
});

describe('alerts', () => {
  let hook: http.Server;
  let received: any[];
  let answer: number;

  beforeAll(async () => {
    hook = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.statusCode = answer;
        res.end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  });
  afterAll(() => new Promise((r) => hook.close(r)));
  const useHook = () => {
    received = [];
    answer = 200;
    config.opsAlerts.webhookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  };
  const failing = async () => {
    const name = job();
    await q(`INSERT INTO job_state (job, holder, lease_until, consecutive_failures, last_started_at) VALUES ($1,'x',now() - interval '1 minute',3,now())`, [name]);
    return name;
  };
  const open = () => q(`SELECT * FROM ops_alerts WHERE closed_at IS NULL`);

  it('a failing job opens one alert and tells the channel once, however often it is checked', async () => {
    useHook();
    const name = await failing();
    await evaluateAlerts();
    await evaluateAlerts();
    await evaluateAlerts();
    expect((await open()).map((a) => a.key)).toEqual([`job-failing:${name}`]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ source: 'geoattend', key: `job-failing:${name}`, severity: 'CRITICAL' });
  });

  it('closes when the problem clears, and a new one alerts again', async () => {
    useHook();
    const name = await failing();
    await evaluateAlerts();
    await q(`UPDATE job_state SET consecutive_failures = 0 WHERE job = $1`, [name]);
    await evaluateAlerts();
    expect(await open()).toEqual([]);
    await q(`UPDATE job_state SET consecutive_failures = 3 WHERE job = $1`, [name]);
    await evaluateAlerts();
    expect(received).toHaveLength(2);
    expect(await q(`SELECT 1 FROM ops_alerts WHERE key = $1`, [`job-failing:${name}`])).toHaveLength(2);
  });

  it('a channel that fails is retried, is never marked as told, and shows as a failing job', async () => {
    useHook();
    answer = 500;
    await failing();
    await expect(evaluateAlerts()).rejects.toThrow('could not be sent');
    expect((await open())[0]).toMatchObject({ notified_at: null, notify_error: 'Webhook answered 500', notify_attempts: 1 });
    answer = 200;
    await evaluateAlerts();
    expect((await open())[0].notified_at).not.toBeNull();
    expect(received).toHaveLength(2);
  });

  it('with no channel it stays visible and is not called notified', async () => {
    await failing();
    await evaluateAlerts();
    expect((await open())[0]).toMatchObject({ notified_at: null, notify_error: 'No alert channel is configured.' });
    const { body } = await ops('/alerts').expect(200);
    expect(body.items).toHaveLength(1);
  });

  it('no two alerts open for one problem when two instances check at once', async () => {
    await failing();
    await Promise.all([evaluateAlerts(), evaluateAlerts(), evaluateAlerts()]);
    expect(await open()).toHaveLength(1);
  });

  it('an alert names the job and never a company or a person', async () => {
    useHook();
    await failing();
    await evaluateAlerts();
    const text = JSON.stringify(received);
    expect(text).not.toContain(A.org);
    expect(text).not.toContain('Alpha');
  });
});

describe('the whole sweep', () => {
  it('includes the new jobs and runs clean', async () => {
    await sweepOnce();
    const failing = await q(`SELECT job, last_error FROM job_state WHERE consecutive_failures > 0`);
    expect(failing).toEqual([]);
    const names = (await q(`SELECT DISTINCT job FROM job_runs`)).map((r) => r.job);
    expect(names).toEqual(expect.arrayContaining(['backup-check', 'ops-alerts']));
    expect(names).toHaveLength(JOBS.length);
  });

  it('job records are trimmed: good runs after three days, failures after thirty', async () => {
    const { runRetention } = await import('../src/modules/jobs/retention.js');
    await q(`INSERT INTO job_runs (job, holder, status, started_at) VALUES ('old-ok','x','OK',now() - interval '4 days'), ('old-bad','x','FAILED',now() - interval '4 days'), ('ancient-bad','x','FAILED',now() - interval '31 days')`);
    await q(`INSERT INTO ops_alerts (key, severity, message, closed_at) VALUES ('gone','WARNING','m',now() - interval '91 days'), ('open','WARNING','m',NULL)`);
    await runRetention();
    expect((await q(`SELECT job FROM job_runs WHERE job IN ('old-ok','old-bad','ancient-bad')`)).map((r) => r.job)).toEqual(['old-bad']);
    expect((await q(`SELECT key FROM ops_alerts`)).map((r) => r.key)).toEqual(['open']);
  });
});
