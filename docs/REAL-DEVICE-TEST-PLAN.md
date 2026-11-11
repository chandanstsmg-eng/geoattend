# Real-device test plan: shared phones, GPS, network, sign-in, push, iPhone and SOS

For the person testing the release that contains the approved business rules (Phase J, 11 November 2026). **None of these tests has been run.** Every line below is "not tested" until someone runs it on a real phone or browser and writes the result in the sheet at the end. A step that was not run is "not tested", never "pass".

This plan adds what the general [Android device test plan](ANDROID-DEVICE-TEST-PLAN.md) does not cover, and points to that plan's sections where it already covers a topic. Run both.

## Ground rules

- Use a **test server** with a test company, never the live server or the live database.
- Install the signed test build only on the testers' phones. Do not share the APK link publicly.
- Phone clocks on automatic time unless a step says otherwise.
- Keep the manager dashboard open on a second screen to see what the server received.

## Setup

| Item | Detail |
|---|---|
| Phones | Two Android phones (one Android 11–12, one 14 or newer); one iPhone (iOS 16.4 or newer) |
| Computers | One with Chrome; one Mac with Safari, if available |
| Test company | One workplace with a geofence you can walk out of; one shift running today; one day of the week with no shift |
| Accounts | Owner **O**; supervisors **SA** and **SB**, both managing the same workplace; employees **E1** and **E2** in SA's team; employee **E3** in SB's team |
| Settings | Tracking › maximum plausible speed: 150 km/h (default). Workforce › One phone per employee: start with **On** |
| Server, for push | `EXPO_PUSH_ENABLED=true` and `EXPO_ACCESS_TOKEN` for phone push; VAPID keys for browser push; mail settings for e-mail. Without them, sections P and S can only check the dashboard inbox |

Before each phone, note brand, model, Android or iOS version and app build.

## 1. Two employees sharing one Android phone (SP)

With **One phone per employee: On**, a phone approved for one employee refuses another (`DEVICE_IN_USE`) and tells the manager (`SHARED_DEVICE`). Sharing only works with the setting on **Alert only** or **Off**, so test both.

| # | Do | Pass when |
|---|---|---|
| SP1 | Setting **On**. E1 signs in on phone 1; SA approves the phone | E1 signed in |
| SP2 | E1 signs out. E2 signs in on phone 1 | Refused: "This phone is registered to another employee". Dashboard shows a "Phone used by two employees" alert |
| SP3 | Switch the setting to **Alert only**. E2 signs in on phone 1 | Allowed; an alert is still raised |
| SP4 | E1 checks in offline (airplane mode), signs out; E2 signs in | E2 sees none of E1's saved items in History › Saved on this phone |
| SP5 | Reconnect while E2 is signed in | E1's items are **not** sent under E2. They stay waiting |
| SP6 | E2 signs out, E1 signs in again | E1's items are sent, once each, under E1 |
| SP7 | E1 has items waiting; start the send, sign out while "Sending" shows | Nothing more of E1's is sent after the sign-out, under anyone; the rest waits for E1 |
| SP8 | E1 on shift with tracking running; E1 signs out; E2 signs in | Tracking for E1 stops at the sign-out; no further E1 readings arrive; nothing of E1's is marked "not accepted" because of E2's sign-in |
| SP9 | Dashboard › the phone's page | Shows both employees' sign-ins with times |

## 2. GPS accuracy and suspicious-location detection (G)

