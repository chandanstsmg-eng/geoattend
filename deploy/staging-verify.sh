#!/usr/bin/env bash
# Checks a running GeoAttend STAGING stack on its Linux server. Run from /opt/geoattend after
# `docker compose up -d --build` and db:seed:   bash deploy/staging-verify.sh [--with-backup]
# Each line prints PASS, FAIL or SKIP with the evidence. It restarts and stops containers of THIS stack
# only (never `down -v`, so no volume is removed), writes nothing to the database, and must never be run
# against production. NOT YET RUN: no Linux server was available (docs/STAGING.md).
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No .env here."; exit 1; }
env_get() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
API_PUBLIC=$(env_get PUBLIC_API_URL); APP_PUBLIC=$(env_get DASHBOARD_URL); OPS_TOKEN=$(env_get OPS_TOKEN)
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails + 1)); }
skip() { echo "SKIP  $*"; }
wait_health() { for _ in $(seq 1 90); do curl -fsS -m 3 http://127.0.0.1:4400/health >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
count() { docker compose exec -T db psql -U geoattend -d geoattend -tAc "SELECT (SELECT count(*) FROM users)||'/'||(SELECT count(*) FROM attendance_records)||'/'||(SELECT max(version) FROM schema_migrations)" 2>/dev/null | tr -d '[:space:]'; }

echo "== 1. Configuration"
docker compose config -q && pass "docker compose config parses with every required variable set" || fail "docker compose config"
grep -nE 'REPLACE_ME|GENERATE_ME|example\.com' .env >/dev/null && fail ".env still has placeholders: grep -nE 'REPLACE_ME|GENERATE_ME|example\\.com' .env" || pass ".env has no placeholders"
[ "$(stat -c %a .env)" = 600 ] && pass ".env is chmod 600" || fail ".env permissions are $(stat -c %a .env), expected 600"
grep -qE '^PAYROLL_ENABLED=false' .env && pass "payroll stays off" || fail "PAYROLL_ENABLED is not false"

echo "== 2. Containers and health"
wait_health && pass "API /health answers on 127.0.0.1:4400" || fail "API /health did not answer within 3 minutes"
for s in db api admin web minio; do
  st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$(docker compose ps -q $s)" 2>/dev/null)
  [[ "$st" = healthy || "$st" = running ]] && pass "$s is $st" || fail "$s is '${st:-missing}'"
done
docker compose exec -T api /usr/lib/postgresql/17/bin/pg_dump --version | grep -q ' 17\.' && pass "pg_dump 17 in the API image" || fail "pg_dump 17 missing from the API image"

echo "== 3. Only 22, 80 and 443 face the network"
exposed=$(ss -ltnH | awk '{print $4}' | grep -vE '^(127\.0\.0\.1|\[::1\]):' | grep -E ':(5432|9000|9001|4400|3400|3500|6379)$' || true)
[ -z "$exposed" ] && pass "database, MinIO, API, dashboard and website listen on loopback only" || fail "exposed: $exposed"
command -v ufw >/dev/null && ufw status | grep -q 'Status: active' && pass "ufw active" || fail "ufw not active"

echo "== 4. HTTPS through Caddy"
if [[ "$API_PUBLIC" == https://* ]]; then
  curl -fsS -m 10 "$API_PUBLIC/health" >/dev/null && pass "$API_PUBLIC/health over a trusted certificate" || fail "$API_PUBLIC/health"
  curl -fsS -m 10 -o /dev/null "$APP_PUBLIC/login" && pass "$APP_PUBLIC/login" || fail "$APP_PUBLIC/login"
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://${APP_PUBLIC#https://}/login")
  [[ "$code" =~ ^30[178]$ ]] && pass "plain http redirects to https ($code)" || fail "plain http answered $code"
  curl -sI -m 10 "$APP_PUBLIC/login" | grep -qi '^strict-transport-security' && pass "HSTS header present" || fail "no Strict-Transport-Security header"
else skip "PUBLIC_API_URL is not https"; fi

echo "== 5. Monitoring endpoint"
if [ -n "$OPS_TOKEN" ]; then
  body=$(curl -s -m 10 -H "Authorization: Bearer $OPS_TOKEN" http://127.0.0.1:4400/api/v1/ops/health)
  [ -n "$body" ] && pass "ops health answers: $(echo "$body" | head -c 300)" || fail "ops health gave nothing"
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:4400/api/v1/ops/health)
  [[ "$code" = 401 || "$code" = 403 || "$code" = 404 ]] && pass "ops health refuses a request without the token ($code)" || fail "ops health without token answered $code"
else skip "OPS_TOKEN not set"; fi

echo "== 6. Graceful shutdown (SIGTERM)"
start=$(date +%s); docker compose stop api >/dev/null 2>&1; took=$(( $(date +%s) - start ))
code=$(docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -aq api)")
docker compose logs --no-color --since 2m api 2>/dev/null | grep -q 'SIGTERM received' && pass "API logged 'SIGTERM received'" || fail "no SIGTERM log line"
[ "$code" = 0 ] && pass "API exited 0 after ${took}s (stop grace 30 s)" || fail "API exit code $code after ${took}s (137 means it was killed)"
docker compose start api >/dev/null && wait_health && pass "API back after start" || fail "API did not come back"

echo "== 7. Crash recovery (SIGKILL from the host, restart policy)"
before=$(count)
kill -9 "$(docker inspect -f '{{.State.Pid}}' "$(docker compose ps -q api)")"
sleep 3
wait_health && pass "API restarted by Docker after a kill -9" || fail "API not restarted after kill -9"
[ "$(count)" = "$before" ] && pass "data unchanged after the crash (users/attendance/migration $before)" || fail "counts changed: $before -> $(count)"

echo "== 8. Persistence across down/up (volumes kept)"
before=$(count)
docker compose down >/dev/null 2>&1 && docker compose up -d >/dev/null 2>&1
wait_health && [ "$(count)" = "$before" ] && pass "same data after down/up ($before)" || fail "after down/up: $before -> $(count)"

echo "== 9. Backup"
if [ "${1:-}" = --with-backup ]; then
  if docker compose --profile backup run --rm backup; then
    m=$(ls -t data/backups/*.manifest.json 2>/dev/null | head -n1)
    grep -q '"RESTORE_PROVEN"' "$m" && pass "backup RESTORE_PROVEN: $m" || fail "newest manifest $m is not RESTORE_PROVEN"
    grep -q '"offsite"' "$m" && pass "off-site copy verified by checksum" || fail "no off-site copy (BACKUP_S3_BUCKET empty?)"
  else fail "backup run exited non-zero (see the output above; a FAILED manifest was written)"; fi
else skip "backup (run again with --with-backup once /etc/geoattend/backup.env is filled)"; fi

echo
[ "$fails" = 0 ] && echo "ALL CHECKS PASSED" || echo "$fails CHECK(S) FAILED"
exit $(( fails > 0 ))
