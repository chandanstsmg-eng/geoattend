/**
 * Every test run gets its own database server: a new folder, a free port, a new password. Nothing
 * depends on what else is running on the machine or on what a previous run left behind, and the
 * developer's database and .env are never used.
 *
 * Tests connect the way production does: as an ordinary owner that is not a superuser, with requests
 * on the separate restricted login. If the code needed superuser rights, the tests would fail.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

export const TEST_OWNER = 'geoattend_owner';

export async function setup() {
  const password = crypto.randomBytes(24).toString('hex');
  const port = await freePort();
  // Set before config.ts is first imported. An empty value also stops .env from supplying one.
  Object.assign(process.env, {
    LOG_LEVEL: process.env.LOG_LEVEL || 'silent',
    PG_PORT: String(port),
    PG_PASSWORD: password,
    PG_DATA_SUBDIR: `pg-test-${process.pid}`,
    PG_MAX_CONNECTIONS: '300',
    PG_USER: '',
    DATABASE_URL: '',
    APP_DATABASE_URL: '',
  });
  const { ensureDatabase } = await import('../src/db/postgres.js');
  const admin = new pg.Client({ connectionString: await ensureDatabase('postgres') });
  await admin.connect();
  await admin.query(`CREATE ROLE ${TEST_OWNER} LOGIN NOSUPERUSER CREATEDB CREATEROLE PASSWORD '${password}'`);
  await admin.end();
  process.env.PG_USER = TEST_OWNER; // test files connect as this; they start after this function returns
}

export async function teardown() {
  const { DATA_DIR } = await import('../src/config.js');
  const { stopEmbeddedDatabase, postgresLogFile } = await import('../src/db/postgres.js');
  await stopEmbeddedDatabase().catch(() => undefined);
  fs.rmSync(path.join(DATA_DIR, process.env.PG_DATA_SUBDIR!), { recursive: true, force: true });
  fs.rmSync(postgresLogFile(process.env.PG_DATA_SUBDIR!), { force: true });
  fs.rmSync(path.join(DATA_DIR, 'test-photos'), { recursive: true, force: true });
}