The approved rule: a reading implying more than 150 km/h from the last good reading (after allowing for both readings' accuracy) is **kept and flagged**, shown on the trail as "ignored: N km/h jump", left out of arrival, departure, the live position and check-in evidence, and reported to the managers once per shift ("GPS jump ignored"). If a third reading agrees with the two flagged ones before it, it is accepted as the new position; the two stay flagged. Before check-in, leaving now needs a confirmed departure (readings outside over about 60 seconds), not one stray reading.

| # | Do | Pass when |
|---|---|---|
| G1 | Stand at 5 marked spots inside and outside the geofence, 2 minutes each | Record the accuracy shown and the distance the dashboard reports at each spot |
| G2 | Inside, near tall buildings or under a roof, wait for "Attendance ready", stay put 10 minutes | Never re-locks from a single bad reading |
| G3 | After "Attendance ready", walk out and stay out | Re-locks after about a minute outside, not on the first reading |
| G4 | After "Attendance ready", step just outside for 20 seconds and come back | Stays ready |
| G5 | Check in normally after G4 | Recorded, on time or late by the right minutes |
| G6 | Developer options › mock-location app. During a shift, jump the position 50 km away and back | Trail shows the jumped reading as "ignored: N km/h jump"; the employee is **not** marked away; managers get one "GPS jump ignored" |
| G7 | Repeat G6 twice in the same shift | Still only one "GPS jump ignored" for that shift |
| G8 | Jump 50 km away and **stay** there 3 readings | The third reading is accepted as the new position (the employee then shows as away); the first two stay flagged |
| G9 | Ready to check in, jump far away, check in at once | Refused; nothing recorded; the attendance stays waiting for a normal reading inside |
| G10 | Drive at normal road speed (under 100 km/h) for 10 minutes during a shift | No reading flagged |
| G11 | Note: the mock-location app also sets Android's mock flag | Record whether the separate "mock location" alert appears too. Mock readings are flagged but **not** removed from automatic decisions (see POLICY-SPECS.md) |

## 3. Poor network and offline check-in (N)

Run the Android plan's section D (D1–D15) on both phones. In addition:

| # | Do | Pass when |
|---|---|---|
| N1 | Developer options or the router: limit to 2G / 50 kbit/s. Check in | Either recorded, or saved for later; never both, never lost |
| N2 | Same, end the shift with a selfie | Same |
| N3 | Weak signal at the edge of the geofence; walk in and check in | Recorded or saved; arrival is not decided from an inaccurate reading |
| N4 | Start the app in airplane mode (cold start) | Opens; shows saved state; no endless spinner |

## 4. Sign-in renewal and sign-out (T)

Run the Android plan's section T (T1–T6). In addition:

| # | Do | Pass when |
|---|---|---|
| T7 | Sign out while saved items are sending | See SP7 |
| T8 | Sign out with saved items, sign in as the same person | Sent (D13) |
| T9 | Sign out; press the phone's Back button | Returns to the sign-in screen, no employee data visible |
| T10 | Owner resets E1's password while E1 is signed in | Record what happens at E1's next action. Saved items must not be lost |

## 5. Android push notifications (P)

Needs the push credentials in Setup. Run the Android plan's section P (P1–P5) on both phones. The server marks a push `SENT` when Expo accepts it; only the phone proves it arrived. In addition:

| # | Do | Pass when |
|---|---|---|
| P6 | E1 and E2 share a phone (section 1); E1 signs out, E2 signs in; send E1 a task | Nothing for E1 appears on the shared phone while E2 is signed in (sign-out removes E1's push address for that phone). E1 sees the task in the app after signing in again |

## 6. iPhone and Safari (I)

The phone app has an iOS configuration but **no iOS build has ever been made**: it needs an Apple developer account and an EAS iOS build. Until then, only the dashboard and website can be tested on Apple devices.

| # | Do | Pass when |
|---|---|---|
| I1 | Safari on Mac: owner signs in; dashboard, Attendance, Employees, Approvals, Reports, Settings | Everything loads; no layout broken |
| I2 | Safari on Mac and iPhone: live map and day replay | Map loads (needs the restricted maps key for that address) |
| I3 | Safari: download a CSV export | File downloads and opens in Numbers or Excel with the right columns |
| I4 | Safari: date pickers and the Attendance "Extra day" form | Usable; the date chosen is the date saved |
| I5 | iPhone Safari, portrait: phone menu, tables | No sideways scrolling of the page; menu opens and closes; Tab stays inside the open menu |
| I6 | iPhone Safari: an employee signs in to the website | Sent to the phone app instructions, not the dashboard |
| I7 | iPhone, iOS 16.4+: add the dashboard to the Home Screen, allow notifications | Record whether browser push works; Safari only allows it from the Home Screen |
| I8 | Only once an iOS build exists: repeat sections 2–5 on the iPhone | — |

## 7. Supervisor SOS notifications (S)

The approved rule: a supervisor sees only their own team, **including SOS**. Owners see everything. A supervisor marked as away still receives SOS. Supervisors get SOS through the dashboard: the inbox, a live update on an open dashboard, browser push if they allowed it, and e-mail if mail is configured. The phone app's push goes to employees only.

| # | Do | Pass when |
|---|---|---|
| S1 | O, SA and SB each sign in to the dashboard in a separate browser; allow notifications | — |
| S2 | E1 presses SOS on the phone | O and SA see it at once (live), in the inbox, by browser push and by e-mail; SB sees nothing anywhere: inbox, live map, SOS list |
| S3 | E1 presses SOS again while it is open | The same alert is updated with the new location; no second alert |
| S4 | E3 presses SOS | O and SB are told; SA is not |
| S5 | Mark SA as away today, then E2 presses SOS | SA still receives it |
| S6 | SA resolves E1's SOS | Shown resolved to O; SB still cannot open it (link from O's screen gives "not found") |
| S7 | SOS with location off | Alert still sent, marked without location |
| S8 | SOS offline | Record what the app does; the alert must not be shown as sent until it reaches the server |
| S9 | Live map and today's headcount as SA | Shows E1 and E2 only; as O, all three |

## Results sheet

Copy one per device or browser.

| Field | Value |
|---|---|
| Tester, date | |
| Device or browser, version | |
| App build, server address | |
| Settings used | |

| Section | Passed | Failed | Not tested | Notes, ticket numbers |
|---|---|---|---|---|
| 1 Shared phone | | | | |
| 2 GPS and suspicious location | | | | |
| 3 Poor network and offline | | | | |
| 4 Sign-in renewal and sign-out | | | | |
| 5 Android push | | | | |
| 6 iPhone and Safari | | | | |
| 7 Supervisor SOS | | | | |

**Release rule:** a section may be described as working only after it has passed on a real device, and section 7 must pass before supervisors rely on SOS alerts.
