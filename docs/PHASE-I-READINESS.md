# Phase I: staging and production readiness

**Branch.** `phase-i-staging`, from `production-remediation` at `3ef7f8f`. Merged on 9 November 2026 (merge `1959a30`, rollback tag `before-phase-i`). Not deployed.

**Machine.** Everything ran on the Windows development machine, against a disposable staging copy: API 4410, dashboard 3410, PostgreSQL 18.4 on 54352, data in `D:\gh`, restored from a verified backup. The live `geoattend` database (migration 020) and your development stack were not touched.

**Statuses.**
- **PASS:** actually tested and passed.
- **FAIL:** tested and failed.
- **BLOCKED:** a dependency is missing.
- **NOT VERIFIED:** nothing was actually checked.

## Environment found

| Item | Finding |
|---|---|
| Production environment | None on this machine. `DATABASE_URL` is empty, so everything uses the built-in local database. No production server, domain or credentials were provided |
| Development and "live" databases | Both live in the same local PostgreSQL. Development uses `geoattend_demo` (migration 030); `geoattend` stays at 020 and was not touched. They are separate databases, not separate servers |
| Architecture | Docker Compose (PostGIS 17, MinIO, API, dashboard, website) behind a TLS reverse proxy, or managed services. See [DEPLOYMENT.md](DEPLOYMENT.md) |
| Not configured | SMTP, alert recipients, the Expo push token, the Maps Map ID, an off-site bucket, an alert webhook, `OPS_TOKEN` |

## Results by area

| Area | Check | Status |
|---|---|---|
| Linux server | Start, SIGTERM, restart, resources, log rotation, firewall, HTTPS | **BLOCKED**: no Linux, WSL or Docker here; enabling WSL needs your approval |
| Linux server | SIGTERM handling, by code review | API and worker catch SIGTERM, let requests finish (10 s) and the job in hand finish its record, then close the database. Containers run Node as the main process, so the signal reaches it |
| Crash recovery | API killed with no shutdown (Phase H) | **PASS**: no data lost, no job stuck, 12 of 15 jobs ran within 16 s of restart |
| Database backups | `db:backup:production`: dump and counts in one snapshot, restore check of 52/52 tables, scratch database dropped | **PASS** |
| Database backups | Off-site copy read back by checksum; retention keeps the newest N | **PASS** against a local S3-compatible server. **BLOCKED** for a real off-machine bucket |
| Database backups | Restore of the downloaded copy, with a second API run against it | **PASS**: same 30-day figures as staging (42 employees, 1,045 expected, 946 present, 452,679 min) |
| Database backups | A failed run is recorded FAILED, the health check reports it, and an alert reaches a webhook | **PASS** with a local receiver. **BLOCKED** for delivery to a person |
| Database backups | Scheduled runs (`deploy/geoattend-backup.timer`) | **BLOCKED**: no Linux server |
| Database backups | Migration safety | **PASS**: migration 030 rolled back and re-applied on the disposable copy with data unchanged (Phase H) |
| Monitoring | `/ops/health`, job monitoring, alert opening and resending | **PASS** locally (Phase F tests 117/117, plus the backup alert above) |
| Monitoring | An outside monitor, real alert delivery, disk and memory alerts | **BLOCKED**: no monitoring service or credentials. Disk and memory are not watched by the app; use the host's or provider's monitoring |
| Notifications | Notification records for owners and supervisors; inboxes show the right set | **PASS** (walkthrough, step 20) |
| Notifications | SMTP, Android push, WhatsApp delivery | **BLOCKED**: no credentials. Not reported as delivered |
| Android | Release build and device tests on Xiaomi, Oppo, Vivo and Samsung | **BLOCKED**: no devices, no Android SDK, and no production API address to build against |
| Browsers | Chrome 156, Edge 156 | **PASS**, apart from Google Maps messages caused by the test key |
| Browsers | Firefox and WebKit (Playwright builds, not stock Firefox or Safari) | **PASS**, apart from Google Maps messages and Safari's default of not tabbing to links |
| Browsers | Safari on a real Apple device | **BLOCKED**: no Apple device |
| Google Maps | Key restricted by site address | **PASS**: the key refuses this test address |
| Google Maps | Key works for the real domain, billing, Places and Geocoding | **BLOCKED**: tiles show "For development purposes only". Needs a key on a billed project, restricted to the production domain |
| Google Maps | Fallback when Google fails without reporting it | **PASS** after a fix: the new watchdog falls back to the diagram after 20 s (Chrome) |
| Docker | Build and run the images, health checks, restart policies | **BLOCKED**: Docker not installed |
| Docker | Configuration review | Log rotation and a 30 s stop grace added. The Compose file parses. `deploy/Caddyfile` added |
| Business workflow | 20-step walkthrough by an independent tester: API, dashboard and SQL agree | **PASS**, 19 of 20. Step 20 (notification delivery) is **BLOCKED** |
| Security | Phase H audit: 189 routes, company isolation, injection, XSS, CSRF, tokens, uploads | **PASS** (Phase H, unchanged since) |
| Security | Dependency audit | **PASS** for the API, dashboard, website and shared code: 0 vulnerabilities. The phone app has 5 moderate advisories in Expo's build-time tools, not in the shipped app; the only fix changes Expo's major version |
| Performance | 40 users for 60 s, mixed dashboard reads | **PASS**: 11,365 requests (189/s), 0 errors; p95 under 0.2 s for lists, about 1 s for the 7-day dashboard; healthy afterwards |
| Concurrency | 30 identical attendance submissions at once | **PASS**: 1 created, 29 refused, 1 record |
| Accessibility | axe on 6 key pages in Chrome | **PASS**: only 4 nodes, inside Google Maps' own dialog |

