-- Tasks with proof of work: an administrator assigns, the employee completes with a photo,
-- a note and their location, the administrator approves or sends it back.
CREATE TABLE tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  assignee_id      UUID NOT NULL REFERENCES users(id),
  workplace_id     UUID REFERENCES workplaces(id),
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  details          TEXT CHECK (length(details) <= 2000),
  due_date         DATE,
  requires_photo   BOOLEAN NOT NULL DEFAULT true,
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUBMITTED', 'APPROVED', 'REOPENED', 'CANCELLED')),
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at     TIMESTAMPTZ,
  submission_note  TEXT CHECK (length(submission_note) <= 1000),
  submitted_lat    DOUBLE PRECISION,
  submitted_lng    DOUBLE PRECISION,
  submitted_accuracy_m DOUBLE PRECISION,
  reviewed_by      UUID REFERENCES users(id),
  reviewed_at      TIMESTAMPTZ,
  review_note      TEXT CHECK (length(review_note) <= 500)
);
CREATE INDEX tasks_org_status_idx ON tasks (org_id, status, due_date);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id, status);

CREATE TABLE task_photos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id    UUID NOT NULL REFERENCES users(id),
  object_key     TEXT NOT NULL UNIQUE,
  content_type   TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  declared_bytes INT NOT NULL CHECK (declared_bytes > 0),
  status         TEXT NOT NULL DEFAULT 'PENDING_UPLOAD' CHECK (status IN ('PENDING_UPLOAD', 'UPLOADED', 'ATTACHED', 'DELETED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_photos_task_idx ON task_photos (task_id);
