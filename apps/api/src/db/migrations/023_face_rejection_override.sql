-- Rollback: docs/migrations/023_rollback.sql.

-- A record sent late from the phone was not checked by the server when it happened, so it waits for a person.
ALTER TABLE attendance_records DROP CONSTRAINT attendance_records_verification_status_check;
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_verification_status_check
  CHECK (verification_status IN ('VERIFIED', 'MANUAL_APPROVED', 'CORRECTED', 'DISPUTED', 'VOIDED', 'PENDING_VERIFICATION'));

-- A voided record stays voided, with one exception: the owner's audited override of a rejected face check
-- or a rejected offline record. The override sets geoattend.face_override for its own transaction only.
CREATE OR REPLACE FUNCTION attendance_void_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verification_status = 'VOIDED' AND NEW.verification_status <> 'VOIDED'
     -- IS NOT TRUE, not NOT: any side can be NULL, and NOT NULL would let the restore through.
     AND ((OLD.face_review = 'REJECTED' OR 'VERIFICATION_REJECTED' = ANY(OLD.risk_flags))
          AND current_setting('geoattend.face_override', true) = 'on') IS NOT TRUE THEN
    RAISE EXCEPTION 'A voided attendance record cannot be restored (%).', OLD.id;
  END IF;
  RETURN NEW;
END $$;
