-- Daily close: an administrator confirms a day's attendance. The summary at that moment
-- is kept; payroll warns about days that were never confirmed.
CREATE TABLE day_closes (
  org_id      UUID NOT NULL REFERENCES organizations(id),
  close_date  DATE NOT NULL,
  closed_by   UUID NOT NULL REFERENCES users(id),
  closed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT CHECK (length(note) <= 500),
  summary     JSONB NOT NULL,
  PRIMARY KEY (org_id, close_date)
);
