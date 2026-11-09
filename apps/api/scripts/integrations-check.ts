/**
 * Real test of each external integration, with the settings this server would use (environment / .env).
 *
 *   npm run integrations:check -w @geoattend/api -- [--email you@company.in] [--expo-token ExponentPushToken[…]]
 *                                                   [--whatsapp-to 91XXXXXXXXXX] [--only smtp,expo,…]
 *
 * Every line ends in one of:
 *   PASS      the outside service proved it: an object written, read back by checksum and removed.
 *   ACCEPTED  the service took the message. It is NOT proof of delivery: a person must confirm it arrived
 *             (inbox, phone, alert channel) and record that in docs/STAGING.md.
 *   FAIL      the service refused, or did not answer.
 *   BLOCKED   not configured, or no test recipient given. Nothing was sent.
 *
 * It sends real messages only to the recipients given on the command line, writes only a small probe
 * object (removed again) under the configured buckets, and never reads or changes the database.
 * Google Maps keys are browser keys and cannot be proven from a server: see docs/STAGING.md.
 */
import { createHash, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../src/config.js';
import { errorText, redact } from '../src/lib/redact.js';

type Status = 'PASS' | 'ACCEPTED' | 'FAIL' | 'BLOCKED';
const results: { name: string; status: Status; detail: string }[] = [];
const report = (name: string, status: Status, detail: string) => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(9)} ${name.padEnd(22)} ${detail}`);
};

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]?.trim() || '' : '';
};
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const wanted = (k: string) => !only || only.has(k);
const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const stamp = new Date().toISOString();
const failText = (err: unknown) => redact(errorText(err)).slice(0, 300);

async function smtp() {
  if (!config.email.smtpUrl) return report('SMTP e-mail', 'BLOCKED', 'SMTP_URL is not set');
  const to = arg('email');
  const t = nodemailer.createTransport({ url: config.email.smtpUrl, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 } as any);
  try {
    await t.verify();
  } catch (err) {
    return report('SMTP e-mail', 'FAIL', `login to the mail server failed: ${failText(err)}`);
  }
  if (!to) return report('SMTP e-mail', 'BLOCKED', 'mail server login works; give --email <address> to send a test');
  try {
    const info = await t.sendMail({ from: config.email.from, to, subject: '[GeoAttend] Integration test', text: `Test message sent at ${stamp} by integrations:check. Reply not needed.` });
    if (!info.accepted?.length) return report('SMTP e-mail', 'FAIL', `server rejected ${to}: ${JSON.stringify(info.rejected)}`);
    report('SMTP e-mail', 'ACCEPTED', `server accepted it for ${to} (id ${info.messageId}); confirm it is in the inbox, not spam`);
  } catch (err) {
    report('SMTP e-mail', 'FAIL', failText(err));
  }
}

async function expo() {
  const to = arg('expo-token');
  if (!config.push.expoPushEnabled) return report('Expo push', 'BLOCKED', 'EXPO_PUSH_ENABLED is false');
  if (!to) return report('Expo push', 'BLOCKED', "give --expo-token (from a test phone's device registration)");
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(config.push.expoAccessToken ? { Authorization: `Bearer ${config.push.expoAccessToken}` } : {}) };
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers, signal: AbortSignal.timeout(15_000), body: JSON.stringify({ to, title: 'GeoAttend test', body: `Integration test ${stamp}`, priority: 'high', channelId: 'attendance' }) });
    const ticket: any = ((await res.json().catch(() => ({}))) as any)?.data;
    if (!res.ok || ticket?.status !== 'ok') return report('Expo push', 'FAIL', `Expo refused: ${res.status} ${JSON.stringify(ticket ?? {}).slice(0, 200)}`);
    // The ticket only means Expo queued it. The receipt says whether FCM/APNs took it.
    await new Promise((r) => setTimeout(r, 15_000));
    const rr = await fetch('https://exp.host/--/api/v2/push/getReceipts', { method: 'POST', headers, signal: AbortSignal.timeout(15_000), body: JSON.stringify({ ids: [ticket.id] }) });
    const receipt: any = ((await rr.json().catch(() => ({}))) as any)?.data?.[ticket.id];
    if (!receipt) return report('Expo push', 'ACCEPTED', `queued by Expo (ticket ${ticket.id}); no receipt yet. Confirm on the phone`);
    if (receipt.status !== 'ok') return report('Expo push', 'FAIL', `receipt: ${JSON.stringify(receipt).slice(0, 200)}`);
    report('Expo push', 'ACCEPTED', 'handed to FCM/APNs (receipt ok); confirm the notification appeared on the phone');
  } catch (err) {
    report('Expo push', 'FAIL', failText(err));
  }
}

async function whatsapp() {
  const to = arg('whatsapp-to');
  if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) return report('WhatsApp', 'BLOCKED', 'WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set');
  if (!to) return report('WhatsApp', 'BLOCKED', 'give --whatsapp-to <number with country code, no +>');
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name: config.whatsapp.template, language: { code: config.whatsapp.language }, components: [{ type: 'body', parameters: ['GeoAttend test', stamp, 'Integration test, no action needed'].map((text) => ({ type: 'text', text })) }] },
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) return report('WhatsApp', 'FAIL', `Meta answered ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 200)}`);
    report('WhatsApp', 'ACCEPTED', `Meta accepted it (message ${body?.messages?.[0]?.id ?? '?'}); confirm it arrived on ${to}`);
  } catch (err) {
    report('WhatsApp', 'FAIL', failText(err));
  }
}

async function webhook() {
  const url = config.opsAlerts.webhookUrl;
  if (!url) return report('Alert webhook', 'BLOCKED', 'ALERT_WEBHOOK_URL is not set');
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000), body: JSON.stringify({ source: 'geoattend', key: 'integration-test', severity: 'INFO', message: `Integration test ${stamp}. No action needed.`, openedAt: stamp }) });
    if (!res.ok) return report('Alert webhook', 'FAIL', `answered ${res.status}`);
    report('Alert webhook', 'ACCEPTED', `answered ${res.status}; confirm the on-call person or channel received it`);
  } catch (err) {
    report('Alert webhook', 'FAIL', failText(err));
  }
}

/** Write a probe, read it back by checksum, remove it. Only this proves a bucket works end to end. */
async function bucket(name: string, b: { bucket: string; region: string; endpoint: string; key: string; secret: string; pathStyle: boolean; prefix: string }) {
  if (!b.bucket) return report(name, 'BLOCKED', 'bucket not set');
  const s3 = new S3Client({ region: b.region || 'us-east-1', endpoint: b.endpoint || undefined, forcePathStyle: b.pathStyle, credentials: b.key ? { accessKeyId: b.key, secretAccessKey: b.secret } : undefined });
  const Key = `${b.prefix}integration-check/${randomUUID()}.txt`;
  const body = Buffer.from(`GeoAttend integration check ${stamp}`);
  const sum = createHash('sha256').update(body).digest('hex');
  try {
    await s3.send(new PutObjectCommand({ Bucket: b.bucket, Key, Body: body }));
    const got = await s3.send(new GetObjectCommand({ Bucket: b.bucket, Key }));
    const back = createHash('sha256').update(Buffer.from(await got.Body!.transformToByteArray())).digest('hex');
    if (back !== sum) return report(name, 'FAIL', 'object read back with a different checksum');
    report(name, 'PASS', `wrote, read back by SHA-256 and removed ${b.bucket}/${Key}`);
  } catch (err) {
    report(name, 'FAIL', failText(err));
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: b.bucket, Key })).catch(() => undefined);
  }
}

const checks: [string, () => Promise<unknown>][] = [
  ['smtp', smtp],
  ['expo', expo],
  ['whatsapp', whatsapp],
  ['webhook', webhook],
  ['photos', () => bucket('Photo bucket', { bucket: config.storage.driver === 's3' ? config.storage.s3Bucket : '', region: config.storage.s3Region, endpoint: config.storage.s3Endpoint, key: config.storage.s3AccessKeyId, secret: config.storage.s3SecretAccessKey, pathStyle: config.storage.s3ForcePathStyle, prefix: '' })],
  ['offsite', () => bucket('Off-site backups', { bucket: env('BACKUP_S3_BUCKET'), region: env('BACKUP_S3_REGION'), endpoint: env('BACKUP_S3_ENDPOINT'), key: env('BACKUP_S3_ACCESS_KEY_ID'), secret: env('BACKUP_S3_SECRET_ACCESS_KEY'), pathStyle: env('BACKUP_S3_FORCE_PATH_STYLE') === 'true', prefix: env('BACKUP_S3_PREFIX', 'geoattend/') })],
];
for (const [k, fn] of checks) if (wanted(k)) await fn();
console.log('MANUAL    Google Maps key + Map ID  in a browser on the dashboard domain (docs/STAGING.md, section 3)');
console.log('MANUAL    External monitor         an outside service polling /health (docs/STAGING.md, section 3)');
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
