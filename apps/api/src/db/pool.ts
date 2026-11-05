/**
 * Thin wrapper over node-postgres. Every query is parameterised; there is no
 * string-built SQL with user input anywhere in the code base.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

// Return BIGINT/NUMERIC as JS numbers (values here are small) and keep DATE as text.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * Which company a query runs for. Inside `withOrg` every query runs as the role geoattend_tenant
 * with that company set, so the database's own policies (migration 025) keep other companies out,
 * whatever the query says. `asSystem` and code outside any request (jobs, scripts, migrations) run
 * as the owner, unrestricted. lib/http.ts mount() decides this for every route.
 */
export const TENANT_ROLE = 'geoattend_tenant';
const scope = new AsyncLocalStorage<{ orgId: string | null }>();
export const withOrg = <T>(orgId: string, fn: () => T): T => scope.run({ orgId }, fn);
export const asSystem = <T>(fn: () => T): T => scope.run({ orgId: null }, fn);
/** The company of the current request; null for system work. */
export const currentOrg = () => scope.getStore()?.orgId ?? null;

// What each pooled connection is currently set to, so the setting is only sent when it changes.
const applied = new WeakMap<pg.PoolClient, string>();

async function applyScope(client: pg.PoolClient) {
  const orgId = currentOrg() ?? '';
  if ((applied.get(client) ?? '') === orgId) return;
  applied.delete(client);
  await client.query(`SELECT set_config('app.org_id', $1, false), set_config('role', $2, false)`, [orgId, orgId ? TENANT_ROLE : 'none']);
  applied.set(client, orgId);
}

/** A failure of the connection itself, not of a query or of the application's own rules. */
const connectionFault = (err: any) => !(err instanceof pg.DatabaseError) && /timeout|terminated|ECONN|EPIPE|not queryable/i.test(`${err?.code} ${err?.message}`);

/** Checks out a connection set to the current scope. A broken connection is not returned to the pool. */
async function withClient<T>(fn: (client: pg.PoolClient, markBroken: (err: Error) => void) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const ignore = () => undefined; // a dropped connection fails the running query; it must not crash the process
  client.on('error', ignore);
  let failure: Error | undefined;
  try {
    await applyScope(client);
    return await fn(client, (err) => (failure = err));
  } catch (err: any) {
    if (connectionFault(err)) failure = err;
    throw err;
  } finally {
    client.removeListener('error', ignore);
    client.release(failure);
  }
}

let pool: pg.Pool | null = null;

export function initPool(connectionString: string) {
  // Explicit timeouts: without them a request (or the watchdog) can wait forever on a dead server.
  pool = new pg.Pool({
    connectionString,
    max: 15,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    keepAlive: true,
    // Timestamps and interval arithmetic must not depend on how the server happens to be configured.
    options: '-c TimeZone=UTC',
  });
  pool.on('error', () => {
    /* idle client errors are surfaced on next query */
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Database pool not initialised');
  return pool;
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db?: Queryable): Promise<T[]> {
  // A transaction's client is already set; anything else takes a connection set to the current scope.
  if (db && !(db instanceof pg.Pool)) return (await db.query<T>(text, params as any[])).rows;
  return withClient(async (client) => (await client.query<T>(text, params as any[])).rows);
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db?: Queryable): Promise<T | null> {
  const rows = await q<T>(text, params, db);
  return rows[0] ?? null;
}

/** Runs `fn` in a transaction; rolls back on throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client, markBroken) => {
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(markBroken); // a connection left inside a transaction must not be reused
      throw err;
    }
  });
}
