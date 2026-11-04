/**
 * Outbound delivery of persisted notifications with retry and back-off.
 * Channels are optional and only used when configured:
 *   WEB_PUSH  — admin browsers (VAPID keys)
 *   EMAIL     — SMTP_URL
 *   EXPO_PUSH — employee devices via the Expo push service (FCM/APNs underneath)
 */
import webpush from 'web-push';
import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import { q } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';

const MAX_ATTEMPTS = 6;
let mailer: ReturnType<typeof nodemailer.createTransport> | null = null;

if (config.push.vapidPublicKey && config.push.vapidPrivateKey) {
  webpush.setVapidDetails(config.push.vapidSubject, config.push.vapidPublicKey, config.push.vapidPrivateKey);
}

async function sendOne(d: any) {
  const payload = { title: d.title, body: d.body, type: d.type, severity: d.severity, notificationId: d.notification_id, createdAt: d.created_at };
  if (d.channel === 'WEB_PUSH') {
    const sub = (await q('SELECT * FROM web_push_subscriptions WHERE id = $1', [d.target]))[0];
    if (!sub) return 'GONE';
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600 });
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
    mailer ??= nodemailer.createTransport(config.email.smtpUrl);
    await mailer.sendMail({
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

export async function processDeliveries(limit = 25) {
  const due = await q(
    `SELECT d.*, n.title, n.body, n.type, n.severity, n.created_at, n.session_id
     FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
     WHERE d.status IN ('PENDING', 'FAILED') AND d.next_attempt_at <= now()
     ORDER BY d.next_attempt_at LIMIT $1`,
    [limit],
  );
  for (const d of due) {
    try {
      const outcome = await sendOne(d);
      await q(`UPDATE notification_deliveries SET status = $2, attempts = attempts + 1, sent_at = now(), last_error = $3 WHERE id = $1`, [d.id, outcome === 'SENT' ? 'SENT' : 'GAVE_UP', outcome === 'GONE' ? 'target no longer registered' : null]);
    } catch (err) {
      const attempts = d.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      const backoffSec = Math.min(3600, 30 * 2 ** (attempts - 1));
      await q(
        `UPDATE notification_deliveries SET status = $2, attempts = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1`,
        [d.id, giveUp ? 'GAVE_UP' : 'FAILED', attempts, String((err as Error).message).slice(0, 500), backoffSec],
      );
      logger.warn({ channel: d.channel, attempts, err: (err as Error).message }, 'notification delivery failed');
    }
  }
}
