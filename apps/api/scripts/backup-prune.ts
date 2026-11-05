/**
 * Removes surplus backups: proven ones beyond the newest BACKUP_KEEP. Failed, unproven and older
 * backups without a manifest are never touched; those are for a person to look at.
 *   npm run db:backup:prune             → lists what would go, removes nothing
 *   npm run db:backup:prune -- --apply  → removes them, after re-checking every byte of the ones kept
 */
import fs from 'node:fs';
import { config } from '../src/config.js';
import { listBackups, planPrune } from '../src/lib/backups.js';

const apply = process.argv.includes('--apply');
const all = await listBackups(config.backups.dir, apply);
const surplus = planPrune(all, config.backups.keep);
const proven = all.filter((b) => b.status === 'OK').length;
console.log(`  ${all.length} backups, ${proven} proven, keeping the newest ${config.backups.keep} proven. ${all.length - proven} not proven: left alone.`);
if (!surplus.length) console.log('  Nothing to remove.');
for (const b of surplus) {
  console.log(`  ${apply ? 'Removing' : 'Would remove'} ${b.name}`);
  if (!apply) continue;
  fs.rmSync(b.location, { recursive: true, force: true });
  if (b.kind === 'dump') fs.rmSync(`${b.location}.manifest.json`, { force: true });
}
