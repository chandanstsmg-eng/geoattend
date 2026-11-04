-- GeoAttend initial schema.
-- Conventions: UUID primary keys for business entities, BIGSERIAL for high-volume
-- logs, TIMESTAMPTZ everywhere (stored in UTC), snake_case columns.
-- is_simulated / is_demo flags keep demo data visibly separate from real records.

-- ───────────────────────── identities ─────────────────────────
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('ADMIN', 'EMPLOYEE')),
  full_name           TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  is_demo             BOOLEAN NOT NULL DEFAULT false,
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  failed_login_count  INT NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  last_login_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE administrator_profiles (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT,
  phone        TEXT,
  notify_email BOOLEAN NOT NULL DEFAULT true,
  notify_push  BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employee_profiles (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT NOT NULL UNIQUE CHECK (length(employee_code) BETWEEN 1 AND 40),
  phone         TEXT,
  department    TEXT,
  designation   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  family_id   UUID NOT NULL,
  client      TEXT NOT NULL CHECK (client IN ('web', 'mobile')),
  device_id   TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

-- ───────────────────────── workplaces & shifts ─────────────────────────
CREATE TABLE workplaces (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  address                   TEXT,
  latitude                  DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude                 DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_m                  NUMERIC(6,1) NOT NULL CHECK (radius_m BETWEEN 10 AND 1000),
  timezone                  TEXT NOT NULL DEFAULT 'UTC',
  default_grace_minutes     INT NOT NULL DEFAULT 10 CHECK (default_grace_minutes BETWEEN 0 AND 240),
  absence_threshold_minutes INT NOT NULL DEFAULT 15 CHECK (absence_threshold_minutes BETWEEN 1 AND 480),
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  is_demo                   BOOLEAN NOT NULL DEFAULT false,
  config_version            INT NOT NULL DEFAULT 1,
  created_by                UUID REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workplace_assignments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL REFERENCES users(id),
  workplace_id   UUID NOT NULL REFERENCES workplaces(id),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to   DATE,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
-- One current workplace per employee.
CREATE UNIQUE INDEX workplace_assignments_current_uq ON workplace_assignments (employee_id) WHERE effective_to IS NULL;

CREATE TABLE shifts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workplace_id              UUID NOT NULL REFERENCES workplaces(id),
  name                      TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  start_time                TIME NOT NULL,
  end_time                  TIME NOT NULL,
  timezone                  TEXT NOT NULL,
  days_of_week              SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}' CHECK (days_of_week <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[] AND cardinality(days_of_week) > 0),
  arrival_grace_minutes     INT NOT NULL DEFAULT 10 CHECK (arrival_grace_minutes BETWEEN 0 AND 240),
  absence_threshold_minutes INT CHECK (absence_threshold_minutes BETWEEN 1 AND 480),
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  is_demo                   BOOLEAN NOT NULL DEFAULT false,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_time <> end_time)
);
CREATE INDEX shifts_workplace_idx ON shifts (workplace_id);

CREATE TABLE employee_shift_assignments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL REFERENCES users(id),
  shift_id       UUID NOT NULL REFERENCES shifts(id),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to   DATE,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX esa_current_uq ON employee_shift_assignments (employee_id, shift_id) WHERE effective_to IS NULL;

-- ───────────────────────── devices & permissions ─────────────────────────
CREATE TABLE device_registrations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL CHECK (length(device_id) BETWEEN 8 AND 128),
  platform     TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'simulator')),
  os_version   TEXT,
  model        TEXT,
  app_version  TEXT,
  push_token   TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

