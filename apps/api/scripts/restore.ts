/**
 * Restore a pg_dump backup INTO A NEW DATABASE, never over the live one:
 *   npm run db:restore -- data/backups/geoattend-....dump geoattend_restored
 * Then point PG_DATABASE (embedded) or DATABASE_URL at it after checking the data.
 */
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
import { embeddedBinary, ensureDatabase } from '../src/db/postgres.js';

const [file, target] = process.argv.slice(2);
if (!file || !target) {
  console.error('Usage: npm run db:restore -- <backup.dump> <new_database_name>');
  process.exit(1);
}
if (target === config.dbName) {
  console.error('Refusing to restore over the live database. Choose a new database name.');
  process.exit(1);
}
const url = await ensureDatabase(target);
const pgRestore = config.externalDatabaseUrl ? 'pg_restore' : await embeddedBinary('pg_restore');
execFileSync(pgRestore, ['--no-owner', '--exit-on-error', `--dbname=${url}`, file], { stdio: 'inherit', windowsHide: true });
console.log(`  Restored into database "${target}".`);
