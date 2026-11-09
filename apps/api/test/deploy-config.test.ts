/**
 * The pre-deployment check (scripts/config-check.ts) that deploy/staging-deploy.sh runs before it switches
 * anything: it must refuse what the API would refuse, and never print a secret.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { API_ROOT } from '../src/config.js';

const run = promisify(execFile);
const good: Record<string, string> = {
  NODE_ENV: 'production',
  JWT_SECRET: 'k3Vq9xPz1LmT7wRb2YcN8dFh4JsG6aUe0QoZ',
  STORAGE_SIGNING_KEY: 'Yt5Rn2Kd8WqB3vLx7PzH1cMf9SgJ4aEu6ToI',
  DATABASE_URL: 'postgresql://geoattend_owner:Str0ngPassOwner@db:5432/geoattend',
  APP_DATABASE_URL: 'postgresql://geoattend_tenant:An0therPassTenant@db:5432/geoattend',
  PUBLIC_API_URL: 'https://api.geoattend.in',
  DASHBOARD_URL: 'https://app.geoattend.in',
  CORS_ORIGINS: 'https://app.geoattend.in',
  TRUST_PROXY: '1',
  COOKIE_SECURE: 'true',
  DEMO_MODE: 'false',
  PAYROLL_ENABLED: 'false',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'geoattend-photos',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'https://photos.geoattend.in',
  S3_ACCESS_KEY_ID: 'minioKeyValue123',
  S3_SECRET_ACCESS_KEY: 'm1n10SecretValueThatMustNotLeak',
};

/** Runs the check in a fresh process that sees ONLY these variables (no .env from the machine). */
async function check(vars: Record<string, string>) {
  const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', GEOATTEND_ENV_FILE: path.join(API_ROOT, 'no-such.env'), LOG_LEVEL: 'silent', ...vars };
  try {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', 'scripts/config-check.ts'], { cwd: API_ROOT, env, windowsHide: true });
    return { code: 0, out: stdout };
  } catch (err: any) {
    return { code: err.code as number, out: String(err.stdout) };
  }
}

describe('pre-deployment configuration check', () => {
  it('accepts a complete production environment and lists what is not configured', async () => {
    const r = await check(good);
    expect(r.code).toBe(0);
    expect(r.out).toContain('OK');
    expect(r.out).toMatch(/NOT configured\s+SMTP/);
    expect(r.out).toContain('payroll off');
  }, 60_000);

  it('refuses what the API would refuse, naming settings and never printing their values', async () => {
    const r = await check({ ...good, JWT_SECRET: 'change-me-at-least-32-characters-long-random', DEMO_MODE: 'true', PAYROLL_ENABLED: 'true', TRUST_PROXY: 'true', PUBLIC_API_URL: 'http://localhost:4400' });
    expect(r.code).toBe(1);
    for (const name of ['JWT_SECRET', 'DEMO_MODE', 'PAYROLL_ENABLED', 'TRUST_PROXY', 'PUBLIC_API_URL']) expect(r.out).toContain(name);
    for (const secret of ['change-me-at-least', 'Str0ngPassOwner', 'An0therPassTenant', 'm1n10SecretValueThatMustNotLeak', 'Yt5Rn2Kd8WqB3vLx7PzH1cMf9SgJ4aEu6ToI']) expect(r.out).not.toContain(secret);
  }, 60_000);

  it('refuses a server that is not running in production mode', async () => {
    const r = await check({ ...good, NODE_ENV: 'development' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('NODE_ENV must be production');
  }, 60_000);
});
