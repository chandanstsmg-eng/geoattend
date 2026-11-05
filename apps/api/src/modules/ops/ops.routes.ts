/**
 * The operations API, for whoever runs the platform: not for companies. It sees every company's job
 * failures, so it sits behind OPS_TOKEN, not a company sign-in: a company owner has no access, and without
 * the token it answers 404, as if it were not there. No employee name, address or location appears here,
 * and failure messages are redacted before they are stored.
 */
import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config.js';
import { asSystem, one, q } from '../../db/pool.js';
import { listBackups } from '../../lib/backups.js';
import { JOBS } from '../jobs/sweeper.js';
import { fullHealth } from './health.js';

const notFound = (res: Response) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } });

export function hasOpsToken(req: Request) {
  const given = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${config.opsToken}`);
  return !!config.opsToken && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const filters = z.object({
  job: z.string().max(64).optional(),
  status: z.enum(['OK', 'FAILED', 'TIMED_OUT', 'INTERRUPTED']).optional(),
  company: z.uuid().optional(),
  from: date,
  to: date,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Parameterised conditions shared by the two history lists. */
function conditions(f: z.infer<typeof filters>, timeColumn: string, company: (n: string) => string) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (n: string) => string, v: unknown) => {
    params.push(v);
    where.push(sql(`$${params.length}`));
  };
  if (f.job) add((n) => `job = ${n}`, f.job);
  if (f.company) add(company, f.company);
  if (f.from) add((n) => `${timeColumn} >= ${n}::date`, f.from);
  if (f.to) add((n) => `${timeColumn} < ${n}::date + 1`, f.to);
  return { where, params };
}

const route = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  asSystem(() => fn(req, res)).catch(next);
};

export const opsRouter = Router();

// Counts wrong tokens only, so monitoring can poll freely and guessing cannot.
opsRouter.use(
  rateLimit({ windowMs: 60_000, limit: config.isTest ? 100_000 : 20, skipSuccessfulRequests: true, requestWasSuccessful: (_req, res) => res.statusCode !== 404, standardHeaders: false, legacyHeaders: false, message: { error: { code: 'NOT_FOUND', message: 'No such endpoint' } }, statusCode: 404 }),
);
opsRouter.use((req, res, next) => (hasOpsToken(req) ? next() : notFound(res)));

opsRouter.get('/health', route(async (_req, res) => {
  const h = await fullHealth();
  res.status(h.status === 'fail' ? 503 : 200).json(h);
}));

opsRouter.get('/jobs', route(async (_req, res) => {
  const rows = await q(
    `SELECT s.job, s.running_since, s.last_started_at, s.last_ok_at, s.last_failed_at, s.last_error, s.next_run_at, s.last_duration_ms, s.consecutive_failures, s.runs_ok, s.runs_failed,
            CASE WHEN s.running_since IS NOT NULL AND s.lease_until >= now() THEN 'RUNNING'
                 WHEN s.running_since IS NOT NULL THEN 'INTERRUPTED'
                 WHEN s.consecutive_failures > 0 AND s.next_run_at > now() THEN 'RETRYING'
                 WHEN s.consecutive_failures > 0 THEN 'FAILED'
                 WHEN s.next_run_at <= now() THEN 'PENDING'
                 ELSE 'SCHEDULED' END AS state
     FROM job_state s ORDER BY s.job`,
  );
  const seen = new Set(rows.map((r) => r.job));
  const jobs = [...rows, ...JOBS.filter((j) => !seen.has(j.name)).map((j) => ({ job: j.name, state: 'NEVER_RUN', runs_ok: 0, runs_failed: 0, consecutive_failures: 0 }))];
  const count = (...states: string[]) => jobs.filter((j) => states.includes(j.state)).length;
  res.json({
    summary: {
      total: jobs.length,
      running: count('RUNNING'),
      pending: count('PENDING', 'NEVER_RUN'),
      retrying: count('RETRYING'),
      failed: jobs.filter((j) => j.consecutive_failures > 0 || j.state === 'INTERRUPTED').length,
      completedRuns: jobs.reduce((n, j) => n + Number(j.runs_ok), 0),
      failedRuns: jobs.reduce((n, j) => n + Number(j.runs_failed), 0),
    },
    jobs,
  });
}));

opsRouter.get('/runs', route(async (req, res) => {
  const f = filters.safeParse(req.query);
  if (!f.success) return res.status(400).json({ error: { code: 'BAD_FILTER', message: 'Check the filters.' } });
  const { where, params } = conditions(f.data, 'started_at', (n) => `EXISTS (SELECT 1 FROM job_failures x WHERE x.run_id = r.id AND x.org_id = ${n})`);
  if (f.data.status) {
    params.push(f.data.status);
    where.push(`status = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await one(`SELECT count(*)::int AS n FROM job_runs r ${clause}`, params);
  const items = await q(
    `SELECT r.id, r.job, r.status, r.started_at, r.finished_at, r.duration_ms, r.companies, r.companies_failed, r.failures, r.error FROM job_runs r ${clause}
     ORDER BY r.started_at DESC, r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.data.limit, f.data.offset],
  );
  res.json({ total: total!.n, items });
}));

opsRouter.get('/failures', route(async (req, res) => {
  const f = filters.safeParse(req.query);
  if (!f.success) return res.status(400).json({ error: { code: 'BAD_FILTER', message: 'Check the filters.' } });
  const { where, params } = conditions(f.data, 'at', (n) => `org_id = ${n}`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await one(`SELECT count(*)::int AS n FROM job_failures ${clause}`, params);
  const items = await q(
    `SELECT x.id, x.job, x.org_id, o.name AS company, x.message, x.at, x.run_id
     FROM (SELECT * FROM job_failures ${clause} ORDER BY at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}) x
     LEFT JOIN organizations o ON o.id = x.org_id ORDER BY x.at DESC, x.id DESC`,
    [...params, f.data.limit, f.data.offset],
  );
  res.json({ total: total!.n, items });
}));

opsRouter.get('/companies', route(async (_req, res) => {
  res.json({ items: await q(`SELECT id, name FROM organizations ORDER BY name LIMIT 1000`) });
}));

opsRouter.get('/alerts', route(async (_req, res) => {
  res.json({ items: await q(`SELECT id, key, severity, message, opened_at, last_seen_at, closed_at, notified_at, notify_error FROM ops_alerts ORDER BY closed_at IS NULL DESC, opened_at DESC LIMIT 100`) });
}));

opsRouter.get('/backups', route(async (_req, res) => {
  const all = await listBackups(config.backups.dir);
  res.json({ monitored: config.backups.maxAgeHours > 0, maxAgeHours: config.backups.maxAgeHours, items: all.slice(0, 50).map(({ location: _hidden, ...b }) => b) });
}));
