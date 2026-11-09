# Staging on a Linux server

How to bring up GeoAttend staging on a separate Ubuntu server, prove each external integration, test real devices, and run the regression there. **None of it has been run yet:** no Linux server, credentials or devices were available (9 November 2026). Record every result in the log at the end, with date and evidence. A step that was not run is "not tested", never "pass".

Staging is a separate server with its own secrets, its own database and its own buckets. **Never point it at production data or production credentials,** and never run these scripts on the production server.

## 1. Prepare the server

The full step-by-step for a new Ubuntu 24.04 LTS server, with a check after each step, is [UBUNTU-SERVER.md](UBUNTU-SERVER.md). It covers SSH keys and lockdown, firewall, Docker, DNS, HTTPS and secrets. In short:

Needs: Ubuntu 22.04 or 24.04, 2 vCPU, 4 GB RAM and 40 GB disk at least, SSH access, and four DNS names pointing at it (dashboard, API, photos, website).

```bash
git clone <private repository> /opt/geoattend
cd /opt/geoattend && git checkout production-remediation
sudo bash deploy/staging-bootstrap.sh
```

`deploy/staging-bootstrap.sh`:
- installs Docker Engine with Compose v2 and Caddy, from their official repositories;
- opens SSH, 80 and 443 only (ufw);
- writes `/opt/geoattend/.env` from `deploy/staging.env.example`, with new random secrets, chmod 600;
- writes `/etc/geoattend/backup.env` from `deploy/backup.env.example`;
- installs the backup timer, but does not enable it.

It never overwrites an existing `.env` and never starts the stack.

Then, by hand:
1. In `.env`, replace every `REPLACE_ME` and `example.com`. `grep -vE '^[[:space:]]*#' .env | grep -nE 'REPLACE_ME|example\.com'` must print nothing (comment lines are skipped), and `docker compose run --rm --no-deps api npm run config:check -w @geoattend/api` must say OK; the API refuses to start otherwise.
2. Put the four host names in `deploy/Caddyfile`, copy it to `/etc/caddy/Caddyfile` and run `systemctl reload caddy`. Caddy obtains the HTTPS certificates itself.

## 2. Start and verify the stack

```bash
cd /opt/geoattend
bash deploy/staging-deploy.sh origin/production-remediation --first
docker compose exec api npm run db:seed -w @geoattend/api   # first administrator from .env
bash deploy/staging-verify.sh
```

`deploy/staging-deploy.sh` switches nothing until the first five steps pass:
1. Checks out the release, refusing a checkout with local changes.
2. Builds the images, tagged with the commit.
3. Checks the environment with the new image's own start-up rules (`config:check`). It prints setting names, never values.
4. Takes a pre-deployment backup, which must reach `RESTORE_PROVEN`. Skipped on the first install, when there is no database yet.
5. Runs the database migrations while the old release still serves.
6. Switches the containers to the new release.
7. Runs the health and HTTPS checks (`staging-verify.sh --quick`).
8. Records the release in `data/deploy-history.log`.

**Rollback:** `bash deploy/staging-rollback.sh` returns to the previous release's images (they are kept, tagged by commit) and re-runs the quick checks. It never changes the database. Migrations only add, so an older release normally runs on the newer schema. If it does not, see [BACKUPS.md](BACKUPS.md) and `docs/migrations/`.

`deploy/staging-verify.sh` prints PASS, FAIL or SKIP for each check:

| # | Check |
|---|---|
| 1 | Compose file valid; no placeholders left in `.env`; `.env` is chmod 600; payroll off |
| 2 | Every container healthy; `pg_dump` 17 present in the API image |
| 3 | Database, MinIO, API, dashboard and website listen on loopback only; ufw active |
| 4 | HTTPS on the API and dashboard with a trusted certificate; http redirects to https; HSTS header |
| 5 | `/api/v1/ops/health` answers with `OPS_TOKEN` and refuses without it |
| 6 | **Graceful shutdown:** `docker compose stop api` logs "SIGTERM received" and exits 0 within the 30 s grace |
| 7 | **Crash recovery:** `kill -9` of the API from the host; Docker restarts it; data unchanged |
| 8 | **Persistence:** `docker compose down` then `up -d` (volumes kept); same data |
| 9 | With `--with-backup`: a backup run reaches `RESTORE_PROVEN`, with a verified off-site copy |

