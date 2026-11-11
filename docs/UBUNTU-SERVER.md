# Ubuntu 24.04 LTS server for GeoAttend

Exact steps to turn a **new, empty** Ubuntu 24.04 LTS server into a GeoAttend staging (or later production) host. It assumes nothing exists yet. Do every step in order; each ends with a check. After section 8, continue with [STAGING.md](STAGING.md) section 2.

**Not yet run on a real server** (9 November 2026). Record any difference you meet, and fix this page.

## 0. What to have ready

| Item | Detail |
|---|---|
| Server | Ubuntu Server 24.04 LTS, 64-bit. At least 2 vCPU, 4 GB RAM, 40 GB SSD; a fixed public IPv4 address. A cloud VM in India (Mumbai or Hyderabad region) keeps latency low |
| Domain | One you control, with access to its DNS records |
| Your computer | An SSH client (Windows 11 has `ssh` built in) |
| Separate staging | Its own server, its own secrets and buckets. Never reuse production credentials |

## 1. First login and updates

From your computer, with the address and initial user the provider gave you:

```bash
ssh root@<server-ip>          # or: ssh ubuntu@<server-ip>
apt update && apt full-upgrade -y
timedatectl set-timezone UTC          # the app stores UTC and converts per company
timedatectl                            # check: "System clock synchronized: yes"
reboot
```

## 2. An administrator account with an SSH key

On **your computer**, create a key if you do not have one, and keep its passphrase safe:

```bash
ssh-keygen -t ed25519 -C "geoattend-admin"
```

On the **server** (as root), create the admin user and give it the key:

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
nano /home/deploy/.ssh/authorized_keys    # paste the ONE line from your id_ed25519.pub
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
passwd deploy                              # a strong password, needed for sudo only
```

**Check, in a NEW terminal, before going on:** `ssh deploy@<server-ip>` logs in with the key, and `sudo -v` works. Keep the root session open until it does.

## 3. Lock down SSH

```bash
sudo tee /etc/ssh/sshd_config.d/10-geoattend.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowUsers deploy
EOF
sudo sshd -t && sudo systemctl reload ssh
```

**Check, in a new terminal:** `ssh deploy@<server-ip>` still works; `ssh root@<server-ip>` is refused; `ssh -o PubkeyAuthentication=no deploy@<server-ip>` is refused.

Also:

```bash
sudo apt install -y unattended-upgrades fail2ban
sudo dpkg-reconfigure -plow unattended-upgrades     # answer Yes: security updates install themselves
sudo systemctl enable --now fail2ban                 # bans addresses that keep failing SSH logins
```

## 4. Get the code

The repository is private, so the server needs read-only access. Use a GitHub **deploy key** (read-only) and never your personal key:

```bash
sudo -u root ssh-keygen -t ed25519 -f /root/.ssh/geoattend_deploy -N ""
sudo cat /root/.ssh/geoattend_deploy.pub     # add it in GitHub → repository → Settings → Deploy keys (read only)
sudo tee -a /root/.ssh/config >/dev/null <<'EOF'
Host github.com
  IdentityFile /root/.ssh/geoattend_deploy
  IdentitiesOnly yes
