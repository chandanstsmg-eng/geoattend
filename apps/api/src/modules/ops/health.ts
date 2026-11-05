/**
 * The whole system's condition, for whoever runs it. Counts and job names only: nothing here says
 * anything about an employee, and the only company detail is a failure's company id on the operations page.
 */
import { asSystem, one, q, withOrg } from '../../db/pool.js';
import { config } from '../../config.js';
import { backupHealth } from '../../lib/backups.js';
import { checkStorage } from '../../lib/storage.js';
import { redact } from '../../lib/redact.js';

type Level = 'ok' | 'warn' | 'fail' | 'off';
const CHECK_LIMIT_MS = 5_000;
/** A job still running after this, with its lease being renewed, is stuck rather than slow. */
const STALLED_AFTER_MIN = 15;
const QUEUE_BEHIND_MIN = 10;
const NOBODY_UUID = '00000000-0000-0000-0000-000000000000';

async function guarded<T extends { status: Level }>(name: string, fn: () => Promise<T>): Promise<T | { status: 'fail'; message: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not answer within ${CHECK_LIMIT_MS / 1000} seconds`)), CHECK_LIMIT_MS);
      }),
    ]);
  } catch (err) {
    return { status: 'fail', message: redact(String((err as Error)?.message ?? err)).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

async function database() {
  const t = Date.now();
  const r = await asSystem(() => one(`SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections, current_setting('max_connections')::int AS max_connections`));
  await withOrg(NOBODY_UUID, () => q(`SELECT 1`)); // the restricted login must work too
  const used = r!.connections / r!.max_connections;
  return { status: (used > 0.85 ? 'warn' : 'ok') as Level, latencyMs: Date.now() - t, connections: r!.connections, maxConnections: r!.max_connections };
}

async function worker(now: Date) {
  const r = await asSystem(() => one(`SELECT max(last_started_at) AS last_tick FROM job_state`));
  const silentAfterMs = Math.max(120_000, config.sweeperIntervalMs * 4);
  if (!r?.last_tick) return { status: 'warn' as Level, lastTickAt: null, message: 'No job has run yet.' };
  const silentMs = now.getTime() - new Date(r.last_tick).getTime();
  const alive = silentMs <= silentAfterMs;
  return { status: (alive ? 'ok' : 'fail') as Level, lastTickAt: r.last_tick, message: alive ? 'Jobs are running.' : `No job has started for ${Math.round(silentMs / 60_000)} minutes.` };
}

async function jobs() {
  const r = await asSystem(() =>
    one(`SELECT count(*) FILTER (WHERE consecutive_failures > 0)::int AS failing,
                coalesce(array_agg(job ORDER BY job) FILTER (WHERE consecutive_failures >= 3), '{}') AS failing_repeatedly,
                coalesce(array_agg(job ORDER BY job) FILTER (WHERE running_since IS NOT NULL AND lease_until < now()), '{}') AS interrupted,
                coalesce(array_agg(job ORDER BY job) FILTER (WHERE running_since < now() - make_interval(mins => ${STALLED_AFTER_MIN}) AND lease_until >= now()), '{}') AS stalled,
                max(last_ok_at) AS last_ok_at
         FROM job_state`),
  );
  const level: Level = r!.stalled.length || r!.failing_repeatedly.length ? 'fail' : r!.failing || r!.interrupted.length ? 'warn' : 'ok';
  return { status: level, failing: r!.failing as number, failingRepeatedly: r!.failing_repeatedly as string[], interrupted: r!.interrupted as string[], stalled: r!.stalled as string[], lastOkAt: r!.last_ok_at };
}

async function queue() {
  const r = await asSystem(() =>
    one(`SELECT (SELECT count(*)::int FROM notification_deliveries WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now()) AS due,
                (SELECT extract(epoch FROM now() - min(next_attempt_at))::int FROM notification_deliveries WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now()) AS oldest_seconds,
                (SELECT count(*)::int FROM notification_deliveries WHERE status = 'GAVE_UP' AND last_error <> 'target no longer registered' AND created_at > now() - interval '24 hours') AS gave_up,
                (SELECT count(*)::int FROM digest_runs WHERE failed AND attempts >= 3 AND sent_at > now() - interval '7 days') AS reports_gave_up`),
  );
  const behind = (r!.oldest_seconds ?? 0) > QUEUE_BEHIND_MIN * 60;
  return { status: (behind ? 'fail' : r!.gave_up || r!.reports_gave_up ? 'warn' : 'ok') as Level, notificationsDue: r!.due as number, oldestDueSeconds: (r!.oldest_seconds ?? 0) as number, notificationsGaveUp24h: r!.gave_up as number, reportsGaveUp7d: r!.reports_gave_up as number };
}

export async function fullHealth(now = new Date()) {
  const [db, wk, jb, qu, st, bk, al] = await Promise.all([
    guarded('The database', database),
    guarded('The job table', () => worker(now)),
    guarded('The job table', jobs),
    guarded('The notification queue', queue),
    guarded('Photo storage', async () => {
      await checkStorage();
      return { status: 'ok' as Level, driver: config.storage.driver };
    }),
    guarded('The backup folder', () => backupHealth(config.backups.dir, config.backups.maxAgeHours, now)),
    guarded('The alert table', async () => {
      const r = await asSystem(() => one(`SELECT count(*)::int AS open, count(*) FILTER (WHERE notified_at IS NULL)::int AS not_notified FROM ops_alerts WHERE closed_at IS NULL`));
      return { status: (r!.open ? 'warn' : 'ok') as Level, open: r!.open as number, notNotified: r!.not_notified as number, channel: !!(config.opsAlerts.webhookUrl || (config.opsAlerts.emails.length && config.email.smtpUrl)) };
    }),
  ]);
  const checks = { api: { status: 'ok' as Level, uptimeSeconds: Math.round(process.uptime()) }, database: db, worker: wk, jobs: jb, queue: qu, storage: st, backups: bk, alerts: al };
  const levels = Object.values(checks).map((c) => c.status);
  return { status: levels.includes('fail') ? 'fail' : levels.includes('warn') ? 'warn' : 'ok', checkedAt: now.toISOString(), checks };
}
