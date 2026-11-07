-- Rollback of 027_query_indexes. Run by hand. No data is involved: reports become slow again at scale.
BEGIN;
DROP INDEX IF EXISTS attendance_records_face_due_idx, absence_intervals_session_idx, absence_intervals_employee_idx, attendance_records_session_idx, attendance_records_workplace_idx,
  attendance_photos_employee_idx, overtime_entries_attendance_idx, tracking_sessions_workplace_idx, employee_shift_assignments_shift_idx,
  geofence_events_employee_idx, review_requests_employee_idx, review_requests_session_idx, refresh_tokens_user_idx, notification_deliveries_note_idx,
  notification_reads_user_idx, permission_events_employee_idx, pay_adjustments_employee_idx, sos_alerts_employee_idx, task_photos_employee_idx, web_push_subscriptions_user_idx;
DELETE FROM schema_migrations WHERE version = '027_query_indexes';
COMMIT;