EOF
sudo git clone git@github.com:<owner>/<repository>.git /opt/geoattend
cd /opt/geoattend && sudo git checkout production-remediation
```

**Check:** `ls /opt/geoattend/docker-compose.yml` exists.

## 5. Firewall, Docker Engine, Compose and Caddy

One script does this, from the official Docker and Caddy repositories (it never overwrites existing files and never starts the application):

```bash
cd /opt/geoattend && sudo bash deploy/staging-bootstrap.sh
```

What it does, if you prefer to do it by hand:

| Step | Command it runs |
|---|---|
| Firewall | `ufw allow OpenSSH; ufw allow 80/tcp; ufw allow 443/tcp; ufw --force enable` |
| Docker Engine and Compose v2 | Docker's apt repository for `noble`, then `apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin` |
| Caddy | Caddy's apt repository, then `apt install caddy` |
| Folders | `/opt/geoattend/data/backups` owned by uid 10001 (the containers' user), mode 750; `/etc/geoattend` mode 700 |
| Secrets | `/opt/geoattend/.env` from `deploy/staging.env.example`, every `GENERATE_ME` replaced by `openssl rand -hex 32`, mode 600; `/etc/geoattend/backup.env` from `deploy/backup.env.example`, mode 600 |
| Backup timer | Copies the unit files to `/etc/systemd/system/`; does **not** enable them |

**Checks:**

```bash
sudo ufw status verbose                 # active; 22, 80, 443 only
docker --version && docker compose version
caddy version
sudo ls -l /opt/geoattend/.env /etc/geoattend/backup.env    # -rw------- root root
```

**Docker and the firewall.** Docker writes its own iptables rules, and they bypass ufw for **published** ports. That is why every port in `docker-compose.yml` is bound to `127.0.0.1`. Never change a port line to `"5432:5432"` or `"0.0.0.0:…"`. `deploy/staging-verify.sh` checks this from the server's listening sockets.

Do not add the `deploy` user to the `docker` group: membership is equivalent to root. Run Docker commands with `sudo`.

## 6. DNS

At your DNS provider, create these records for the staging server, with a TTL of 300 seconds while setting up:

| Name | Type | Value | Used for |
|---|---|---|---|
| `app.staging.<domain>` | A | `<server-ip>` | Dashboard (`DASHBOARD_URL`, `CORS_ORIGINS`) |
| `api.staging.<domain>` | A | `<server-ip>` | API and phone app (`PUBLIC_API_URL`, `EXPO_PUBLIC_API_URL`) |
| `photos.staging.<domain>` | A | `<server-ip>` | Signed photo links (`S3_PUBLIC_ENDPOINT`) |
| `staging.<domain>` | A | `<server-ip>` | Public website (`NEXT_PUBLIC_SITE_URL`) |
| `<domain>` | CAA | `0 issue "letsencrypt.org"` | Optional: only Let's Encrypt may issue certificates |

Add AAAA records only if the server has IPv6 and port 80/443 are open on it.

**Check:** `dig +short app.staging.<domain>` (or `nslookup`) returns the server's address for all four names, before section 7.

## 7. HTTPS and the reverse proxy

Caddy obtains and renews Let's Encrypt certificates itself; it needs ports 80 and 443 open and the DNS of section 6.

```bash
# Edit the COPY in /etc/caddy, never the file in the repository: deploy scripts refuse a checkout with local changes.
sudo install -m 0644 /opt/geoattend/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/app\.example\.com/app.staging.<domain>/; s/api\.example\.com/api.staging.<domain>/; s/photos\.example\.com/photos.staging.<domain>/; s/www\.example\.com, example\.com/staging.<domain>/' /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

`deploy/Caddyfile` proxies:
- the dashboard to `127.0.0.1:3400`;
- the API to `127.0.0.1:4400`, without buffering, so live updates stream;
- photos to MinIO on `127.0.0.1:9000`, with a 10 MB upload cap;
- the website to `127.0.0.1:3500`.

Caddy replaces any `X-Forwarded-For` a browser sends. That is why `TRUST_PROXY=1` (one proxy) is right for this layout.

**Check, once the stack runs (section 8):** `curl -I https://api.staging.<domain>/health` shows `HTTP/2 200` with no certificate warning, and `curl -I http://app.staging.<domain>` redirects to https.

## 8. Environment variables and secrets

Edit `/opt/geoattend/.env` (`sudo nano /opt/geoattend/.env`):
1. Replace every `REPLACE_ME` and `example.com` with the staging names of section 6, and set `ADMIN_EMAIL`.
2. Leave every integration value empty until a real credential exists. The comments in the file explain each format.
3. Never paste a secret into a chat, a ticket or Git. The repository ignores `.env`, and `.dockerignore` keeps it out of images.

Secrets live in two files only, both `root:root`, mode 600:
- `/opt/geoattend/.env`;
- `/etc/geoattend/backup.env`.

The Google Maps key is the one value that is public by design, because it is built into the dashboard. Restrict it in Google Cloud as the comments describe.

**Checks:**

```bash
sudo grep -vE '^[[:space:]]*#' /opt/geoattend/.env | grep -nE 'REPLACE_ME|GENERATE_ME|example\.com'   # prints nothing
cd /opt/geoattend && sudo docker compose config -q                                                 # prints nothing
```

Then deploy for the first time:

```bash
sudo bash deploy/staging-deploy.sh origin/production-remediation --first
sudo docker compose exec api npm run db:seed -w @geoattend/api    # first administrator from ADMIN_EMAIL / ADMIN_PASSWORD
sudo bash deploy/staging-verify.sh                                 # full checks, including restart and crash recovery
```

Remove `ADMIN_PASSWORD` from `.env` after you have signed in and changed it. Continue with [STAGING.md](STAGING.md) section 2 onwards: backups, integrations, devices and the regression.

## 9. Keeping it running

| Task | How |
|---|---|
| New release | `sudo bash deploy/staging-deploy.sh origin/production-remediation`: backup, checks, migration, switch, verification |
| Undo a release | `sudo bash deploy/staging-rollback.sh` |
| Logs | `sudo docker compose logs --since 1h api` (rotated: 5 × 20 MB per container) |
| Disk | `df -h /` and `sudo docker system df`. Alert yourself at 80 % in your provider's monitoring; the app does not watch the disk |
| Old images | `sudo docker image prune` keeps tagged releases; remove release tags older than the last three by hand |
| OS updates | Automatic for security updates. Reboot during a quiet hour when `/var/run/reboot-required` exists; containers restart by themselves |
