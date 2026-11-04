-- Owner → Supervisor → Worker hierarchy, work assignments, announcements and reporting indexes.
-- Additive only: no existing row is changed or removed.

-- The supervisor a worker reports to. Visibility stays site-based (administrator_profiles.site_ids);
-- this is the named person responsible for the worker, and must manage the worker's home workplace.
ALTER TABLE employee_profiles ADD COLUMN supervisor_id UUID REFERENCES users(id);
CREATE INDEX employee_profiles_supervisor_idx ON employee_profiles (supervisor_id) WHERE supervisor_id IS NOT NULL;

-- What the worker is assigned to do on a roster entry (shown in the worker app).
ALTER TABLE employee_shift_assignments ADD COLUMN notes TEXT CHECK (length(notes) <= 500);

-- The Google place the address was resolved from, and the staffing level a workplace needs per day
-- (NULL = no target; the roster then shows no shortage).
ALTER TABLE workplaces
  ADD COLUMN place_id  TEXT CHECK (length(place_id) <= 300),
  ADD COLUMN min_staff INT CHECK (min_staff BETWEEN 0 AND 10000);

-- Announcements (formerly "messages"): pinning, editing and archiving. History is kept.
ALTER TABLE broadcasts
  ADD COLUMN pinned      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN updated_at  TIMESTAMPTZ,
  ADD COLUMN updated_by  UUID REFERENCES users(id);
CREATE INDEX broadcasts_live_idx ON broadcasts (org_id, pinned DESC, created_at DESC) WHERE archived_at IS NULL;

-- Reporting: per-employee date ranges and per-workplace roll-ups.
CREATE INDEX attendance_records_employee_date_idx ON attendance_records (employee_id, shift_date);
CREATE INDEX tracking_sessions_employee_date_idx ON tracking_sessions (employee_id, shift_date);
CREATE INDEX workplace_assignments_workplace_idx ON workplace_assignments (workplace_id) WHERE effective_to IS NULL;
