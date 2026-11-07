-- Rollback of 029_shift_reminders. Employees' reminder choices are lost; nothing else changes.
-- Take a backup first. The code from this release needs this migration, so deploy the earlier code too.
BEGIN;
ALTER TABLE employee_profiles DROP COLUMN IF EXISTS shift_reminders;
DELETE FROM schema_migrations WHERE version = '029_shift_reminders';
COMMIT;
