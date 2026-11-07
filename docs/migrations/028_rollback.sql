-- Rollback of 028_job_monitoring. Removes the job history and operational alerts; touches no company data.
-- Take a backup first. The code from this release needs this migration, so deploy the earlier code too.
BEGIN;
DROP TABLE IF EXISTS ops_alerts;
DROP INDEX IF EXISTS job_failures_run_idx;
DROP INDEX IF EXISTS job_failures_org_idx;
ALTER TABLE job_failures DROP COLUMN IF EXISTS run_id;
ALTER TABLE job_state DROP COLUMN IF EXISTS last_duration_ms;
DROP TABLE IF EXISTS job_runs;
DELETE FROM schema_migrations WHERE version = '028_job_monitoring';
COMMIT;
