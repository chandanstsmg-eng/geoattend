-- History of background job runs and operational alerts. Rollback: docs/migrations/028_rollback.sql.
-- Two new tables, two new nullable columns and six indexes: no existing row changes meaning.
-- None of this is company data, so the restricted role is given no access to it.

CREATE TABLE job_runs (
  id               BIGSERIAL PRIMARY KEY,
  job              TEXT NOT NULL,
  holder           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('OK', 'FAILED', 'TIMED_OUT', 'INTERRUPTED')),
  started_at       TIMESTAMPTZ NOT NULL,
  finished_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms      INT,                         -- empty when the process died and nobody timed it
  companies        INT NOT NULL DEFAULT 0,      -- companies visited
  companies_failed INT NOT NULL DEFAULT 0,
  failures         INT NOT NULL DEFAULT 0,      -- all failures; job_failures keeps the first 50 of a run
  error            TEXT
);
CREATE INDEX job_runs_started_idx ON job_runs (started_at DESC);
CREATE INDEX job_runs_job_idx ON job_runs (job, started_at DESC);

ALTER TABLE job_state ADD COLUMN last_duration_ms INT;

-- No foreign key: the failure log must outlive the run history, which is kept for less time.
ALTER TABLE job_failures ADD COLUMN run_id BIGINT;
CREATE INDEX job_failures_org_idx ON job_failures (org_id, at DESC) WHERE org_id IS NOT NULL;
CREATE INDEX job_failures_run_idx ON job_failures (run_id) WHERE run_id IS NOT NULL;

-- A problem an operator should hear about: one open row per problem, closed when it clears.
CREATE TABLE ops_alerts (
  id              BIGSERIAL PRIMARY KEY,
  key             TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('WARNING', 'CRITICAL')),
  message         TEXT NOT NULL,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  notified_at     TIMESTAMPTZ,                  -- empty until someone has actually been told
  notify_attempts INT NOT NULL DEFAULT 0,
  notify_error    TEXT
);
CREATE UNIQUE INDEX ops_alerts_one_open ON ops_alerts (key) WHERE closed_at IS NULL;
CREATE INDEX ops_alerts_opened_idx ON ops_alerts (opened_at DESC);
