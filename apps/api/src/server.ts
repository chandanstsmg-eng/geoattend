import net from 'node:net';
import { assertRuntimeConfig, config, sampleData } from './config.js';
import { startSampleHeartbeat } from './modules/jobs/sample-heartbeat.js';
import { logger } from './lib/logger.js';
import { ensureDatabase } from './db/postgres.js';
import { closePool, databaseRoleProblems, getPool, initPool, prepareTenantLogin } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { startSweeper } from './modules/jobs/sweeper.js';

function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

async function main() {
  assertRuntimeConfig();
  if (!(await portFree(config.port))) {
    logger.error(`Port ${config.port} is already in use — is GeoAttend already running in another terminal? Stop it or set API_PORT.`);
    process.exit(1);
  }
  const url = await ensureDatabase();
  const pool = initPool(url);
  await migrate(pool, (m) => logger.info(m));
  await prepareTenantLogin();
  const roleProblems = await databaseRoleProblems();
  if (roleProblems.length && config.isProduction) throw new Error(`Refusing to start in production:\n - ${roleProblems.join('\n - ')}`);
  for (const p of roleProblems) logger.warn(p);

  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(`GeoAttend API on http://localhost:${config.port}  (docs: /api/docs)${config.demoMode ? '  — DEMO MODE: simulator enabled' : ''}`);
  });
  const stopSweeper = startSweeper();
  const stopSample = sampleData ? startSampleHeartbeat() : () => undefined;

  // Built-in database watchdog: if the local PostgreSQL is stopped while the API runs
  // (e.g. `npm run db:stop` from another terminal), start it again instead of failing every request.
  let healing = false;
  const watchdog = config.externalDatabaseUrl
    ? null
    : setInterval(async () => {
        if (healing) return;
        try {
          await getPool().query('SELECT 1');
        } catch {
          healing = true;
          logger.warn('Built-in database is not reachable — restarting it…');
          try {
            const fresh = await ensureDatabase();
            // Drop connections that belonged to the stopped server so requests recover at once.
            const old = getPool();
            initPool(fresh);
            void old.end().catch(() => undefined);
            logger.info('Built-in database is running again');
          } catch (err) {
            logger.error({ err }, 'Could not restart the built-in database; see data/logs/postgres.log');
          } finally {
            healing = false;
          }
        }
      }, 5000);
  watchdog?.unref();

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    stopSweeper();
    stopSample();
    // Let requests in flight finish; live streams and stuck clients are cut after 10 seconds.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, 10_000).unref();
    });
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
