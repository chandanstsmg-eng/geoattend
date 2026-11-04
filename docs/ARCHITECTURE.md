# GeoAttend — Architecture

## Components

```
┌──────────────────────┐   HTTPS (Bearer JWT)    ┌───────────────────────────────┐
│ Employee mobile app  │ ──────────────────────▶ │                               │
│ Expo / React Native  │  locations (batched,    │   API  (Node 24, Express 5,   │──▶ PostgreSQL (+ PostGIS)
│ foreground service,  │  idempotent), photos    │   TypeScript, zod)            │
│ offline queue        │  via signed PUT URL     │                               │──▶ Private object storage
└──────────────────────┘                         │  • auth / RBAC / audit        │    (local signed links or S3)
                                                 │  • state-machine engine       │
┌──────────────────────┐  same origin /api/*     │  • sweeper (stale, prolonged, │──▶ Web push (VAPID), SMTP,
│ Admin dashboard      │ ──▶ Next.js proxy ────▶ │    window end, retention,     │    Expo push (FCM/APNs)
│ Next.js 16 App Router│  httpOnly cookies+CSRF  │    delivery retries)          │
│ Google Maps JS API   │ ◀── SSE live events ─── │  • SSE hub                    │
└──────────────────────┘                         └───────────────────────────────┘
```

| Path | Purpose |
|---|---|
| `packages/shared` | Geodesy (Vincenty WGS‑84 distance), inside/outside classification with accuracy margin + hysteresis, state & notification enums. Used by API and dashboard. |
| `apps/api` | REST API `/api/v1`, OpenAPI at `/api/v1/openapi.json`, Swagger UI at `/api/docs`. Modules: `auth`, `employees` (+ `me`), `workplaces`, `shifts`, `tracking`, `attendance`, `events` (geofence events, absences, audit), `notifications`, `reports`, `settings`, `jobs`, `demo`. |
| `apps/admin` | Admin dashboard. The browser only talks to its own origin; `/api/*` is rewritten to the API, and the SSE stream has a dedicated route handler that closes the upstream connection when the browser leaves. |
| `apps/mobile` | Employee app (standalone install, not an npm workspace, so React Native's React version never clashes with Next.js). |

## Why these decisions

* **Server is the only source of truth.** The device sends raw readings (untrusted evidence). The server computes distance, classification and state; the app renders `guidance` text written by the server.
* **Pure state-machine engine** (`apps/api/src/modules/tracking/engine.ts`): `evaluate(session, reading, rules) → {state, effects}` with no I/O. Live devices and the demo simulator call the same function.
* **Time-driven transitions in a database-driven sweeper** (`jobs/sweeper.ts`) every 15 s: stale updates → `TRACKING_INTERRUPTED`; away beyond threshold → `PROLONGED_ABSENCE`; shift window over → session closed. Each step re-reads the session under a row lock, so restarts lose nothing and several API instances are safe. A separate job queue (BullMQ/Redis) was deliberately *not* used: the work is small, periodic and idempotent, and the database is already the coordination point. Redis is included in docker‑compose as an optional profile for a shared rate-limit store when running multiple API instances.
* **Concurrency:** every session mutation runs in a transaction holding `SELECT … FOR UPDATE` on the session row.
* **Exactly-once attendance:** `attendance_records.idempotency_key UNIQUE` + `UNIQUE (employee_id, shift_id, shift_date)`; location readings are idempotent by `(session_id, client_event_id)`.
* **PostGIS optional:** the migration enables PostGIS and adds a `geography` column + GiST index when the extension exists (docker‑compose uses `postgis/postgis`). Eligibility never depends on it — the tested geodesic code gives the same answer on plain PostgreSQL (used by the built-in local database).
* **Embedded PostgreSQL for local development:** no Docker required; `data/pg` is started with `pg_ctl` and survives API crashes.

## State machine

```
SHIFT_START_PENDING ──permission OK──▶ TRACKING_ACTIVE ──outside──▶ OUTSIDE_GEOFENCE
        │ permission denied                 │ inside (accurate)            │ inside
        ▼                                   ▼                              ▼
TRACKING_PERMISSION_REQUIRED       ARRIVAL_CANDIDATE ──stable N readings & T s──▶ ATTENDANCE_READY
                                          │ outside → OUTSIDE_GEOFENCE                │ photo intent
                                                                                      ▼
                                                    outside ◀── ATTENDANCE_SUBMISSION_PENDING
                                                                                      │ server-verified submit
                                                                                      ▼
   PROLONGED_ABSENCE ◀──threshold (sweeper)── TEMPORARILY_AWAY ◀──verified exit── PRESENT
            └──────────────verified return────────────┴──────────────────────────────▶ PRESENT

Any tracking state ──no updates for staleAfterSec──▶ TRACKING_INTERRUPTED ──next valid reading──▶ previous state
Any open state ──end shift / admin terminate / window end──▶ SHIFT_END_PENDING ──▶ SHIFT_COMPLETED
Pre-attendance ──employee request──▶ MANUAL_REVIEW_REQUIRED ──admin approve/reject──▶ PRESENT / previous
```

### Reading classification (`packages/shared/src/geofence.ts`)

* accuracy worse than `maxAccuracyM` → `INSUFFICIENT_ACCURACY` (decides nothing)
* `distance + boundaryFactor × accuracy ≤ boundary` → `INSIDE`
* `distance − boundaryFactor × accuracy > boundary` → `OUTSIDE`
* otherwise `AMBIGUOUS` (decides nothing)
* boundary = `radius` before attendance / while away; `radius + exitHysteresisM` once counted inside.

Entry, exit and return each need a configurable number of consistent readings spanning a configurable time. Uncertain readings never approve, never reject, never create a departure. A silent device is an interruption, never a departure.

## Data model

Migration: `apps/api/src/db/migrations/001_initial_schema.sql`. Tables: `users`, `employee_profiles`, `administrator_profiles`, `refresh_tokens`, `workplaces`, `workplace_assignments`, `shifts`, `employee_shift_assignments`, `tracking_sessions`, `session_state_transitions`, `location_updates`, `permission_status_events`, `attendance_photos`, `attendance_records`, `review_requests` (manual reviews, disputes, technical issues, admin corrections with before/after), `geofence_events`, `absence_intervals`, `notifications`, `notification_reads`, `notification_deliveries`, `web_push_subscriptions`, `device_registrations`, `audit_logs` (append-only via trigger), `application_settings`, `notice_acknowledgements`.

`is_demo` / `is_simulated` flags mark fictional and simulated data everywhere; `sim_clock_offset_sec` is constrained to 0 for non-simulated sessions.

## Security summary

* scrypt password hashing; account lock after 8 failures; login rate-limited.
* 15‑minute access JWT; rotating refresh tokens stored as SHA‑256 hashes with family revocation on re-use.
* Web: httpOnly `SameSite=Strict` cookies + double-submit CSRF token; mobile: Bearer header.
* Role guard on every route; employee endpoints scoped to the caller's own id; cross-employee access tested.
* zod validation on every body/query/param; all SQL parameterised.
* helmet headers + CSP; CORS allow-list; JSON body limit 512 KB; photo uploads size/type/magic-byte checked, written once, never public.
* Photos and location history: every admin view audited; signed links expire in 120 s.
* Errors never leak stack traces; logs redact tokens and cookies.
