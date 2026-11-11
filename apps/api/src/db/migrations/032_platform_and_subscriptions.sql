-- Platform administration, company editions and subscriptions, invitations and password resets.
-- Rollback: docs/migrations/032_rollback.sql.
--
-- Additive only. No existing row changes meaning:
--   * every existing company gets status ACTIVE, the ENTERPRISE edition, no employee or supervisor limit,
--     every optional module on and no subscription end date, so nothing it can do today is taken away;
--   * new nullable or defaulted columns rewrite no row.
--
-- Who may touch what:
--   * editions, platform_admins, platform_sessions, platform_settings and platform_audit_logs are platform
--     data. The restricted company login (geoattend_tenant) gets no rights on them at all.
--   * account_tokens (invitations and password resets) belong to a company through the user, with the same
--     row-level security as refresh_tokens.
--   * the platform fields on organizations (status, edition, limits, modules, subscription, registration) can be
--     read by the company itself but changed only by the platform: a trigger refuses the restricted login.

-- ── Editions: templates the platform copies onto a company when it assigns one ──
CREATE TABLE editions (
  code                  TEXT PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name                  TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description           TEXT CHECK (length(description) <= 500),
  employee_limit        INT CHECK (employee_limit >= 0),    -- NULL: no limit
  supervisor_limit      INT CHECK (supervisor_limit >= 0),  -- NULL: no limit
  features              JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(features) = 'object'),
  default_duration_days INT NOT NULL DEFAULT 365 CHECK (default_duration_days BETWEEN 1 AND 3660),
  sort_order            INT NOT NULL DEFAULT 0,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Optional modules (the core of attendance, GPS, leave, reports, exports, SOS and notifications is in every edition):
--   announcements, tasks, overtime, payroll (payroll also needs PAYROLL_ENABLED on the server).
INSERT INTO editions (code, name, description, employee_limit, supervisor_limit, features, default_duration_days, sort_order) VALUES
  ('STARTER',      'Starter',      'Attendance, GPS geofencing, leave, reports and exports for a small team.', 25, 2,
   '{"announcements": false, "tasks": false, "overtime": false, "payroll": false}', 365, 1),
  ('PROFESSIONAL', 'Professional', 'Everything in Starter, with announcements, tasks and overtime.', 200, 10,
   '{"announcements": true, "tasks": true, "overtime": true, "payroll": false}', 365, 2),
  ('ENTERPRISE',   'Enterprise',   'Every module, with no employee or supervisor limit.', NULL, NULL,
   '{"announcements": true, "tasks": true, "overtime": true, "payroll": true}', 365, 3);

-- ── The company's own status, entitlements and subscription ──
ALTER TABLE organizations
  ADD COLUMN status                 TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  ADD COLUMN status_reason          TEXT CHECK (length(status_reason) <= 500),
  ADD COLUMN status_changed_at      TIMESTAMPTZ,
  ADD COLUMN edition_code           TEXT NOT NULL DEFAULT 'ENTERPRISE' REFERENCES editions(code),
  ADD COLUMN employee_limit         INT CHECK (employee_limit >= 0),
  ADD COLUMN supervisor_limit       INT CHECK (supervisor_limit >= 0),
  ADD COLUMN features               JSONB NOT NULL DEFAULT '{"announcements": true, "tasks": true, "overtime": true, "payroll": true}' CHECK (jsonb_typeof(features) = 'object'),
  ADD COLUMN subscription_status    TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (subscription_status IN ('TRIAL', 'ACTIVE', 'CANCELLED')),
  ADD COLUMN subscription_starts_on DATE,
  -- The renewal date: the last day the subscription covers. NULL: no end date.
  ADD COLUMN subscription_ends_on   DATE,
  ADD COLUMN registration           JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(registration) = 'object'),
  ADD COLUMN registration_source    TEXT NOT NULL DEFAULT 'EXISTING' CHECK (registration_source IN ('EXISTING', 'PLATFORM', 'SELF_SIGNUP', 'DEMO')),
  ADD CONSTRAINT organizations_subscription_dates CHECK (subscription_ends_on IS NULL OR subscription_starts_on IS NULL OR subscription_ends_on >= subscription_starts_on);