-- ───────────────────────── tracking ─────────────────────────
CREATE TABLE tracking_sessions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id              UUID NOT NULL REFERENCES users(id),
  shift_id                 UUID NOT NULL REFERENCES shifts(id),
  workplace_id             UUID NOT NULL REFERENCES workplaces(id),
  shift_date               DATE NOT NULL,
  scheduled_start_at       TIMESTAMPTZ NOT NULL,
  scheduled_end_at         TIMESTAMPTZ NOT NULL,
  state                    TEXT NOT NULL,
  resume_state             TEXT,
  state_changed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  authorization_status     TEXT NOT NULL DEFAULT 'AUTHORIZED' CHECK (authorization_status IN ('AUTHORIZED', 'ENDED', 'TERMINATED', 'EXPIRED')),
  termination_reason       TEXT,
  terminated_by            UUID REFERENCES users(id),
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at                 TIMESTAMPTZ,
  device_id                TEXT,
  foreground_permission    TEXT,
  background_permission    TEXT,
  location_services_enabled BOOLEAN,
  last_location_at         TIMESTAMPTZ,   -- server receipt time of the newest evaluated reading
  last_location_client_at  TIMESTAMPTZ,   -- device time of that reading
  last_latitude            DOUBLE PRECISION,
  last_longitude           DOUBLE PRECISION,
  last_accuracy_m          DOUBLE PRECISION,
  last_distance_m          DOUBLE PRECISION,
  last_classification      TEXT,
  last_is_mocked           BOOLEAN NOT NULL DEFAULT false,
  candidate_since          TIMESTAMPTZ,   -- entry / exit / return candidate start (device time)
  candidate_count          INT NOT NULL DEFAULT 0,
  uncertain_since          TIMESTAMPTZ,
  is_simulated             BOOLEAN NOT NULL DEFAULT false,
  -- Demo simulator only: seconds this session's virtual clock is ahead of real time.
  -- Always 0 for real sessions (enforced below).
  sim_clock_offset_sec     INT NOT NULL DEFAULT 0 CHECK (sim_clock_offset_sec >= 0),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, shift_id, shift_date),
  CHECK (is_simulated OR sim_clock_offset_sec = 0),
  CHECK (state IN ('OFF_SHIFT','SHIFT_START_PENDING','TRACKING_PERMISSION_REQUIRED','TRACKING_ACTIVE','OUTSIDE_GEOFENCE',
                   'ARRIVAL_CANDIDATE','ATTENDANCE_READY','ATTENDANCE_SUBMISSION_PENDING','PRESENT','TEMPORARILY_AWAY',
                   'PROLONGED_ABSENCE','TRACKING_INTERRUPTED','SHIFT_END_PENDING','SHIFT_COMPLETED','MANUAL_REVIEW_REQUIRED'))
);
CREATE INDEX tracking_sessions_open_idx ON tracking_sessions (state) WHERE ended_at IS NULL;
CREATE INDEX tracking_sessions_date_idx ON tracking_sessions (shift_date, workplace_id);

CREATE TABLE session_state_transitions (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES tracking_sessions(id) ON DELETE CASCADE,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('SYSTEM', 'EMPLOYEE', 'ADMIN', 'SIMULATOR')),
  actor_id    UUID,
  metadata    JSONB NOT NULL DEFAULT '{}',
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sst_session_idx ON session_state_transitions (session_id, at);

