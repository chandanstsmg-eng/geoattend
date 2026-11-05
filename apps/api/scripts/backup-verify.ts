/**
 * Checks backups byte by byte against their manifests. Reads only; it changes nothing.
 *   npm run db:backup:verify             → every backup
 *   npm run db:backup:verify -- <name>   → one backup
 * Exits 1 unless the newest backup (or the one named) is proven and unchanged.
 */
import { config } from '../src/config.js';
import { listBackups } from '../src/lib/backups.js';

const only = process.argv[2];
const all = (await listBackups(config.backups.dir, true)).filter((b) => !only || b.name === only);
if (!all.length) {
  console.log(only ? `  No backup called ${only} in ${config.backups.dir}.` : `  No backups in ${config.backups.dir}.`);
  process.exit(1);
}
for (const b of all) {
  const size = `${Math.round(b.sizeBytes / 1048576)} MB, ${b.fileCount} files`;
  console.log(`  ${b.status.padEnd(12)} ${b.name}  ${b.status === 'OK' ? `${b.result}, ${size}` : (b.problem ?? '')}`);
}
process.exit(all[0]!.status === 'OK' ? 0 : 1);
