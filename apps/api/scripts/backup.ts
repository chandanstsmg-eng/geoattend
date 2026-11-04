/**
 * Database backup with pg_dump (custom format). Uses the embedded server's
 * pg_dump unless DATABASE_URL points elsewhere and pg_dump is on PATH.
 *   npm run db:backup                → data/backups/geoattend-<timestamp>.dump
 * Photos are stored separately (data/photos or the S3 bucket) — back them up too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, DATA_DIR } from '../src/config.js';
import { embeddedBinary, ensureDatabase } from '../src/db/postgres.js';
import { clientEnvironment } from '../src/db/restore-target.js';

const url = await ensureDatabase();
const dir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `geoattend-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
const pgDump = config.externalDatabaseUrl ? 'pg_dump' : await embeddedBinary('pg_dump');
const client = clientEnvironment(url);
execFileSync(pgDump, ['--format=custom', '--no-owner', `--file=${file}`, client.url], { stdio: 'inherit', windowsHide: true, env: { ...process.env, PGPASSWORD: client.password } });
console.log(`  Backup written to ${file}`);