CREATE TABLE permission_status_events (
  id                        BIGSERIAL PRIMARY KEY,
  employee_id               UUID NOT NULL REFERENCES users(id),
  session_id                UUID REFERENCES tracking_sessions(id) ON DELETE SET NULL,
  device_id                 TEXT,
  foreground                TEXT NOT NULL CHECK (foreground IN ('granted', 'denied', 'undetermined')),
  background                TEXT NOT NULL CHECK (background IN ('granted', 'denied', 'undetermined', 'unavailable')),
  location_services_enabled BOOLEAN NOT NULL,
  precise                   BOOLEAN,
  battery_optimization      TEXT,
  client_time               TIMESTAMPTZ,
  received_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pse_session_idx ON permission_status_events (session_id, received_at);

CREATE TABLE location_updates (
  id                       BIGSERIAL PRIMARY KEY,
  session_id               UUID NOT NULL REFERENCES tracking_sessions(id) ON DELETE CASCADE,
  employee_id              UUID NOT NULL REFERENCES users(id),
  client_event_id          UUID NOT NULL,
  latitude                 DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude                DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m               DOUBLE PRECISION NOT NULL CHECK (accuracy_m > 0),
  altitude_m               DOUBLE PRECISION,
  speed_mps                DOUBLE PRECISION,
  heading_deg              DOUBLE PRECISION,
  is_mocked                BOOLEAN NOT NULL DEFAULT false,
  source                   TEXT NOT NULL CHECK (source IN ('FOREGROUND', 'BACKGROUND', 'SUBMISSION', 'SIMULATOR')),
  client_time              TIMESTAMPTZ NOT NULL,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  distance_m               DOUBLE PRECISION NOT NULL,
  classification           TEXT NOT NULL CHECK (classification IN ('INSIDE', 'OUTSIDE', 'AMBIGUOUS', 'INSUFFICIENT_ACCURACY')),
  validation_status        TEXT NOT NULL CHECK (validation_status IN ('EVALUATED', 'HISTORICAL', 'DELAYED')),
  workplace_config_version INT NOT NULL,
  is_simulated             BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (session_id, client_event_id)
);
CREATE INDEX location_updates_session_time_idx ON location_updates (session_id, client_time);
CREATE INDEX location_updates_employee_time_idx ON location_updates (employee_id, client_time);
CREATE INDEX location_updates_received_idx ON location_updates (received_at);

-- ───────────────────────── attendance ─────────────────────────
CREATE TABLE attendance_photos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id        UUID NOT NULL REFERENCES users(id),
  session_id         UUID NOT NULL REFERENCES tracking_sessions(id),
  object_key         TEXT NOT NULL UNIQUE,
  content_type       TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  declared_bytes     INT NOT NULL CHECK (declared_bytes > 0),
  size_bytes         INT,
  sha256             TEXT,
  status             TEXT NOT NULL DEFAULT 'PENDING_UPLOAD' CHECK (status IN ('PENDING_UPLOAD', 'UPLOADED', 'ATTACHED', 'EXPIRED', 'DELETED')),
  idempotency_key    TEXT NOT NULL,
  upload_expires_at  TIMESTAMPTZ NOT NULL,
  uploaded_at        TIMESTAMPTZ,
  retention_until    TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,
  deleted_reason     TEXT,
  is_simulated       BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attendance_photos_session_idx ON attendance_photos (session_id);

CREATE TABLE attendance_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           UUID NOT NULL REFERENCES users(id),
  workplace_id          UUID NOT NULL REFERENCES workplaces(id),
  shift_id              UUID NOT NULL REFERENCES shifts(id),
  session_id            UUID REFERENCES tracking_sessions(id),
  shift_date            DATE NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),     -- server time, never client time
  idempotency_key       TEXT NOT NULL UNIQUE,
  photo_id              UUID REFERENCES attendance_photos(id),
  evidence_latitude     DOUBLE PRECISION,
  evidence_longitude    DOUBLE PRECISION,
  evidence_accuracy_m   DOUBLE PRECISION,
  evidence_distance_m   DOUBLE PRECISION,
  evidence_client_time  TIMESTAMPTZ,
  radius_m_at_record    NUMERIC(6,1) NOT NULL,
  is_late               BOOLEAN NOT NULL DEFAULT false,
  late_by_minutes       INT NOT NULL DEFAULT 0,
  verification_status   TEXT NOT NULL CHECK (verification_status IN ('VERIFIED', 'MANUAL_APPROVED', 'CORRECTED', 'DISPUTED', 'VOIDED')),
  risk_flags            TEXT[] NOT NULL DEFAULT '{}',
  device_meta           JSONB NOT NULL DEFAULT '{}',
  is_simulated          BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Exactly one attendance record per employee, shift and day.
  UNIQUE (employee_id, shift_id, shift_date)
);
CREATE INDEX attendance_records_date_idx ON attendance_records (shift_date, workplace_id);

-- Manual-review requests, technical-issue reports, disputes and admin corrections.
CREATE TABLE review_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('MANUAL_REVIEW', 'TECHNICAL_ISSUE', 'DISPUTE', 'ADMIN_CORRECTION')),
  employee_id     UUID NOT NULL REFERENCES users(id),
  session_id      UUID REFERENCES tracking_sessions(id),
  attendance_id   UUID REFERENCES attendance_records(id),
  reason          TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 2000),
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED', 'CANCELLED', 'APPLIED', 'ACKNOWLEDGED')),
  before_data     JSONB,
  after_data      JSONB,
  requested_by    UUID NOT NULL REFERENCES users(id),
  resolved_by     UUID REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  is_simulated    BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_requests_status_idx ON review_requests (status, created_at);

