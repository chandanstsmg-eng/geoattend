-- Rollback of 030_refresh_redelivery. A phone whose refresh answer was lost can then no longer get it again
-- (it signs in again, as before this migration); nothing else changes.
-- Take a backup first. The code from this release needs this migration, so deploy the earlier code too.
BEGIN;
DROP INDEX IF EXISTS refresh_tokens_replaced_by_idx;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS successor_box, DROP COLUMN IF EXISTS rotation_key_hash;
DELETE FROM schema_migrations WHERE version = '030_refresh_redelivery';
COMMIT;
