-- Rollback of 025_company_isolation. Run by hand after a backup, with the API stopped: code from the
-- same release expects the role and the policies. No rows change. After this, company isolation rests
-- on the application's own filters alone. The role stays, because other databases on the server may use it.
BEGIN;
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid WHERE c.relnamespace = 'public'::regnamespace AND p.polname = 'company_isolation' LOOP
    EXECUTE format('DROP POLICY company_isolation ON %I', t.relname);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;
ALTER VIEW attendance_work RESET (security_invoker);
ALTER VIEW attendance_work_all RESET (security_invoker);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM geoattend_tenant;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM geoattend_tenant;
REVOKE ALL ON SCHEMA public FROM geoattend_tenant;
DROP FUNCTION app_org();
DELETE FROM schema_migrations WHERE version = '025_company_isolation';
COMMIT;
