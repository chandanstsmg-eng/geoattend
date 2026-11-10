/** A restore can only create a new database: real connections to a throw-away database stand in for the live one. */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { dropDatabase, ensureDatabase } from '../src/db/postgres.js';
import { assertRestoreTarget, clientEnvironment, databaseName, ensureTenantRole, prepareRestoreTarget, withDatabase } from '../src/db/restore-target.js';

const live = `geoattend_test_live_${crypto.randomBytes(3).toString('hex')}`;
const made: string[] = [];
let liveUrl: string;

beforeAll(async () => {
  liveUrl = await ensureDatabase(live);
  const c = new pg.Client({ connectionString: liveUrl });
  await c.connect();
  await c.query(`CREATE TABLE precious (id int); INSERT INTO precious VALUES (1)`);
  await c.end();
});
afterAll(async () => {
  for (const name of [...made, live]) await dropDatabase(name);
});

describe('db:restore script', () => {
  it('a missing pg_restore stops it before the new database is created, so the retry is not blocked', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { API_ROOT } = await import('../src/config.js');
    const noTools = fs.mkdtempSync(path.join(os.tmpdir(), 'pgbin-empty-'));
    const dump = path.join(noTools, 'some.dump');
    fs.writeFileSync(dump, 'not a real dump');
    const target = `geoattend_test_notools_${crypto.randomBytes(3).toString('hex')}`;
    const env = { ...process.env, PG_BIN: noTools, GEOATTEND_ENV_FILE: path.join(noTools, 'no.env'), LOG_LEVEL: 'silent' };
    const r = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/restore.ts', dump, target], { cwd: API_ROOT, env, windowsHide: true }).then(
      () => ({ code: 0, err: '' }),
      (e: any) => ({ code: e.code as number, err: String(e.stderr) }),
    );
    fs.rmSync(noTools, { recursive: true, force: true });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not found in PG_BIN/);
    const c = new pg.Client({ connectionString: liveUrl });
    await c.connect();
    const exists = (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [target])).rowCount;
    await c.end();
    expect(exists).toBe(0);
  }, 60_000);
});

describe('restore target', () => {
  it('refuses the live database, by name and when it comes from DATABASE_URL', async () => {
    await expect(prepareRestoreTarget(liveUrl, live)).rejects.toThrow(/over the live database/);
    expect(() => assertRestoreTarget({ target: 'geoattend', liveDatabase: 'geoattend', production: false })).toThrow(/live database/);
  });

  it('refuses any database that already exists', async () => {
    const other = `geoattend_test_other_${crypto.randomBytes(3).toString('hex')}`;
    await ensureDatabase(other);
    made.push(other);
    await expect(prepareRestoreTarget(liveUrl, other)).rejects.toThrow(/already exists/);
  });

  it('creates a new database whose URL is not the live one (the old script returned DATABASE_URL here)', async () => {
    const target = `geoattend_test_new_${crypto.randomBytes(3).toString('hex')}`;
    made.push(target);
    const url = await prepareRestoreTarget(liveUrl, target);
    expect(databaseName(url)).toBe(target);
    expect(url).not.toBe(liveUrl);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    expect((await c.query(`SELECT to_regclass('precious') AS t`)).rows[0].t).toBeNull();
    await c.end();
    const l = new pg.Client({ connectionString: liveUrl });
    await l.connect();
    expect((await l.query('SELECT count(*)::int AS n FROM precious')).rows[0].n).toBe(1);
    await l.end();
  });

  it('makes sure the role in the dump\'s policies exists, and can run twice', async () => {
    await ensureTenantRole(liveUrl);
    await ensureTenantRole(liveUrl);
    const c = new pg.Client({ connectionString: liveUrl });
    await c.connect();
    const r = (await c.query(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'geoattend_tenant'`)).rows;
    await c.end();
    expect(r).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: true }]);
  });

  it('needs explicit confirmation on a production system', () => {
    expect(() => assertRestoreTarget({ target: 'recovered', liveDatabase: 'geoattend', production: true })).toThrow(/RESTORE_CONFIRM/);
    expect(() => assertRestoreTarget({ target: 'recovered', liveDatabase: 'geoattend', production: true, confirm: 'other' })).toThrow(/RESTORE_CONFIRM/);
    expect(() => assertRestoreTarget({ target: 'recovered', liveDatabase: 'geoattend', production: true, confirm: 'recovered' })).not.toThrow();
  });

  it('refuses names that could inject SQL', () => {
    for (const bad of ['x"; DROP DATABASE geoattend; --', 'Has-Caps', '', 'a b']) expect(() => assertRestoreTarget({ target: bad, liveDatabase: 'geoattend', production: false })).toThrow(/lower-case/);
  });

  it('keeps query options and takes the password off the command line', () => {
    const url = withDatabase('postgresql://u:p%40ss@db.internal:5432/geoattend?sslmode=require', 'recovered');
    expect(url).toBe('postgresql://u:p%40ss@db.internal:5432/recovered?sslmode=require');
    expect(clientEnvironment(url)).toEqual({ password: 'p@ss', url: 'postgresql://u@db.internal:5432/recovered?sslmode=require' });
  });
});
