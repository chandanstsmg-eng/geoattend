/** A restore can only create a new database: real connections to a throw-away database stand in for the live one. */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { dropDatabase, ensureDatabase } from '../src/db/postgres.js';
import { assertRestoreTarget, clientEnvironment, databaseName, prepareRestoreTarget, withDatabase } from '../src/db/restore-target.js';

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
