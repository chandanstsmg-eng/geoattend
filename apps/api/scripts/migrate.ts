import { ensureDatabase } from '../src/db/postgres.js';
import { closePool, initPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const pool = initPool(await ensureDatabase());
await migrate(pool, (m) => console.log(`  ${m}`));
const ext = await pool.query(`SELECT extversion FROM pg_extension WHERE extname = 'postgis'`);
console.log(`  Database schema is up to date. PostGIS: ${ext.rowCount ? `enabled (${ext.rows[0].extversion})` : 'not installed — using built-in geodesic calculations'}.`);
await closePool();