CREATE INDEX organizations_ends_on_idx ON organizations (subscription_ends_on) WHERE subscription_ends_on IS NOT NULL;

CREATE FUNCTION organizations_platform_fields_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'geoattend_tenant' AND
     (NEW.status, NEW.status_reason, NEW.status_changed_at, NEW.edition_code, NEW.employee_limit, NEW.supervisor_limit, NEW.features,
      NEW.subscription_status, NEW.subscription_starts_on, NEW.subscription_ends_on, NEW.registration, NEW.registration_source)
     IS DISTINCT FROM
     (OLD.status, OLD.status_reason, OLD.status_changed_at, OLD.edition_code, OLD.employee_limit, OLD.supervisor_limit, OLD.features,
      OLD.subscription_status, OLD.subscription_starts_on, OLD.subscription_ends_on, OLD.registration, OLD.registration_source) THEN
    RAISE EXCEPTION 'A company''s status, edition and subscription are managed by the platform' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_platform_fields BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION organizations_platform_fields_guard();

-- ── Platform administrators: a separate account type, not a member of any company ──
CREATE TABLE platform_admins (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 200),
  password_hash        TEXT NOT NULL,
  full_name            TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  is_active            BOOLEAN NOT NULL DEFAULT true,
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  failed_login_count   INT NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admins_email_uq ON platform_admins (lower(email));

-- Refresh tokens of platform sign-ins, stored as hashes and rotated on every use. A family (one sign-in)
-- also has an absolute end: a platform session never lasts longer than that, however active.
CREATE TABLE platform_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id          UUID NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL UNIQUE,
  family_id         UUID NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  family_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  replaced_by       UUID,
  ip                TEXT,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX platform_sessions_family_idx ON platform_sessions (family_id);
CREATE INDEX platform_sessions_admin_idx ON platform_sessions (admin_id);

CREATE TABLE platform_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES platform_admins(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Self sign-up stays on, as today; a company that signs itself up starts on a Starter trial.
INSERT INTO platform_settings (key, value) VALUES
  ('signup', '{"enabled": true, "editionCode": "STARTER", "trialDays": 30}'),
  ('subscriptions', '{"graceDays": 7, "warningDays": 14}'),
  ('support', '{"email": null, "phone": null}');

CREATE TABLE platform_audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    UUID REFERENCES platform_admins(id),
  action      TEXT NOT NULL,
  org_id      UUID REFERENCES organizations(id),
  target_type TEXT NOT NULL,
  target_id   TEXT,
  before_data JSONB,
  after_data  JSONB,
  reason      TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_logs_created_idx ON platform_audit_logs (created_at DESC);
CREATE INDEX platform_audit_logs_org_idx ON platform_audit_logs (org_id, created_at DESC) WHERE org_id IS NOT NULL;
CREATE FUNCTION platform_audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_logs is append-only';
END $$;
CREATE TRIGGER platform_audit_logs_no_update BEFORE UPDATE OR DELETE ON platform_audit_logs FOR EACH ROW EXECUTE FUNCTION platform_audit_logs_immutable();

-- ── Invitations and password resets: one-time tokens, stored only as SHA-256 hashes ──
CREATE TABLE account_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('INVITE', 'PASSWORD_RESET')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_open_idx ON account_tokens (user_id, purpose) WHERE used_at IS NULL AND revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON account_tokens TO geoattend_tenant;
ALTER TABLE account_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON account_tokens TO geoattend_tenant
  USING (EXISTS (SELECT 1 FROM users o WHERE o.id = account_tokens.user_id))
  WITH CHECK (EXISTS (SELECT 1 FROM users o WHERE o.id = account_tokens.user_id)
              AND (account_tokens.created_by IS NULL OR EXISTS (SELECT 1 FROM users p WHERE p.id = account_tokens.created_by)));
