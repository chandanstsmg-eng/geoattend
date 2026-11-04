# GeoAttend — employee mobile app

Expo SDK 58 · React Native 0.88 · TypeScript · Expo Router.

The app is a **standalone install**. It is deliberately *not* a member of the
root npm workspace, so React Native's React version never clashes with the
Next.js dashboard. Install and run everything from `apps/mobile`.

> **Status: not verified on a real device.** The code type-checks, passes
> `expo-doctor`, bundles for Android (`expo export`), and the offline-queue
> logic has unit tests. Background location, the camera, notifications, maps
> and battery behaviour have **not** been exercised on a phone. Use the checklist
> at the end before relying on it.

---

## 1. Setup

```powershell
cd apps\mobile
npm install
copy .env.example .env
```

Edit `.env`:

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | API base URL. **A phone cannot reach `localhost` on your PC.** Use the PC's LAN IP, e.g. `http://192.168.1.20:4400` (find it with `ipconfig` → IPv4 Address). The API listens on `0.0.0.0:4400`. Allow port 4400 through Windows Firewall for private networks. |
| `GOOGLE_MAPS_ANDROID_API_KEY` | Google Maps SDK for Android key (see §5). Optional: without it the map screen shows coordinates + radius instead of a map. |
| `EAS_PROJECT_ID` | Optional. Enables Expo push tokens (§6). |
| `APP_VARIANT` | `development` / `preview` / `production`. Set automatically by `eas.json`. Defaults to `development` locally. |
| `ALLOW_CLEARTEXT` | Optional `1` to allow plain-HTTP API traffic in a **preview** build for LAN testing. Never in production. |

`EXPO_PUBLIC_*` values are inlined when Metro bundles, so restart Metro after changing `.env`.

### Plain HTTP vs HTTPS

* **Development builds** (`APP_VARIANT=development`) allow cleartext HTTP so you can talk to the API on your LAN (`android:usesCleartextTraffic=true` via `expo-build-properties`; iOS `NSAllowsArbitraryLoads`/`NSAllowsLocalNetworking`).
* **Preview** builds block cleartext unless `ALLOW_CLEARTEXT=1` is set for that build.
* **Production builds always block cleartext. The production API must be HTTPS.**

## 2. Running

```powershell
npx expo start          # Metro for a development build (expo-dev-client)
npm run android         # = npx expo run:android  (builds + installs a dev build locally; needs Android SDK)
```

### Why Expo Go is NOT enough

Expo Go cannot run this app properly:

* background location needs `ACCESS_BACKGROUND_LOCATION`, a **location foreground service** and the config-plugin manifest entries — only present in your own native build;
* `expo-task-manager` background tasks don't run in Expo Go on Android;
* `react-native-maps` with a Google key, the custom notification channel and the permission strings all come from `app.config.ts`, which Expo Go ignores.

Use a **development build** instead:

```powershell
npx expo run:android                                        # local (Android Studio / SDK installed)
npx eas-cli@latest build --profile development --platform android   # cloud, installs as an APK
```

Then `npx expo start` and open the project from the dev client.

## 3. Build profiles (`eas.json`)

| Profile | Output | Notes |
| --- | --- | --- |
| `development` | APK with dev client | `APP_VARIANT=development`, cleartext allowed, package `com.geoattend.employee.development` |
| `preview` | installable APK | `APP_VARIANT=preview`, package `com.geoattend.employee.preview`, HTTPS unless `ALLOW_CLEARTEXT=1` |
| `production` | AAB for Play Store | `APP_VARIANT=production`, package `com.geoattend.employee`, HTTPS only |

Set `EXPO_PUBLIC_API_URL`, `GOOGLE_MAPS_ANDROID_API_KEY` (and `EAS_PROJECT_ID`) as
EAS environment variables / secrets for cloud builds (`.env` is not uploaded).

```powershell
npx eas-cli@latest build --profile preview --platform android
npx eas-cli@latest build --profile production --platform android
```

Google Play requires a **background location declaration** (prominent disclosure +
video) for `ACCESS_BACKGROUND_LOCATION`. The permission explanation screen is the
in-app prominent disclosure.

## 4. Verification commands

```powershell
npx tsc --noEmit                                         # type check
npx expo-doctor                                          # dependency / config check
npx expo export --platform android --output-dir dist     # proves the JS bundle resolves (delete dist afterwards)
npm test                                                 # offline-queue unit tests (node --test, Node ≥ 22.18)
```

## 5. Google Maps key (Android)

1. Google Cloud Console → enable **Maps SDK for Android**.
2. Create an API key, restrict it to *Android apps* with your package name
   (`com.geoattend.employee[.development|.preview]`) and the signing SHA-1
   (`npx eas-cli@latest credentials` shows it for EAS builds).
3. Put it in `GOOGLE_MAPS_ANDROID_API_KEY` and rebuild (it is a native setting; Metro reload is not enough).

`app.config.ts` writes it to `android.config.googleMaps.apiKey` and the
`react-native-maps` plugin, and sets `extra.googleMapsConfigured`. Without a key
the map screen shows **"Map unavailable — Google Maps key not configured"** with
coordinates and radius — never a blank map. iOS uses Apple Maps.

## 6. Notifications & push

* Local notifications work without any setup: "Attendance is ready — open GeoAttend to capture your photo" (arrival) and "Location tracking stopped". Android channel id: `attendance`.
* Tapping a notification opens the **shift screen**. Notifications and background tasks never open the camera.
* Push tokens: run `npx eas-cli@latest init`, put the project id into `EAS_PROJECT_ID`, rebuild. The app then sends an Expo push token with `POST /me/devices`. Without a project id the token is skipped.
* Android 13+ asks for notification permission when the employee starts a shift.

