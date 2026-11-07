-- Background job leases, outcomes and failures. Rollback: docs/migrations/026_rollback.sql.
-- New tables and two new columns with defaults: no existing row changes meaning.
-- Neither table holds company data and the restricted role has no access to them.

CREATE TABLE job_state (
  job                  TEXT PRIMARY KEY,
  holder               TEXT NOT NULL,                       -- the process running it, or that last ran it
  lease_until          TIMESTAMPTZ NOT NULL,                -- another instance may take over after this
  running_since        TIMESTAMPTZ,                         -- set while running; left set if the process died
  next_run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),  -- back-off after a failure, or the job's own interval
  last_started_at      TIMESTAMPTZ,
  last_ok_at           TIMESTAMPTZ,
  last_failed_at       TIMESTAMPTZ,
  last_error           TEXT,
  consecutive_failures INT NOT NULL DEFAULT 0,
  runs_ok              BIGINT NOT NULL DEFAULT 0,
  runs_failed          BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE job_failures (
  id      BIGSERIAL PRIMARY KEY,
  job     TEXT NOT NULL,
  org_id  UUID,                     -- no foreign key: this log must outlive what it describes
  message TEXT NOT NULL,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_failures_at_idx ON job_failures (at DESC);

-- A summary that failed to send can be tried again, a limited number of times.
ALTER TABLE digest_runs
  ADD COLUMN attempts INT NOT NULL DEFAULT 1,
  ADD COLUMN failed   BOOLEAN NOT NULL DEFAULT false;
