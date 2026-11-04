# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing configuration: JWT_SECRET …` | No `.env`. Run `npm run setup`. |
| `Port 4400 is already in use` | Another GeoAttend API is running (another terminal). Stop it, or set `API_PORT`. The dashboard uses 3400 (`next dev --port 3400`). |
| `Database did not start (pg_ctl exit …)` | Look at `data/logs/postgres.log`. Common: port 54340 taken (set `PG_PORT`), or a stale `data/pg/postmaster.pid` after a hard power-off — make sure no `postgres.exe` is running, then delete that file. |
| Database still running after closing everything | By design the built-in database keeps running (crash-safe). Stop it with `npm run db:stop`. |
| Dashboard shows "Reconnecting…" | The API is down or unreachable from the dashboard (`API_INTERNAL_URL`). Data still refreshes every 30–60 s once the API is back. |
| Dashboard requests hang after many reloads | Fixed in this version (the SSE stream closes on `pagehide` and the stream proxy closes upstream). If you put your own proxy in front, disable response buffering for `/api/v1/notifications/stream`. |
| "Google Maps is not configured" | Set `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and rebuild — see GOOGLE-MAPS.md. |
| Map is grey / "For development purposes only" | Billing not enabled, API not enabled, or referrer restriction does not match the dashboard origin. |
| Phone cannot reach the API | Use the PC's LAN IP in `apps/mobile/.env` (`EXPO_PUBLIC_API_URL=http://192.168.x.x:4400`), allow port 4400 in Windows Firewall (Private network), phone on the same Wi-Fi. |
| Attendance never unlocks indoors | Accuracy worse than *Worst acceptable GPS accuracy* or the reading straddles the boundary. Move near a window/outdoors, or have the employee request a manual review. Don't simply raise the accuracy limit for small (20 m) geofences. |
| Employee shows "Tracking interrupted" constantly | Background permission not "Allow all the time", battery optimisation/"Restricted" battery mode, or the app was force-stopped. See the mobile README's battery guidance. |
| `EVIDENCE_STALE` on submit | Phone clock far off, or the fix is older than *Max age of attendance GPS evidence*. Enable automatic time on the phone. |
| `NOTICE_ACK_REQUIRED` | The privacy notice changed (new version). The employee must re-acknowledge in the app. |
| `SHIFT_ALREADY_COMPLETED` | The employee already ended this shift today. An admin can create manual attendance if needed; sessions are one per shift per day. |
| Demo can't be replayed | Demo Simulator → *Reset demo data*. |
| Tests fail with connection errors | The test suite uses the built-in PostgreSQL; make sure `.env` exists (`npm run setup`). |
