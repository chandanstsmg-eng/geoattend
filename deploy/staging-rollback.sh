#!/usr/bin/env bash
# Returns STAGING to the previous release recorded by staging-deploy.sh. Run from /opt/geoattend as root:
#   bash deploy/staging-rollback.sh            the release before the newest one in data/deploy-history.log
#   bash deploy/staging-rollback.sh <commit>   a specific earlier release (its images must still exist)
#
# Code only. The database is never restored or changed by this script: migrations only add, so an older
# release normally runs on the newer schema. If it does not, follow docs/BACKUPS.md "Restoring after a
# loss" with the pre-deployment backup, into a NEW database, or apply docs/migrations/<NNN>_rollback.sql
# after reading it. NOT YET RUN: no Linux server was available.
set -euo pipefail
cd "$(dirname "$0")/.."
HIST=data/deploy-history.log
TARGET=${1:-}
if [ -z "$TARGET" ]; then
  [ -f "$HIST" ] || { echo "No $HIST: nothing to roll back to."; exit 1; }
  # The "from" commit of the newest release ("<time> <sha> from <previous> ref=<ref>"); rollback lines skipped.
  TARGET=$(grep -v ' ROLLBACK ' "$HIST" | tail -n1 | awk '{print $4}')
fi
for i in api admin web; do
  docker image inspect "geoattend-$i:$TARGET" >/dev/null 2>&1 || { echo "Image geoattend-$i:$TARGET is gone; rebuild with staging-deploy.sh $TARGET"; exit 1; }
done

# schema_migrations.version is the file name without .sql, e.g. 030_refresh_redelivery
newest=$(docker compose exec -T db psql -U geoattend -d geoattend -tAc 'SELECT max(version) FROM schema_migrations' | tr -d '[:space:]' | cut -c1-3)
known=$(git ls-tree --name-only "$TARGET" apps/api/src/db/migrations/ | sed -n 's#.*/\([0-9]\{3\}\)_.*#\1#p' | sort | tail -n1)
echo "database is at migration $newest; release $TARGET knows up to $known"
if [ -n "$newest" ] && [ -n "$known" ] && [ "$((10#$newest))" -gt "$((10#$known))" ]; then
  echo "NOTE: the database has migrations this release does not know. Migrations only add, so it should run;"
  echo "      if it does not, see docs/migrations/ and docs/BACKUPS.md. The database is NOT changed here."
fi

git checkout --quiet --detach "$TARGET"
for i in api admin web; do docker tag "geoattend-$i:$TARGET" "geoattend-$i:local"; done
docker compose up -d --remove-orphans
bash deploy/staging-verify.sh --quick && echo "$(date -u +%FT%TZ) ROLLBACK to $TARGET" >> "$HIST"
