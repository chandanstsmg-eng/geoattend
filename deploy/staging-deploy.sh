#!/usr/bin/env bash
# Deploys a Git revision to the GeoAttend STAGING server. Run from /opt/geoattend as root:
#   bash deploy/staging-deploy.sh origin/production-remediation          (or a commit or tag)
#   bash deploy/staging-deploy.sh origin/production-remediation --first  first install: no database yet, so no backup
#
# Order, and where it stops (nothing is switched until steps 1-5 pass):
#   1. clean working tree, fetch, check out <git-ref>
#   2. build the api, admin and web images, tagged with the commit
#   3. environment check with the NEW image (scripts/config-check.ts, the API's own start-up rules)
#   4. pre-deployment backup: must end RESTORE_PROVEN (skipped only with --first)
#   5. database migrations with the NEW image, while the old release still serves
#   6. switch: the commit's images become :local, and the containers are recreated
#   7. health checks, HTTPS and quick post-deployment checks (staging-verify.sh --quick)
#   8. record the release in data/deploy-history.log
# If step 6 or 7 fails: bash deploy/staging-rollback.sh (code back to the previous release).
# NEVER run against production. NOT YET RUN: no Linux server was available (docs/STAGING.md).
set -euo pipefail
cd "$(dirname "$0")/.."
REF=${1:?usage: staging-deploy.sh <git-ref> [--first]}
FIRST=${2:-}
HIST=data/deploy-history.log
step() { echo; echo "== $*"; }
die() { echo "STOPPED: $*"; exit 1; }
[ -f .env ] || die "no .env (run deploy/staging-bootstrap.sh first)"
grep -qE '^NODE_ENV=production' .env || die ".env is not a production-mode file"

step "1. Check out $REF"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "the working tree has local changes; commit or remove them first"
PREV=$(git rev-parse --short HEAD)
git fetch --quiet --all --tags
git checkout --quiet --detach "$REF"
SHA=$(git rev-parse --short HEAD)
echo "previous release $PREV, deploying $SHA ($(git log -1 --format=%s))"

step "2. Build images geoattend-*:$SHA"
GEOATTEND_TAG=$SHA docker compose build api admin web || { git checkout --quiet "$PREV"; die "build failed; nothing was switched"; }

step "3. Environment check (the new image's own rules)"
GEOATTEND_TAG=$SHA docker compose run --rm --no-deps -T api node --import tsx apps/api/scripts/config-check.ts \
  || { git checkout --quiet "$PREV"; die "fix .env; nothing was switched"; }

if [ "$FIRST" = --first ]; then
  step "4. Pre-deployment backup: skipped (--first, no database yet)"
  docker compose up -d db minio minio-init
else
  step "4. Pre-deployment backup"
  docker compose --profile backup run --rm -T backup || { git checkout --quiet "$PREV"; die "backup failed; nothing was switched"; }
  m=$(ls -t data/backups/*.manifest.json | head -n1)
  grep -q '"status": "RESTORE_PROVEN"' "$m" || { git checkout --quiet "$PREV"; die "newest backup $m is not RESTORE_PROVEN"; }
  echo "pre-deployment backup: $m"
fi

step "5. Database migrations"
GEOATTEND_TAG=$SHA docker compose run --rm -T api npm run db:migrate -w @geoattend/api \
  || die "migration failed. The old release still runs. Restore from the pre-deployment backup if a migration half-applied (docs/BACKUPS.md)"

step "6. Switch to $SHA"
for i in api admin web; do docker tag "geoattend-$i:$SHA" "geoattend-$i:local"; done
docker compose up -d --remove-orphans

step "7. Health, HTTPS and quick checks"
bash deploy/staging-verify.sh --quick || die "post-deployment checks failed: run  bash deploy/staging-rollback.sh"

step "8. Record"
mkdir -p data && echo "$(date -u +%FT%TZ) $SHA from $PREV ref=$REF" >> "$HIST"
echo "Deployed $SHA. Previous release $PREV is kept for rollback. Next: the full checks (bash deploy/staging-verify.sh) and docs/STAGING.md section 5."
