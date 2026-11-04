# GeoAttend

GPS-geofenced employee attendance, shift-scoped live tracking and workforce alerts.

* **Admin dashboard** (`apps/admin`, Next.js 16): self-signup for new companies with a getting-started checklist; owners and site supervisors; one approvals inbox (leave, attendance requests, new phones) with escalation to owners; daily close and "needs attention" patterns; workplaces and geofences on Google Maps, employees (CSV/Excel import, one approved phone each), shifts, holidays; a live workforce map with phone battery and network, day replay; attendance with photo review, liveness instruction and face check; tasks with photo proof; messages with read receipts; SOS alerts; hours, overtime, monthly summary and payroll with payslips; WhatsApp / e-mail daily summaries; notifications, CSV reports, audit log, settings and a demo simulator.
* **API** (`apps/api`, Node 24 + Express 5 + PostgreSQL): multi-company (each company's data kept separate, checked for every route by `test/tenancy.test.ts`), server-validated attendance state machine, geofence evaluation, absence, interruption and no-show detection, leave and holidays, phone binding, worked time and overtime, payroll, tasks, SOS, broadcasts, digests, face check (optional Amazon Rekognition), notifications (in-app, SSE, web push, e-mail, Expo push), private photo storage, retention, OpenAPI.
* **Employee app** (`apps/mobile`, Expo SDK 58 + Expo Router): sign-in, workplace map, shift start with permission explanation, background location with a foreground service, offline queue, camera attendance after verified arrival (with an anti-spoof instruction and a receipt number), phone health check, absence warnings, "my rules", leave, tasks, messages, SOS, earnings and payslips, history, privacy notice. See [apps/mobile/README.md](apps/mobile/README.md).
* **Public website** (`apps/web`, Next.js 16): English and Hindi product site on port 3500.

The server is the source of truth. Client GPS is treated as untrusted evidence. Tracking only runs during a shift the employee explicitly starts, and the app shows it is running.

## Quick start (Windows, macOS, Linux — no Docker needed)

Requires Node.js 20.19+ (24 recommended).

```bash
npm install
npm run setup     # creates .env with generated secrets, starts the built-in PostgreSQL, migrates, seeds
npm run dev       # API on http://localhost:4400, dashboard on http://localhost:3400
```

`npm run setup` prints the administrator password and the demo password. They are stored in `.env` (`ADMIN_PASSWORD`, `DEMO_PASSWORD`).

| Account | Email (username) | Password (development) |
|---|---|---|
| Administrator (dashboard) | `admin@geoattend.local` | `Admin@2026` |
| Demo administrator (dashboard) | `demo.admin@example.test` | `Demo@12345` |
| Demo employees (mobile app) | `demo.asha@example.test`, `demo.vikram@example.test`, `demo.meera@example.test` | `Demo@12345` |

These are development-only passwords (`ADMIN_PASSWORD` and `DEMO_PASSWORD` in `.env`). To change them, edit `.env` and run `npm run set-logins`. Passwords need at least 10 characters including letters and digits. Use strong, unique passwords in production, where demo mode is refused.

All demo people and the "Demo Workplace (fictional)" are fictional and marked as demo. Simulated data is labelled **SIMULATED** throughout the dashboard.

### See it work in two minutes (demo mode)

1. Sign in at http://localhost:3400, open **Demo Simulator**.
2. For Asha: **Start shift**, then **Move outside geofence**. The dashboard shows "You are N metres away. Attendance unlocks within 30 metres."
3. **Move inside geofence**, then **Simulate successful attendance**. Asha becomes Present.
4. **Move outside geofence** (a departure), then **Advance absence timer +15 min**. Asha moves to Prolonged absence and a critical alert appears.
5. **Move inside geofence** (a return), then **Simulate tracking interruption**, then **End shift**.
6. Watch **Overview**, **Live Workforce Map** and **Notifications** update live. Use **Reset demo data** to replay.

The simulator runs the same engine and rules as real devices. It advances a per-session virtual clock instead of making you wait, and uses a synthetic striped image in place of a camera photo.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API (watch mode) + dashboard (dev server) |
| `npm run build` then `npm start` | Production build and start of both |
| `npm test` | All automated tests (52: geodesy, state machine, HTTP API against a throw-away database) |
| `npm run typecheck` | TypeScript across shared, API and dashboard |
| `npm run db:migrate` / `npm run db:seed` | Apply migrations / seed (idempotent) |
| `npm run db:backup` / `npm run db:restore -- <file> <newdb>` | pg_dump backup / restore into a new database |
| `npm run db:stop` | Stop the built-in PostgreSQL (it keeps running after the API stops, by design) |
| `npm run openapi -w @geoattend/api` | Regenerate `docs/openapi.json` |

API documentation: http://localhost:4400/api/docs (Swagger UI), with the spec at `/api/v1/openapi.json`.

## Repository layout

```
geoattend/
├─ apps/
│  ├─ api/          REST API, migrations, scripts, tests, Dockerfile
│  ├─ admin/        Next.js dashboard, Dockerfile
│  └─ mobile/       Expo employee app (standalone install)
├─ packages/shared/ geodesy, geofence classification, states (used by API + dashboard)
├─ docs/            architecture, test plan, deployment, Google Maps, privacy, troubleshooting, openapi.json
├─ docker-compose.yml   PostGIS + MinIO + API + dashboard (+ optional Redis)
└─ .env.example
```

## Documentation

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, state machine, data model, security
* [docs/TEST-PLAN.md](docs/TEST-PLAN.md): the 20 required scenarios with expected results, plus manual device tests
* [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): production setup, HTTPS, storage, push, mobile builds, backups
* [docs/GOOGLE-MAPS.md](docs/GOOGLE-MAPS.md): API keys and what works without them
* [docs/PRIVACY.md](docs/PRIVACY.md): transparency and compliance design, and what you must still decide
* [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
* [docs/STATUS.md](docs/STATUS.md): what is implemented and verified, and what still needs credentials or real devices
