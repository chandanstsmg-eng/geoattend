# Deployment

> The Dockerfiles and `docker-compose.yml` were written for this project but **have not been built or run here** (Docker is not installed on the development machine). Build them in a test environment before relying on them.

## Production requirements

* HTTPS everywhere. Terminate TLS at a reverse proxy (Caddy, nginx, cloud load balancer) in front of the dashboard (port 3400) and the API (port 4400). The mobile app must use `https://` in production builds.
* `NODE_ENV=production`, `COOKIE_SECURE=true`, `DEMO_MODE=false` (the API refuses to start otherwise).
* Strong, unique `JWT_SECRET` and `STORAGE_SIGNING_KEY` (≥ 32 random characters) from a secret manager.
* PostgreSQL 15+ (PostGIS recommended) with TLS (`?sslmode=require`), automated backups and point-in-time recovery.
* A **private** S3-compatible bucket (block all public access) for photos; credentials limited to that bucket.
* `CORS_ORIGINS` = the dashboard origin only. `TRUST_PROXY` = the number of proxy hops (e.g. `1`) so client IPs and `https` are detected correctly. The API refuses to start in production if any required setting is missing, a placeholder, or points at localhost.
* Restrict database and object-storage ports to the private network.

## Topology options

**A. Docker Compose (single host)** — `docker compose up -d --build` starts PostGIS, MinIO (+ bucket init), API and dashboard. Then create the first admin:

```
docker compose exec api npx tsx apps/api/scripts/seed.ts
```
(uses `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`).

**B. Managed services** — API as a Node 24 service (`npx tsx apps/api/src/server.ts` from the repo root, with `DATABASE_URL` set), dashboard as a Next.js deployment (`npm run build && npm run start -w @geoattend/admin`, with `API_INTERNAL_URL` pointing at the API on the private network), managed PostgreSQL, managed object storage.

The dashboard proxies `/api/*` to the API, so the browser only ever talks to the dashboard origin. The mobile app talks to the API origin directly (`EXPO_PUBLIC_API_URL`).

Run a **single sweeper** or several: the sweeper is safe to run on multiple API instances (it re-checks state under row locks), but rate limits are per-instance in memory; for multiple instances put a shared limiter (e.g. Redis store for express-rate-limit, `docker compose --profile redis`) or rate-limit at the proxy.

## Environment

See `.env.example` for every variable with comments. Key production values:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Set it — the built-in database is for development only |
| `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` (non-AWS), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (MinIO: true) | Private bucket |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Admin browser push. Generate: `npx web-push generate-vapid-keys` |
| `SMTP_URL`, `EMAIL_FROM`, `ALERT_EMAIL_RECIPIENTS` | Optional e-mail alerts |
| `EXPO_PUSH_ENABLED=true`, `EXPO_ACCESS_TOKEN` | Optional pushes to employee devices (needs an EAS project id in the app) |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Browser key, referrer-restricted — see GOOGLE-MAPS.md. Needed at **build** time |

## Push notifications

* **Admin dashboard:** Web Push with VAPID. Each admin clicks *Notifications → Enable browser push on this device*. Requires HTTPS (localhost is exempt).
* **Employee app:** local notifications work without configuration. Remote pushes (shift closed by admin / window end) go through the Expo push service, which forwards to FCM (Android) and APNs (iOS): create an EAS project (`eas init`), configure FCM v1 credentials in EAS (`eas credentials`), set `EXPO_PUSH_ENABLED=true`.

## Object storage (S3/MinIO)

1. Create a bucket with *Block all public access*.
2. CORS on the bucket: allow `PUT` from any origin is **not** needed for the native app; add the dashboard origin for `GET` only if you serve images cross-origin.
3. The API issues pre-signed `PUT` URLs (5 min, content type and length signed) and pre-signed `GET` URLs (2 min). After upload the API re-reads the object's size and first bytes to confirm it is a real JPEG/PNG.
4. Lifecycle rule (defence in depth): expire objects older than your photo retention + 30 days.

Uploads, signed downloads, deletion, private access and outages are tested against a local SeaweedFS server (pps/api/test/s3-storage.test.ts, run with `S3_TEST_ENDPOINT`). **No cloud provider has been tested yet**; run that test against yours before launch.

## Mobile app builds

See `apps/mobile/README.md`. Summary: `eas build --profile preview --platform android` (APK for testing) / `--profile production` (AAB for Play). Background location requires a development or production build — not Expo Go — and **must be verified on real devices** (docs/TEST-PLAN.md, manual device tests). Google Play requires a background-location declaration and a prominent in-app disclosure (the app's permission explanation screen) before requesting `ACCESS_BACKGROUND_LOCATION`.

## Backups and restore

Built-in database (development):

```
npm run db:backup                                   # → data/backups/geoattend-<timestamp>.dump
npm run db:restore -- data/backups/<file>.dump geoattend_restored   # into a NEW database
```

Production: use your provider's automated backups plus periodic logical dumps:

```
pg_dump --format=custom --no-owner "$DATABASE_URL" > geoattend-$(date +%F).dump
createdb geoattend_restore && pg_restore --no-owner --dbname=geoattend_restore geoattend-YYYY-MM-DD.dump
```

Back up the photo bucket separately (versioning or replication). Test a restore at least quarterly. The restore script refuses to overwrite the live database.

## Upgrades

Migrations run automatically at API start (`schema_migrations` table) and can be run explicitly with `npm run db:migrate`. Take a backup first.
