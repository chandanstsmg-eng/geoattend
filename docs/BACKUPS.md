# Backups and recovery (production)

Development backups of the built-in database (`db:backup:online`) are described in [RUNBOOK.md](RUNBOOK.md). This page covers production, where PostgreSQL runs as its own server.

## What runs

`npm run db:backup:production -w @geoattend/api` runs nightly from `deploy/geoattend-backup.timer`. On the Docker Compose stack, the timer runs it as the `backup` service, `docker compose --profile backup run --rm backup`. That service uses the API image, which carries `pg_dump` 17, and writes to `data/backups`. The API mounts the same folder read-only for its hourly check. Each run does four things:

1. **Dump.** It counts every table's rows and runs `pg_dump` in one database snapshot, so the counts describe exactly what the dump holds.
2. **Prove.** It restores the dump into a new scratch database on `BACKUP_VERIFY_DATABASE_URL` and compares every table's count. Only an exact match is `RESTORE_PROVEN`. The scratch database is then dropped; it is the only thing the script ever drops.
3. **Copy off the machine.** It uploads the dump and its manifest to `BACKUP_S3_BUCKET`, then downloads the dump again and checks its SHA-256.
4. **Keep a bounded history.** It removes off-site copies beyond the newest `BACKUP_OFFSITE_KEEP` (default 30), only after the new copy has been verified. Local copies are pruned with `npm run db:backup:prune -- --apply` (keeps `BACKUP_KEEP`, default 14).

**When a run fails.** A run that fails at any step writes a `FAILED` manifest and exits 1. The API's hourly backup check then reports the failure. If no proven backup is newer than `BACKUP_MAX_AGE_HOURS` (26 in production), an operations alert opens and is sent to `ALERT_WEBHOOK_URL` or `OPS_ALERT_EMAILS`. An alert counts as sent only when that channel accepts it.

## Settings

Put these in `/etc/geoattend/backup.env`, chmod 600; the template is `deploy/backup.env.example`. On the Compose stack, `docker-compose.yml` sets `DATABASE_URL`, `PG_BIN` and `BACKUP_DIR` itself. Test the off-site bucket before the first run with `npm run integrations:check -w @geoattend/api -- --only offsite`.

