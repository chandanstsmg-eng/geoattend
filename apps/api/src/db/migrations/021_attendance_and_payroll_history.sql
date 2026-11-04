-- History that later edits cannot rewrite. Rollback: docs/migrations/021_rollback.sql.
-- One step is not purely additive: payroll_runs' UNIQUE (org_id, month) becomes a unique index over
-- current runs, so a reopened run can stay in place as history instead of being deleted.

-- Employment dates decide which days count for a person; NULL means not recorded (no limit).
ALTER TABLE employee_profiles
  ADD COLUMN joined_on DATE,
  ADD COLUMN left_on   DATE,
  ADD CONSTRAINT employee_profiles_employment_check CHECK (joined_on IS NULL OR left_on IS NULL OR left_on >= joined_on);

-- People deactivated before this column existed: the day it was done, so their past days reappear.
UPDATE employee_profiles ep
SET left_on = (COALESCE(
      (SELECT max(a.created_at) FROM audit_logs a WHERE a.action = 'employee.deactivate' AND a.resource_id = ep.user_id::text),
      u.updated_at) AT TIME ZONE 'Asia/Kolkata')::date
FROM users u
WHERE u.id = ep.user_id AND NOT u.is_active;

-- A disabled workspace still counts for the days before it was disabled.
ALTER TABLE workplaces ADD COLUMN deactivated_on DATE;
UPDATE workplaces SET deactivated_on = (updated_at AT TIME ZONE timezone)::date WHERE NOT is_active;

-- What a shift looked like before an edit. Dates with no revision use the current definition in `shifts`.
CREATE TABLE shift_revisions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id              UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  valid_from            DATE,                -- NULL: since the shift was created
  valid_to              DATE NOT NULL,       -- inclusive
  start_time            TIME NOT NULL,
  end_time              TIME NOT NULL,
  timezone              TEXT NOT NULL,
  days_of_week          SMALLINT[] NOT NULL,
  arrival_grace_minutes INT NOT NULL,
  is_active             BOOLEAN NOT NULL,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shift_id, valid_to),
  CHECK (valid_from IS NULL OR valid_from <= valid_to)
);

-- Shifts disabled before this table existed were active until the day before that.
INSERT INTO shift_revisions (shift_id, valid_to, start_time, end_time, timezone, days_of_week, arrival_grace_minutes, is_active)
SELECT id, (updated_at AT TIME ZONE timezone)::date - 1, start_time, end_time, timezone, days_of_week, arrival_grace_minutes, true
FROM shifts WHERE NOT is_active;

-- Attendance: who approved it and when, kept apart from the arrival time, and the first recorded time.
ALTER TABLE attendance_records
  ADD COLUMN original_recorded_at  TIMESTAMPTZ,   -- set the first time recorded_at is corrected
  ADD COLUMN approved_by           UUID REFERENCES users(id),
  ADD COLUMN approved_at           TIMESTAMPTZ,
  ADD COLUMN manual_worked_minutes INT CHECK (manual_worked_minutes BETWEEN 0 AND 1440);

-- Payroll revisions: reopening supersedes a run; nothing is deleted.
ALTER TABLE payroll_runs
  ADD COLUMN revision         INT NOT NULL DEFAULT 1,
  ADD COLUMN superseded_at    TIMESTAMPTZ,
  ADD COLUMN superseded_by    UUID REFERENCES users(id),
  ADD COLUMN supersede_reason TEXT CHECK (length(supersede_reason) <= 500),
  ADD CONSTRAINT payroll_runs_revision_key UNIQUE (org_id, month, revision);
ALTER TABLE payroll_runs DROP CONSTRAINT payroll_runs_org_id_month_key;
CREATE UNIQUE INDEX payroll_runs_current_key ON payroll_runs (org_id, month) WHERE superseded_at IS NULL;

CREATE FUNCTION payroll_history_is_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payroll history cannot be deleted (%). Reopen the month instead.', TG_TABLE_NAME;
END $$;
CREATE TRIGGER payroll_runs_keep BEFORE DELETE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION payroll_history_is_kept();
CREATE TRIGGER payslips_keep BEFORE DELETE ON payslips FOR EACH ROW EXECUTE FUNCTION payroll_history_is_kept();

-- Scheduled time now comes from the session's own snapshot, so editing a shift cannot change it.
-- Time away before arrival no longer reduces worked time. Manual records carry entered minutes.
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
       CASE WHEN s.id IS NULL THEN ar.manual_worked_minutes
            ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (reg.ends_at - reg.starts_at)) / 60)::int - away.minutes - brk.unpaid_minutes)
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
CROSS JOIN LATERAL (
  SELECT GREATEST(ar.recorded_at, s.scheduled_start_at) AS starts_at, LEAST(COALESCE(s.ended_at, now()), s.scheduled_end_at) AS ends_at
) reg
CROSS JOIN LATERAL (
  SELECT CASE WHEN s.id IS NOT NULL THEN ROUND(EXTRACT(EPOCH FROM (s.scheduled_end_at - s.scheduled_start_at)) / 60)::int
              ELSE ROUND(EXTRACT(EPOCH FROM (CASE WHEN sh.end_time > sh.start_time THEN sh.end_time - sh.start_time ELSE sh.end_time - sh.start_time + interval '24 hours' END)) / 60)::int
         END AS minutes
) sched
CROSS JOIN LATERAL (
  SELECT COALESCE(ROUND(SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(a.ended_at, s.ended_at, now()), reg.ends_at) - GREATEST(a.started_at, reg.starts_at))))) / 60), 0)::int AS minutes
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
