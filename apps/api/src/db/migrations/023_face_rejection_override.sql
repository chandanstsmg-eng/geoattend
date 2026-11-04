-- Rollback: docs/migrations/023_rollback.sql.

-- A voided record stays voided, with one exception: the owner's audited override of a rejected face
-- check. The override sets geoattend.face_override for its own transaction only (see overrideFaceRejection).
CREATE OR REPLACE FUNCTION attendance_void_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verification_status = 'VOIDED' AND NEW.verification_status <> 'VOIDED'
     -- IS NOT TRUE, not NOT: either side can be NULL, and NOT NULL would let the restore through.
     AND (OLD.face_review = 'REJECTED' AND current_setting('geoattend.face_override', true) = 'on') IS NOT TRUE THEN
    RAISE EXCEPTION 'A voided attendance record cannot be restored (%).', OLD.id;
  END IF;
  RETURN NEW;
END $$;
