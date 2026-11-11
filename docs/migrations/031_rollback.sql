-- Rollback of 031_suspicious_readings. The readings themselves stay; only the flag and the implied speed are lost,
-- so readings flagged as impossible jumps can no longer be told apart from the others.
-- Take a backup first. The code from this release writes these columns, so deploy the earlier code too.
BEGIN;
ALTER TABLE location_updates DROP COLUMN IF EXISTS implied_speed_kmh, DROP COLUMN IF EXISTS suspect_reason;
DELETE FROM schema_migrations WHERE version = '031_suspicious_readings';
COMMIT;
