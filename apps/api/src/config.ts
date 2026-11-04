/**
 * Environment configuration. Everything secret comes from the environment
 * (root .env in development, a secret manager in production) — never from code.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const API_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

const envFile = process.env.GEOATTEND_ENV_FILE ?? path.join(REPO_ROOT, '.env');
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, quiet: true });

const str = (name: string, fallback = '') => (process.env[name] ?? fallback).trim();
const int = (name: string, fallback: number) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
};
const bool = (name: string, fallback = false) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const nodeEnv = str('NODE_ENV', 'development');
/** Express "trust proxy": a hop count, false, or a list of proxy addresses / ranges. */
export function parseTrustProxy(value: string): boolean | number | string[] {
  const v = value.trim();
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const DATA_DIR = path.resolve(REPO_ROOT, str('DATA_DIR', 'data'));

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: int('API_PORT', 4400),
  publicApiUrl: str('PUBLIC_API_URL', 'http://localhost:4400'),
  corsOrigins: str('CORS_ORIGINS', 'http://localhost:3400')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  trustProxy: parseTrustProxy(str('TRUST_PROXY', 'loopback')),

  externalDatabaseUrl: str('DATABASE_URL'),
  pgPort: int('PG_PORT', 54340),
  pgPassword: str('PG_PASSWORD'),
  dbName: str('PG_DATABASE', 'geoattend'),

  jwtSecret: str('JWT_SECRET'),
  accessTokenTtlSec: int('ACCESS_TOKEN_TTL_SEC', 15 * 60),
  refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30),
  cookieSecure: bool('COOKIE_SECURE', nodeEnv === 'production'),

  demoMode: bool('DEMO_MODE', false),
  demoPassword: str('DEMO_PASSWORD'),
  /** Off until payroll rules are confirmed by a qualified person; see modules/payroll/guard.ts. */
  payrollEnabled: bool('PAYROLL_ENABLED', false),

  storage: {
    driver: str('STORAGE_DRIVER', 'local') as 'local' | 's3',
    signingKey: str('STORAGE_SIGNING_KEY'),
    localDir: path.resolve(REPO_ROOT, str('STORAGE_LOCAL_DIR', 'data/photos')),
    s3Bucket: str('S3_BUCKET'),
    s3Region: str('S3_REGION', 'us-east-1'),
    s3Endpoint: str('S3_ENDPOINT'),
    /** The address phones and browsers reach the bucket on, when the API uses a private one. */
    s3PublicEndpoint: str('S3_PUBLIC_ENDPOINT'),
    s3AccessKeyId: str('S3_ACCESS_KEY_ID'),
    s3SecretAccessKey: str('S3_SECRET_ACCESS_KEY'),
    s3ForcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
    maxPhotoBytes: int('MAX_PHOTO_BYTES', 5 * 1024 * 1024),
    uploadUrlTtlSec: int('UPLOAD_URL_TTL_SEC', 300),
    downloadUrlTtlSec: int('DOWNLOAD_URL_TTL_SEC', 120),
  },

  push: {
    vapidPublicKey: str('VAPID_PUBLIC_KEY'),
    vapidPrivateKey: str('VAPID_PRIVATE_KEY'),
    vapidSubject: str('VAPID_SUBJECT', 'mailto:admin@example.com'),
    expoAccessToken: str('EXPO_ACCESS_TOKEN'),
    expoPushEnabled: bool('EXPO_PUSH_ENABLED', false),
  },

  email: {
    smtpUrl: str('SMTP_URL'),
    from: str('EMAIL_FROM', 'GeoAttend <no-reply@example.com>'),
    adminRecipients: str('ALERT_EMAIL_RECIPIENTS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Daily summaries on WhatsApp go through Meta's WhatsApp Cloud API with a pre-approved
  // message template whose body has three variables: {{1}} company, {{2}} date and time, {{3}} summary.
  whatsapp: {
    token: str('WHATSAPP_TOKEN'),
    phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID'),
    template: str('WHATSAPP_SUMMARY_TEMPLATE', 'daily_summary'),
    language: str('WHATSAPP_TEMPLATE_LANGUAGE', 'en'),
  },
  // Face matching of shift photos against the employee's enrolled face: 'local' (default — an
  // open-source model running inside this server; photos never leave it) or 'off' (photos are
  // kept for manual review, nothing is compared). Threshold: similarity in % needed to match.
  faceMatch: {
    provider: str('FACE_MATCH_PROVIDER', 'local') as 'local' | 'off',
    threshold: int('FACE_MATCH_THRESHOLD', 60),
  },
  /** Link put in summaries so the owner can open the dashboard. */
  dashboardUrl: str('DASHBOARD_URL', 'http://localhost:3400'),

  sweeperIntervalMs: int('SWEEPER_INTERVAL_MS', 15_000),
  logLevel: str('LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info'),
};

/**
 * The generated sample company (npm run demo:seed) lives in its own local database whose name ends
 * in "_demo". Only then does the app show the sample-data banner and keep sample positions fresh.
 * Never in production, never on an external database.
 */
export const sampleData = config.demoMode && !config.isProduction && !config.externalDatabaseUrl && config.dbName.endsWith('_demo');

const PLACEHOLDER = /change[-_]?me|replace[-_]?me|your[-_]|example|placeholder|^secret|^password/i;
const isPublicHttps = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(u.hostname) && !u.hostname.endsWith('.example.com') && u.hostname !== 'example.com';
  } catch {
    return false;
  }
};

