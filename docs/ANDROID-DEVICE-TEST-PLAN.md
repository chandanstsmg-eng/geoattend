# Android device test plan

For the person testing GeoAttend on real phones. **No real phone has run this version yet.** Offline, background tracking and battery behaviour are not proven until this plan has been completed and signed. Automated tests prove the sync rules; they cannot prove what a phone maker's battery manager does.

Record every result in the sheet at the end. A step that was not run is "not tested", never "pass".

## What you need

| Item | Detail |
|---|---|
| Phones | One each: Xiaomi / Redmi (MIUI or HyperOS), Oppo (ColorOS), Vivo (Funtouch or OriginOS), Samsung (One UI), one near-stock Android (Motorola, Nokia or Pixel) |
| Android versions | At least one on Android 11 or 12, and one on 14 or newer |
| Build | A signed test build from EAS, pointing at a test server. Never the live server |
| Test server | A copy with a test company, one workplace, one shift, and a manager account |
| Place | A real workplace you can walk out of, at least 300 m of open route, and one spot with weak signal |
| Second screen | The manager dashboard open, to check what the server received |

Before each phone: note brand, model, Android version, app version. Fully charge. Install fresh.

## A. First use

| # | Do | Pass when |
|---|---|---|
| A1 | Sign in on a new phone | Told the phone awaits approval; the manager sees the request |
| A2 | Approve it in the dashboard, sign in again | Signed in |
| A3 | Sign in with a temporary password | Told to change it; shift actions are blocked until it is changed |
| A4 | Wrong password five times | Clear lock message, no crash |
| A5 | Enroll the face, in normal light | Five photos accepted |
| A6 | Enroll in the dark, or with two faces | Clear message, can retry |

## B. Permissions

| # | Do | Pass when |
|---|---|---|
| B1 | Start a shift, choose "While using the app" | App explains what stops working; a company that requires "all the time" blocks the start |
| B2 | Choose "Allow all the time" | Accepted; ongoing notification appears |
| B3 | Choose approximate location | Told to turn on precise location |
| B4 | During a shift, revoke location in Settings | Within minutes the app and the dashboard show permission lost |
| B5 | During a shift, turn off GPS | Same |
| B6 | Deny the camera, then press capture | Clear message with a way to Settings |
| B7 | Deny notifications | App still works; Phone check warns |

## C. Attendance with a connection

| # | Do | Pass when |
|---|---|---|
| C1 | Walk into the geofence | "Attendance ready" within about 2 minutes |
| C2 | Take the photo and confirm | Receipt shown; dashboard shows the record with the right time |
| C3 | Stay outside the geofence | Attendance stays locked |
| C4 | Arrive after the grace period | Marked late by the right minutes |
| C5 | Press capture twice quickly, or retry a slow request | One record only |
| C6 | Run a fake-GPS app | Refused or flagged, per company setting |
| C7 | End the shift with a selfie | Shift closed; tracking notification gone |
| C8 | Overnight shift across midnight | One record, on the shift's start date |
| C9 | Have a manager change the shift | Next shift uses the new time; past records unchanged |

## D. Offline (the main risk)

For each, first check what is on the phone (History › Saved on this phone), then what reached the dashboard.

| # | Do | Pass when |
|---|---|---|
| D1 | Start a shift, then airplane mode. Walk in. Press "Check in offline" | Says "Saved on this phone", **never** "recorded". Dashboard shows nothing yet |
| D2 | Turn the connection back on | Sends by itself. Dashboard shows one record at the capture time, flagged offline. Phone shows "Sent" |
| D3 | Airplane mode, check in, then force-stop the app, reopen, connect | Saved item survives and sends once |
| D4 | Airplane mode, check in, restart the phone, connect | Same |
| D5 | Signal drops while "Submitting" | Saved for later, not lost, not doubled |
| D6 | Wi-Fi with no internet (router unplugged) | Treated as offline; nothing lost |
| D7 | Very slow network (2G) | Timeout saves for later; no duplicate after it recovers |
| D8 | Airplane mode for 1 hour during a shift, screen off | All readings arrive afterwards, in order |
| D9 | End the shift in airplane mode, reconnect later | Dashboard shows the shift ended at the saved time |
| D10 | Stay offline past the shift window, reconnect | Readings kept; end time corrected to the saved one |
| D11 | Offline check-in from outside the geofence, reconnect | Phone shows "Not accepted" with the reason; nothing counted |
| D12 | Revoke the session in the dashboard while offline, reconnect | Asked to sign in; saved items still there; sent after signing in |
| D13 | Sign out with items saved, sign in as the same person | Sent |
| D14 | Sign out with items saved, sign in as someone else | Not sent, not visible as theirs |
| D15 | Set the phone clock 2 hours back while offline, check in | Never earlier than the session start on the server; flagged |

## E. Background tracking

Run on every phone. Do this **before** and **after** applying the steps in Phone check.

| # | Do | Pass when |
|---|---|---|
| E1 | Start a shift, lock the screen, 60 minutes, phone still | Readings keep arriving (see dashboard timeline) |
| E2 | Swipe the app away from recents, 30 minutes | Note whether tracking continues. **Expected to differ by brand** |
| E3 | Battery saver on, 30 minutes | Note what happens |
| E4 | Leave the phone unplugged overnight in a shift | Note what happens |
| E5 | Restart the phone during a shift | Tracking does **not** resume by itself. The app must be opened; the manager sees it stopped |
| E6 | Walk out of the geofence | Marked away; warning notification |
| E7 | Force-stop the app during a shift | Manager sees tracking stopped; app offers Resume |

## F. Battery

Measure on Xiaomi and one other phone, for a full 8-hour shift, screen mostly off.

| Measure | Record |
|---|---|
| Battery at start and end | % |
| Share used by GeoAttend (Settings › Battery) | % |
| Phone temperature | Warm or hot |
| Mobile data used | MB |

The location interval is set per company (`updateIntervalSec`, default 30 s). If use is too high, try 60 s and repeat. There is no measured figure yet, so none may be quoted to customers.

## G. Camera and photos

| # | Do | Pass when |
|---|---|---|
| G1 | Capture in low light, front and back camera | Usable photo; size under the limit |
| G2 | Compare with the enrolled face (same person) | Match |
| G3 | Capture a different person | Goes to manager review, not silently accepted |
| G4 | Supervisor rejects it with a reason | Not counted; the employee sees the reason in History |
| G5 | Owner overrides the rejection | Counted again; history shows both |
| G6 | Storage full on the phone, then capture offline | Clear failure, never a false "saved" |
| G7 | Server storage outage | Saved for later and retried |

## H. Results sheet

Copy one per phone.

| Field | Value |
|---|---|
| Tester, date | |
| Brand, model | |
| Android version, skin version | |
| App version, build | |
| Battery settings applied | |

| Section | Passed | Failed | Not tested | Notes, ticket numbers |
|---|---|---|---|---|
| A First use | | | | |
| B Permissions | | | | |
| C With a connection | | | | |
| D Offline | | | | |
| E Background | | | | |
| F Battery | | | | |
| G Camera | | | | |

**Release rule:** the app may not be described as working offline, or as tracking in the background, on a phone brand until sections D and E have passed on that brand.
