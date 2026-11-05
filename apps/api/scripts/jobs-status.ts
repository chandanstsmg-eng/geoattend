/** Background job status for whoever runs the server: npm run jobs:status */
import { ensureDatabase } from '../src/db/postgres.js';
import { closePool, initPool, q } from '../src/db/pool.js';

initPool(await ensureDatabase());
const jobs = await q(`SELECT job, runs_ok, runs_failed, consecutive_failures, last_ok_at, last_failed_at, last_duration_ms, next_run_at, running_since, last_error FROM job_state ORDER BY job`);
if (!jobs.length) console.log('No job has run yet.');
for (const j of jobs) {
  const state = j.running_since ? 'RUNNING' : j.consecutive_failures > 0 ? `FAILING (${j.consecutive_failures} in a row)` : 'ok';
  console.log(`${String(j.job).padEnd(20)} ${state.padEnd(24)} ok ${j.runs_ok}, failed ${j.runs_failed}, last ok ${j.last_ok_at?.toISOString() ?? 'never'}, took ${j.last_duration_ms ?? '?'} ms, next ${j.next_run_at.toISOString()}`);
  if (j.last_error) console.log(`  last error: ${j.last_error}`);
}
const recent = await q(`SELECT job, org_id, message, at FROM job_failures ORDER BY at DESC LIMIT 20`);
if (recent.length) console.log('\nLatest failures:');
for (const f of recent) console.log(`  ${f.at.toISOString()} ${f.job}${f.org_id ? ` company ${f.org_id}` : ''}: ${f.message}`);
await closePool();
