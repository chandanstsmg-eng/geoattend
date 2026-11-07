-- An employee's choice about shift reminders. Rollback: docs/migrations/029_rollback.sql.
-- One new column with a default: no existing row changes meaning, and nothing is sent because of it.
-- Companies turn reminders on themselves (alerts.shiftReminderMinutes, off by default).
ALTER TABLE employee_profiles ADD COLUMN shift_reminders BOOLEAN NOT NULL DEFAULT true;
