-- Rollback of 032_platform_and_subscriptions. Company, employee, attendance, GPS, leave and payroll records stay.
-- Lost: platform administrators and their sign-ins, the platform audit log and settings, editions, each company's
-- status, edition, limits, modules, subscription dates and registration details, and open invitations and
-- password-reset links (their users keep their current passwords).
-- Take a backup first. The code from this release reads these tables and columns, so deploy the earlier code too.
BEGIN;
DROP TABLE IF EXISTS account_tokens;
DROP TABLE IF EXISTS platform_audit_logs;
DROP FUNCTION IF EXISTS platform_audit_logs_immutable();
DROP TABLE IF EXISTS platform_settings;
DROP TABLE IF EXISTS platform_sessions;
DROP TABLE IF EXISTS platform_admins;
DROP TRIGGER IF EXISTS organizations_platform_fields ON organizations;
DROP FUNCTION IF EXISTS organizations_platform_fields_guard();
DROP INDEX IF EXISTS organizations_ends_on_idx;
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_subscription_dates,
  DROP COLUMN IF EXISTS registration_source,
  DROP COLUMN IF EXISTS registration,
  DROP COLUMN IF EXISTS subscription_ends_on,
  DROP COLUMN IF EXISTS subscription_starts_on,
  DROP COLUMN IF EXISTS subscription_status,
  DROP COLUMN IF EXISTS features,
  DROP COLUMN IF EXISTS supervisor_limit,
  DROP COLUMN IF EXISTS employee_limit,
  DROP COLUMN IF EXISTS edition_code,
  DROP COLUMN IF EXISTS status_changed_at,
  DROP COLUMN IF EXISTS status_reason,
  DROP COLUMN IF EXISTS status;
DROP TABLE IF EXISTS editions;
DELETE FROM schema_migrations WHERE version = '032_platform_and_subscriptions';
COMMIT;
