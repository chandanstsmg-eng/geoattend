/**
 * pg_dump / pg_restore lookup for db:backup and db:restore (Windows reliability, Phase I): PG_BIN wins, and a
 * missing tool is explained instead of failing with a bare ENOENT.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_DIR } from '../src/config.js';
import { embeddedBinary, LOG_FILE, postgresLogFile } from '../src/db/postgres.js';

const exe = (n: string) => (os.platform() === 'win32' ? `${n}.exe` : n);

describe('built-in database log files', () => {
  it('each data folder logs to its own file, so tests can start while the dev server runs (Windows locks open logs)', () => {
    expect(postgresLogFile('pg')).toBe(path.join(DATA_DIR, 'logs', 'postgres.log'));
    expect(postgresLogFile('pg-test-123')).toBe(path.join(DATA_DIR, 'logs', 'postgres-pg-test-123.log'));
    // This very run uses a test folder, so it must not be writing to the dev server's log.
    expect(LOG_FILE).not.toBe(postgresLogFile('pg'));
  });
});

describe('PostgreSQL client tools for backup and restore', () => {
  it('uses PG_BIN when it holds the tool', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgbin-'));
    fs.writeFileSync(path.join(dir, exe('pg_restore')), '');
    expect(await embeddedBinary('pg_restore', dir)).toBe(path.join(dir, exe('pg_restore')));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('explains a PG_BIN folder without the tool', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgbin-'));
    await expect(embeddedBinary('pg_dump', dir)).rejects.toThrow(/not found in PG_BIN/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('without PG_BIN, a tool missing from the built-in package points to db:backup:online', async () => {
    const pgCtl = (await import(`@embedded-postgres/${os.platform() === 'win32' ? 'windows' : os.platform()}-${os.arch()}`)).pg_ctl as string;
    const present = fs.existsSync(path.join(path.dirname(pgCtl), exe('pg_dump')));
    if (present) expect(await embeddedBinary('pg_dump', '')).toContain('pg_dump');
    else await expect(embeddedBinary('pg_dump', '')).rejects.toThrow(/db:backup:online/);
  });
});
