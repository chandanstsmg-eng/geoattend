-- SOS for people working alone, and broadcast messages with read receipts.
CREATE TABLE sos_alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  employee_id     UUID NOT NULL REFERENCES users(id),
  workplace_id    UUID REFERENCES workplaces(id),
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  accuracy_m      DOUBLE PRECISION,
  message         TEXT CHECK (length(message) <= 500),
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by UUID REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  resolved_by     UUID REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT CHECK (length(resolution_note) <= 500)
);
CREATE INDEX sos_alerts_open_idx ON sos_alerts (org_id, status, created_at DESC);

CREATE TABLE broadcasts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  workplace_id UUID REFERENCES workplaces(id),          -- NULL = everyone in the company
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body         TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  recipients   INT NOT NULL,                             -- active employees it was sent to
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX broadcasts_org_idx ON broadcasts (org_id, created_at DESC);

CREATE TABLE broadcast_recipients (
  broadcast_id UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  employee_id  UUID NOT NULL REFERENCES users(id),
  read_at      TIMESTAMPTZ,
  PRIMARY KEY (broadcast_id, employee_id)
);
CREATE INDEX broadcast_recipients_employee_idx ON broadcast_recipients (employee_id, read_at);
