-- Leave requests, and the phone's battery / network state on each shift session.

-- ───────────────────────── leave ─────────────────────────
CREATE TABLE leave_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL REFERENCES users(id),
  leave_type     TEXT NOT NULL CHECK (leave_type IN ('CASUAL', 'SICK', 'EARNED', 'UNPAID', 'OTHER')),
  start_date     DATE NOT NULL,
  end_date       DATE NOT NULL,
  half_day       BOOLEAN NOT NULL DEFAULT false,
  reason         TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by   UUID NOT NULL REFERENCES users(id),   -- the employee, or an admin recording leave for them
  decided_by     UUID REFERENCES users(id),
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (end_date - start_date <= 90),
  CHECK (NOT half_day OR start_date = end_date)
);
CREATE INDEX leave_requests_employee_idx ON leave_requests (employee_id, start_date);
CREATE INDEX leave_requests_status_idx ON leave_requests (status, created_at DESC);

-- ───────────────────────── device status ─────────────────────────
-- Sent with each location upload so "tracking stopped" alerts can say why (dead battery, no network).
ALTER TABLE tracking_sessions
  ADD COLUMN last_battery_level    REAL CHECK (last_battery_level BETWEEN 0 AND 1),
  ADD COLUMN last_battery_charging BOOLEAN,
  ADD COLUMN last_low_power_mode   BOOLEAN,
  ADD COLUMN last_network          TEXT CHECK (last_network IN ('wifi', 'cellular', 'none', 'other', 'unknown')),
  ADD COLUMN last_device_status_at TIMESTAMPTZ;
