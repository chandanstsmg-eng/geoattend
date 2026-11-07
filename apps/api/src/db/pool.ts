/**
 * Thin wrapper over node-postgres. Every query is parameterised; there is no
 * string-built SQL with user input anywhere in the code base.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import pg from 'pg';
import { config } from '../config.js';

// Return BIGINT/NUMERIC as JS numbers (values here are small) and keep DATE as text.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * Two database logins, two pools.
 *
 * Inside `withOrg` a query uses the restricted login, geoattend_tenant, with the company set on the
 * connection. That login owns nothing, cannot bypass row-level security and cannot become any other
 * role, so the database's own policies (migration 025) keep other companies out whatever the query says.
 * Every signed-in request (lib/http.ts mount) and every background job (modules/jobs/runner.ts) runs there.
 *
 * `asSystem`, and code outside any request (migrations, scripts), uses the owner login, which is not
 * limited by the policies. docs/COMPANY-ISOLATION.md lists what may do that.
 */
export const TENANT_ROLE = 'geoattend_tenant';
const scope = new AsyncLocalStorage<{ orgId: string | null }>();
export const withOrg = <T>(orgId: string, fn: () => T): T => scope.run({ orgId }, fn);
export const asSystem = <T>(fn: () => T): T => scope.run({ orgId: null }, fn);
/** The company of the current request; null for system work. */
export const currentOrg = () => scope.getStore()?.orgId ?? null;

// The company each restricted connection is currently set to, so it is only sent when it changes.
const applied = new WeakMap<pg.PoolClient, string>();

async function applyCompany(client: pg.PoolClient, orgId: string) {
  if (applied.get(client) === orgId) return;
  applied.delete(client);
  await client.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
  applied.set(client, orgId);
}

let tenant: pg.Pool | null = null;

/** The owner login's URL with the restricted login in it, for development and tests. */
function derivedTenantUrl(ownerUrl: string) {
  const u = new URL(ownerUrl);
  const secret = crypto.createHash('sha256').update(`geoattend-tenant-login:${decodeURIComponent(u.password)}`).digest('hex');
  u.username = TENANT_ROLE;
  u.password = secret;
  return { url: u.toString(), secret };
}

const ownerUrl = () => (getPool() as any).options.connectionString as string;

export function getTenantPool(): pg.Pool {
  if (!tenant) {
    tenant = newPool(config.tenantDatabaseUrl || derivedTenantUrl(ownerUrl()).url, 15);
  }
  return tenant;
}

/**
 * Development and tests: gives the restricted login the password derived from the owner's, if it does
 * not work yet. In production the password is set once by whoever creates the role.
 */
export async function prepareTenantLogin() {
  if (config.tenantDatabaseUrl) return;
  const { url, secret } = derivedTenantUrl(ownerUrl());
  const works = async () => {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      return true;
    } catch {
      return false;
    } finally {
      await c.end().catch(() => undefined);
    }
  };
  for (let i = 0; i < 20 && !(await works()); i++) {
    // Not a parameter: ALTER ROLE takes none. The value is hexadecimal, from the hash above.
    await getPool().query(`ALTER ROLE ${TENANT_ROLE} PASSWORD '${secret}'`).catch(() => undefined); // parallel starts may collide; look again
    await new Promise((r) => setTimeout(r, 50 * i));
  }
}

/** Everything wrong with the two database logins, as readable lines. */
export async function databaseRoleProblems() {
  const problems: string[] = [];
  const t = await withOrg('00000000-0000-0000-0000-000000000000', () =>
    one(`SELECT current_user AS name, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
                (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid AND c.relnamespace = 'public'::regnamespace) AS owned,
                pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'users'::regclass), 'MEMBER') AS can_become_owner
         FROM pg_roles r WHERE r.rolname = current_user`),
  );
  if (t!.rolsuper) problems.push(`The restricted login ${t!.name} is a superuser.`);
  if (t!.rolbypassrls) problems.push(`The restricted login ${t!.name} can bypass row-level security.`);
  if (t!.rolcreaterole || t!.rolcreatedb) problems.push(`The restricted login ${t!.name} can create roles or databases.`);
  if (t!.owned > 0) problems.push(`The restricted login ${t!.name} owns tables, so row-level security does not apply to it.`);
  if (t!.can_become_owner) problems.push(`The restricted login ${t!.name} can become the table owner.`);
  const o = await asSystem(() => one(`SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user`));
  if (o!.rolsuper) problems.push(`The owner login ${o!.name} is a superuser. Use an ordinary owner in production.`);
  return problems;
}

/** A failure of the connection itself, not of a query or of the application's own rules. */
const connectionFault = (err: any) => !(err instanceof pg.DatabaseError) && /timeout|terminated|ECONN|EPIPE|not queryable/i.test(`${err?.code} ${err?.message}`);

/** Checks out a connection for the current scope. A broken connection is not returned to the pool. */
async function withClient<T>(fn: (client: pg.PoolClient, markBroken: (err: Error) => void) => Promise<T>): Promise<T> {
  const orgId = currentOrg();
  const client = await (orgId ? getTenantPool() : getPool()).connect();
  const ignore = () => undefined; // a dropped connection fails the running query; it must not crash the process
  client.on('error', ignore);
  let failure: Error | undefined;
  try {
    if (orgId) await applyCompany(client, orgId);
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

function newPool(connectionString: string, max: number) {
  // Explicit timeouts: without them a request (or the watchdog) can wait forever on a dead server.
  const p = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    keepAlive: true,
    // Timestamps and interval arithmetic must not depend on how the server happens to be configured.
    options: '-c TimeZone=UTC',
  });
  p.on('error', () => {
    /* idle client errors are surfaced on next query */
  });
  return p;
}

export function initPool(connectionString: string) {
  pool = newPool(connectionString, 8); // sign-in, sign-up and job scheduling only
  if (tenant) void tenant.end().catch(() => undefined);
  tenant = null;
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Database pool not initialised');
  return pool;
}

export async function closePool() {
  if (tenant) await tenant.end();
  tenant = null;
  if (pool) await pool.end();
  pool = null;
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db?: Queryable): Promise<T[]> {
  // A transaction's client is already set; anything else takes a connection set to the current scope.
  if (db && !(db instanceof pg.Pool)) return (await db.query<T>(text, params as any[])).rows;
  return withClient(async (client) => (await client.query<T>(text, params as any[])).rows);
}

/**
 * The same as `q`, for a query that runs many times per request and costs more to plan than to run:
 * each connection keeps the plan. Nothing about the company is baked into it: row security reads
 * app.org_id when the query runs, and PostgreSQL replans when the role changes. Needs a direct or
 * session-mode connection, which the company setting requires anyway (docs/COMPANY-ISOLATION.md).
 * `text` must be the same every time for a given `name`.
 */
export async function qPrepared<T extends pg.QueryResultRow = any>(name: string, text: string, params: unknown[]): Promise<T[]> {
  return withClient(async (client) => (await client.query<T>({ name, text, values: params as any[] })).rows);
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