| Setting | What it is |
|---|---|
| `DATABASE_URL` | The production database (the owner login) |
| `PG_BIN` | Folder with `pg_dump` and `pg_restore` of the **same major version as the server**, or newer |
| `BACKUP_DIR` | Local folder for dumps and manifests |
| `BACKUP_VERIFY_DATABASE_URL` | A login that may create databases, ideally on **another** PostgreSQL server. The owner login cannot create databases |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ENDPOINT` (non-AWS), `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_FORCE_PATH_STYLE`, `BACKUP_S3_PREFIX` | Off-site storage. Use a bucket in another account or provider from the servers, with versioning or object lock, and credentials that can only write to that prefix |
| `BACKUP_OFFSITE_KEEP` | Off-site dumps to keep |

**Photos are not in the database dump.** Protect the photo bucket separately with versioning or replication, and never set a lifecycle rule that expires objects ([DEPLOYMENT.md](DEPLOYMENT.md)).

## Recovery point and recovery time

| | Value | Basis |
|---|---|---|
| Recovery point (data that can be lost) | Up to 24 hours with nightly dumps alone | Lower it with the database provider's point-in-time recovery, or by running the backup more often |
| Recovery time (to a working database) | Measured on 9 November 2026: a 2.3 MB dump downloaded from storage and restored in about 2 s, with every table's count matching | Real companies will be larger; measure on staging with production-sized data |

## Restoring after a loss

1. **Stop the API and worker,** so nothing writes during the restore.
2. **Get the dump.** Download the newest off-site dump whose manifest says `RESTORE_PROVEN`, and check its SHA-256 against the manifest.
3. **Restore into a new database:** `createdb geoattend_restored`, then `pg_restore --no-owner --exit-on-error --dbname=…/geoattend_restored <file>`. Create the `geoattend_tenant` role first if the server lacks it (see [COMPANY-ISOLATION.md](COMPANY-ISOLATION.md)). Never restore over a database that exists.
4. **Check the data.** Compare row counts with the manifest's figures, then open the dashboard with a test owner.
5. **Switch over.** Point `DATABASE_URL` and `APP_DATABASE_URL` at the restored database and start the API. Migrations run on start; a restored backup from before a migration is brought up to date.
6. **Record it.** Note the time of the backup used, and tell the companies affected about any lost hours.

## Recovery drill on a Windows development machine

This is the procedure that was run on 11 November 2026. Use it before trusting a new backup. It never restores over a database: the restore goes to a new database on a separate, throw-away PostgreSQL cluster.

1. **Fingerprint the existing backups.** Record the size and SHA-256 of every file in `data/backups`, so you can show afterwards that nothing was overwritten.
2. **Take the backup.**
   ```
   set PG_BIN=<folder with pg_dump/pg_restore 18.x>
   set DATABASE_URL=postgresql://<owner>@127.0.0.1:54340/geoattend_demo
   npm run db:backup -w @geoattend/api
   ```
   `pg_dump` only reads the database. The new `geoattend-<time>.dump` and its `.manifest.json`, which holds the size and SHA-256, get a new timestamped name, so an existing file is never replaced.
3. **Check the checksum independently.** Run `Get-FileHash <dump> -Algorithm SHA256`; it must equal `files[0].sha256` in the manifest. Then run `npm run db:backup:verify -w @geoattend/api`.
4. **Restore into a new database on a throw-away cluster.** Leave `DATABASE_URL` unset.
   ```
   set DATA_DIR=D:\gbk
   set PG_PORT=54362
   npm run db:restore -w @geoattend/api -- <dump> geoattend_restore_drill
   ```
   The command refuses a target that already exists.
5. **Compare.** Compare every table's row count and a fingerprint of all its rows with the source, reading the source in a read-only transaction. Also compare migrations, policies, foreign keys, indexes, views and triggers.
6. **Confirm nothing was overwritten.** Fingerprint the backup folder again: the only change must be the new dump and its manifest.

**Result on 11 November 2026, for the dev database `geoattend_demo`:**
- **Backup:** a 2.5 MB dump in 3 s, with status `READABLE`. The SHA-256 computed independently equals the manifest's (`c899e7d4…4c8b6b`).
- **Restore:** 10 s.
- **Tables:** 50 of 52 are identical in every row. The other 2 are the job scheduler's own tables, `job_runs` and `job_state`, which the running dev server kept writing after the dump. All 26,459 `job_runs` rows from before the dump are identical. The 50 rows started after the dump, and the newer `job_state` times and counters, are the only differences.
- **Structure:** identical. Migration 030, 45 isolation policies, 116 foreign keys (all validated), 156 indexes, 2 views and 6 triggers.
- **Existing backups:** all 25 earlier items unchanged.
- **Live database:** `geoattend` was not read by the backup, and is still at migration 020.

**The 9 old backups without manifests** are `pg-online-*` folders from 4–5 November, taken before manifests existed. They have not been checked and are kept as they are; nothing was deleted. They are older than the backups verified since.

## Verified here, and not verified

| Check | Status |
|---|---|
| Dump in one snapshot, restore check, 52/52 tables matching, scratch database dropped | **PASS** (PostgreSQL 18.4 tools, disposable cluster) |
| Off-site upload, read-back checksum, retention keeping the newest 2 | **PASS** against a local S3-compatible server (SeaweedFS) |
| Restore of the downloaded off-site copy into a new database: counts equal to the source | **PASS** |
| Wrong off-site credentials: run recorded as `FAILED`, exit code 1 | **PASS** |
| **PostgreSQL 17** (the Docker server's version), with the 17.6 client tools: logins from `docker/db-init`, migrations up to date, `db:backup:production` RESTORE_PROVEN 52/52, off-site copy verified, downloaded copy's SHA-256 equal, restored into a separate database with identical counts (49 users, 2,886 attendance records, migration 030) | **PASS** (disposable 17.6 server, 9 Nov 2026) |
| Tools older than the server (pg_dump 17.6 against a PostgreSQL 18 server) | **PASS**: refused with "server version mismatch", run recorded `FAILED`, exit 1. So the API image must carry the server's major version: it installs `postgresql-client-17` |
| Fresh development backup: SHA-256 checked independently, restored on a separate cluster, every table and the structure compared with the source, no earlier backup changed | **PASS** (11 Nov 2026, see the drill above) |
| A real off-machine bucket | **BLOCKED**: no bucket or credentials provided |
| The systemd timer on a Linux server | **BLOCKED**: no Linux server |
| An alert reaching a person | **BLOCKED**: no webhook or SMTP configured |
