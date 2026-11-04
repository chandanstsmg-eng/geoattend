-- Rollback: docs/migrations/022_rollback.sql.

-- A phone is approved only by a person. Rows already APPROVED stay approved.
ALTER TABLE device_registrations ALTER COLUMN status SET DEFAULT 'PENDING';

-- Every change of a phone's status, written by the database so no code path can skip it.
CREATE TABLE device_status_history (
  id              BIGSERIAL PRIMARY KEY,
  device_id       UUID NOT NULL REFERENCES device_registrations(id) ON DELETE CASCADE,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  changed_by      UUID REFERENCES users(id),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_status_history_device_idx ON device_status_history (device_id, id);

CREATE FUNCTION record_device_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO device_status_history (device_id, from_status, to_status, changed_by, note)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, NEW.decided_by, NEW.status_note);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER device_status_recorded AFTER INSERT OR UPDATE OF status ON device_registrations FOR EACH ROW EXECUTE FUNCTION record_device_status();

-- Where each phone stands as history begins.
INSERT INTO device_status_history (device_id, to_status, changed_by, note, created_at)
SELECT id, status, decided_by, 'Status when history began', COALESCE(decided_at, created_at) FROM device_registrations;

-- A voided attendance record stays voided, whatever path tries to change it.
CREATE FUNCTION attendance_void_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verification_status = 'VOIDED' AND NEW.verification_status <> 'VOIDED' THEN
    RAISE EXCEPTION 'A voided attendance record cannot be restored (%).', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_void_final BEFORE UPDATE OF verification_status ON attendance_records FOR EACH ROW EXECUTE FUNCTION attendance_void_is_final();

-- One open dispute per record, so a second one cannot overwrite the status to restore.
CREATE UNIQUE INDEX review_requests_one_open_dispute ON review_requests (attendance_id) WHERE kind = 'DISPUTE' AND status = 'OPEN';