## 7. Android battery optimisation (tell employees)

Aggressive battery managers (Xiaomi/MIUI, Samsung, Oppo/ColorOS, Vivo, Huawei, OnePlus) kill background apps even with a foreground service. For reliable tracking:

* Settings → Apps → GeoAttend → Battery → **Unrestricted** / "No restrictions".
* Samsung: remove GeoAttend from "Sleeping apps" / "Deep sleeping apps".
* Xiaomi: enable **Autostart**, battery saver "No restrictions".
* Location permission → **Allow all the time**, and keep **Use precise location** on.
* Do not swipe the app away during a shift on devices that kill foreground services.

If the OS still stops updates, the server marks the session *Tracking interrupted* (not "left the workplace") and the app shows the interruption screen.

## 8. How it works

```
src/app/                 Expo Router screens
  _layout.tsx            root: imports the background task, splash, auth gate
  login.tsx
  (app)/(tabs)/          Home · History · Privacy · Account
  (app)/map.tsx          workplace map / "map unavailable" panel
  (app)/shift-details.tsx
  (app)/permissions.tsx  permission explanation (prominent disclosure)
  (app)/activate.tsx     permission requests → POST /tracking/sessions → permission report → start updates
  (app)/shift.tsx        live shift; one component per server state (components/shift/views.tsx)
  (app)/capture.tsx      camera → preview → confirm → intent → PUT → fresh fix → POST /attendance
  (app)/success.tsx      server-confirmed time only
  (app)/completed.tsx    "Location tracking has stopped"
src/lib/api/             fetch client (single-flight token refresh) + API types
src/lib/tracking/
  task.ts                TaskManager.defineTask (top level)
  runtime.ts             readings, upload, start/stop, permission reports, reconcile
  queue-core.ts          pure bounded-queue logic (+ .test.ts)
  store.ts               AsyncStorage persistence + UI snapshot
src/lib/secure.ts        tokens + device id in expo-secure-store (AFTER_FIRST_UNLOCK)
```

Key rules implemented:

* **The server is the source of truth.** Screens render the status object (`guidance`, `attendanceAvailable`, `tracking.*`). The app never decides eligibility. "Attendance recorded" appears only after `POST /attendance` returned 200/201, with the server's `recordedAt`.
* **Tracking only during an explicitly started shift.** Updates stop when the employee ends the shift, when the server returns `tracking.shouldTrack=false`, when the local clock passes `tracking.windowClosesAt`, or on sign-out / session loss. On launch the app reconciles: updates running without an open session are stopped; an open session without updates shows **"Tracking is not running — tap to resume"** (never restarted silently).
* **Offline queue:** bounded by `tracking.offlineQueueMax`, drops the oldest and counts drops, flushes oldest-first in batches ≤ 500, removes only readings the server answered (ACCEPTED / DUPLICATE / REJECTED). Flushes on reconnect and on app foreground.
* **Attendance submission:** one idempotency key per capture attempt, reused on every retry; photo resized to ≤1280 px JPEG q≈0.7 (< 5 MB); fresh `Accuracy.Highest` fix taken right before `POST /attendance`. 422/409 codes map to clear messages with retry / retake / back.
* **Permissions:** reported to the server on start, on every app foreground, every 60 s while open, and every ~5 min from the background task when they changed. Revocation shows the permission-required screen with "Open settings" and "Request manual review".
* **Mock locations** are reported (`isMocked`) and never blocked by the app.

## 9. Real-device test checklist

Run against a dev or preview build on a physical Android phone (and iOS if relevant). Watch the admin dashboard's live view at the same time.

- [ ] Sign in; device appears in the admin's device list (`POST /me/devices`).
- [ ] First shift: privacy notice must be acknowledged (version + retention days shown).
- [ ] Start shift: explanation → "While using" → "Allow all the time" settings flow → tracking notification appears.
- [ ] Decline background permission: app continues with the "updates only while the app is open" warning; admin sees background unavailable.
- [ ] Walk from outside → inside the geofence: distance updates, *Verifying arrival*, then *Attendance ready*; with the app in background, the "Attendance is ready" local notification appears; tapping it opens the shift screen (not the camera).
- [ ] Capture photo: camera permission asked only now; front/back switch, retake, confirm; success shows server time.
- [ ] Kill network during submit → Retry → exactly one record (same idempotency key).
- [ ] Walk out and back: *Temporarily away* → *Present*.
- [ ] Lock the screen for 15+ minutes: updates keep arriving (check "Last sent" and the admin map).
- [ ] Swipe the app away: foreground service keeps running (device-dependent).
- [ ] Sit still for a long time: check updates still arrive (distance filter vs. stale threshold).
- [ ] Revoke location permission in Settings mid-shift → permission-required screen; admin sees permission revoked.
- [ ] Turn GPS (location services) off → same screen, "Location services are off".
- [ ] Airplane mode for 10 min while moving → "Offline — N locations queued" → back online → queue drains, history fills in.
- [ ] Reboot the phone mid-shift → open the app → "Tracking is not running — tap to resume" → resume works.
- [ ] End shift → "Location tracking has stopped"; tracking notification disappears; no further uploads.
- [ ] Admin terminates the session → phone shows "Location tracking stopped" notification and stops.
- [ ] Leave a shift running past its window → tracking stops by itself.
- [ ] Sign out mid-shift → tracking stops immediately.
- [ ] Dispute a history record; report a technical issue; change password (phone stays signed in).
- [ ] Map: with and without the Google Maps key.
- [ ] Small screen (≈ 5") and large font size: all buttons reachable and readable.
