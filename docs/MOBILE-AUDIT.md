# Mobile app audit

Android app, Expo SDK 58, React Native 0.88. Audited 4 Nov 2026 by reading the code and running it through automated tests. **No real phone was used.**

## Findings fixed

| # | Severity | Finding | Fix |
|---|---|---|---|
| M1 | Critical | `stopTracking` wiped the offline queue without checking what had been sent. It ran on sign-in loss, on the shift window closing while offline, on any 403 or 404, and on signing out | Stopping now only stops collection. Only the server's answer removes a reading |
| M2 | Critical | Check-in and shift end had no offline path. A failed submit lived in memory, so a restart lost it, and the photo sat in the cache folder | Durable outbox, with the photo copied to the documents folder |
| M3 | Critical | The server rejected queued readings once a session had closed, and the phone treated that as answered, so they vanished | Readings taken before the close are kept as history and cannot change the session |
| M4 | Critical | The 60–90 second evidence limit made any delayed check-in impossible | Delayed check-ins are judged on their evidence, flagged, and bounded by the server's session start |
| M5 | High | Arriving with no signal could not be recorded at all: the server cannot unlock attendance if it never sees the arrival | "Check in offline" appears on the shift screen when there is no connection |
| M6 | High | After a restart with no connection the shift screen had no data, so nobody could check in or end the shift | The last server status is stored on the phone |
| M7 | High | Starting the next shift deleted the previous shift's unsent readings | Readings carry their own session and employee |
| M8 | High | Phase C's device and password checks answer 403, which the phone read as "session gone", stopping tracking and deleting the queue | These now pause sending and tell the employee |
| M9 | High | Ending a shift offline left the shift to run to its window, overstating hours | The end time is saved, sent later, and corrects the automatic close |
| M10 | High | Any 4xx on token refresh signed the employee out, including passing errors | Only 400, 401 and 403 end the sign-in |
| M11 | Medium | One malformed reading caused its whole batch of up to 500 to be dropped | The batch is halved until the bad reading is alone, and that reading is set aside |
| M12 | Medium | A failed storage read looked like an empty queue, and the next write erased the real one | A failed read now throws; unreadable content is set aside |
| M13 | Medium | Readings and photos could leave the phone through Android cloud backup | `allowBackup: false`, confirmed in the generated manifest |
| M14 | Medium | A production build could be made with no server address, or plain HTTP | `app.config.ts` refuses it |
| M15 | Medium | 17 Expo packages were behind the SDK; two high-severity advisories in the app's dependencies | Aligned with `expo install --fix`; both high advisories cleared |
| M16 | Medium | Background location refusal was swallowed silently | Recorded in `lastError` |
| M17 | Low | History showed raw status codes, and no reason for a rejected face check | Plain labels, the reason, and an offline note |
| M18 | Low | Text claimed matched photos are deleted at once, which stopped being true with the retention hold | Corrected |
| M19 | Low | Only 5 mobile tests, all on the queue | 35 mobile tests, plus 6 end-to-end sync tests against the real API |

## Not fixed: known limits

| # | Limit | Consequence |
|---|---|---|
| L1 | Starting a shift needs a connection: the server issues the session | A worker with no signal when starting cannot start. Changing this is a larger design decision |
| L2 | Breaks and overtime need a connection | They show a clear error offline |
| L3 | An end-of-shift selfie is not saved offline | The shift ends without it, and the manager sees it missing. Overtime's end proof is affected too |
| L4 | Tracking does not resume by itself after a phone restart or force-stop | Android forbids starting location from the background. The employee must open the app; the manager sees tracking stop |
| L5 | Saved items send only while the app runs, or when a location fix wakes it | After the shift, nothing sends until the app is opened. A background job could be added later |
| L6 | The queue is capped per company (default 2,000 readings, about 16 hours at 30 s) | Beyond that the oldest are dropped and counted. Attendance events are not capped |
| L7 | A phone clock can be changed while offline | Bounded by the server's session start and receipt time, and flagged, but a delayed time is weaker evidence than a live one |
| L8 | Saved data is not encrypted beyond Android's app-private storage | For the legal review |
| L9 | Battery use has never been measured | Highest-accuracy location every 30 s is likely to be significant. No figure may be quoted |
| L10 | Rooted or emulator detection is basic, and there is no Play Integrity check | A determined user can fake a device |
| L11 | Two JavaScript runtimes could write at once if the OS starts a background task beside the app | The in-process lock does not span them. Needs checking on real phones |
| L12 | 5 moderate advisories remain, in Expo's build tooling | Fixing them needs an Expo major downgrade (`npm audit fix --force`), so they were left |

## Play Store requirements

Background location needs a Play Console declaration, a demonstration video and an in-app prominent disclosure. The app shows an explanation before the permission, but it has not been reviewed against Google's current policy. A signing key, a store listing and a privacy policy address are also needed.

## Android compatibility

Phone check gives brand-specific steps for Xiaomi, Oppo, Realme, OnePlus, Vivo, iQOO, Samsung, Huawei and Honor. **The steps come from general knowledge of those phones and have not been confirmed on any of them**, and menu names change between versions.

## Android build

A local release build (`preview` variant, arm64 only) completed on 4 Nov 2026: `app-release.apk`, 37.1 MB, signed with the debug key. It proves the native project compiles. It has not been installed on any phone or emulator. A store build needs EAS, or a real signing key.

Building on Windows needs a real short folder rather than a mapped drive, about 8 GB of free disk, and `ninja` 1.12 or newer: the 1.10 bundled with CMake 3.22 fails on paths over 260 characters even with Windows long paths on. EAS builds on Linux, where none of this applies.
