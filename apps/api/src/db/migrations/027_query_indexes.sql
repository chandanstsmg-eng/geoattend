-- Indexes for columns that reports and jobs search by. Rollback: docs/migrations/027_rollback.sql.
-- No row changes. Found by load testing with 810,000 attendance records: attendance_work looks up each
-- record's absences by session, with no index for it, so the hours report never finished at that size.
-- Foreign keys only used for integrity checks by rarely deleted rows (created_by and the like) are left out.
-- Each index blocks writes to its table while it builds. On a large live table, build it first by
-- hand with CREATE INDEX CONCURRENTLY: IF NOT EXISTS below then skips it.

CREATE INDEX IF NOT EXISTS absence_intervals_session_idx      ON absence_intervals (session_id);
CREATE INDEX IF NOT EXISTS absence_intervals_employee_idx     ON absence_intervals (employee_id, started_at);
CREATE INDEX IF NOT EXISTS attendance_records_session_idx     ON attendance_records (session_id);
CREATE INDEX IF NOT EXISTS attendance_records_workplace_idx   ON attendance_records (workplace_id, shift_date);
-- The face check job looks for records still waiting, among all records of the last three days.
CREATE INDEX IF NOT EXISTS attendance_records_face_due_idx    ON attendance_records (created_at) WHERE face_status IS NULL OR (end_photo_id IS NOT NULL AND end_face_status IS NULL);
CREATE INDEX IF NOT EXISTS attendance_photos_employee_idx     ON attendance_photos (employee_id);
CREATE INDEX IF NOT EXISTS overtime_entries_attendance_idx    ON overtime_entries (attendance_id);
CREATE INDEX IF NOT EXISTS tracking_sessions_workplace_idx    ON tracking_sessions (workplace_id, shift_date);
CREATE INDEX IF NOT EXISTS employee_shift_assignments_shift_idx ON employee_shift_assignments (shift_id);
CREATE INDEX IF NOT EXISTS geofence_events_employee_idx       ON geofence_events (employee_id, event_time);
CREATE INDEX IF NOT EXISTS review_requests_employee_idx       ON review_requests (employee_id);
CREATE INDEX IF NOT EXISTS review_requests_session_idx        ON review_requests (session_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx            ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS notification_deliveries_note_idx   ON notification_deliveries (notification_id);
CREATE INDEX IF NOT EXISTS notification_reads_user_idx        ON notification_reads (user_id);
CREATE INDEX IF NOT EXISTS permission_events_employee_idx     ON permission_status_events (employee_id);
CREATE INDEX IF NOT EXISTS pay_adjustments_employee_idx       ON pay_adjustments (employee_id);
CREATE INDEX IF NOT EXISTS sos_alerts_employee_idx            ON sos_alerts (employee_id);
CREATE INDEX IF NOT EXISTS task_photos_employee_idx           ON task_photos (employee_id);
CREATE INDEX IF NOT EXISTS web_push_subscriptions_user_idx    ON web_push_subscriptions (user_id);
