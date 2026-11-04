/**
 * Where a restore may go. A restore only ever creates a NEW, empty database next to the live one:
 * the live database, and any other database that already exists, is refused before anything is written.
 */
import pg from 'pg';

export const databaseName = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));

export function withDatabase(url: string, name: string) {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

/** The checks that need no database. `confirm` is RESTORE_CONFIRM, required on a production system. */
export function assertRestoreTarget(o: { target: string; liveDatabase: string; production: boolean; confirm?: string }) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(o.target)) throw new Error('The new database name may use only lower-case letters, digits and underscores.');
  if (o.target === o.liveDatabase) throw new Error('Refusing to restore over the live database. Choose a new database name.');
  if (o.production && o.confirm !== o.target) throw new Error(`On a production system set RESTORE_CONFIRM=${o.target} to confirm this restore.`);
}

/** Creates the empty target on the live database's server and returns its URL. Refuses a name already in use. */
export async function prepareRestoreTarget(liveUrl: string, target: string, opts: { production?: boolean; confirm?: string } = {}) {
  const liveDatabase = databaseName(liveUrl);
  assertRestoreTarget({ target, liveDatabase, production: !!opts.production, confirm: opts.confirm });
  const client = new pg.Client({ connectionString: liveUrl });
  await client.connect();
  try {
    if ((await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target])).rowCount) {
      throw new Error(`Database "${target}" already exists. A restore only creates a new database.`);
    }
    await client.query(`CREATE DATABASE "${target}"`); // the name passed the pattern above
  } finally {
    await client.end();
  }
  const url = withDatabase(liveUrl, target);
  if (databaseName(url) === liveDatabase) throw new Error('Refusing to restore over the live database.');
  return url;
}

/** Connection settings for pg_dump / pg_restore, so the password is not on the command line. */
export function clientEnvironment(url: string) {
  const u = new URL(url);
  return { password: decodeURIComponent(u.password), url: (u.password = '', u.toString()) };
}
