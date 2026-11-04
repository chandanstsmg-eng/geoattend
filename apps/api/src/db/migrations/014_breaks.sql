-- Declared breaks. An employee who is present starts a break from inside the workplace area
-- (break type + selfie + fresh GPS fix). While it runs, leaving the area is not an absence and
-- raises no alert; location is still collected. The break ends when the employee taps
-- "End break", when they are verified back inside after having left, or when the shift ends.
-- Type, paid flag and time limit are copied from settings when the break starts, so later
-- settings changes never rewrite history.
ALTER TABLE tracking_sessions DROP CONSTRAINT tracking_sessions_state_check;
ALTER TABLE tracking_sessions ADD CONSTRAINT tracking_sessions_state_check
  CHECK (state IN ('OFF_SHIFT','SHIFT_START_PENDING','TRACKING_PERMISSION_REQUIRED','TRACKING_ACTIVE','OUTSIDE_GEOFENCE',
                   'ARRIVAL_CANDIDATE','ATTENDANCE_READY','ATTENDANCE_SUBMISSION_PENDING','PRESENT','TEMPORARILY_AWAY',
                   'PROLONGED_ABSENCE','TRACKING_INTERRUPTED','SHIFT_END_PENDING','SHIFT_COMPLETED','MANUAL_REVIEW_REQUIRED',
                   'ON_BREAK'));

-- Break selfies share the attendance photo pipeline (private upload slot, retention, deletion).
ALTER TABLE attendance_photos ADD COLUMN purpose TEXT NOT NULL DEFAULT 'ATTENDANCE' CHECK (purpose IN ('ATTENDANCE', 'BREAK'));

CREATE TABLE session_breaks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID NOT NULL REFERENCES tracking_sessions(id) ON DELETE CASCADE,
  employee_id        UUID NOT NULL REFERENCES users(id),
  workplace_id       UUID NOT NULL REFERENCES workplaces(id),
  type_key           TEXT NOT NULL CHECK (length(type_key) BETWEEN 1 AND 40),
  type_label         TEXT NOT NULL CHECK (length(type_label) BETWEEN 1 AND 60),
  paid               BOOLEAN NOT NULL,
  max_minutes        INT NOT NULL CHECK (max_minutes BETWEEN 1 AND 480),
  note               TEXT CHECK (length(note) <= 500),
  photo_id           UUID REFERENCES attendance_photos(id),
  started_at         TIMESTAMPTZ NOT NULL,                 -- server time
  start_latitude     DOUBLE PRECISION NOT NULL,
  start_longitude    DOUBLE PRECISION NOT NULL,
  start_accuracy_m   DOUBLE PRECISION NOT NULL,
  start_distance_m   DOUBLE PRECISION NOT NULL,
  left_at            TIMESTAMPTZ,                          -- first verified exit from the area during the break
  overdue_at         TIMESTAMPTZ,                          -- when the time limit passed and the admin was alerted
  ended_at           TIMESTAMPTZ,
  end_reason         TEXT CHECK (end_reason IN ('EMPLOYEE', 'RETURNED', 'SHIFT_ENDED')),
  is_simulated       BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX session_breaks_one_open_idx ON session_breaks (session_id) WHERE ended_at IS NULL;
CREATE INDEX session_breaks_session_idx ON session_breaks (session_id, started_at);
CREATE INDEX session_breaks_employee_idx ON session_breaks (employee_id, started_at);

-- Worked time now also excludes unpaid breaks. (Paid breaks count as work.)
CREATE OR REPLACE VIEW attendance_work AS
SELECT ar.id AS attendance_id,
       ar.employee_id,
       ar.shift_id,
       ar.shift_date,
       ar.workplace_id,
       ar.session_id,
       (s.id IS NOT NULL AND s.ended_at IS NULL) AS in_progress,
       sched.minutes AS scheduled_minutes,
       away.minutes AS away_minutes,
       CASE WHEN s.id IS NULL THEN NULL
            ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - GREATEST(ar.recorded_at, s.scheduled_start_at))) / 60)::int - away.minutes - brk.unpaid_minutes)
       END AS worked_minutes,
       CASE WHEN s.ended_at IS NOT NULL THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (s.scheduled_end_at - s.ended_at)) / 60)::int) END AS ended_early_minutes,
       brk.minutes AS break_minutes,
       brk.unpaid_minutes AS unpaid_break_minutes
FROM attendance_records ar
JOIN shifts sh ON sh.id = ar.shift_id
LEFT JOIN tracking_sessions s ON s.id = ar.session_id
CROSS JOIN LATERAL (
  SELECT ROUND(EXTRACT(EPOCH FROM (CASE WHEN sh.end_time > sh.start_time THEN sh.end_time - sh.start_time ELSE sh.end_time - sh.start_time + interval '24 hours' END)) / 60)::int AS minutes
) sched
CROSS JOIN LATERAL (
  SELECT COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, s.ended_at, now()) - a.started_at))) / 60), 0)::int AS minutes
  FROM absence_intervals a WHERE a.session_id = ar.session_id
) away
CROSS JOIN LATERAL (
  SELECT COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(b.ended_at, s.ended_at, now()) - b.started_at))) / 60), 0)::int AS minutes,
         COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(b.ended_at, s.ended_at, now()) - b.started_at))) FILTER (WHERE NOT b.paid) / 60), 0)::int AS unpaid_minutes
  FROM session_breaks b WHERE b.session_id = ar.session_id
) brk
WHERE ar.verification_status <> 'VOIDED';
