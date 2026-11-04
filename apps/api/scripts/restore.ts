/**
 * Restore a pg_dump backup INTO A NEW DATABASE, never over the live one:
 *   npm run db:restore -- data/backups/geoattend-....dump geoattend_restored
 * The target must not exist; it is created here. With NODE_ENV=production also set RESTORE_CONFIRM
 * to the new name. Then point PG_DATABASE (embedded) or DATABASE_URL at it after checking the data.
 */
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
import { embeddedBinary, ensureDatabase } from '../src/db/postgres.js';
import { clientEnvironment, prepareRestoreTarget } from '../src/db/restore-target.js';

const [file, target] = process.argv.slice(2);
if (!file || !target) {
  console.error('Usage: npm run db:restore -- <backup.dump> <new_database_name>');
  process.exit(1);
}
try {
  const liveUrl = await ensureDatabase();
  const url = await prepareRestoreTarget(liveUrl, target, { production: config.isProduction, confirm: process.env.RESTORE_CONFIRM });
  const pgRestore = config.externalDatabaseUrl ? 'pg_restore' : await embeddedBinary('pg_restore');
  const client = clientEnvironment(url);
  execFileSync(pgRestore, ['--no-owner', '--exit-on-error', `--dbname=${client.url}`, file], { stdio: 'inherit', windowsHide: true, env: { ...process.env, PGPASSWORD: client.password } });
  console.log(`  Restored into new database "${target}". The live database was not touched.`);
} catch (err) {
  console.error(`  ${(err as Error).message}`);
  process.exit(1);
}
process.exit(0);
