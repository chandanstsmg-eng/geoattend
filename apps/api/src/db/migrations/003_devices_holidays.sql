-- One approved phone per employee, and holidays.

-- ───────────────────────── device approval ─────────────────────────
-- Phones registered before this migration stay approved. A sign-in from a new phone
-- creates a PENDING row that an administrator approves (or revokes) in Approvals.
ALTER TABLE device_registrations DROP CONSTRAINT IF EXISTS device_registrations_platform_check;
ALTER TABLE device_registrations ADD CONSTRAINT device_registrations_platform_check CHECK (platform IN ('android', 'ios', 'web', 'simulator', 'unknown'));
ALTER TABLE device_registrations
  ADD COLUMN status      TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('APPROVED', 'PENDING', 'REVOKED')),
  ADD COLUMN model_hint  TEXT,
  ADD COLUMN decided_by  UUID REFERENCES users(id),
  ADD COLUMN decided_at  TIMESTAMPTZ,
  ADD COLUMN status_note TEXT;
CREATE INDEX device_registrations_device_idx ON device_registrations (device_id) WHERE status = 'APPROVED';
CREATE INDEX device_registrations_pending_idx ON device_registrations (created_at) WHERE status = 'PENDING';

-- ───────────────────────── holidays ─────────────────────────
-- workplace_id NULL = every workplace. Weekly offs are the days a shift does not run (shifts.days_of_week).
CREATE TABLE holidays (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workplace_id UUID REFERENCES workplaces(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX holidays_uq ON holidays (COALESCE(workplace_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date);
CREATE INDEX holidays_date_idx ON holidays (holiday_date);