/** Everything wrong with a production environment, as readable lines. Takes the raw variables so each rule can be tested. */
export function productionConfigErrors(env: Record<string, string | undefined>) {
  const e: string[] = [];
  const get = (k: string) => (env[k] ?? '').trim();
  for (const k of ['JWT_SECRET', 'STORAGE_SIGNING_KEY']) {
    if (get(k).length < 32) e.push(`${k} must be at least 32 characters.`);
    else if (PLACEHOLDER.test(get(k))) e.push(`${k} is still a placeholder value.`);
  }
  if (get('JWT_SECRET') && get('JWT_SECRET') === get('STORAGE_SIGNING_KEY')) e.push('JWT_SECRET and STORAGE_SIGNING_KEY must be different.');
  if (!get('DATABASE_URL')) e.push('DATABASE_URL is required: the built-in database is for development only.');
  else if (PLACEHOLDER.test(get('DATABASE_URL'))) e.push('DATABASE_URL still contains a placeholder value.');
  if (!isPublicHttps(get('PUBLIC_API_URL'))) e.push('PUBLIC_API_URL must be the public https:// address of the API.');
  if (!isPublicHttps(get('DASHBOARD_URL'))) e.push('DASHBOARD_URL must be the public https:// address of the dashboard.');
  const origins = get('CORS_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length || !origins.every(isPublicHttps)) e.push('CORS_ORIGINS must list the public https:// dashboard origins.');
  const proxy = get('TRUST_PROXY');
  if (!proxy) e.push('TRUST_PROXY is required: the number of proxies in front of the API, or their addresses.');
  else if (proxy === 'true') e.push('TRUST_PROXY=true trusts any client-supplied address. Use the proxy count or addresses.');
  if (get('NODE_ENV') === 'production' && !bool2(env.COOKIE_SECURE, true)) e.push('COOKIE_SECURE must be true in production (serve over HTTPS).');
  if (bool2(env.DEMO_MODE, false)) e.push('DEMO_MODE must not be enabled when NODE_ENV=production.');
  if (bool2(env.PAYROLL_ENABLED, false)) e.push('PAYROLL_ENABLED must stay off until the pay rules have been reviewed by a qualified person.');
  if (get('STORAGE_DRIVER') !== 's3') e.push('STORAGE_DRIVER must be s3 in production.');
  else {
    if (!get('S3_BUCKET')) e.push('S3_BUCKET is required.');
    if (get('S3_ACCESS_KEY_ID') && PLACEHOLDER.test(get('S3_SECRET_ACCESS_KEY'))) e.push('S3_SECRET_ACCESS_KEY is still a placeholder value.');
    if (Boolean(get('S3_ACCESS_KEY_ID')) !== Boolean(get('S3_SECRET_ACCESS_KEY'))) e.push('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together.');
    if (get('S3_ENDPOINT') && !isPublicHttps(get('S3_PUBLIC_ENDPOINT') || get('S3_ENDPOINT'))) e.push('S3_PUBLIC_ENDPOINT must be the https:// address phones can reach the bucket on.');
  }
  return e;
}
function bool2(v: string | undefined, fallback: boolean) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function assertRuntimeConfig() {
  const missing: string[] = [];
  if (!config.jwtSecret || config.jwtSecret.length < 32) missing.push('JWT_SECRET (≥ 32 chars)');
  if (!config.storage.signingKey || config.storage.signingKey.length < 32) missing.push('STORAGE_SIGNING_KEY (≥ 32 chars)');
  if (!config.externalDatabaseUrl && !config.pgPassword) missing.push('PG_PASSWORD or DATABASE_URL');
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}.\nRun "npm run setup" to create .env, or see .env.example.`);
  }
  if (config.isProduction) {
    const errors = productionConfigErrors(process.env);
    if (errors.length) throw new Error(`Refusing to start in production:\n - ${errors.join('\n - ')}`);
  }
}