## Defects found and fixed in Phase I

| Defect | Fix |
|---|---|
| A manual arrival time was not checked against the record's date: a record for 8 November could carry an arrival from October | The arrival must fall between 6 hours before and 24 hours after that day's shift start, for manual entries and corrections alike |
| A supervisor could request "GPS-verified" in a correction; it was refused only at the owner's approval | Refused when the supervisor submits it |
| When Google Maps failed without calling its refusal hook, users saw Google's grey error box | Watchdog: no tiles within 20 s, and the page shows the diagram |
| Two bugs in my own first version of the backup script: a success was reported as FAILED, and a real off-site failure was not recorded, so it would never have alerted | The manifest is written once, after every step, including the off-site copy |

Each fix has a test, and each test fails when its fix is undone. The backup script was verified by running it, including the forced failure.

## Decisions waiting for the company (not invented)

- **Half-day leave lateness.** The data does not say which half of the day is leave.
- **Slow-network check-ins.** Should one that times out stay pending (D5)?
- **Offline cold start (M2).**
- **Minimum overtime.** A minimum-length setting is saved but never applied. Decide whether it should be.
- **Supervisor leave.** Should leave recorded by a supervisor be approved at once? Today it is.
- **Reversing leave.** Should an owner be able to reverse a decided leave?
- **Offline arrival time.** Should it be the phone's time (now) or the time it reached the server?
- **Owner notification.** Should the owner be notified when a supervisor enters attendance?

## Staging execution preparation (after the merge)

Found by reading the Docker setup; **not yet proven, because Docker is not available here:**

| Defect | Fix |
|---|---|
| The API image installed Debian's `pg_dump` 15, which refuses to dump the PostgreSQL 17 database, so backups and restores in the container would fail | It installs the PostgreSQL 17 client from the PostgreSQL project's repository |
| The API's hourly backup check read a folder inside its container, which no backup ever writes to. In production it would have warned every hour | The host's backup folder is mounted into the API read-only (`BACKUP_DIR=/backups`) |
| The backup timer needed Node and a matching PostgreSQL client installed on the host | The backup runs as the `backup` Compose service in the API image; the host needs Docker only |

New, for the Linux server ([STAGING.md](STAGING.md)):
- `deploy/staging-bootstrap.sh`: Docker, Caddy and the firewall, plus secrets generated into chmod-600 files.
- `deploy/staging-verify.sh`: health, loopback-only ports, HTTPS, SIGTERM, kill -9 recovery, persistence, backup.
- `deploy/staging.env.example` and `deploy/backup.env.example`.
- `npm run integrations:check`: real sends. Off-site and photo buckets are PASS only after a checksum read-back; e-mail, push, WhatsApp and webhooks are only ACCEPTED until a person confirms receipt.

**Locally verified:** the integration check's PASS, ACCEPTED, FAIL and BLOCKED paths, against a local S3 server, a local webhook and a closed SMTP port. The probe object was removed afterwards. **Not verified:** any real service.

