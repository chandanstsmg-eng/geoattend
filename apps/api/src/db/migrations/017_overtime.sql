-- Overtime with approval.
-- The regular shift now counts only up to its scheduled end. Work after it is overtime, and
-- overtime exists only when the employee starts it from the app (selfie + location) once the
-- shift has ended. While it runs the session is ON_OVERTIME: location is still collected but,
-- as overtime may be worked anywhere, leaving the workplace area raises no absence. Ending
-- overtime (selfie again) closes the session. An owner, or a supervisor of the workplace,
-- then approves (optionally adjusting the minutes) or rejects it; only approved minutes reach
-- reports and payroll.
ALTER TABLE tracking_sessions DROP CONSTRAINT tracking_sessions_state_check;
ALTER TABLE tracking_sessions ADD CONSTRAINT tracking_sessions_state_check
  CHECK (state IN ('OFF_SHIFT','SHIFT_START_PENDING','TRACKING_PERMISSION_REQUIRED','TRACKING_ACTIVE','OUTSIDE_GEOFENCE',
                   'ARRIVAL_CANDIDATE','ATTENDANCE_READY','ATTENDANCE_SUBMISSION_PENDING','PRESENT','TEMPORARILY_AWAY',
                   'PROLONGED_ABSENCE','TRACKING_INTERRUPTED','SHIFT_END_PENDING','SHIFT_COMPLETED','MANUAL_REVIEW_REQUIRED',
                   'ON_BREAK','ON_OVERTIME'));

ALTER TABLE attendance_photos DROP CONSTRAINT attendance_photos_purpose_check;
ALTER TABLE attendance_photos ADD CONSTRAINT attendance_photos_purpose_check CHECK (purpose IN ('ATTENDANCE', 'BREAK', 'ENROLLMENT', 'SHIFT_END', 'OVERTIME'));

CREATE TABLE overtime_entries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID NOT NULL UNIQUE REFERENCES tracking_sessions(id) ON DELETE CASCADE, -- at most one per shift
  attendance_id      UUID NOT NULL REFERENCES attendance_records(id),
  employee_id        UUID NOT NULL REFERENCES users(id),
  workplace_id       UUID NOT NULL REFERENCES workplaces(id),
  shift_date         DATE NOT NULL,
  note               TEXT CHECK (length(note) <= 500),     -- what the employee is working on
  started_at         TIMESTAMPTZ NOT NULL,                 -- server time
  start_photo_id     UUID REFERENCES attendance_photos(id),
  start_latitude     DOUBLE PRECISION NOT NULL,
  start_longitude    DOUBLE PRECISION NOT NULL,
  start_accuracy_m   DOUBLE PRECISION NOT NULL,
  start_distance_m   DOUBLE PRECISION NOT NULL,
  ended_at           TIMESTAMPTZ,
  end_reason         TEXT CHECK (end_reason IN ('EMPLOYEE', 'ADMIN', 'TRACKING_LOST', 'NEXT_SHIFT', 'SYSTEM')),
  end_photo_id       UUID REFERENCES attendance_photos(id),
  start_face_status  TEXT CHECK (start_face_status IN ('MATCH', 'MISMATCH', 'NO_FACE', 'NOT_CHECKED', 'NO_PHOTO', 'ERROR', 'NOT_ENROLLED')),
  start_face_score   REAL,
  end_face_status    TEXT CHECK (end_face_status IN ('MATCH', 'MISMATCH', 'NO_FACE', 'NOT_CHECKED', 'NO_PHOTO', 'ERROR', 'NOT_ENROLLED')),
  end_face_score     REAL,
  status             TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  approved_minutes   INT CHECK (approved_minutes BETWEEN 0 AND 1440),
  decided_by         UUID REFERENCES users(id),
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT CHECK (length(decision_note) <= 500),
  is_simulated       BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (status = 'PENDING' OR ended_at IS NOT NULL),
  CHECK ((status = 'APPROVED') = (approved_minutes IS NOT NULL)),
  CHECK ((status = 'PENDING') = (decided_at IS NULL))
);
CREATE INDEX overtime_entries_employee_idx ON overtime_entries (employee_id, shift_date);
CREATE INDEX overtime_entries_date_idx ON overtime_entries (shift_date, workplace_id);
CREATE INDEX overtime_entries_pending_idx ON overtime_entries (created_at) WHERE status = 'PENDING';
CREATE INDEX overtime_entries_face_due_idx ON overtime_entries (created_at) WHERE start_face_status IS NULL OR (end_photo_id IS NOT NULL AND end_face_status IS NULL);

-- Regular worked time stops at the scheduled end (away time and unpaid breaks are clipped to the
-- same window). Overtime is reported separately: `overtime_minutes` is what was approved,
-- `overtime_claimed_minutes` what was worked (still running: so far).
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
            ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (reg.ends_at - GREATEST(ar.recorded_at, s.scheduled_start_at))) / 60)::int - away.minutes - brk.unpaid_minutes)
       END AS worked_minutes,
       CASE WHEN s.ended_at IS NOT NULL THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (s.scheduled_end_at - s.ended_at)) / 60)::int) END AS ended_early_minutes,
       brk.minutes AS break_minutes,
       brk.unpaid_minutes AS unpaid_break_minutes,
       ot.id AS overtime_id,
       CASE WHEN ot.id IS NULL THEN NULL WHEN ot.ended_at IS NULL THEN 'RUNNING' ELSE ot.status END AS overtime_status,
       COALESCE(ot.claimed, 0) AS overtime_claimed_minutes,
       COALESCE(CASE WHEN ot.status = 'APPROVED' THEN ot.approved_minutes END, 0) AS overtime_minutes
FROM attendance_records ar
JOIN shifts sh ON sh.id = ar.shift_id
LEFT JOIN tracking_sessions s ON s.id = ar.session_id
CROSS JOIN LATERAL (SELECT LEAST(COALESCE(s.ended_at, now()), s.scheduled_end_at) AS ends_at) reg
CROSS JOIN LATERAL (
  SELECT ROUND(EXTRACT(EPOCH FROM (CASE WHEN sh.end_time > sh.start_time THEN sh.end_time - sh.start_time ELSE sh.end_time - sh.start_time + interval '24 hours' END)) / 60)::int AS minutes
) sched
CROSS JOIN LATERAL (
  SELECT COALESCE(ROUND(SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(a.ended_at, s.ended_at, now()), reg.ends_at) - a.started_at)))) / 60), 0)::int AS minutes
  FROM absence_intervals a WHERE a.session_id = ar.session_id
) away
CROSS JOIN LATERAL (
  SELECT COALESCE(ROUND(SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(b.ended_at, s.ended_at, now()), reg.ends_at) - b.started_at)))) / 60), 0)::int AS minutes,
         COALESCE(ROUND(SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(b.ended_at, s.ended_at, now()), reg.ends_at) - b.started_at)))) FILTER (WHERE NOT b.paid) / 60), 0)::int AS unpaid_minutes
  FROM session_breaks b WHERE b.session_id = ar.session_id
) brk
LEFT JOIN LATERAL (
  SELECT o.id, o.status, o.ended_at, o.approved_minutes,
         ROUND(EXTRACT(EPOCH FROM (COALESCE(o.ended_at, now()) - o.started_at)) / 60)::int AS claimed
  FROM overtime_entries o WHERE o.session_id = ar.session_id
) ot ON true
WHERE ar.verification_status <> 'VOIDED';
