-- Face enrollment and matching.
-- On first use the employee takes five guided photos (front, left, right, up, down). The server
-- computes a face "fingerprint" (embedding) from each and keeps them, with the photos, as the
-- employee's primary face. Start- and end-of-shift photos are compared with it: a match is
-- deleted at once (only the result is kept); a mismatch is kept and waits for a manager's review.

-- Enrollment photos are not taken during a shift session.
ALTER TABLE attendance_photos ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE attendance_photos DROP CONSTRAINT attendance_photos_purpose_check;
ALTER TABLE attendance_photos ADD CONSTRAINT attendance_photos_purpose_check CHECK (purpose IN ('ATTENDANCE', 'BREAK', 'ENROLLMENT', 'SHIFT_END'));
ALTER TABLE attendance_photos ADD CONSTRAINT attendance_photos_session_check CHECK (session_id IS NOT NULL OR purpose = 'ENROLLMENT');

CREATE TABLE employee_face_profiles (
  employee_id  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  poses        TEXT[] NOT NULL,
  photo_ids    UUID[] NOT NULL,          -- one per pose, same order; kept until the profile is reset
  embeddings   JSONB NOT NULL,           -- one embedding per pose (empty when matching is off)
  model        TEXT NOT NULL,
  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_id    TEXT
);

ALTER TABLE attendance_records DROP CONSTRAINT attendance_records_face_status_check;
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_face_status_check
  CHECK (face_status IN ('MATCH', 'MISMATCH', 'NO_FACE', 'NOT_CHECKED', 'REFERENCE_SET', 'NO_PHOTO', 'ERROR', 'NOT_ENROLLED'));
ALTER TABLE attendance_records
  ADD COLUMN end_photo_id        UUID REFERENCES attendance_photos(id),
  ADD COLUMN end_face_status     TEXT CHECK (end_face_status IN ('MATCH', 'MISMATCH', 'NO_FACE', 'NOT_CHECKED', 'NO_PHOTO', 'ERROR', 'NOT_ENROLLED')),
  ADD COLUMN end_face_score      REAL,
  ADD COLUMN end_face_checked_at TIMESTAMPTZ,
  -- A failed start or end check holds the record for a manager: APPROVED keeps it, REJECTED voids it (absent).
  ADD COLUMN face_review         TEXT CHECK (face_review IN ('PENDING', 'APPROVED', 'REJECTED')),
  ADD COLUMN face_reviewed_by    UUID REFERENCES users(id),
  ADD COLUMN face_reviewed_at    TIMESTAMPTZ,
  ADD COLUMN face_review_note    TEXT CHECK (length(face_review_note) <= 500);
CREATE INDEX attendance_records_end_face_pending_idx ON attendance_records (created_at) WHERE end_photo_id IS NOT NULL AND end_face_status IS NULL;
CREATE INDEX attendance_records_face_review_idx ON attendance_records (face_review) WHERE face_review = 'PENDING';