Then fill `/etc/geoattend/backup.env` (section 3), run `bash deploy/staging-verify.sh --with-backup`, and enable the timer: `systemctl enable --now geoattend-backup.timer`.

**Fixed while preparing this, not yet proven on Docker:**
- **Backup tools:** the API image carried Debian's `pg_dump` 15, which refuses to dump the PostgreSQL 17 database. It now installs the version 17 client.
- **Backup check:** the API's hourly backup check looked inside its own container, so it would have warned every hour. `docker-compose.yml` now mounts the backup folder into the API read-only.
- **Backup job:** the backup now runs as the `backup` Compose service, so the server needs Docker only.

## 3. External integrations

Every integration is configured in `.env` (or `backup.env`) and then tested for real:

```bash
docker compose exec api npm run integrations:check -w @geoattend/api -- \
  --email <your inbox> --expo-token <a test phone's token> --whatsapp-to <91XXXXXXXXXX>
```

The script sends only to the recipients given. It never reads or changes the database. In the bucket checks it writes one small test file and removes it again.

Its statuses:
- **PASS:** the service proved it worked: the test file was written, read back by checksum and removed.
- **ACCEPTED:** the service took the message. That is **not** delivery: a person must confirm it arrived, and only then may the log say PASS.
- **FAIL:** the service refused the message, or did not answer.
- **BLOCKED:** not configured, or no test recipient was given.

| Integration | Settings | Done when |
|---|---|---|
| SMTP e-mail | `SMTP_URL`, `EMAIL_FROM`, `ALERT_EMAIL_RECIPIENTS`, `OPS_ALERT_EMAILS`. Set SPF and DKIM for the sending domain | ACCEPTED, then the message is found in the inbox, not in spam |
| Expo push | `EXPO_PUSH_ENABLED=true`, `EXPO_ACCESS_TOKEN`, an EAS project with FCM credentials | ACCEPTED with "receipt ok", then the notification is seen on the phone (device plan, P1) |
| WhatsApp | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, an approved template with 3 body variables | ACCEPTED, then the message is seen on the phone. The dashboard's "Send a test summary" also sends one |
| Off-site backups | `BACKUP_S3_*` in `/etc/geoattend/backup.env`. Use another account or provider, with versioning or object lock | The script says PASS, and `staging-verify.sh --with-backup` passes |
| Photo bucket | Default: MinIO in the stack. A cloud bucket goes in `S3_*` | The script says PASS, and a photo from a real phone appears in the dashboard |
| Alert delivery | `ALERT_WEBHOOK_URL` (https) or `OPS_ALERT_EMAILS` | ACCEPTED, then the on-call person confirms receipt. Also: stop the backup timer for 27 hours, or make a backup fail, and confirm the alert reaches that person |
| External monitor | An outside service (for example UptimeRobot or Better Stack) polling `https://<api>/health` every minute, alerting a person | Stop the API (`docker compose stop api`); the person is alerted within 5 minutes; start it again |
| Google Maps key | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`: a key on a billed project, restricted by HTTP referrer to the dashboard host, and to the Maps JavaScript API and Places API. Set a budget alert. Built into the image: rebuild `admin` after changing it | In Chrome on `https://<dashboard>/map`: real tiles, no "For development purposes only" watermark, no Google error in the console. Geofence editor place search finds a real address |
| Google Maps Map ID | `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`, a JavaScript vector Map ID from the same project. Rebuild `admin` | Live map markers show as Advanced Markers, with no Map ID warning in the console |

**Maps and monitoring cannot be proven from the server.** A browser key only works in a browser on its allowed domain, and a monitor is outside the server by definition. Both need the checks in the table.

## 4. Real devices

**Build.** An internal EAS build (APK or internal distribution) with `EXPO_PUBLIC_API_URL=https://<staging api>`. **Do not publish it** to the Play Store or share it outside the test group, and never build it against the production API.

**Android: Xiaomi, Oppo, Vivo, Samsung and one near-stock phone.** Follow [ANDROID-DEVICE-TEST-PLAN.md](ANDROID-DEVICE-TEST-PLAN.md):
- GPS and geofence (C, E6);
- permissions (B);
- background tracking and battery (E, F);
- offline attendance and delayed sync (D);
- camera (G);
- push (P);
- sign-in renewal (T).

