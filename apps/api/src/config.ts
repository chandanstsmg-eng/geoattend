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
  trustProxy: str('TRUST_PROXY', 'loopback'),

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

  storage: {
    driver: str('STORAGE_DRIVER', 'local') as 'local' | 's3',
    signingKey: str('STORAGE_SIGNING_KEY'),
    localDir: path.resolve(REPO_ROOT, str('STORAGE_LOCAL_DIR', 'data/photos')),
    s3Bucket: str('S3_BUCKET'),
    s3Region: str('S3_REGION', 'us-east-1'),
    s3Endpoint: str('S3_ENDPOINT'),
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

export function assertRuntimeConfig() {
  const missing: string[] = [];
  if (!config.jwtSecret || config.jwtSecret.length < 32) missing.push('JWT_SECRET (≥ 32 chars)');
  if (!config.storage.signingKey || config.storage.signingKey.length < 32) missing.push('STORAGE_SIGNING_KEY (≥ 32 chars)');
  if (!config.externalDatabaseUrl && !config.pgPassword) missing.push('PG_PASSWORD or DATABASE_URL');
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}.\nRun "npm run setup" to create .env, or see .env.example.`);
  }
  if (config.isProduction && config.demoMode) {
    throw new Error('DEMO_MODE must not be enabled when NODE_ENV=production.');
  }
  if (config.isProduction && !config.cookieSecure) {
    throw new Error('COOKIE_SECURE must be true in production (serve over HTTPS).');
  }
}