-- ───────────────────────── geofence & absence ─────────────────────────
CREATE TABLE geofence_events (
  id            BIGSERIAL PRIMARY KEY,
  employee_id   UUID NOT NULL REFERENCES users(id),
  workplace_id  UUID NOT NULL REFERENCES workplaces(id),
  session_id    UUID NOT NULL REFERENCES tracking_sessions(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL CHECK (event_type IN ('ENTRY_CANDIDATE', 'ENTRY_VERIFIED', 'LEFT_BEFORE_ATTENDANCE', 'EXIT_CANDIDATE', 'EXIT_VERIFIED', 'RETURN_VERIFIED', 'ACCURACY_INSUFFICIENT')),
  event_time    TIMESTAMPTZ NOT NULL,
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  accuracy_m    DOUBLE PRECISION,
  distance_m    DOUBLE PRECISION,
  validation    JSONB NOT NULL DEFAULT '{}',
  is_simulated  BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX geofence_events_session_idx ON geofence_events (session_id, event_time);
CREATE INDEX geofence_events_time_idx ON geofence_events (event_time);

CREATE TABLE absence_intervals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID NOT NULL REFERENCES tracking_sessions(id) ON DELETE CASCADE,
  employee_id      UUID NOT NULL REFERENCES users(id),
  workplace_id     UUID NOT NULL REFERENCES workplaces(id),
  started_at       TIMESTAMPTZ NOT NULL,                 -- departure time (first outside reading)
  verified_at      TIMESTAMPTZ NOT NULL DEFAULT now(),   -- when the exit was confirmed
  ended_at         TIMESTAMPTZ,
  threshold_minutes INT NOT NULL,
  prolonged_at     TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RETURNED', 'SHIFT_ENDED')),
  tracking_gap     BOOLEAN NOT NULL DEFAULT false,
  last_known_latitude  DOUBLE PRECISION,
  last_known_longitude DOUBLE PRECISION,
  last_known_at    TIMESTAMPTZ,
  is_simulated     BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX absence_one_open_per_session ON absence_intervals (session_id) WHERE status = 'OPEN';
CREATE INDEX absence_intervals_time_idx ON absence_intervals (started_at);

-- ───────────────────────── notifications ─────────────────────────
CREATE TABLE notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,
  audience      TEXT NOT NULL DEFAULT 'ADMIN' CHECK (audience IN ('ADMIN', 'EMPLOYEE')),
  severity      TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  employee_id   UUID REFERENCES users(id),
  workplace_id  UUID REFERENCES workplaces(id),
  session_id    UUID REFERENCES tracking_sessions(id) ON DELETE SET NULL,
  data          JSONB NOT NULL DEFAULT '{}',
  dedupe_key    TEXT UNIQUE,
  is_simulated  BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_created_idx ON notifications (audience, created_at DESC);
CREATE INDEX notifications_employee_idx ON notifications (employee_id, created_at DESC);

CREATE TABLE notification_reads (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE notification_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL CHECK (channel IN ('WEB_PUSH', 'EMAIL', 'EXPO_PUSH')),
  target          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'GAVE_UP')),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (next_attempt_at) WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE web_push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── governance ─────────────────────────
CREATE TABLE audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      UUID REFERENCES users(id),
  actor_role    TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  before_data   JSONB,
  after_data    JSONB,
  reason        TEXT,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id);

-- Audit entries are append-only.
CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

CREATE TABLE application_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notice_acknowledgements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notice_version  INT NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, notice_version)
);

-- ───────────────────────── optional PostGIS ─────────────────────────
-- When PostGIS is available (docker-compose uses postgis/postgis), keep a
-- geography point per workplace for spatial queries and reporting.
-- Eligibility decisions are made by the server's validated geodesic code, so
-- behaviour is identical on a plain PostgreSQL server.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    CREATE EXTENSION IF NOT EXISTS postgis;
    EXECUTE 'ALTER TABLE workplaces ADD COLUMN geog geography(Point, 4326)
             GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED';
    EXECUTE 'CREATE INDEX workplaces_geog_idx ON workplaces USING GIST (geog)';
  END IF;
END $$;
