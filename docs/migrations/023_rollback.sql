-- Rollback of 023_face_rejection_override. Run by hand after a backup.
-- Records already restored by an override stay restored; only the exception is removed.
BEGIN;
CREATE OR REPLACE FUNCTION attendance_void_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verification_status = 'VOIDED' AND NEW.verification_status <> 'VOIDED' THEN
    RAISE EXCEPTION 'A voided attendance record cannot be restored (%).', OLD.id;
  END IF;
  RETURN NEW;
END $$;
DELETE FROM schema_migrations WHERE version = '023_face_rejection_override';
COMMIT;
