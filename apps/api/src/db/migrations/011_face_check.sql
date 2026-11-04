-- Face check: a reference photo per employee, a "liveness" instruction shown at capture,
-- and the result of comparing each attendance photo with the reference.
CREATE TABLE employee_faces (
  employee_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  photo_id    UUID NOT NULL REFERENCES attendance_photos(id),
  set_by      UUID REFERENCES users(id),           -- NULL = taken automatically from the first verified attendance
  set_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE attendance_records
  ADD COLUMN challenge       TEXT,       -- instruction shown on the camera, e.g. "Hold up 2 fingers"
  ADD COLUMN face_status     TEXT CHECK (face_status IN ('MATCH', 'MISMATCH', 'NO_FACE', 'NOT_CHECKED', 'REFERENCE_SET', 'NO_PHOTO', 'ERROR')),
  ADD COLUMN face_score      REAL,       -- similarity 0–100 when a matcher ran
  ADD COLUMN face_checked_at TIMESTAMPTZ;
CREATE INDEX attendance_records_face_pending_idx ON attendance_records (created_at) WHERE face_status IS NULL;
