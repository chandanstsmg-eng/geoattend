# GeoAttend — Test Plan

Automated tests: `npm test` (from the repository root) runs

* `packages/shared/src/geo.test.ts` — geodesy against the published Vincenty test vector, classification and hysteresis (8 tests)
* `apps/api/test/engine.test.ts` — the pure state machine (13 tests)
* `apps/api/test/api.test.ts` — the HTTP API against a throw-away PostgreSQL database, including SSE, CSV, retention and the demo simulator (31 tests)

Each API test run creates a fresh database on the built-in PostgreSQL server and drops it afterwards; uploaded test photos go to `data/test-photos` and are deleted.

Browser end-to-end check of the dashboard: `C:\Users\Hi\.lmstest\ga-flow.js` (kept outside the project; see README).

## Scenarios

| # | Scenario | Expected result | How verified |
|---|---|---|---|
| 1 | Employee 42 m from a 30 m geofence | State `OUTSIDE_GEOFENCE`; message "You are 42 metres away. Attendance unlocks within 30 metres."; photo intent → 409 `ATTENDANCE_LOCKED` | api.test (1), engine.test |
| 2 | Enters with good accuracy | `ARRIVAL_CANDIDATE` → after the stabilisation window and minimum readings `ATTENDANCE_READY`; admin `ARRIVED` + employee `ATTENDANCE_READY` notifications | api.test (2), engine.test |
| 3 | Inside but accuracy ±55–60 m | Stays `TRACKING_ACTIVE`; guidance "GPS accuracy insufficient"; one `ACCURACY_INSUFFICIENT` geofence event | api.test (3), engine.test |
| 4 | Leaves before submitting | Outside reading → `OUTSIDE_GEOFENCE`, upload slot cancelled; submission → 422, no record. Submitting outside evidence directly → 422 `NOT_ELIGIBLE` + `ATTENDANCE_SUBMISSION_FAILED` notification | api.test (4), (4b) |
| 5 | Photo captured → attendance | Record `VERIFIED`, `recorded_at` = server time, state `PRESENT` | api.test (5)(6) |
| 6 | Duplicate requests | Same idempotency key → 200 replay, same id; different key → 409 `DUPLICATE_SUBMISSION` + notification; exactly one row | api.test (5)(6) |
| 7 | No workplace / no shift assignment | Start session → 403 | api.test (7) |
| 8 | Exits geofence | Exit needs N outside readings over T s; then `TEMPORARILY_AWAY`, absence opened at first outside reading, `GEOFENCE_EXIT` alert | api.test (8)(9), engine.test |
| 9 | Returns before threshold | Verified return → `PRESENT`, interval `RETURNED`, never prolonged | api.test (8)(9) |
| 10 | Away beyond threshold | `PROLONGED_ABSENCE`, one CRITICAL alert with last known location, departure, duration, freshness; repeat only after cooldown | api.test (10) |
| 11 | Updates stop | `TRACKING_INTERRUPTED` after `staleAfterSec`, no absence created, alert says it is not evidence of leaving; next reading resumes + `TRACKING_RESUMED` | api.test (11), engine.test |
| 12 | Employee ends shift | `SHIFT_COMPLETED`, `shouldTrack=false`, further readings rejected (`SESSION_CLOSED`), nothing stored, cannot restart same shift. Window end closes sessions automatically | api.test (12) |
| 13 | Permission revoked mid-shift | `TRACKING_PERMISSION_REQUIRED` + `PERMISSION_REVOKED` alert; re-granted → previous state; foreground-only → `BACKGROUND_UNAVAILABLE` alert | api.test (13) |
| 14 | Offline then reconnect | Out-of-order batch processed in device-time order; resend → all `DUPLICATE`; older-than-latest reading stored as `HISTORICAL` | api.test (14) |
| 15 | Geofence edited during shift | Version incremented, `GEOFENCE_CHANGED` alert, next reading judged by the new radius, audit entry, other fields unchanged | api.test (15) |
| 16 | Cross-employee / unauthorised access | 401 without auth; 403 for other employees' sessions, readings, location history, photos, admin endpoints; CSRF required for cookie writes; refresh-token re-use revokes family | api.test (auth & 16) |
| 17 | Dashboard live updates | SSE stream delivers `session.updated` for a new reading; dashboard map updates without reload | api.test (17), ga-flow.js |
| 18 | Background tracking on a real Android device | See "Manual device tests" — **not yet executed** | manual |
| 19 | Battery optimisation, app kill, permission revoke, GPS off | See "Manual device tests" — **not yet executed** | manual |
| 20 | Retention | Location history of closed sessions and photos past retention deleted (file removed, status `DELETED`); open sessions and attendance records kept | api.test (20) |

Also covered: malformed coordinates (400), future/ancient timestamps, null island, stale evidence, non-image upload (415), tampered upload token (403), correction requires reason and is history-tracked, audit log is append-only, manual review approve → `MANUAL_APPROVED`, CSV formula-injection protection, notice acknowledgement required before tracking, late arrival flag.

## Manual device tests (Android, development or preview build)

Run on at least one recent Pixel/Samsung and one budget device. Record device, Android version, app build, result.

| Step | Expected |
|---|---|
| Fresh install → sign in → read and acknowledge notice | Notice shows retention days; Start shift disabled until acknowledged |
| Start shift away from site | Permission explanation, then "While using" → "Allow all the time" flow; persistent "GeoAttend is tracking your shift" notification; dashboard shows the employee "Outside workplace" with distance |
| Walk to the site | Distance falls; "Verifying your arrival"; local notification "Attendance is ready" (also with screen locked); camera does **not** open by itself |
| Capture photo indoors with weak GPS | Submission refused with an accuracy message, retry works; no success shown before the server confirms |
| Capture photo at site | "Attendance recorded successfully — Recorded at <server time>"; dashboard updates live |
| Lock screen, pocket the phone 15 min | Updates keep arriving (check dashboard "Live · n s ago") |
| Leave the site > exit stabilisation | Dashboard: Temporarily away; after threshold: Prolonged absence alert |
| Return | Present again; Returned notification |
| Airplane mode 10 min, then off | Dashboard shows Tracking interrupted (not "left"); after reconnect queued readings upload, state resumes |
| Revoke location permission in Settings | Dashboard Permission revoked alert within one cycle; app shows permission screen |
| Turn GPS off | Location-services-off reported; no fabricated positions |
| Force-stop the app | Dashboard shows Tracking interrupted after the stale timeout; reopening the app offers to resume |
| Battery saver / "Restricted" battery setting | Observe and record update gaps honestly |
| Reboot during shift | App does not silently restart tracking; banner "Tracking is not running — tap to resume" |
| End shift | Notification disappears; "Tracking stopped" confirmation; no further readings in location history |
| Shift window passes without ending | Server closes session; app stops on next contact |