Note: the server marks an employee push `SENT` when Expo accepts it; it does not read Expo's receipts. Treat `SENT` as "accepted", not "delivered".

## Infrastructure preparation and deployment validation

**PostgreSQL 17, verified here:**
- **Full API suite on PostgreSQL 17.10:** every migration ran, and 624 tests passed with 9 skipped (the cloud-bucket tests, which need S3 settings). Earlier, every test had run on 18.4 only.
- **Backup drill on a 17.6 server with the 17.6 tools:**
  - The logins from `docker/db-init` were created correctly.
  - `db:backup:production` reached RESTORE_PROVEN, with the off-site copy verified.
  - The downloaded copy restored into a separate database with identical counts.
  - Tools older than the server are refused, and that run is recorded `FAILED` ([BACKUPS.md](BACKUPS.md)).

**Found and fixed in this round:**

| Problem | Fix | Test |
|---|---|---|
| The dashboard's proxy for live updates dropped `X-Forwarded-For`, so the API saw every user's stream as coming from the dashboard container, under one shared per-address rate limit | The proxy passes the client address on, like the generic `/api` rewrite | `apps/admin/lib/stream-headers.test.ts` (new; the dashboard now has `npm test`, run by CI) |
| No way to check a server's settings before deploying; the first sign was a refused start | `npm run config:check`: the API's own start-up rules; names only, never values | `apps/api/test/deploy-config.test.ts` (3 tests, including that no secret is printed) |
| The dashboard and website images had no version tags, so a release could not be undone | Images tagged per commit; `deploy/staging-deploy.sh` and `deploy/staging-rollback.sh` | Script syntax only; needs a server |
| Docker's 10 s stop limit can cut PostgreSQL's shutdown checkpoint short | `stop_grace_period: 60s` on `db` | Needs Docker |
| My own earlier `staging-verify.sh` would always fail its placeholder check: the template's comments mention the placeholders and are copied into `.env` | Comment lines are skipped | Needs a server |

**Reviewed, no change needed:**

| Area | Finding |
|---|---|
| Restart policies | `unless-stopped` on db, minio, api, admin, web and redis; the one-off jobs have none |
| Start-up order | After a reboot Docker ignores `depends_on`. An API that starts before the database exits 1 and is restarted until the database answers |
| API shutdown | SIGTERM closes connections cleanly (exit 0) inside the 30 s grace |
| PostgreSQL shutdown | The image stops PostgreSQL with SIGINT (fast shutdown) |
| Health checks | API `/health` runs a database query; dashboard and website check a page; db uses `pg_isready` |
| Proxy addresses | The generic `/api` rewrite adds no extra `X-Forwarded-For` hop, so `TRUST_PROXY=1` behind Caddy is correct |
| Data on disk | `pgdata` and `photos` are named volumes; `down` without `-v` keeps them |
| Secrets in the frontend | Only `NEXT_PUBLIC_GOOGLE_MAPS_*`, which is public by design and must be restricted by referrer |

New: [UBUNTU-SERVER.md](UBUNTU-SERVER.md), the exact guide for a new Ubuntu 24.04 server.

## Windows continuation (10 November 2026)

Ubuntu and Docker were set aside; everything below ran on the Windows development machine, on disposable copies. The live `geoattend` database and the developer's stack were not used for any test.

### Windows reliability

Disposable stack: API 4410, database 54352, data `D:\gh`.

| Check | Result |
|---|---|
| Second API on a port already in use | **PASS**: exit 1 with "Port … is already in use"; the running API stays healthy |
| Clean shutdown through the Windows IPC message, with a year-long dashboard request in flight | **PASS**: the request finished (200); exit 0 within 4.4 s; no job left marked running |
| Database killed under the running API (`pg_ctl stop -m immediate`) | **PASS**: 503 while down; the watchdog restarted the database; healthy after 7 s; data intact |
| API killed with no shutdown while jobs run | **PASS**: no job stuck; jobs ran again after the restart; counts unchanged (the 18 fewer location points were the retention job, which ran in that window) |
| Restart time, 1,032-employee copy | **PASS**: healthy 5.6 s after a kill |
| Monitoring right after a restart | Reports the worker as `fail` until its first tick (about 1 minute), then `ok`. Expected; noted here so it is not mistaken for a fault |
| Online-backup restore by the RUNBOOK steps, into a new folder | **PASS**: served in 17 s; every count equal to the source databases; owner sign-in worked |
| `db:restore` of a dump into a new database (with `PG_BIN`) | **PASS** after the fix below: identical counts; existing names and the live database refused |

