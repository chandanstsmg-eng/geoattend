-- Hours worked per attendance record, in one place for reports, the roster and the employee app.
-- Work counts from the later of "attendance marked" and "shift start" until the shift ended (or now,
-- while it is running), minus time away from the workplace. Manual records without a session have
-- no worked time. Overtime / left-early thresholds are applied by the queries (Settings › workforce).
CREATE VIEW attendance_work AS
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
            ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - GREATEST(ar.recorded_at, s.scheduled_start_at))) / 60)::int - away.minutes)
       END AS worked_minutes,
       CASE WHEN s.ended_at IS NOT NULL THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (s.scheduled_end_at - s.ended_at)) / 60)::int) END AS ended_early_minutes
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
WHERE ar.verification_status <> 'VOIDED';
