# Backup and rollback runbook

## Current environment

No production environment exists yet. The repository has no remote, and no hosting configuration or live server is recorded anywhere in it. The only environment is the development machine:

| Setting | Value |
|---|---|
| `NODE_ENV` | `development` |
| `PG_DATABASE` | `geoattend_demo` (the sample company) |
| Database | Built-in PostgreSQL 18.4, `data/pg`, port 54340; databases `geoattend` and `geoattend_demo` |
| `DEMO_MODE` | `true` |
| `COOKIE_SECURE` | `false` |
| `STORAGE_DRIVER` | `local` (`data/photos`) |
| `TRUST_PROXY` | `loopback` |
| E-mail, WhatsApp, S3 | Not configured |
| Google Maps key, VAPID keys | Set |

Treat `geoattend` as real data until told otherwise: it holds records that are not seeded by `demo:seed`.

## Git

- `main` and the tag `baseline-before-remediation` hold the code as it was before remediation.
- Remediation happens on `production-remediation`, one commit or more per phase. `main` changes only by an approved merge.
- There is no remote yet, so the repository exists only on this machine. Add a private remote before relying on it.

Roll back the code:

```
git switch production-remediation
git revert <commit>                 # undo one change, keeping history
git switch main                     # or return to the baseline completely
```

## Database backups

**Development (any platform):** `npm run db:backup:online`

Copies the running database into `data/backups/pg-online-<timestamp>/`, starts the copy on a separate port and compares row counts with the live database. The live server keeps running.

To restore one:

1. Stop the dev servers and run `npm run db:stop`.
2. Rename `data/pg` to `data/pg-replaced`. Do not delete it until the restore is checked.
3. Copy the backup folder to `data/pg`.
4. Start the servers. PostgreSQL replays the included WAL on first start.

`npm run db:backup` does not work on Windows, because the embedded package has no `pg_dump.exe`.

**Production:** provider backups with point-in-time recovery, plus `pg_dump` as described in [DEPLOYMENT.md](DEPLOYMENT.md). This has not been set up or tested.

Known defect: with `DATABASE_URL` set, `npm run db:restore` restores into the database that URL names, not the new name given. Do not use it against a real server until this is fixed (Phase C).

## Photos and secrets

- Photos: `tar -czf data/backups/photos-<date>.tar.gz -C data photos`.
- `data/backups/source-*.tar.gz` include `.env`, so they contain secrets. Treat them as confidential.
- `data/` is not in git, so **every backup listed here is on this one disk**. Copy them elsewhere for protection against disk loss.

## Before any risky migration

1. Run `npm run db:backup:online` and check that it reports a successful restore.
2. Get approval for the migration.
3. Run it against a restored copy first and compare results.
4. Keep the backup until the change has been verified in use.

Migrations have no down scripts. Rolling back a migration means restoring the backup, and data written since then is lost.
