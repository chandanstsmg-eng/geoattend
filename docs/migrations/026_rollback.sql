-- Rollback of 026_job_tracking. Run by hand after a backup, with the API stopped.
-- Only job bookkeeping is lost: no attendance, payroll or company record changes.
BEGIN;
ALTER TABLE digest_runs DROP COLUMN attempts, DROP COLUMN failed;
DROP TABLE job_failures;
DROP TABLE job_state;
DELETE FROM schema_migrations WHERE version = '026_job_tracking';
COMMIT;
