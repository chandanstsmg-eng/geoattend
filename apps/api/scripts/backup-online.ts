/**
 * Backup of the built-in database while it is running, then proof that it restores.
 *   npm run db:backup:online   → data/backups/pg-online-<timestamp>/
 *
 * For development machines, including Windows where the embedded package has no pg_dump.
 * Uses PostgreSQL's backup mode, so the live server keeps running and is not changed. The copy is
 * started on a separate port from a temporary folder and its row counts are compared with the live ones.
 * The outcome, and the size and SHA-256 of every file, go in the backup's manifest.json. A failure is
 * recorded there too, and the command exits 1. `npm run db:backup:verify` checks a backup against it later.
 * To use a backup: stop the database (npm run db:stop), keep data/pg aside, copy the folder to data/pg.
 * Production uses the provider's backups and pg_dump instead; see docs/RUNBOOK.md.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { config, DATA_DIR } from '../src/config.js';
import { describeFolder, writeManifest } from '../src/lib/backups.js';
import { redact } from '../src/lib/redact.js';

if (config.externalDatabaseUrl) throw new Error('db:backup:online is for the built-in database only. Use db:backup with DATABASE_URL.');

const TEST_PORT = config.pgPort + 59;
const SOURCE = path.join(DATA_DIR, 'pg');
const createdAt = new Date().toISOString();
const stamp = createdAt.replace(/[:.]/g, '-');
const target = path.join(config.backups.dir, `pg-online-${stamp}`);
const trial = path.join(config.backups.dir, `.restore-trial-${stamp}`);
if (fs.existsSync(target)) throw new Error(`${target} already exists; a backup is never overwritten.`);
// Recreated empty; PostgreSQL rebuilds their contents at start-up.
const RUNTIME_DIRS = ['pg_stat_tmp', 'pg_replslot', 'pg_dynshmem', 'pg_notify', 'pg_serial', 'pg_snapshots', 'pg_subtrans'];
const SKIP = new Set(['postmaster.pid', 'postmaster.opts', 'pg_wal', ...RUNTIME_DIRS]);

const platform = os.platform() === 'win32' ? 'windows' : os.platform();
const { pg_ctl: pgCtl } = await import(`@embedded-postgres/${platform}-${os.arch()}`);
const url = (port: number, db: string) => `postgresql://geoattend:${encodeURIComponent(config.pgPassword)}@localhost:${port}/${db}`;

async function rowCounts(port: number) {
  const admin = new pg.Client({ connectionString: url(port, 'postgres') });
  await admin.connect();
  const { rows } = await admin.query(`SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' AND datname NOT LIKE 'geoattend\\_test\\_%' ORDER BY 1`);
  await admin.end();
  const counts: Record<string, Record<string, number>> = {};
  for (const { datname } of rows) {
    const db = new pg.Client({ connectionString: url(port, datname) });
    await db.connect();
    counts[datname] = {};
    for (const { tablename } of (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows) {
      counts[datname][tablename] = Number((await db.query(`SELECT count(*) FROM "${tablename}"`)).rows[0].count);
    }
    await db.end();
  }
  return counts;
}

function copyTree(from: string, to: string, skip: (name: string) => boolean = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, dest);
    else {
      try {
        fs.copyFileSync(source, dest);
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err; // temporary files may vanish mid-copy; WAL replay covers them
      }
    }
  }
}

async function backUp() {
  const live = await rowCounts(config.pgPort);
  const session = new pg.Client({ connectionString: url(config.pgPort, 'postgres') });
  await session.connect();
  await session.query(`SELECT pg_backup_start('geoattend-online', true)`);
  copyTree(SOURCE, target, (name) => SKIP.has(name));
  const { rows: [stop] } = await session.query(`SELECT * FROM pg_backup_stop(false)`);
  await session.end();
  fs.writeFileSync(path.join(target, 'backup_label'), stop.labelfile);
  if (stop.spcmapfile) fs.writeFileSync(path.join(target, 'tablespace_map'), stop.spcmapfile);
  for (const dir of RUNTIME_DIRS) fs.mkdirSync(path.join(target, dir), { recursive: true });
  copyTree(path.join(SOURCE, 'pg_wal'), path.join(target, 'pg_wal'));

  // The trial runs on a copy, because starting a backup consumes its backup_label.
  fs.cpSync(target, trial, { recursive: true });
  const started = spawnSync(pgCtl, ['start', '-w', '-t', '90', '-D', trial, '-l', path.join(trial, 'trial.log'), '-o', `-p ${TEST_PORT} -c listen_addresses=localhost`], { stdio: 'ignore', windowsHide: true });
  if (started.status !== 0) throw new Error(`The backup did not start (pg_ctl exit ${started.status}). See ${trial}/trial.log.`);
  let restored: Awaited<ReturnType<typeof rowCounts>>;
  try {
    restored = await rowCounts(TEST_PORT);
  } finally {
    spawnSync(pgCtl, ['stop', '-m', 'fast', '-w', '-D', trial], { stdio: 'ignore', windowsHide: true });
  }
  fs.rmSync(trial, { recursive: true, force: true });

  let same = 0;
  const different: string[] = [];
  for (const [db, tables] of Object.entries(live)) {
    if (!restored[db]) throw new Error(`Database ${db} is missing from the restored copy.`);
    for (const [table, n] of Object.entries(tables)) {
      if (restored[db][table] === undefined) throw new Error(`Table ${db}.${table} is missing from the restored copy.`);
      if (restored[db][table] === n) same++;
      else different.push(`${db}.${table}: live ${n}, restored ${restored[db][table]}`);
    }
  }
  return { databases: Object.keys(restored), same, different };
}

try {
  fs.mkdirSync(target, { recursive: true });
  const r = await backUp();
  writeManifest(target, { version: 1, kind: 'online', status: 'RESTORE_PROVEN', createdAt, finishedAt: new Date().toISOString(), databases: r.databases, tablesMatching: r.same, tablesDifferent: r.different, files: await describeFolder(target) });
  console.log(`  Backup: ${target}`);
  console.log(`  Restored on port ${TEST_PORT}: ${r.databases.join(', ')}. ${r.same} tables match the live row counts, ${r.different.length} differ.`);
  // Tables can differ by rows written while the backup ran; the databases and tables above are all present.
  for (const line of r.different) console.log(`    ${line}`);
  process.exit(0);
} catch (err) {
  const message = redact(String((err as Error).message)).slice(0, 500);
  writeManifest(target, { version: 1, kind: 'online', status: 'FAILED', createdAt, finishedAt: new Date().toISOString(), error: message, files: [] });
  console.error(`  Backup FAILED, and is recorded as failed: ${message}`);
  process.exit(1);
}
