-- One row per sent summary slot (e.g. "2026-10-28 10:00", "monthly 2026-10"), so a restart or a
-- second server never sends the same summary twice.
CREATE TABLE digest_runs (
  org_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slot     TEXT NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  results  JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, slot)
);
