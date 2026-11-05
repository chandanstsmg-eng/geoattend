# Background jobs

Fourteen jobs run every 15 seconds (`SWEEPER_INTERVAL_MS`), in the order in [modules/jobs/sweeper.ts](../apps/api/src/modules/jobs/sweeper.ts). Retention and the backup check run hourly, alerts each minute. There is no queue to lose work from: each job finds its work from database state on every run.

By default the API runs them. To keep heavy work away from requests, set `JOBS_ENABLED=false` on the API and run `npm run worker`. Several workers are safe.

## Guarantees

| Need | How |
|---|---|
| Company isolation | `eachCompany` runs the work on the restricted login, with one company set |
| One failure stops nothing else | A failing record, company or job is logged and the next one continues |
| No duplicate runs | A lease in `job_state`, taken in one atomic statement: only one instance runs a job at a time |
| No duplicate alerts | Unique `dedupe_key` on notifications, and state re-checked under a row lock |
| No duplicate sends | Each delivery is claimed in one statement before it is sent |
| No partial updates | Each record's change and its alert share one transaction |
| Safe retries | A failed job waits 30 s, doubling to 15 minutes, then runs again, however long the outage |
| A stuck job | Recorded as failed after `JOB_TIMEOUT_MS` (10 minutes) so the jobs behind it run. Calls to outside services have their own 10 to 30 second limits |
| Clean shutdown | A job finishes the record in hand and stops, recorded as `INTERRUPTED`, not failed. The next run carries on at once. Shutdown waits up to 8 seconds |
| Recovery after a crash | A job cut off by a crash is detected when its lease runs out (`JOB_LEASE_SECONDS`, 5 minutes), recorded and run again |
| Intervals survive restarts | The next run time is in the database |
| Failures never vanish | `job_runs` keeps each run, `job_failures` each failure with its company. Good runs are kept 3 days, failures 30 |

## Watching them

**The operations page** is `/operations` in the dashboard. It has no menu link: it covers every company, so it needs an owner's sign-in and `OPS_TOKEN`, which stays in the page's memory only. It shows job states, last success and failure, duration, next run, failure reasons, run history filtered by job, status, company and date, alerts and backups.

**The operations API** needs `Authorization: Bearer <OPS_TOKEN>`. Without it, or if `OPS_TOKEN` is not set, every address answers 404, and wrong guesses are limited to 20 a minute. Company owners have no access. Nothing there names an employee, and failure messages have addresses, numbers and tokens removed before they are stored.

| Address | Gives |
|---|---|
| `GET /api/v1/ops/health` | API, both database logins, worker, jobs, notification queue, storage, backups, alerts. **503** if any check fails |
| `GET /api/v1/ops/jobs` | Totals, and each job's state |
| `GET /api/v1/ops/runs` | Run history: `job`, `status`, `company`, `from`, `to`, `limit`, `offset` |
| `GET /api/v1/ops/failures` | Failures, with the same filters |
| `GET /api/v1/ops/alerts`, `/backups`, `/companies` | Alerts, backups, the company list for the filter |
| `GET /health/jobs` | Short job counts, as before |
| `GET /health` | Public: only whether the API can reach the database |

`npm run jobs:status` shows the same job list on the server.

### Job states

`RUNNING`, `SCHEDULED` (waiting for its time), `PENDING` (due now), `RETRYING` (failed, waiting to try again), `FAILED` (failed and due again), `INTERRUPTED` (cut off, recovery due), `NEVER_RUN`.

### Alerts

The `ops-alerts` job opens one alert per problem and closes it when the problem clears:

| Alert | When |
|---|---|
| `job-failing:<job>` | Three failures in a row |
| `job-stalled:<job>` | Running over 15 minutes with a live lease |
| `job-interrupted:<job>` | Cut off and not yet recovered |
| `worker` | No job has started for 2 minutes |
| `queue-behind` | A notification has been due for over 10 minutes |
| `notifications-gave-up`, `reports-gave-up` | Something could not be delivered after all its tries |
| `backup` | No proven backup within `BACKUP_MAX_AGE_HOURS`, or the newest is bad |
| `database`, `storage` | The check failed |