**Found and fixed:**

| Problem | Fix | Test |
|---|---|---|
| `npm test` could not start while the dev stack ran: every built-in database logged to `data/logs/postgres.log`, which Windows locks for the running dev server | One log file per data folder; the dev server keeps `postgres.log` | `client-tools.test.ts`; the suite now runs beside the dev stack |
| `db:backup` and `db:restore` failed with a bare npm error on Windows (no `pg_dump` in the embedded package) | `PG_BIN` honoured, and a clear message pointing to `db:backup:online` | `client-tools.test.ts` |
| `db:restore` created the new, empty database before finding out `pg_restore` was missing; the retry was then refused | The tool is found first | `restore-target.test.ts` runs the script with an empty `PG_BIN` |

### Performance with a large company

A separate restored copy (`D:\gr`) was grown to **1,032 employees** with 90 days of history: 69,264 attendance records and sessions, and 322,896 location points.

| Measure (1,032 employees) | Before | After the fixes |
|---|---|---|
| Dashboard, 30 days | 6.4 s | 2.7 s |
| Dashboard, 90 days | 20 s | 7.9 s |
| `monthly.csv` | 7 s | 2.4 s |
| 40 users for 60 s, dashboard p50 / p95 | 9.0 s / 11.9 s | 3.3 s / 4.7 s |
| 40 users for 60 s, throughput | 20 requests/s | 37–40 requests/s, 0 errors |
| `overdue-approvals` job, every minute | average 5–6 s, worst 37 s | average 224 ms, worst 655 ms |

Other figures, after the fixes:
- Employees page: 13 ms. Live map: 42 ms. Reports overview: 52 ms (single requests).
- Attendance list: about 0.5 s. `attendance.csv` for 30 days (3.6 MB): about 2 s.
- 30 identical attendance submissions at once: 1 created, 29 refused.
- API memory: 141 MB idle.

**Causes:**
- **No-show calculation:** each day's no-show check parsed a time-zone-aware time for every row, about 150 ms per day. It now does this once per shift time.
- **Day-by-day lookups:** run 4 at a time instead of one after another.
- **The approvals job:** re-sent its whole backlog every minute. It now skips items already raised.

Tests prove the figures are unchanged (`report-speed.test.ts`), and each test fails when its fix is undone.

**Still slow, not changed:** a 90-day dashboard for 1,000 employees takes about 8 s. Most of that is the per-record worked-time calculation. Making it faster means precomputing daily totals, which changes how hours are computed, so it needs approval first.

**Not measured:** API CPU under load. The sampler lost the process, so no figure is given.

### Independent reviews

**Workflow review** (16 areas, a second company created through sign-up):
- 11 areas PASS. Company isolation: 112 cross-company calls on id routes, with no leak. Supervisor scope: PASS.
- Defects found: 2 High, 5 Medium and 6 Low.

**UI/UX review** (22 screens, 3 widths, owner and supervisor):
- No sideways scrolling anywhere. axe found no serious issues apart from the known Maps ones.
- Issues found: 2 High, 6 Medium and 7 Low.

**Fixed, each with a test:**

| Finding | Fix |
|---|---|
| Time zone `IST` accepted. The API read it as India time and PostgreSQL as Israel time, so SQL dates and lateness were 3.5 h off | Only IANA names or UTC; the message suggests `Asia/Kolkata` |
| A correction could store "not late" with 90 minutes late | The flag and the minutes always agree; "late" with 0 minutes is refused |
| Phone app: a rooted-phone or emulator refusal was resent for ever, held back the check-out, and alerted the manager every 10 minutes | Treated as a final refusal and shown with its reason |
| Phone app: a missing photo was re-uploaded every 15 s for ever | Waits longer after each attempt |
| Approvals: a failed decision was shown only at the top of the page | Also shown as a toast |
| Approvals: "Reject" on a new phone revoked it on one tap | Asks for a reason first |
| Raw browser errors ("Failed to fetch", "Request failed (502)") and requests that never ended | Plain messages for no connection, proxy errors and the general rate limit; a 45 s limit |
| Phone menu: focus left the menu, and the page behind stayed reachable | Behaves as a dialog: focus moves in, Tab stays inside, focus returns on close |
| Touch targets smaller than 44 px on phones | Buttons, header icons and fields are 44 px on touch screens |

