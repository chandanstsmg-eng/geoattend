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

-- How each table belongs to a company: its own column, or one key lookup into its parent. Measured on
-- 2,900 and 171,000 records, a lookup stays close to unrestricted speed at both sizes; `IN (SELECT ...)`
-- made the planner compute the whole attendance view on small tables (20 times slower).
-- Writes additionally check every reference to another company-owned table, one key lookup each.
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
      ('absence_intervals',         'EXISTS (SELECT 1 FROM users o WHERE o.id = absence_intervals.employee_id)'),
      ('attendance_photos',         'EXISTS (SELECT 1 FROM users o WHERE o.id = attendance_photos.employee_id)'),
      ('attendance_records',        'EXISTS (SELECT 1 FROM users o WHERE o.id = attendance_records.employee_id)'),
      ('broadcast_recipients',      'EXISTS (SELECT 1 FROM users o WHERE o.id = broadcast_recipients.employee_id)'),
      ('employee_face_profiles',    'EXISTS (SELECT 1 FROM users o WHERE o.id = employee_face_profiles.employee_id)'),
      ('employee_faces',            'EXISTS (SELECT 1 FROM users o WHERE o.id = employee_faces.employee_id)'),
      ('employee_pay',              'EXISTS (SELECT 1 FROM users o WHERE o.id = employee_pay.employee_id)'),
      ('employee_shift_assignments','EXISTS (SELECT 1 FROM users o WHERE o.id = employee_shift_assignments.employee_id)'),
      ('geofence_events',           'EXISTS (SELECT 1 FROM users o WHERE o.id = geofence_events.employee_id)'),
      ('leave_requests',            'EXISTS (SELECT 1 FROM users o WHERE o.id = leave_requests.employee_id)'),
      ('location_updates',          'EXISTS (SELECT 1 FROM users o WHERE o.id = location_updates.employee_id)'),
      ('overtime_entries',          'EXISTS (SELECT 1 FROM users o WHERE o.id = overtime_entries.employee_id)'),
      ('pay_adjustments',           'EXISTS (SELECT 1 FROM users o WHERE o.id = pay_adjustments.employee_id)'),
      ('payslips',                  'EXISTS (SELECT 1 FROM users o WHERE o.id = payslips.employee_id)'),
      ('permission_status_events',  'EXISTS (SELECT 1 FROM users o WHERE o.id = permission_status_events.employee_id)'),
      ('review_requests',           'EXISTS (SELECT 1 FROM users o WHERE o.id = review_requests.employee_id)'),
      ('session_breaks',            'EXISTS (SELECT 1 FROM users o WHERE o.id = session_breaks.employee_id)'),
      ('task_photos',               'EXISTS (SELECT 1 FROM users o WHERE o.id = task_photos.employee_id)'),
      ('tracking_sessions',         'EXISTS (SELECT 1 FROM users o WHERE o.id = tracking_sessions.employee_id)'),
      ('workplace_assignments',     'EXISTS (SELECT 1 FROM users o WHERE o.id = workplace_assignments.employee_id)'),
      -- through the user account
      ('administrator_profiles',    'EXISTS (SELECT 1 FROM users o WHERE o.id = administrator_profiles.user_id)'),
      ('device_registrations',      'EXISTS (SELECT 1 FROM users o WHERE o.id = device_registrations.user_id)'),
      ('notice_acknowledgements',   'EXISTS (SELECT 1 FROM users o WHERE o.id = notice_acknowledgements.user_id)'),
      ('refresh_tokens',            'EXISTS (SELECT 1 FROM users o WHERE o.id = refresh_tokens.user_id)'),
      ('web_push_subscriptions',    'EXISTS (SELECT 1 FROM users o WHERE o.id = web_push_subscriptions.user_id)'),
      -- through another owned record
      ('device_status_history',     'EXISTS (SELECT 1 FROM device_registrations o WHERE o.id = device_status_history.device_id)'),
      ('notification_deliveries',   'EXISTS (SELECT 1 FROM notifications o WHERE o.id = notification_deliveries.notification_id)'),
      ('notification_reads',        'EXISTS (SELECT 1 FROM notifications o WHERE o.id = notification_reads.notification_id)'),
      ('session_state_transitions', 'EXISTS (SELECT 1 FROM tracking_sessions o WHERE o.id = session_state_transitions.session_id)'),
      ('shift_revisions',           'EXISTS (SELECT 1 FROM shifts o WHERE o.id = shift_revisions.shift_id)'),
      ('shifts',                    'EXISTS (SELECT 1 FROM workplaces o WHERE o.id = shifts.workplace_id)')
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
