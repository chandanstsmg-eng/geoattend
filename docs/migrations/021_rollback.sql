-- Rollback of 021_attendance_and_payroll_history. Run by hand, in one transaction, after a backup.
-- Removes what the migration added, including anything written to those columns since. It refuses to
-- run if a payroll month has been reopened, because the old UNIQUE (org_id, month) could not hold.
-- Restoring the backup taken before the migration remains the safest route.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payroll_runs WHERE superseded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Superseded payroll runs exist. Restore the backup instead of rolling back.';
  END IF;
END $$;

-- The view as in 017_overtime.sql.
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

DROP TRIGGER payslips_keep ON payslips;
DROP TRIGGER payroll_runs_keep ON payroll_runs;
DROP FUNCTION payroll_history_is_kept();
DROP INDEX payroll_runs_current_key;
ALTER TABLE payroll_runs
  DROP CONSTRAINT payroll_runs_revision_key,
  DROP COLUMN revision, DROP COLUMN superseded_at, DROP COLUMN superseded_by, DROP COLUMN supersede_reason,
  ADD CONSTRAINT payroll_runs_org_id_month_key UNIQUE (org_id, month);

ALTER TABLE attendance_records
  DROP COLUMN original_recorded_at, DROP COLUMN approved_by, DROP COLUMN approved_at, DROP COLUMN manual_worked_minutes;
DROP TABLE shift_revisions;
ALTER TABLE workplaces DROP COLUMN deactivated_on;
ALTER TABLE employee_profiles DROP CONSTRAINT employee_profiles_employment_check, DROP COLUMN joined_on, DROP COLUMN left_on;

DELETE FROM schema_migrations WHERE version = '021_attendance_and_payroll_history';
COMMIT;
