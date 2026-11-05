/**
 * Operational alerts. A problem opens one alert, however long it lasts; it closes when the problem clears.
 * An alert is marked as notified only after a channel accepted it, so a failed send is tried again.
 * Nothing here can raise the alarm if the process running it is down: an outside monitor must watch
 * GET /api/v1/ops/health as well (docs/BACKGROUND-JOBS.md).
 */
import { asSystem, q } from '../../db/pool.js';
import { config } from '../../config.js';
import { backupHealth } from '../../lib/backups.js';
import { logger } from '../../lib/logger.js';
import { mailer } from '../../lib/mailer.js';
import { redact } from '../../lib/redact.js';
import { fullHealth } from './health.js';

const MAX_NOTIFY_ATTEMPTS = 20;
type Wanted = { key: string; severity: 'WARNING' | 'CRITICAL'; message: string };

/** The hourly check. Fails while backups are in doubt, so it also shows on the job list. */
export async function checkBackups(now = new Date()) {
  const h = await backupHealth(config.backups.dir, config.backups.maxAgeHours, now);
  if (h.status === 'fail') throw new Error(h.message);
}

function problems(h: Awaited<ReturnType<typeof fullHealth>>): Wanted[] {
  const c: any = h.checks;
  const out: Wanted[] = [];
  const critical = (key: string, message: string) => out.push({ key, severity: 'CRITICAL', message });
  const warning = (key: string, message: string) => out.push({ key, severity: 'WARNING', message });
  if (c.database.status === 'fail') critical('database', `Database check failed: ${c.database.message}`);
  if (c.storage.status === 'fail') critical('storage', `Photo storage check failed: ${c.storage.message}`);
  if (c.worker.status === 'fail') critical('worker', c.worker.message);
  for (const job of c.jobs.failingRepeatedly ?? []) critical(`job-failing:${job}`, `Job ${job} has failed at least three times in a row.`);
  for (const job of c.jobs.stalled ?? []) critical(`job-stalled:${job}`, `Job ${job} has been running for over 15 minutes.`);
  for (const job of c.jobs.interrupted ?? []) warning(`job-interrupted:${job}`, `Job ${job} stopped part way through.`);
  if (c.queue.status === 'fail') critical('queue-behind', `Notifications are behind: ${c.queue.notificationsDue} due, the oldest for ${c.queue.oldestDueSeconds} seconds.`);
  if (c.queue.notificationsGaveUp24h) warning('notifications-gave-up', `${c.queue.notificationsGaveUp24h} notifications could not be delivered in the last 24 hours.`);
  if (c.queue.reportsGaveUp7d) warning('reports-gave-up', `${c.queue.reportsGaveUp7d} summaries could not be sent in the last 7 days.`);
  if (c.backups.status === 'fail') critical('backup', c.backups.message);
  else if (c.backups.status === 'warn') warning('backup', c.backups.message);
  return out;
}

async function send(a: { key: string; severity: string; message: string; opened_at: Date }) {
  const { webhookUrl, emails } = config.opsAlerts;
  if (webhookUrl) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'geoattend', key: a.key, severity: a.severity, message: a.message, openedAt: a.opened_at }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Webhook answered ${res.status}`);
    return true;
  }
  if (emails.length && config.email.smtpUrl) {
    await mailer().sendMail({ from: config.email.from, to: emails, subject: `[GeoAttend ${a.severity}] ${a.key}`, text: `${a.message}\n\nOpened: ${new Date(a.opened_at).toISOString()}` });
    return true;
  }
  return false;
}

export async function evaluateAlerts(now = new Date()) {
  return asSystem(async () => {
    const wanted = problems(await fullHealth(now));
    for (const w of wanted) {
      await q(
        `INSERT INTO ops_alerts (key, severity, message) VALUES ($1, $2, $3)
         ON CONFLICT (key) WHERE closed_at IS NULL DO UPDATE SET last_seen_at = now(), message = EXCLUDED.message, severity = EXCLUDED.severity`,
        [w.key, w.severity, w.message],
      );
    }
    await q(`UPDATE ops_alerts SET closed_at = now() WHERE closed_at IS NULL AND NOT (key = ANY($1))`, [wanted.map((w) => w.key)]);

    const unsent = await q(`SELECT * FROM ops_alerts WHERE closed_at IS NULL AND notified_at IS NULL AND notify_attempts < $1 ORDER BY opened_at`, [MAX_NOTIFY_ATTEMPTS]);
    let failed = 0;
    for (const a of unsent) {
      try {
        if (await send(a)) await q(`UPDATE ops_alerts SET notified_at = now(), notify_error = NULL, notify_attempts = notify_attempts + 1 WHERE id = $1`, [a.id]);
        else if (a.notify_attempts === 0) {
          logger.error({ alert: a.key, severity: a.severity }, a.message); // no channel: the log and the operations page are all there is
          await q(`UPDATE ops_alerts SET notify_attempts = 1, notify_error = 'No alert channel is configured.' WHERE id = $1`, [a.id]);
        }
      } catch (err) {
        failed++;
        await q(`UPDATE ops_alerts SET notify_attempts = notify_attempts + 1, notify_error = $2 WHERE id = $1`, [a.id, redact(String((err as Error).message)).slice(0, 300)]);
      }
    }
    if (failed) throw new Error(`${failed} alert${failed === 1 ? '' : 's'} could not be sent.`);
    return wanted;
  });
}
