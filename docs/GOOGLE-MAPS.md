# Google Maps setup

GeoAttend uses Google Maps **only** to visualise workplaces and employees and to help administrators pick coordinates. Whether an employee may mark attendance is decided by the API using geodesic distance — never by what a map draws.

## What needs a key

| Feature | Without a key | With a key |
|---|---|---|
| Workplace editor | Manual latitude/longitude entry, schematic preview labelled "not a map", setup notice | Address search (Places), click to place, draggable marker, resizable circle, reverse geocoding |
| Live Workforce Map | Schematic diagram of positions relative to one workplace, labelled "not a map" | Google map with geofence circles and employee markers |
| Mobile workplace map (Android) | "Map unavailable — Google Maps key not configured" panel with coordinates and radius | Google map with circle and own position |
| Attendance eligibility | **Unaffected** | **Unaffected** |

## Dashboard key (browser key)

1. Google Cloud Console → create/select a project → enable billing.
2. Enable **Maps JavaScript API**, **Places API (New)** and **Geocoding API**.
3. Credentials → Create API key → **Application restrictions: Websites** → add your dashboard origins, e.g. `https://admin.example.com/*` (and `http://localhost:3400/*` for development).
4. **API restrictions:** restrict the key to the three APIs above.
5. Set quotas / budget alerts (Maps APIs are billed per load/request).
6. Optional: Map Management → create a **Map ID** (JavaScript, vector) for Advanced Markers styling; otherwise the built-in `DEMO_MAP_ID` is used.
7. In `.env`:
   ```
   NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIza...
   NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=          # optional
   ```
8. Rebuild/restart the dashboard (`npm run build` / `npm run dev`). `NEXT_PUBLIC_*` values are compiled into the browser bundle — that is expected for a referrer-restricted browser key. Never put a server/unrestricted key there.

## Android key (mobile app)

1. Enable **Maps SDK for Android**.
2. Create a separate key restricted to **Android apps** with the package name (`com.geoattend.employee`) and your signing certificate SHA‑1 (debug, upload and Play App Signing certificates).
3. Put it in `apps/mobile/.env` as `GOOGLE_MAPS_ANDROID_API_KEY=` and rebuild the native app (the key is baked in at build time).

## Status in this repository

Google Maps code paths are implemented but have **not been exercised with a real key** in this environment (no key was available). The keyless fallback paths were tested in a browser. After adding a key, check: address search returns results, clicking moves the marker, dragging the circle edge changes the radius field, and the live map shows markers.
