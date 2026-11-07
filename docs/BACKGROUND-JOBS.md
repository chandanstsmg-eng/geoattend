# Background jobs

The API runs twelve jobs every 15 seconds (`SWEEPER_INTERVAL_MS`), in the order in [modules/jobs/sweeper.ts](../apps/api/src/modules/jobs/sweeper.ts). Retention runs hourly.

## Guarantees

| Need | How |
|---|---|
| Company isolation | `eachCompany` runs the work on the restricted login, with one company set |
| One failure stops nothing else | A failing record, company or job is logged and the next one continues |
| No duplicate runs | A lease in `job_state`: only one instance runs a job at a time |
| No duplicate alerts | Unique `dedupe_key` on notifications, and state re-checked under a row lock |
| No partial updates | Each record's change and its alert share one transaction |
| Safe retries | A failed job waits 30 s, doubling to 15 minutes, then runs again |
| Recovery after a restart | Work is found from database state, not from memory. A job cut off by a crash is detected within 5 minutes, when its lease runs out, recorded as failed and run again |
| Intervals survive restarts | The next run time is in the database |
| Failure log | `job_failures`, kept 30 days, with the company where it applies |

## Watching them

- `npm run jobs:status` lists every job, its last result and recent failures.
- `GET /health/jobs` with `Authorization: Bearer <OPS_TOKEN>` gives counts for a monitoring service: `failing`, `interrupted`, `lastOkAt`. Without `OPS_TOKEN` set, the endpoint does not exist. Alert when `failing` is above 0 for more than a few minutes, or `lastOkAt` is older than 5 minutes.
- Failures are logged at error level.

Connecting a real alerting service is an external step: see [EXTERNAL-DEPENDENCIES.md](EXTERNAL-DEPENDENCIES.md).

## What a retry can and cannot do

- **Notifications to phones and browsers** are delivered at least once: a crash just after sending and before recording it repeats that one message. Six attempts, then it gives up and records why.
- **Daily summaries** are tried up to three times, five minutes apart, if nothing was delivered. If some recipients got one, it is not sent again, and the job shows as failed.
- **Photo deletion** stays on hold (see [PENDING-VERIFICATION.md](PENDING-VERIFICATION.md)).

## Adding a job

Add it to `JOBS`, run it through `eachCompany`, and make it safe to run twice. Use `eachRecord` for loops, and keep each record's changes in one transaction.
