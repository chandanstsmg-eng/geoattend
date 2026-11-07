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
 *  - Recorded: job_state holds the latest outcome of each job and job_failures each failure. Neither
 *    is visible to companies. /health reports the count of failing jobs; `npm run jobs:status` the detail.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { asSystem, currentOrg, one, q, withOrg } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';

const HOLDER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
const LEASE_SECONDS = 300;
const RENEW_MS = 60_000;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 900;

export interface Failure {
  orgId: string | null;
  message: string;
}

export class JobFailures extends Error {
  constructor(public failures: Failure[]) {
    super(`${failures.length} failure${failures.length === 1 ? '' : 's'}: ${failures[0]?.message ?? ''}`);
  }
}

const describe = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 500);

/** Runs `fn` for each record; a record that fails is logged and returned, and the rest still run. */
export async function eachRecord<T>(records: T[], fn: (record: T) => Promise<unknown>): Promise<Failure[]> {
  const failures: Failure[] = [];
  for (const r of records) {
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
  const failures: Failure[] = [];
  for (const orgId of list) {
    try {
      await withOrg(orgId, () => fn(orgId));
    } catch (err) {
      if (err instanceof JobFailures) failures.push(...err.failures);
      else {
        logger.error({ err, orgId }, 'background job failed for one company');
        failures.push({ orgId, message: describe(err) });
      }
    }
  }
  throwIfAny(failures);
}

/** Jobs that started and never finished: the process died. Their lease has run out, so they can run again. */
export async function recoverInterruptedJobs() {
  return asSystem(async () => {
    const lost = await q(
      `UPDATE job_state SET running_since = NULL, last_failed_at = now(), last_error = 'Did not finish: the server stopped while it was running.',
         consecutive_failures = consecutive_failures + 1, runs_failed = runs_failed + 1
       WHERE running_since IS NOT NULL AND lease_until < now() RETURNING job`,
    );
    for (const { job } of lost) {
      logger.error({ job }, 'background job did not finish; it will run again');
      await q(`INSERT INTO job_failures (job, message) VALUES ($1, 'Did not finish: the server stopped while it was running.')`, [job]);
    }
    return lost.map((r) => r.job as string);
  });
}

export type JobOutcome = 'OK' | 'FAILED' | 'SKIPPED';

/**
 * Runs a job if no other instance is running it and it is due. `everyMs` spaces out jobs that should
 * not run on every tick; the time is kept in the database, so a restart does not reset it.
 */
export async function runJob(job: string, fn: () => Promise<unknown>, opts: { everyMs?: number } = {}): Promise<JobOutcome> {
  return asSystem(async () => {
    const held = await one(
      `INSERT INTO job_state (job, holder, lease_until, running_since, last_started_at) VALUES ($1, $2, now() + make_interval(secs => $3), now(), now())
       ON CONFLICT (job) DO UPDATE SET holder = $2, lease_until = now() + make_interval(secs => $3), running_since = now(), last_started_at = now()
       WHERE job_state.lease_until < now() AND job_state.next_run_at <= now()
       RETURNING job`,
      [job, HOLDER, LEASE_SECONDS],
    );
    if (!held) return 'SKIPPED';
    const renew = setInterval(() => {
      void q(`UPDATE job_state SET lease_until = now() + make_interval(secs => $3) WHERE job = $1 AND holder = $2`, [job, HOLDER, LEASE_SECONDS]).catch(() => undefined);
    }, RENEW_MS);
    renew.unref();
    try {
      await fn();
      await q(
        `UPDATE job_state SET running_since = NULL, lease_until = now(), last_ok_at = now(), last_error = NULL, consecutive_failures = 0,
           runs_ok = runs_ok + 1, next_run_at = now() + make_interval(secs => $3) WHERE job = $1 AND holder = $2`,
        [job, HOLDER, (opts.everyMs ?? 0) / 1000],
      );
      return 'OK';
    } catch (err) {
      const failures: Failure[] = err instanceof JobFailures ? err.failures : [{ orgId: null, message: describe(err) }];
      logger.error({ job, failures: failures.length, first: failures[0]?.message }, 'background job failed; it will be retried');
      await q(
        `UPDATE job_state SET running_since = NULL, lease_until = now(), last_failed_at = now(), last_error = $3, consecutive_failures = consecutive_failures + 1, runs_failed = runs_failed + 1,
           next_run_at = now() + make_interval(secs => LEAST($4, $5 * power(2, consecutive_failures)::int)) WHERE job = $1 AND holder = $2`,
        [job, HOLDER, describe(err), BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS],
      ).catch((e) => logger.error({ err: e, job }, 'could not record a job failure'));
      for (const f of failures.slice(0, 50)) await q(`INSERT INTO job_failures (job, org_id, message) VALUES ($1, $2, $3)`, [job, f.orgId, f.message]).catch(() => undefined);
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
