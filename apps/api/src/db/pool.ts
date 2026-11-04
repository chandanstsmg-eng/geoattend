/**
 * Thin wrapper over node-postgres. Every query is parameterised; there is no
 * string-built SQL with user input anywhere in the code base.
 */
import pg from 'pg';

// Return BIGINT/NUMERIC as JS numbers (values here are small) and keep DATE as text.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

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

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = getPool()): Promise<T[]> {
  const res = await db.query<T>(text, params as any[]);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = getPool()): Promise<T | null> {
  const rows = await q<T>(text, params, db);
  return rows[0] ?? null;
}

/** Runs `fn` in a transaction; rolls back on throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
