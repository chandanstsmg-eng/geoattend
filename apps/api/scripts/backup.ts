/**
 * Database backup with pg_dump (custom format). Uses the embedded server's
 * pg_dump unless DATABASE_URL points elsewhere and pg_dump is on PATH.
 *   npm run db:backup                → <BACKUP_DIR>/geoattend-<timestamp>.dump, and its .manifest.json
 * The manifest records the size and SHA-256, and whether pg_restore could read the file. That is not a
 * restore: try one on a test server. A failure is recorded too, and the command exits 1.
 * Photos are stored separately (data/photos or the S3 bucket) — back them up too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
import { embeddedBinary, ensureDatabase } from '../src/db/postgres.js';
import { clientEnvironment } from '../src/db/restore-target.js';
import { sha256, writeManifest, type BackupManifest } from '../src/lib/backups.js';
import { errorText, redact } from '../src/lib/redact.js';

const createdAt = new Date().toISOString();
const dir = config.backups.dir;
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `geoattend-${createdAt.replace(/[:.]/g, '-')}.dump`);
if (fs.existsSync(file)) throw new Error(`${file} already exists; a backup is never overwritten.`);

const finish = async (status: BackupManifest['status'], error?: string) => {
  const files = fs.existsSync(file) ? [{ path: path.basename(file), size: fs.statSync(file).size, sha256: await sha256(file) }] : [];
  writeManifest(file, { version: 1, kind: 'dump', status, createdAt, finishedAt: new Date().toISOString(), files, ...(error ? { error } : {}) });
};

try {
  const url = await ensureDatabase();
  const external = !!config.externalDatabaseUrl;
  const client = clientEnvironment(url);
  const env = { ...process.env, PGPASSWORD: client.password };
  execFileSync(external ? 'pg_dump' : await embeddedBinary('pg_dump'), ['--format=custom', '--no-owner', `--file=${file}`, client.url], { stdio: 'inherit', windowsHide: true, env });
  execFileSync(external ? 'pg_restore' : await embeddedBinary('pg_restore'), ['--list', file], { stdio: 'ignore', windowsHide: true });
  await finish('READABLE');
  console.log(`  Backup written to ${file}. pg_restore can read it; it has not been restored.`);
} catch (err) {
  const message = redact(errorText(err)).slice(0, 500);
  await finish('FAILED', message);
  console.error(`  Backup FAILED: ${message}`);
  process.exit(1);
}
