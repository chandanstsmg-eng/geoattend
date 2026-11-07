/**
 * Outbound delivery of persisted notifications with retry and back-off.
 * Channels are optional and only used when configured:
 *   WEB_PUSH  — admin browsers (VAPID keys)
 *   EMAIL     — SMTP_URL
 *   EXPO_PUSH — employee devices via the Expo push service (FCM/APNs underneath)
 */
import webpush from 'web-push';
import { config } from '../../config.js';
import { q } from '../../db/pool.js';
import { eachCompany } from '../jobs/runner.js';
import { logger } from '../../lib/logger.js';
import { mailer } from '../../lib/mailer.js';
import { errorText, redact } from '../../lib/redact.js';

const MAX_ATTEMPTS = 6;
const SEND_TIMEOUT_MS = 15_000;
/** A claimed delivery is left alone this long, in case the process dies in the middle of sending it. */
const CLAIM_SECONDS = 120;

if (config.push.vapidPublicKey && config.push.vapidPrivateKey) {
  webpush.setVapidDetails(config.push.vapidSubject, config.push.vapidPublicKey, config.push.vapidPrivateKey);
}

async function sendOne(d: any) {
  const payload = { title: d.title, body: d.body, type: d.type, severity: d.severity, notificationId: d.notification_id, createdAt: d.created_at };
  if (d.channel === 'WEB_PUSH') {
    const sub = (await q('SELECT * FROM web_push_subscriptions WHERE id = $1', [d.target]))[0];
    if (!sub) return 'GONE';
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600, timeout: SEND_TIMEOUT_MS });
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await q('DELETE FROM web_push_subscriptions WHERE id = $1', [sub.id]);
        return 'GONE';
      }
      throw err;
    }
    return 'SENT';
  }
  if (d.channel === 'EMAIL') {
    await mailer().sendMail({
      from: config.email.from,
      to: d.target,
      subject: `[GeoAttend] ${d.severity === 'CRITICAL' ? '‼ ' : ''}${d.title}`,
      text: `${d.body}\n\nTime: ${new Date(d.created_at).toISOString()}\nType: ${d.type}\nSeverity: ${d.severity}\n\nOpen the GeoAttend dashboard for details.`,
    });
    return 'SENT';
  }
  if (d.channel === 'EXPO_PUSH') {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(config.push.expoAccessToken ? { Authorization: `Bearer ${config.push.expoAccessToken}` } : {}),
      },
      body: JSON.stringify({ to: d.target, title: d.title, body: d.body, data: { type: d.type, sessionId: d.session_id }, priority: 'high', channelId: 'attendance' }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.data?.status === 'error') {
      if (json?.data?.details?.error === 'DeviceNotRegistered') {
        await q('UPDATE device_registrations SET push_token = NULL WHERE push_token = $1', [d.target]);
        return 'GONE';
      }
      throw new Error(json?.data?.message ?? `Expo push HTTP ${res.status}`);
    }
    return 'SENT';
  }
  throw new Error(`Unknown channel ${d.channel}`);
}

/** Companies with something to send. */
const companiesWithDeliveries = async () =>
  (await q(`SELECT DISTINCT n.org_id FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE d.status IN ('PENDING', 'FAILED') AND d.next_attempt_at <= now()`)).map((r) => r.org_id as string);

export const processDeliveries = (limit = 25) => eachCompany(() => deliveriesForCompany(limit), companiesWithDeliveries);

async function deliveriesForCompany(limit: number) {
  const due = await q(
    `SELECT d.*, n.title, n.body, n.type, n.severity, n.created_at, n.session_id
     FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
     WHERE d.status IN ('PENDING', 'FAILED') AND d.next_attempt_at <= now()
     ORDER BY d.next_attempt_at LIMIT $1`,
    [limit],
  );
  for (const d of due) {
    // Taken one at a time, so two runners can never send the same message.
    const mine = await q(
      `UPDATE notification_deliveries SET next_attempt_at = now() + make_interval(secs => $2) WHERE id = $1 AND status IN ('PENDING', 'FAILED') AND next_attempt_at <= now() RETURNING id`,
      [d.id, CLAIM_SECONDS],
    );
    if (!mine.length) continue;
    try {
      const outcome = await sendOne(d);
      await q(`UPDATE notification_deliveries SET status = $2, attempts = attempts + 1, sent_at = now(), last_error = $3 WHERE id = $1`, [d.id, outcome === 'SENT' ? 'SENT' : 'GAVE_UP', outcome === 'GONE' ? 'target no longer registered' : null]);
    } catch (err) {
      const attempts = d.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      const backoffSec = Math.min(3600, 30 * 2 ** (attempts - 1));
      await q(
        `UPDATE notification_deliveries SET status = $2, attempts = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1`,
        [d.id, giveUp ? 'GAVE_UP' : 'FAILED', attempts, redact(errorText(err)).slice(0, 500), backoffSec],
      );
      logger.warn({ channel: d.channel, attempts, err: redact(errorText(err)) }, 'notification delivery failed');
    }
  }
}
