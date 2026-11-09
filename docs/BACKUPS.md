# Backups and recovery (production)

Development backups of the built-in database (`db:backup:online`) are described in [RUNBOOK.md](RUNBOOK.md). This page covers production, where PostgreSQL runs as its own server.

## What runs

`npm run db:backup:production -w @geoattend/api` runs nightly from `deploy/geoattend-backup.timer`. Each run does four things:

1. **Dump.** It counts every table's rows and runs `pg_dump` in one database snapshot, so the counts describe exactly what the dump holds.
2. **Prove.** It restores the dump into a new scratch database on `BACKUP_VERIFY_DATABASE_URL` and compares every table's count. Only an exact match is `RESTORE_PROVEN`. The scratch database is then dropped; it is the only thing the script ever drops.
3. **Copy off the machine.** It uploads the dump and its manifest to `BACKUP_S3_BUCKET`, then downloads the dump again and checks its SHA-256.
4. **Keep a bounded history.** It removes off-site copies beyond the newest `BACKUP_OFFSITE_KEEP` (default 30), only after the new copy has been verified. Local copies are pruned with `npm run db:backup:prune -- --apply` (keeps `BACKUP_KEEP`, default 14).

**When a run fails.** A run that fails at any step writes a `FAILED` manifest and exits 1. The API's hourly backup check then reports the failure. If no proven backup is newer than `BACKUP_MAX_AGE_HOURS` (26 in production), an operations alert opens and is sent to `ALERT_WEBHOOK_URL` or `OPS_ALERT_EMAILS`. An alert counts as sent only when that channel accepts it.

## Settings

Put these in `/etc/geoattend/backup.env`, readable only by the backup user.

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

## Verified here, and not verified

| Check | Status |
|---|---|
| Dump in one snapshot, restore check, 52/52 tables matching, scratch database dropped | **PASS** (PostgreSQL 18.4 tools, disposable cluster) |
| Off-site upload, read-back checksum, retention keeping the newest 2 | **PASS** against a local S3-compatible server (SeaweedFS) |
| Restore of the downloaded off-site copy into a new database: counts equal to the source | **PASS** |
| Wrong off-site credentials: run recorded as `FAILED`, exit code 1 | **PASS** |
| A real off-machine bucket | **BLOCKED**: no bucket or credentials provided |
| The systemd timer on a Linux server | **BLOCKED**: no Linux server |
| An alert reaching a person | **BLOCKED**: no webhook or SMTP configured |
