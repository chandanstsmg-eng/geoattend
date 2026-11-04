-- Rollback of 022_device_history_and_final_voids. Run by hand after a backup.
-- Phone status history written since the migration is lost; attendance and phones themselves are unchanged.
BEGIN;
DROP INDEX review_requests_one_open_dispute;
DROP TRIGGER attendance_void_final ON attendance_records;
DROP FUNCTION attendance_void_is_final();
DROP TRIGGER device_status_recorded ON device_registrations;
DROP FUNCTION record_device_status();
DROP TABLE device_status_history;
ALTER TABLE device_registrations ALTER COLUMN status SET DEFAULT 'APPROVED';
DELETE FROM schema_migrations WHERE version = '022_device_history_and_final_voids';
COMMIT;
