#!/usr/bin/env bash
# Prepares a FRESH Ubuntu 22.04 / 24.04 server as GeoAttend STAGING. Run as root, once:
#   git clone <private repo> /opt/geoattend && cd /opt/geoattend && git checkout production-remediation
#   sudo bash deploy/staging-bootstrap.sh
# It installs Docker Engine + Compose v2 and Caddy from their official repositories, opens only SSH, 80 and
# 443, creates the folders, and writes /opt/geoattend/.env and /etc/geoattend/backup.env with new random
# secrets (chmod 600). It never overwrites an existing .env or backup.env, never starts the stack, and
# never touches any other server. NOT YET RUN: no Linux server was available (docs/STAGING.md).
set -euo pipefail

APP_DIR=/opt/geoattend
ETC_DIR=/etc/geoattend
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] || { echo "Ubuntu expected, found ${ID:-unknown}."; exit 1; }
[ -f "$APP_DIR/docker-compose.yml" ] || { echo "Clone the repository to $APP_DIR first."; exit 1; }

echo "== Packages"
apt-get update
apt-get install -y ca-certificates curl gnupg openssl ufw debian-keyring debian-archive-keyring apt-transport-https

if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

echo "== Firewall: SSH, 80, 443 only"
# Every container port in docker-compose.yml is bound to 127.0.0.1, so Docker's own iptables rules do not
# expose them; staging-verify.sh checks that from the outside view of the listening sockets.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== Folders"
# The containers run as uid 10001 (the Dockerfiles); the backup job writes here as that user.
install -d -m 0750 -o 10001 -g 10001 "$APP_DIR/data/backups"
install -d -m 0700 "$ETC_DIR"

gen() { openssl rand -hex 32; }
if [ -e "$APP_DIR/.env" ]; then
  echo "== $APP_DIR/.env exists: left unchanged"
else
  echo "== Writing $APP_DIR/.env with new secrets"
  umask 077
  while IFS= read -r line; do
    if [[ "$line" == *=GENERATE_ME ]]; then echo "${line%GENERATE_ME}$(gen)"; else echo "$line"; fi
  done < "$APP_DIR/deploy/staging.env.example" > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

if [ -e "$ETC_DIR/backup.env" ]; then
  echo "== $ETC_DIR/backup.env exists: left unchanged"
else
  echo "== Writing $ETC_DIR/backup.env"
  umask 077
  pg_admin=$(grep -E '^PG_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2-)
  sed "s#postgresql://geoattend:REPLACE_ME@#postgresql://geoattend:${pg_admin}@#" "$APP_DIR/deploy/backup.env.example" > "$ETC_DIR/backup.env"
  chmod 600 "$ETC_DIR/backup.env"
fi

echo "== Backup timer (installed, not enabled)"
install -m 0644 "$APP_DIR/deploy/geoattend-backup.service" "$APP_DIR/deploy/geoattend-backup.timer" /etc/systemd/system/
systemctl daemon-reload

cat <<EOF

Done. Still to do by hand (docs/STAGING.md):
  1. Edit $APP_DIR/.env: replace every REPLACE_ME and example.com (host names, ADMIN_EMAIL).
     grep -vE '^[[:space:]]*#' $APP_DIR/.env | grep -nE 'REPLACE_ME|example\.com'   must print nothing.
  2. Point DNS for the four host names at this server, then (edit the copy, not the repository file)
       install -m 0644 $APP_DIR/deploy/Caddyfile /etc/caddy/Caddyfile, put the names in it, systemctl reload caddy
  3. cd $APP_DIR && bash deploy/staging-deploy.sh origin/production-remediation --first
     docker compose exec api npm run db:seed -w @geoattend/api
  4. bash deploy/staging-verify.sh
  5. Fill $ETC_DIR/backup.env (off-site bucket), run the backup once, then:
       systemctl enable --now geoattend-backup.timer
EOF
