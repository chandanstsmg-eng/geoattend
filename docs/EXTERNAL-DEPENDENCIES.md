# External dependencies

What GeoAttend needs from outside this repository before launch, and what has really been tested. Last updated 4 Nov 2026.

| Dependency | State | Needed from the business |
|---|---|---|
| Cloud S3 bucket | **Never tested.** Only a local SeaweedFS server | A bucket, credentials, a test run |
| Docker deployment | **Never built.** Docker is not installed on the development machine. `docker/db-init` has never run | A machine with Docker |
| Real PostgreSQL server | **Not tried.** Non-superuser logins are tested on the embedded server only; a logical dump and restore has never run | A test server with client tools |
| Job alerts | Alerts, `/api/v1/ops/health` and the webhook sender exist, tested against a local server only; **nothing is watching them** | A monitoring service polling `/api/v1/ops/health`, an `ALERT_WEBHOOK_URL` or `OPS_ALERT_EMAILS`, and someone to alert |
| Backup monitoring | Works for backups made by this project's scripts | `BACKUP_DIR` on the server, a scheduled backup that writes a manifest, and copies off the machine. A provider's backups need the provider's own alerts |
| Google Maps | **Key never exercised.** Local test port was refused by the key's referrer rule | A production key restricted to the real domain |
| GitHub | **No remote.** CI file exists and has never run on GitHub | A private repository |
| Android phones | **No real phone tested** | Xiaomi, Oppo and Vivo phones, plus the Phase D test plan |
| Legal review | **Not done** | Review of photo retention, Privacy and Terms |

Nothing below may be reported as working until its "Done when" check has passed on the real service.

## S3 photo storage

The API talks to any S3-compatible service through the AWS SDK.

Bucket:

- Private, with all public access blocked. Photos are only reached through short-lived signed links.
- Server-side encryption on. Versioning or replication on, because the photos are backed up separately from the database.
- No lifecycle rule that expires objects: photos must not disappear without the application knowing, and automatic deletion is on hold (see Photo retention).
- CORS: the phone app uploads natively and needs none. The dashboard shows photos through signed `GET` links in `<img>` tags, which also need none. Add a rule only if a browser reports a CORS error, and then only `GET` from the dashboard origin.

Credentials, limited to this one bucket:

- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::<bucket>/*`. `HeadObject` uses `s3:GetObject`. On AWS, also grant `s3:ListBucket` on the bucket: without it a missing object answers 403 instead of 404, and the API then reports storage as unavailable instead of "photo not uploaded".

Settings:

| Variable | Value |
|---|---|
| `STORAGE_DRIVER` | `s3` (production refuses `local`) |
| `S3_BUCKET`, `S3_REGION` | The bucket and its region |
| `S3_ENDPOINT` | Empty for AWS; the provider's address otherwise |
| `S3_PUBLIC_ENDPOINT` | The address phones and browsers reach, if different from `S3_ENDPOINT`; signed links are made for it |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | From a secret manager, never in the repository |
| `S3_FORCE_PATH_STYLE` | `true` for MinIO and SeaweedFS, `false` for AWS |
| `PHOTO_ORIGIN` | The photo address, set at dashboard build time so its content security policy allows the images |

Tested so far, on SeaweedFS only: upload, confirmation against the bucket, signed downloads, deletion, private access, outage answers 503.

Done when `apps/api/test/s3-storage.test.ts` passes against the real bucket:

```
S3_TEST_ENDPOINT=<address> S3_TEST_BUCKET=<a separate test bucket> S3_TEST_ACCESS_KEY=<key> S3_TEST_SECRET_KEY=<secret> npm test -w @geoattend/api
```

Then upload from a real phone and see the photo in the dashboard.

## Docker deployment

`docker-compose.yml` defines `db` (PostGIS 17), `minio`, `redis`, `api`, `admin`, `web`, and the nightly `backup` job, which starts only through its profile. It stops with a clear message if a required variable is missing. The Dockerfiles were corrected in Phase C and again in Phase I, when the API image got `pg_dump` 17 for the version 17 server. **No image has ever been built.** The server procedure and its checks are in [STAGING.md](STAGING.md).

Requirements:

- Docker Engine with Compose v2. Memory has not been measured: check it during the first build and under load, since face checking loads a model in the API.
- HTTPS in front of the API, dashboard and website. `TRUST_PROXY` must equal the real number of proxies.
- Required variables: `PG_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_ENDPOINT`, `PUBLIC_API_URL`, `DASHBOARD_URL`, `CORS_ORIGINS`, `TRUST_PROXY`, `NEXT_PUBLIC_SITE_URL`, plus `JWT_SECRET` and `STORAGE_SIGNING_KEY`. The API refuses to start in production on placeholders or localhost addresses.
- Dashboard and website addresses are fixed at build time, so images are built per environment.
- Only 80 and 443 reachable from outside. Database, MinIO and Redis stay internal.
- A managed database or a tested backup job, with backups stored off the machine.

Done when `docker compose up -d --build` starts everything on a clean host, `/health` answers, the first owner can sign in, a photo can be uploaded, and a backup taken there has been restored.

## Google Maps

See [GOOGLE-MAPS.md](GOOGLE-MAPS.md).

- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`: a browser key for the Maps JavaScript API and Places. It is visible in the browser by design, so restrict it by HTTP referrer to the dashboard domain and to those two APIs only.
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`: optional, for Advanced Markers styling.
- A billing account with a budget alert.

The dashboard falls back to its own schematic map. Testing so far ran on a port the key refuses, so **the real map has not been seen working**.

Done when, on the production domain, the live map loads with no console error and place search finds an address.

## GitHub

`.github/workflows/ci.yml` runs build, typecheck and tests for the API, dashboard and website, and typecheck and tests for the mobile app, on `main` and `production-remediation`. The same steps pass on a fresh local clone, but that is not a GitHub run.

Needed:

- A **private** repository. Push `main`, `production-remediation`, the phase branches and the tag `baseline-before-remediation`.
- Branch protection on `main`: pull request and passing CI required.
- A check of Git history for secrets before the first push.
- For the optional S3 tests in CI, the `S3_TEST_*` values as repository secrets, using a separate test bucket.

Done when a push shows a green CI run on GitHub.

## Physical Android testing

No real phone has run this version. The test requires:

- Xiaomi (MIUI/HyperOS), Oppo (ColorOS) and Vivo (Funtouch/OriginOS), on the Android versions customers use, plus one stock Android phone. These brands stop background apps aggressively, which is the main risk to tracking.
- A signed build from EAS, with `EXPO_PUSH_ENABLED` and an Expo access token for push.
- A real workplace with a geofence, and a tester walking in and out.

The full steps and a results sheet are in [ANDROID-DEVICE-TEST-PLAN.md](ANDROID-DEVICE-TEST-PLAN.md).

Offline operation must not be claimed until these pass (Phase D).

Done when a signed test report exists per phone, with model, Android version and result.

## Legal review

Needs a qualified person:

- Photo and location retention periods, and face data, under India's Digital Personal Data Protection Act and any other law that applies.
- The privacy notice shown to employees. Companies that saved their own notice text must check its wording themselves: it may still say photos are deleted automatically.
- Privacy Policy and Terms for the website.

### Photo retention

Each company's owner sets the photo period in Settings. Automatic deletion is **on hold**: nothing deletes employee photos on its own, including photos past their date, abandoned uploads and matched face-check selfies. Only an owner can delete a photo by hand, with a reason, and that is audited.

To lift the hold after the review, both must be on:

1. `PHOTO_AUTO_DELETE_ENABLED=true` on the server.
2. "Delete attendance photos automatically" in the company's Settings.

The next hourly run then deletes every photo past its date, including older ones. Take a backup of the bucket first. "Run retention now" shows how many photos are waiting.

Location history and notifications are still deleted on their own periods; the hold covers photos only.