A browser check confirmed all of these on the rebuilt dashboard (12/12). The existing browser suite: 46 of 47. The one left over needs a running shift, and none of the sample shifts runs after 16:00.

**Not fixed (low impact, or a design question):**
- **Phone app, shared phones (M4):** fixed afterwards. See "Post Phase I fixes".
- **Phone app, fast phone clock (M1):** readings from a phone whose clock runs fast are refused and quietly dropped. The fix is to correct the phone's clock from the server time, which needs device testing.
- **Keyboard:** focus is lost after Approve.
- **Small text links:** "Open on map" and "before / after" are 16 px tall.
- **Number and date formats:** Indian formatting is not used everywhere.
- **Signed-out users:** no "session ended" notice.
- **Demo mode:** a supervisor can open the demo page.
- **Info icons:** their explanations appear only on hover.
- **Empty company:** "Confirm day" shows with 0 of 0 present.
- **Website:** the phone menu stays open after a tap.
- **API only:** `/reports/overview` reports "present" only for today.
- **Data checks:** employee codes are case-sensitive, and a 2099 joining date is accepted.

**Payslip routes while payroll is off:** fixed afterwards. See "Post Phase I fixes".

### More decisions waiting for the company

- **Manual attendance on a day off:** refuse it, or record it as overtime without lateness? Today it is recorded as late (M3).
- **One stray reading:** should a single reading far away re-lock a ready check-in, or should leaving need the same confirmation as during a shift (M2)?
- **Leave on a day already attended:** refuse it, or let it replace the attendance (L1)?
- **Leave for a deactivated employee:** allow it or not (L5)?
- **Supervisor visibility:** should supervisors see only their own reports, or everyone at their workplaces (today)?
- **Mock-location readings:** should they still trigger arrival alerts?
- **Rooted phones:** is server-side attestation (Play Integrity) required? Today the phone reports these flags itself.
- **Mistaken deactivation:** an employee deactivated by mistake and reactivated the same day loses that day's roster. Is that intended?
- **Workplace names:** should two workplaces be allowed the same name?

## Post Phase I fixes (10 November 2026, branch `post-phase-i-fixes`)

| Issue | Result |
|---|---|
| **Payroll information while payroll is off** | `GET /payroll/payslips/:id`, `GET /payroll/:month` (frozen payslips) and `/:month/history` now refuse with `PAYROLL_DISABLED`, like every other payroll route. The dashboard payslip page shows the release notice. A test calls **every** registered payroll route while payroll is off (all reads must be 403), and shows the same records return once payroll is on. **This reverses the earlier rule that approved history stays readable to the owner**: one line per route if that rule is wanted back. Calculation logic not touched |
| **Shared phones** | The phone shows, retries and removes only the signed-in employee's saved items. Both sync loops stop when the signed-in employee changes. A refusal that comes back under another sign-in leaves the item waiting instead of "not accepted". Saved items are hidden at sign-out and when the sign-in is lost. 4 tests; 3 fail if the sign-in check is removed |
| **Large-company dashboard** | On the 1,032-employee copy, under row-level security: 90 days 11.6 s → 7.1 s, 30 days 4.2 s → 2.7 s, hours 2.2 s → 1.6 s, `monthly.csv` 3.9 s → 3.0 s. Every response is identical to before (only `serverTime` differs) |

**What still limits the 90-day dashboard.** The hours query takes about 4 s for 67,000 records because row-level security checks each session, break, absence and overtime row against the company, one lookup per row. That check *is* the company isolation and was not weakened.

The next step would add a company column to those child tables (a migration), so the check needs no lookup, or precompute daily totals. Both change the schema and need approval.

Business decisions: [POLICY-DECISIONS.md](POLICY-DECISIONS.md).

## Open, not fixed

- **Employee notifications:** employees have no in-app list of their notifications; they rely on push, which is not configured.
- **Late alerts:** a late alert is sent for a pending offline record that has not been approved.
- **Deferred items:** those listed in [PHASE-H-QA.md](PHASE-H-QA.md).
