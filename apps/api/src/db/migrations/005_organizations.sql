-- Several client companies on one installation. Each company (organization) has its own
-- administrators, employees, workplaces, holidays, settings, notifications and audit log.
-- Everything below a workplace or an employee (shifts, sessions, attendance, leave, phones…)
-- belongs to the company of that workplace / employee.
-- Existing data moves into one "Default organisation".

CREATE TABLE organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  phone      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO organizations (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Default organisation');

ALTER TABLE users ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE users SET org_id = '00000000-0000-0000-0000-000000000001';
ALTER TABLE users ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX users_org_idx ON users (org_id, role);

ALTER TABLE workplaces ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE workplaces SET org_id = '00000000-0000-0000-0000-000000000001';
ALTER TABLE workplaces ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX workplaces_org_idx ON workplaces (org_id);

ALTER TABLE holidays ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE holidays SET org_id = '00000000-0000-0000-0000-000000000001';
ALTER TABLE holidays ALTER COLUMN org_id SET NOT NULL;
DROP INDEX holidays_uq;
CREATE UNIQUE INDEX holidays_uq ON holidays (org_id, COALESCE(workplace_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date);

ALTER TABLE notifications ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE notifications SET org_id = '00000000-0000-0000-0000-000000000001';
ALTER TABLE notifications ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX notifications_org_idx ON notifications (org_id, audience, created_at DESC);

-- Audit entries are append-only; the trigger is paused only to label existing rows.
ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update;
ALTER TABLE audit_logs ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE audit_logs SET org_id = '00000000-0000-0000-0000-000000000001';
ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update;
CREATE INDEX audit_logs_org_idx ON audit_logs (org_id, created_at DESC);

ALTER TABLE application_settings ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
UPDATE application_settings SET org_id = '00000000-0000-0000-0000-000000000001';
ALTER TABLE application_settings ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE application_settings DROP CONSTRAINT application_settings_pkey;
ALTER TABLE application_settings ADD PRIMARY KEY (org_id, key);
