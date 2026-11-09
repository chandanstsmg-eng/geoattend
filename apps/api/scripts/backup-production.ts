/**
 * Production backup: dump, prove it restores, copy it off the machine, keep a bounded history.
 *   npm run db:backup:production -w @geoattend/api
 * Run it on a schedule (deploy/geoattend-backup.timer, or cron). Every run writes
 * <BACKUP_DIR>/geoattend-<time>.dump and its manifest; a failed run writes a FAILED manifest and exits 1,
 * and the hourly backup check then raises an operations alert (docs/BACKUPS.md).
 *
 * 1. Counts every table's rows and runs pg_dump in ONE database snapshot, so the counts describe the dump exactly.
 * 2. Restores the dump into a new scratch database on BACKUP_VERIFY_DATABASE_URL (a login allowed to create
 *    databases, ideally on another server) and compares every table's count. Only then is it RESTORE_PROVEN.
 *    The scratch database is always dropped afterwards; nothing else is ever dropped.
 * 3. With BACKUP_S3_BUCKET set, uploads the dump and its manifest, downloads the dump again and checks its
 *    SHA-256, then removes off-site copies beyond the newest BACKUP_OFFSITE_KEEP. Nothing is removed unless the
 *    new copy was verified first.
 *
 * Settings (environment): DATABASE_URL (the database to back up), PG_BIN (folder holding pg_dump and
 * pg_restore of the server's major version; else they must be on PATH), BACKUP_VERIFY_DATABASE_URL,
 * BACKUP_S3_BUCKET, BACKUP_S3_ENDPOINT (non-AWS), BACKUP_S3_REGION, BACKUP_S3_ACCESS_KEY_ID,
 * BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_FORCE_PATH_STYLE, BACKUP_S3_PREFIX, BACKUP_OFFSITE_KEEP.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../src/config.js';
import { ensureDatabase } from '../src/db/postgres.js';
import { clientEnvironment, databaseName, ensureTenantRole, prepareRestoreTarget, withDatabase } from '../src/db/restore-target.js';
import { sha256, writeManifest, type BackupManifest } from '../src/lib/backups.js';
import { errorText, redact } from '../src/lib/redact.js';

const run = promisify(execFile);
const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const bin = (name: string) => (env('PG_BIN') ? path.join(env('PG_BIN'), name) : name);

const createdAt = new Date().toISOString();
const stamp = createdAt.replace(/[:.]/g, '-');
const dir = config.backups.dir;
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `geoattend-${stamp}.dump`);
if (fs.existsSync(file)) throw new Error(`${file} already exists; a backup is never overwritten.`);

type Counts = Record<string, number>;
async function countTables(c: pg.Client): Promise<Counts> {
  const tables = await c.query(
    `SELECT format('%I.%I', table_schema, table_name) AS t FROM information_schema.tables
     WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%'
     ORDER BY 1`,
  );
  const out: Counts = {};
  for (const { t } of tables.rows) out[t] = Number((await c.query(`SELECT count(*)::bigint AS n FROM ${t}`)).rows[0].n);
  return out;
}

const manifest: BackupManifest = { version: 1, kind: 'dump', status: 'FAILED', createdAt, finishedAt: createdAt, files: [] };
const describeFile = async () => {
  manifest.files = fs.existsSync(file) ? [{ path: path.basename(file), size: fs.statSync(file).size, sha256: await sha256(file) }] : [];
};
// Written exactly once, when everything (off-site copy included) has succeeded or failed: a manifest is never
// rewritten, so writing it early would leave a failure after that point unrecorded, and unalerted.
const save = () => {
  manifest.finishedAt = new Date().toISOString();
  writeManifest(file, manifest);
};

async function dumpAndCount(sourceUrl: string): Promise<Counts> {
  const c = new pg.Client({ connectionString: sourceUrl });
  await c.connect();
  try {
    // One snapshot for both: the counts are of exactly the data pg_dump writes.
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await c.query('SELECT pg_export_snapshot() AS s')).rows[0].s as string;
    const counts = await countTables(c);
    const client = clientEnvironment(sourceUrl);
    await run(bin('pg_dump'), ['--format=custom', '--no-owner', `--snapshot=${snapshot}`, `--file=${file}`, client.url], { env: { ...process.env, PGPASSWORD: client.password }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    await c.query('COMMIT');
    return counts;
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function restoreCheck(verifyUrl: string, expected: Counts) {
  const scratch = `geoattend_restore_check_${Date.now()}`;
  const url = await prepareRestoreTarget(verifyUrl, scratch); // creates it; refuses any name already in use
  try {
    await ensureTenantRole(url);
    const client = clientEnvironment(url);
    await run(bin('pg_restore'), ['--no-owner', '--exit-on-error', `--dbname=${client.url}`, file], { env: { ...process.env, PGPASSWORD: client.password }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    let restored: Counts;
    try {
      restored = await countTables(c);
    } finally {
      await c.end();
    }
    const names = [...new Set([...Object.keys(expected), ...Object.keys(restored)])].sort();
    const different = names.filter((t) => expected[t] !== restored[t]).map((t) => `${t}: dumped ${expected[t] ?? 'missing'}, restored ${restored[t] ?? 'missing'}`);
    return { matching: names.length - different.length, different };
  } finally {
    // Only the scratch database made above is ever dropped, and only by its own generated name.
    if (/^geoattend_restore_check_\d+$/.test(scratch)) {
      const admin = new pg.Client({ connectionString: verifyUrl });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).finally(() => admin.end());
    }
  }
}

function offsiteClient() {
  return new S3Client({
    region: env('BACKUP_S3_REGION', 'us-east-1'),
    endpoint: env('BACKUP_S3_ENDPOINT') || undefined,
    forcePathStyle: env('BACKUP_S3_FORCE_PATH_STYLE') === 'true',
    credentials: env('BACKUP_S3_ACCESS_KEY_ID') ? { accessKeyId: env('BACKUP_S3_ACCESS_KEY_ID'), secretAccessKey: env('BACKUP_S3_SECRET_ACCESS_KEY') } : undefined,
  });
}

async function copyOffsite(bucket: string) {
  const s3 = offsiteClient();
  const prefix = env('BACKUP_S3_PREFIX', 'geoattend/');
  const key = `${prefix}${path.basename(file)}`;
  const local = manifest.files[0]!;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.createReadStream(file), ContentLength: local.size, ContentType: 'application/octet-stream', Metadata: { sha256: local.sha256 } }));
  // Read it back: a copy counts only if what is stored is byte for byte what was made.
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const h = createHash('sha256');
  for await (const chunk of got.Body as AsyncIterable<Uint8Array>) h.update(chunk);
  const remote = h.digest('hex');
  if (remote !== local.sha256) throw new Error(`The off-site copy differs from the backup (sha256 ${remote.slice(0, 12)}… vs ${local.sha256.slice(0, 12)}…).`);
  manifest.offsite = { bucket, key, sha256: remote, verifiedAt: new Date().toISOString() };
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${key}.manifest.json`, Body: JSON.stringify(manifest, null, 1), ContentType: 'application/json' }));

  // Retention, only after the new copy was verified: the newest BACKUP_OFFSITE_KEEP dumps stay.
  const keep = Math.max(1, Number(env('BACKUP_OFFSITE_KEEP', '30')) || 30);
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key && /geoattend-[^/]+\.dump$/.test(o.Key)) keys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const old = keys.sort().reverse().slice(keep);
  for (const k of old) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }));
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${k}.manifest.json` }));
  }
  return { key, removed: old.length, kept: Math.min(keep, keys.length) };
}

try {
  const sourceUrl = config.externalDatabaseUrl || (await ensureDatabase());
  const counts = await dumpAndCount(sourceUrl);
  await run(bin('pg_restore'), ['--list', file], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  manifest.status = 'READABLE';
  manifest.databases = [databaseName(sourceUrl)];
  const verifyUrl = env('BACKUP_VERIFY_DATABASE_URL');
  if (verifyUrl) {
    const check = await restoreCheck(withDatabase(verifyUrl, databaseName(verifyUrl) || 'postgres'), counts);
    manifest.tablesMatching = check.matching;
    manifest.tablesDifferent = check.different;
    if (check.different.length) throw new Error(`The restored copy differs in ${check.different.length} tables: ${check.different.slice(0, 3).join('; ')}`);
    manifest.status = 'RESTORE_PROVEN';
  }
  await describeFile();
  const bucket = env('BACKUP_S3_BUCKET');
  const offsite = bucket ? await copyOffsite(bucket) : null;
  save();
  console.log(`  Backup ${path.basename(file)}: ${manifest.status}${manifest.tablesMatching != null ? `, ${manifest.tablesMatching} tables restored and matching` : ' (not restored: set BACKUP_VERIFY_DATABASE_URL)'}.`);
  console.log(offsite ? `  Off-site copy verified at ${bucket}/${offsite.key}; ${offsite.kept} kept, ${offsite.removed} older removed.` : '  No off-site copy: set BACKUP_S3_BUCKET. A backup on the same machine does not survive losing that machine.');
  process.exit(0);
} catch (err) {
  manifest.status = 'FAILED';
  manifest.error = redact(errorText(err)).slice(0, 500);
  delete manifest.offsite;
  await describeFile().catch(() => undefined);
  try {
    save();
  } catch (e) {
    console.error(`  Could not record the failure: ${errorText(e)}`);
  }
  console.error(`  Backup FAILED: ${manifest.error}`);
  process.exit(1);
}