Alerts go to `ALERT_WEBHOOK_URL`, or by e-mail to `OPS_ALERT_EMAILS`. With neither, they are only logged and shown on the page, and are not marked as told. An alert sent from inside the server cannot report that server being down, so **an outside monitor must also poll `GET /api/v1/ops/health`**. See [EXTERNAL-DEPENDENCIES.md](EXTERNAL-DEPENDENCIES.md).

## What the jobs do for attendance

| Event | What happens |
|---|---|
| No-show | Owner and site supervisor alerted, employee reminded, once per shift |
| Late arrival | Alert when the attendance is recorded, not by a job |
| Missing check-out | The window closes, the session closes, `MISSING_CHECKOUT` is raised if attendance was marked |
| Record sent late from a phone | `ATTENDANCE_PENDING` when it arrives. **No job ever approves it** |
| Waiting over a day | Leave, requests, new phones, pending records, photo checks, corrections and overtime are raised to owners, once each |

## Summaries

| Summary | When | To | Default |
|---|---|---|---|
| Daily | The company's chosen times | WhatsApp and e-mail recipients | On, if recipients are set |
| Monthly CSV | From 09:00 on the 1st, catching up to the 3rd | E-mail recipients | On |
| Weekly CSV | From 09:00 on Monday, catching up to Wednesday | E-mail recipients | **Off** |
| Supervisor weekly CSV | Same | Each supervisor, their own sites only | **Off** |
| Employee weekly summary | Same | Each employee, in the app | **Off** |

Times use the company's main workplace time zone. A supervisor's rows are chosen by each employee's first site in the period.

## What a retry can and cannot do

- **Notifications to phones and browsers** are delivered at least once: a crash just after sending and before recording it repeats that one message, after two minutes. Six attempts, then it gives up, records why, and raises an alert.
- **Summaries** are tried up to three times, five minutes apart, if nothing was delivered. If some recipients got one, it is not sent again, and the job shows as failed. Each summary is separate, so one failing does not hold up the next.
- **A job that timed out** may still be running, because JavaScript cannot cancel it. Every step re-checks state, so this is safe, but it can use a connection until it finishes.
- **Photo deletion** stays on hold (see [PENDING-VERIFICATION.md](PENDING-VERIFICATION.md)). When allowed by both switches, a photo is skipped while it is a face reference or the evidence for anything undecided, each deletion has its own audit entry, and a storage failure changes nothing and shows as a failing job.

## Backups

Each backup records how it was proven in a manifest, with the size and SHA-256 of every file. A file existing proves nothing: a backup with no manifest does not count.

| Status | Meaning |
|---|---|
| `RESTORE_PROVEN` | Started as a real server and its tables compared with the live ones (`db:backup:online`) |
| `READABLE` | `pg_restore` read its contents list (`db:backup`). **Not a restore** |
| `FAILED` | The backup reported a failure |

- `npm run db:backup:verify` re-reads every byte and exits 1 unless the newest backup is good. It changes nothing.
- `npm run db:backup:prune` lists surplus backups; add `-- --apply` to remove them. It only ever chooses proven backups beyond the newest `BACKUP_KEEP`, and never a failed or unproven one.
- The `backup-check` job fails while backups are in doubt. It checks sizes only: run `db:backup:verify` for the full check.
- `BACKUP_MAX_AGE_HOURS` defaults to 26 in production and 0 (off) elsewhere. With a provider's backups instead, those are checked by the provider: set it to 0, and the page will say backups are not monitored.

## Connections

Each process has up to 8 owner and 15 restricted connections, so plan for 23 per process, and for `max_connections` to cover them all.

## Adding a job

Add it to `JOBS`, run it through `eachCompany`, and make it safe to run twice. Use `eachRecord` for loops, and keep each record's changes in one transaction.
