/**
 * Restore a pg_dump backup INTO A NEW DATABASE, never over the live one:
 *   npm run db:restore -- data/backups/geoattend-....dump geoattend_restored
 * The target must not exist; it is created here. With NODE_ENV=production also set RESTORE_CONFIRM
 * to the new name. Then point PG_DATABASE (embedded) or DATABASE_URL at it after checking the data.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
import { embeddedBinary, ensureDatabase } from '../src/db/postgres.js';
import { clientEnvironment, ensureTenantRole, prepareRestoreTarget } from '../src/db/restore-target.js';

const [file, target] = process.argv.slice(2);
if (!file || !target) {
  console.error('Usage: npm run db:restore -- <backup.dump> <new_database_name>');
  process.exit(1);
}
try {
  // The tool is found BEFORE the new database is created: otherwise a missing pg_restore left an empty
  // database behind, and the retry was refused because the name now existed.
  // PG_BIN, when set, wins; else PATH for an external server, else the embedded package (none on Windows).
  const pgRestore = config.externalDatabaseUrl && !process.env.PG_BIN ? 'pg_restore' : await embeddedBinary('pg_restore');
  if (!fs.existsSync(file)) throw new Error(`Backup file not found: ${file}`);
  const liveUrl = await ensureDatabase();
  const url = await prepareRestoreTarget(liveUrl, target, { production: config.isProduction, confirm: process.env.RESTORE_CONFIRM });
  await ensureTenantRole(url);
  const client = clientEnvironment(url);
  execFileSync(pgRestore, ['--no-owner', '--exit-on-error', `--dbname=${client.url}`, file], { stdio: 'inherit', windowsHide: true, env: { ...process.env, PGPASSWORD: client.password } });
  console.log(`  Restored into new database "${target}". The live database was not touched.`);
} catch (err) {
  console.error(`  ${(err as Error).message}`);
  process.exit(1);
}
process.exit(0);
