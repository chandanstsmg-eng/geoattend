/**
 * How background work runs.
 *
 *  - One company at a time: `eachCompany` runs the work inside `withOrg`, so a job is held to the
 *    same database rules as a request and a query that forgets its filter cannot reach another company.
 *  - One failure stops nothing else: a failing record does not block the next record, a failing
 *    company does not block the next company, and a failing job does not block the next job.
 *  - One runner at a time: `runJob` takes a lease in the database, so several API instances never run
 *    the same job at once. A lease is renewed while the job runs and expires if the process dies.
 *  - Retried with back-off: after a failure a job waits 30 s, doubling to 15 minutes, then runs again.
 *    Every job is safe to repeat: each step re-checks state under a row lock or a unique key.
 *  - Time-limited: a job still running after JOB_TIMEOUT_MS is recorded as failed and the next one
 *    starts. JavaScript cannot cancel the stuck call; it can finish later, and the checks above make that safe.
 *  - Stops cleanly: on shutdown a job finishes the record in hand and is recorded as INTERRUPTED, not
 *    failed, and the next run carries on, because the work is found from database state.
 *  - Recorded: job_runs keeps every run, job_state the latest outcome of each job and job_failures each
 *    failure. None is visible to companies. See docs/BACKGROUND-JOBS.md for how to read them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import os from 'node:os';
import { asSystem, currentOrg, one, q, withOrg } from '../../db/pool.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { errorText, redact } from '../../lib/redact.js';

const HOLDER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
const RENEW_MS = 60_000;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 900;
const FAILURES_KEPT_PER_RUN = 50;

export interface Failure {
  orgId: string | null;
  message: string;
}

export class JobFailures extends Error {
  constructor(public failures: Failure[]) {
    super(`${failures.length} failure${failures.length === 1 ? '' : 's'}: ${failures[0]?.message ?? ''}`);
  }
}

class JobTimedOut extends Error {}

const describe = (err: unknown) => redact(errorText(err)).slice(0, 500);

// What the job in progress has done so far, for its row in job_runs.
const progress = new AsyncLocalStorage<{ companies: number; companiesFailed: number; cut: boolean }>();

let stopping = false;
/** Shutdown: jobs finish the record in hand and stop. */
export const stopJobs = () => {
  stopping = true;
};
export const resumeJobs = () => {
  stopping = false;
};
export const jobsStopping = () => stopping;

const stopHere = () => {
  const p = progress.getStore();
  if (stopping && p) p.cut = true;
  return stopping && !!p;
};

/** Runs `fn` for each record; a record that fails is logged and returned, and the rest still run. */
export async function eachRecord<T>(records: T[], fn: (record: T) => Promise<unknown>): Promise<Failure[]> {
  const failures: Failure[] = [];
  for (const r of records) {
    if (stopHere()) break;
    try {
      await fn(r);
    } catch (err) {
      logger.error({ err, orgId: currentOrg() }, 'background job: one record failed');
      failures.push({ orgId: currentOrg(), message: describe(err) });
    }
  }
  return failures;
}

/** Call last, after anything that must happen anyway: reports the failures `eachRecord` gathered. */
export function throwIfAny(failures: Failure[]) {
  if (failures.length) throw new JobFailures(failures);
}

const allCompanies = async () => (await q<{ id: string }>(`SELECT id FROM organizations ORDER BY created_at, id`)).map((o) => o.id);

/**
 * Runs `fn` once per company, restricted to that company. `companies` can narrow the list to those
 * with something to do. Inside a request (the demo simulator) it runs for that company only.
 */
export async function eachCompany(fn: (orgId: string) => Promise<unknown>, companies: () => Promise<string[]> = allCompanies) {
  const current = currentOrg();
  const list = current ? [current] : await asSystem(companies);
  const stats = progress.getStore();
  const failures: Failure[] = [];
  for (const orgId of list) {
    if (stopHere()) break;
    if (stats) stats.companies++;
    try {
      await withOrg(orgId, () => fn(orgId));
    } catch (err) {
      if (stats) stats.companiesFailed++;
      if (err instanceof JobFailures) failures.push(...err.failures);
      else {
        logger.error({ err, orgId }, 'background job failed for one company');
        failures.push({ orgId, message: describe(err) });
      }
    }
  }
  throwIfAny(failures);
}

const DIED = 'Did not finish: the server stopped while it was running.';

/** Jobs that started and never finished: the process died. Their lease has run out, so they can run again. */
export async function recoverInterruptedJobs() {
  return asSystem(async () => {
    const lost = await q(
      `WITH before AS (SELECT job, running_since, holder FROM job_state WHERE running_since IS NOT NULL AND lease_until < now() FOR UPDATE)
       UPDATE job_state s SET running_since = NULL, last_failed_at = now(), last_error = $1,
         consecutive_failures = s.consecutive_failures + 1, runs_failed = s.runs_failed + 1
       FROM before b WHERE s.job = b.job RETURNING s.job, b.running_since, b.holder`,
      [DIED],
    );
    for (const { job, running_since, holder } of lost) {
      logger.error({ job }, 'background job did not finish; it will run again');
      const run = await one(`INSERT INTO job_runs (job, holder, status, started_at, error) VALUES ($1, $2, 'INTERRUPTED', $3, $4) RETURNING id`, [job, holder, running_since, DIED]);
      await q(`INSERT INTO job_failures (job, message, run_id) VALUES ($1, $2, $3)`, [job, DIED, run?.id ?? null]);
    }
    return lost.map((r) => r.job as string);
  });
}

