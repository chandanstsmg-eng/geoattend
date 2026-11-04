/**
 * Local development database.
 *
 * So that GeoAttend runs with one command on a machine without Docker or a
 * PostgreSQL install, the API ships PostgreSQL binaries (embedded-postgres)
 * and runs a private server from data/pg using pg_ctl. The server survives a
 * crash of the Node process and is adopted on the next start.
 *
 * In production — or whenever DATABASE_URL is set — none of this runs and the
 * configured server (ideally PostgreSQL + PostGIS, see docker-compose.yml) is used.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { config, DATA_DIR } from '../config.js';
import { logger } from '../lib/logger.js';

const run = promisify(execFile);
const PG_DIR = path.join(DATA_DIR, 'pg');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'postgres.log');
const PG_USER = 'geoattend';

async function binaries(): Promise<{ pg_ctl: string; initdb: string }> {
  const platform = os.platform() === 'win32' ? 'windows' : os.platform();
  const pkg = `@embedded-postgres/${platform}-${os.arch()}`;
  try {
    return await import(pkg);
  } catch {
    throw new Error(`Embedded PostgreSQL is not available for ${os.platform()}-${os.arch()}. Set DATABASE_URL to use your own PostgreSQL.`);
  }
}

async function isRunning(pgCtl: string) {
  try {
    await run(pgCtl, ['status', '-D', PG_DIR], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function startServer(pgCtl: string): Promise<void> {
  // stdio must be ignored: postgres inherits the handles and would otherwise keep the pipe open.
  return new Promise((resolve, reject) => {
    const child = spawn(
      pgCtl,
      ['start', '-D', PG_DIR, '-w', '-t', '90', '-l', LOG_FILE, '-o', `-p ${config.pgPort} -c listen_addresses=localhost`],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      const tail = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-6).join('\n') : '';
      reject(new Error(`Database did not start (pg_ctl exit ${code}).\n${tail}`));
    });
  });
}

function serverUrl(db: string) {
  return `postgresql://${PG_USER}:${encodeURIComponent(config.pgPassword)}@localhost:${config.pgPort}/${db}`;
}

/** Creates a database on the embedded server if it does not exist. */
export async function ensureDatabaseExists(dbName: string) {
  const client = new pg.Client({ connectionString: serverUrl('postgres') });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(dbName: string) {
  const client = new pg.Client({ connectionString: serverUrl('postgres') });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName.replace(/"/g, '')}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

/** Starts (or adopts) the embedded server and returns a connection URL for `dbName`. */
export async function ensureDatabase(dbName = config.dbName): Promise<string> {
  if (config.externalDatabaseUrl) return config.externalDatabaseUrl;
  if (!config.pgPassword) throw new Error('PG_PASSWORD is missing in .env — run "npm run setup".');

  const { pg_ctl, initdb } = await binaries();
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  if (!fs.existsSync(path.join(PG_DIR, 'PG_VERSION'))) {
    logger.info('Initialising the local PostgreSQL cluster in data/pg …');
    fs.mkdirSync(PG_DIR, { recursive: true });
    const pwFile = path.join(DATA_DIR, '.pgpass-init');
    fs.writeFileSync(pwFile, config.pgPassword, { mode: 0o600 });
    try {
      await run(initdb, ['-D', PG_DIR, '-U', PG_USER, `--pwfile=${pwFile}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--no-locale'], { windowsHide: true });
    } finally {
      fs.rmSync(pwFile, { force: true });
    }
    fs.appendFileSync(path.join(PG_DIR, 'postgresql.conf'), "\n# GeoAttend local\nshared_buffers = 64MB\nmax_connections = 60\ntimezone = 'UTC'\nlog_timezone = 'UTC'\n");
  }

  if (!(await isRunning(pg_ctl))) await startServer(pg_ctl);
  await ensureDatabaseExists(dbName);
  return serverUrl(dbName);
}

export async function stopEmbeddedDatabase() {
  if (config.externalDatabaseUrl) return;
  const { pg_ctl } = await binaries();
  if (!fs.existsSync(path.join(PG_DIR, 'PG_VERSION'))) return;
  if (!(await isRunning(pg_ctl))) return;
  await run(pg_ctl, ['stop', '-D', PG_DIR, '-m', 'fast', '-w', '-t', '30'], { windowsHide: true });
}

export async function embeddedBinary(name: 'pg_dump' | 'pg_restore' | 'psql'): Promise<string> {
  const { pg_ctl } = await binaries();
  return path.join(path.dirname(pg_ctl), os.platform() === 'win32' ? `${name}.exe` : name);
}
