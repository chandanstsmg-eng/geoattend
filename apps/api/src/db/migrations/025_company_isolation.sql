-- Company isolation enforced by the database itself. Rollback: docs/migrations/025_rollback.sql.
-- No row is changed. Every request of a signed-in user runs as the role below with its company set,
-- so a query that forgets its company filter returns nothing from other companies instead of leaking,
-- and a write that points at another company's record is refused.
--
-- The tables stay owned by the migration user, which is not subject to these policies: sign-in
-- (nobody is known yet) and background jobs (they serve every company) run that way.
--
-- A NEW TABLE MUST BE ADDED HERE (or to a later migration): test/isolation.test.ts fails otherwise.

-- The role is shared by all databases of a server. It can never log in.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geoattend_tenant') THEN
    BEGIN
      CREATE ROLE geoattend_tenant NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- two databases migrating at the same moment
    END;
  END IF;
  -- The API must be allowed to become the role; superusers always are.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AND NOT pg_has_role(current_user, 'geoattend_tenant', 'MEMBER') THEN
    EXECUTE format('GRANT geoattend_tenant TO %I', current_user);
  END IF;
END $$;

-- The company of the current request, NULL when none is set.
CREATE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;

GRANT USAGE ON SCHEMA public TO geoattend_tenant;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO geoattend_tenant;

-- How each table belongs to a company. Reads use a set test (one pass over the small parent table);
-- writes additionally check every reference to another company-owned table, one key lookup each.
DO $$
DECLARE
  t RECORD;
  fk RECORD;
  check_sql TEXT;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      -- directly owned
      ('organizations',             'id = app_org()'),
      ('application_settings',      'org_id = app_org()'),
      ('audit_logs',                'org_id = app_org()'),
      ('broadcasts',                'org_id = app_org()'),
      ('day_closes',                'org_id = app_org()'),
      ('digest_runs',               'org_id = app_org()'),
      ('employee_profiles',         'org_id = app_org()'),
      ('holidays',                  'org_id = app_org()'),
      ('notifications',             'org_id = app_org()'),
      ('payroll_runs',              'org_id = app_org()'),
      ('sos_alerts',                'org_id = app_org()'),
      ('tasks',                     'org_id = app_org()'),
      ('users',                     'org_id = app_org()'),
      ('workplaces',                'org_id = app_org()'),
      -- through the employee
      ('absence_intervals',         'employee_id IN (SELECT id FROM users)'),
      ('attendance_photos',         'employee_id IN (SELECT id FROM users)'),
      ('attendance_records',        'employee_id IN (SELECT id FROM users)'),
      ('broadcast_recipients',      'employee_id IN (SELECT id FROM users)'),
      ('employee_face_profiles',    'employee_id IN (SELECT id FROM users)'),
      ('employee_faces',            'employee_id IN (SELECT id FROM users)'),
      ('employee_pay',              'employee_id IN (SELECT id FROM users)'),
      ('employee_shift_assignments','employee_id IN (SELECT id FROM users)'),
      ('geofence_events',           'employee_id IN (SELECT id FROM users)'),
      ('leave_requests',            'employee_id IN (SELECT id FROM users)'),
      ('location_updates',          'employee_id IN (SELECT id FROM users)'),
      ('overtime_entries',          'employee_id IN (SELECT id FROM users)'),
      ('pay_adjustments',           'employee_id IN (SELECT id FROM users)'),
      ('payslips',                  'employee_id IN (SELECT id FROM users)'),
      ('permission_status_events',  'employee_id IN (SELECT id FROM users)'),
      ('review_requests',           'employee_id IN (SELECT id FROM users)'),
      ('session_breaks',            'employee_id IN (SELECT id FROM users)'),
      ('task_photos',               'employee_id IN (SELECT id FROM users)'),
      ('tracking_sessions',         'employee_id IN (SELECT id FROM users)'),
      ('workplace_assignments',     'employee_id IN (SELECT id FROM users)'),
      -- through the user account
      ('administrator_profiles',    'user_id IN (SELECT id FROM users)'),
      ('device_registrations',      'user_id IN (SELECT id FROM users)'),
      ('notice_acknowledgements',   'user_id IN (SELECT id FROM users)'),
      ('refresh_tokens',            'user_id IN (SELECT id FROM users)'),
      ('web_push_subscriptions',    'user_id IN (SELECT id FROM users)'),
      -- through another owned record
      ('device_status_history',     'device_id IN (SELECT id FROM device_registrations)'),
      ('notification_deliveries',   'notification_id IN (SELECT id FROM notifications)'),
      ('notification_reads',        'notification_id IN (SELECT id FROM notifications)'),
      ('session_state_transitions', 'session_id IN (SELECT id FROM tracking_sessions)'),
      ('shift_revisions',           'shift_id IN (SELECT id FROM shifts)'),
      ('shifts',                    'workplace_id IN (SELECT id FROM workplaces)')
    ) AS x(tbl, owned)
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO geoattend_tenant', t.tbl);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tbl);

    check_sql := t.owned;
    FOR fk IN
      SELECT a.attname AS col, r.relname AS parent, ra.attname AS parent_col
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.conrelid = t.tbl::regclass AND cardinality(c.conkey) = 1 AND r.relname <> 'organizations'
    LOOP
      check_sql := check_sql || format(' AND (%1$I.%2$I IS NULL OR EXISTS (SELECT 1 FROM %3$I p WHERE p.%4$I = %1$I.%2$I))', t.tbl, fk.col, fk.parent, fk.parent_col);
    END LOOP;

    EXECUTE format('CREATE POLICY company_isolation ON %I TO geoattend_tenant USING (%s) WITH CHECK (%s)', t.tbl, t.owned, check_sql);
  END LOOP;
END $$;

-- Views must read with the caller's rights, otherwise they would see every company.
GRANT SELECT ON attendance_work, attendance_work_all TO geoattend_tenant;
ALTER VIEW attendance_work_all SET (security_invoker = true);
ALTER VIEW attendance_work SET (security_invoker = true);
