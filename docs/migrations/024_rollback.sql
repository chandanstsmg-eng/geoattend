-- Rollback of 024_pending_not_counted. Run by hand after a backup, and after 025_rollback.sql if 025 was applied.
-- Views only, no rows change. It stops if any record is waiting for verification: rolling back would
-- count those records, which must never happen without a person deciding them.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM attendance_records WHERE verification_status = 'PENDING_VERIFICATION') THEN
    RAISE EXCEPTION 'Records are waiting for verification. Decide them, or restore the backup.';
  END IF;
END $$;
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
DROP VIEW attendance_work_all;
DELETE FROM schema_migrations WHERE version = '024_pending_not_counted';
COMMIT;