Each phone gets a signed results sheet.

**iPhone app.** The employee app is configured for iOS (background location included) but has never been built or run on an iPhone ([STATUS.md](STATUS.md)). A build needs an Apple Developer account and EAS; then repeat sections B to E, P and T of the device plan on an iPhone. Until then, do not tell customers it works on iPhone.

**Safari.** Test the dashboard and website in Safari on a real iPhone and a Mac:

| # | Do | Pass when |
|---|---|---|
| S1 | Sign in to the dashboard on iPhone Safari and on Mac Safari | Lands on the overview; stays signed in after 20 minutes |
| S2 | Live map, attendance list, approvals, reports | Everything loads; the map shows real tiles (needs the production key) |
| S3 | Download a CSV export | File opens in Numbers and Excel, with correct dates and Indian names |
| S4 | Turn the iPhone sideways; zoom text to 200 % | Nothing cut off; no sideways scrolling |
| S5 | Allow web notifications (Mac Safari, and iPhone added to the Home Screen) | A test alert appears |
| S6 | Public website on iPhone | Pages load; contact links open phone, mail and WhatsApp |

## 5. Regression on the staging server

Run it in this order. Any FAIL stops the move to production.

1. **Code suites on Linux.** On the server, in a throw-away container, with the API using its built-in test database and never the staging one:
   ```bash
   docker run --rm -v /opt/geoattend:/src:ro node:24-bookworm bash -c \
     'cp -r /src /w && cd /w && rm -f .env && npm ci && npm run build && npm run typecheck && npm test -w @geoattend/api && npm test -w @geoattend/shared'
   ```
   It covers employee and supervisor rules, attendance and GPS, payroll and overtime (calculations only, payroll stays off), dates, time zones, company isolation, jobs, notifications, reports, CSV exports and security.
2. **The stack.** Run `bash deploy/staging-verify.sh --with-backup`.
3. **Restore drill.** Take the newest off-site dump and restore it into a new database on another machine (steps in [BACKUPS.md](BACKUPS.md)). Its row counts must equal the manifest's.
4. **Business workflow,** in the browsers on the real HTTPS addresses, with a new test company. These are the 20 steps of the Phase I walkthrough ([PHASE-I-READINESS.md](PHASE-I-READINESS.md)):
   - Company setup: the owner signs in; creates a workplace with a geofence, a shift, a supervisor and employees.
   - The working day: an employee checks in on a real phone, works, takes a break and checks out; one arrives late; one is absent.
   - Supervisor work: the supervisor sees their team only, records a manual entry and proposes a correction; the owner approves it.
   - Leave and overtime: the owner approves leave and overtime.
   - Reports: reports and CSV exports match the database.
   - Notifications arrive: e-mail, push and WhatsApp.
   - Isolation: a second company sees none of it.
5. **Browsers.** Chrome, Edge, Firefox and Safari (section 4) on the dashboard.
6. **Performance.** From a machine outside the server, 40 simultaneous dashboard users for 60 seconds. Target: no errors; p95 under 1 s for lists and under 2 s for the dashboard. Watch `docker stats` for memory during the test and note the peak.
7. **Security.**
   - The bootstrap firewall check (staging-verify sections 3 and 4).
   - `npm audit --omit=dev` must report 0 issues.
   - Try the dashboard over plain http; it must redirect.
   - Try signing in as company A's owner and reading company B's employee by its id; it must be refused with 404.

## Results log

| Date | Step | Result | Evidence (command output, screenshot, signed sheet) | By |
|---|---|---|---|---|
| | 1. Server prepared | not tested | | |
| | 2. staging-verify.sh | not tested | | |
| | 3. SMTP | not tested | | |
| | 3. Expo push | not tested | | |
| | 3. WhatsApp | not tested | | |
| | 3. Off-site backups | not tested | | |
| | 3. Alert delivery to a person | not tested | | |
| | 3. External monitor | not tested | | |
| | 3. Google Maps key | not tested | | |
| | 3. Google Maps Map ID | not tested | | |
| | 4. Xiaomi, Oppo, Vivo, Samsung | not tested | | |
| | 4. iPhone app (needs an Apple Developer account) | not tested | | |
| | 4. iPhone and Mac Safari | not tested | | |
| | 5. Regression on staging | not tested | | |