export type JobOutcome = 'OK' | 'FAILED' | 'SKIPPED' | 'INTERRUPTED';

async function withinLimit(work: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimedOut(`Stopped waiting after ${Math.round(ms / 1000)} seconds.`)), ms);
  });
  work.catch(() => undefined); // if it fails after the limit, nobody is listening
  try {
    await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a job if no other instance is running it and it is due. `everyMs` spaces out jobs that should
 * not run on every tick; the time is kept in the database, so a restart does not reset it.
 */
export async function runJob(job: string, fn: () => Promise<unknown>, opts: { everyMs?: number; timeoutMs?: number } = {}): Promise<JobOutcome> {
  return asSystem(async () => {
    const lease = config.jobs.leaseSeconds;
    const held = await one(
      `INSERT INTO job_state (job, holder, lease_until, running_since, last_started_at) VALUES ($1, $2, now() + make_interval(secs => $3), now(), now())
       ON CONFLICT (job) DO UPDATE SET holder = $2, lease_until = now() + make_interval(secs => $3), running_since = now(), last_started_at = now()
       WHERE job_state.lease_until < now() AND job_state.next_run_at <= now()
       RETURNING job`,
      [job, HOLDER, lease],
    );
    if (!held) return 'SKIPPED';
    const started = new Date();
    const stats = { companies: 0, companiesFailed: 0, cut: false };
    let took = 0;
    const renew = setInterval(() => {
      void q(`UPDATE job_state SET lease_until = now() + make_interval(secs => $3) WHERE job = $1 AND holder = $2`, [job, HOLDER, lease]).catch(() => undefined);
    }, Math.min(RENEW_MS, (lease * 1000) / 3));
    renew.unref();
    const history = (status: string, failures: number, error: string | null) =>
      one(
        `INSERT INTO job_runs (job, holder, status, started_at, duration_ms, companies, companies_failed, failures, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [job, HOLDER, status, started, took, stats.companies, stats.companiesFailed, failures, error],
      );
    try {
      await withinLimit(progress.run(stats, fn), opts.timeoutMs ?? config.jobs.timeoutMs);
      took = Date.now() - started.getTime();
      if (stats.cut) {
        // Stopped for a shutdown. Not a failure, and not finished: the next run picks up the rest at once.
        await q(`UPDATE job_state SET running_since = NULL, lease_until = now(), last_duration_ms = $3, next_run_at = now() WHERE job = $1 AND holder = $2`, [job, HOLDER, took]);
        await history('INTERRUPTED', 0, 'Stopped for a shutdown; the next run continues.');
        return 'INTERRUPTED';
      }
      await q(
        `UPDATE job_state SET running_since = NULL, lease_until = now(), last_ok_at = now(), last_error = NULL, consecutive_failures = 0, last_duration_ms = $4,
           runs_ok = runs_ok + 1, next_run_at = now() + make_interval(secs => $3) WHERE job = $1 AND holder = $2`,
        [job, HOLDER, (opts.everyMs ?? 0) / 1000, took],
      );
      await history('OK', 0, null);
      return 'OK';
    } catch (err) {
      took = Date.now() - started.getTime();
      const failures: Failure[] = err instanceof JobFailures ? err.failures : [{ orgId: null, message: describe(err) }];
      logger.error({ job, failures: failures.length, first: failures[0]?.message }, 'background job failed; it will be retried');
      await q(
        // The power is capped: after 31 failures in a row (a long outage) it would no longer fit an integer, and this record would fail too.
        `UPDATE job_state SET running_since = NULL, lease_until = now(), last_failed_at = now(), last_error = $3, consecutive_failures = consecutive_failures + 1, runs_failed = runs_failed + 1, last_duration_ms = $6,
           next_run_at = now() + make_interval(secs => LEAST($4, $5 * power(2, LEAST(consecutive_failures, 10))::int)) WHERE job = $1 AND holder = $2`,
        [job, HOLDER, describe(err), BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS, took],
      ).catch((e) => logger.error({ err: e, job }, 'could not record a job failure'));
      const run = await history(err instanceof JobTimedOut ? 'TIMED_OUT' : 'FAILED', failures.length, describe(err)).catch(() => null);
      for (const f of failures.slice(0, FAILURES_KEPT_PER_RUN)) await q(`INSERT INTO job_failures (job, org_id, message, run_id) VALUES ($1, $2, $3, $4)`, [job, f.orgId, f.message, run?.id ?? null]).catch(() => undefined);
      return 'FAILED';
    } finally {
      clearInterval(renew);
    }
  });
}

/** For /health: counts only, nothing about any company. */
export async function jobHealth() {
  const r = await asSystem(() =>
    one(`SELECT count(*) FILTER (WHERE consecutive_failures > 0)::int AS failing,
                count(*) FILTER (WHERE running_since IS NOT NULL AND lease_until < now())::int AS interrupted,
                max(last_ok_at) AS last_ok_at
         FROM job_state`),
  );
  return { failing: r?.failing ?? 0, interrupted: r?.interrupted ?? 0, lastOkAt: r?.last_ok_at ?? null };
}
