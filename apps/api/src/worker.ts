/**
 * Runs the background jobs in a process of their own: `npm run worker`, with JOBS_ENABLED=false on the
 * API, so a big report never competes with requests. Optional: by default the API runs them itself.
 * Several workers are safe, because each job holds a lease in the database.
 */
import { assertRuntimeConfig, config } from './config.js';
import { logger } from './lib/logger.js';
import { ensureDatabase } from './db/postgres.js';
import { closePool, databaseRoleProblems, initPool, prepareTenantLogin } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { startSweeper } from './modules/jobs/sweeper.js';

assertRuntimeConfig();
const pool = initPool(await ensureDatabase());
await migrate(pool, (m) => logger.info(m));
await prepareTenantLogin();
const roleProblems = await databaseRoleProblems();
if (roleProblems.length && config.isProduction) throw new Error(`Refusing to start in production:\n - ${roleProblems.join('\n - ')}`);

const stopSweeper = startSweeper();
logger.info(`GeoAttend worker running jobs every ${config.sweeperIntervalMs / 1000} seconds`);
setInterval(() => undefined, 60_000); // the job timer does not keep the process alive on its own

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  logger.info(`${signal} received — finishing the job in hand`);
  await stopSweeper();
  await closePool();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('message', (m) => m === 'shutdown' && void shutdown('shutdown message')); // Windows has no SIGTERM to catch
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
