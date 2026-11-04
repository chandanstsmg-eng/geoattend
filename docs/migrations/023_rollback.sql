-- Rollback of 023_face_rejection_override. Run by hand after a backup.
-- Records already restored by an override stay restored; only the exception is removed.
-- It stops if any record is waiting for verification: those must be decided first, never converted here.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM attendance_records WHERE verification_status = 'PENDING_VERIFICATION') THEN
    RAISE EXCEPTION 'Records are waiting for verification. Decide them, or restore the backup.';
  END IF;
END $$;
ALTER TABLE attendance_records DROP CONSTRAINT attendance_records_verification_status_check;
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_verification_status_check
  CHECK (verification_status IN ('VERIFIED', 'MANUAL_APPROVED', 'CORRECTED', 'DISPUTED', 'VOIDED'));
CREATE OR REPLACE FUNCTION attendance_void_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verification_status = 'VOIDED' AND NEW.verification_status <> 'VOIDED' THEN
    RAISE EXCEPTION 'A voided attendance record cannot be restored (%).', OLD.id;
  END IF;
  RETURN NEW;
END $$;
DELETE FROM schema_migrations WHERE version = '023_face_rejection_override';
COMMIT;
