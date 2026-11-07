# Pending verification

Work that is built and passes automated tests, but has **not** been checked the way a person would use it. None of it may be reported as verified until it is signed off here. Critical attendance workflows must pass before production.

## Open production blockers

Phases E, F and G are merged for development only. None of these is done, and production must wait for all of them.

| Blocker | Status | What it needs |
|---|---|---|
| Linux SIGTERM and graceful worker shutdown | BLOCKED | A Linux machine. Only Windows has been tested, and this one has no WSL or Docker. Steps: [RUNBOOK.md](RUNBOOK.md), "Checks only a Linux server can pass" |
| Off-machine backups | BLOCKED | Storage away from this computer, on a schedule. Every backup is on one disk |
| External monitoring and alert delivery | BLOCKED | An outside monitor, a real alert webhook or mailbox, and someone on call. An alert has only reached a local test process |
| Real SMTP, push and WhatsApp delivery | NOT VERIFIED | Real credentials and a real delivery to a person. No test against a local server or a simulated provider counts |
| Physical Android devices | NOT VERIFIED | Real phones, following [ANDROID-DEVICE-TEST-PLAN.md](ANDROID-DEVICE-TEST-PLAN.md) |
| Real production browser testing | NOT VERIFIED | The browser checks below, on the production domain, including Firefox and Safari |
| Google Maps with the real key | NOT VERIFIED | The real key on the production domain. The key refuses every test address, so only the diagram fallback has been seen |
| Attendance workflows by hand | NOT VERIFIED | A person walking through the critical rows in the table below |

## Phase H decisions waiting

See [PHASE-H-QA.md](PHASE-H-QA.md). D1 (a lost token refresh on a poor network signs the worker out and stops tracking) is HIGH and needs a decision before production. The MEDIUM and LOW items listed there are open.

## Known gaps in the interface

Open after Phase G. Neither hides or alters a record, but both can mislead a supervisor.

| Gap | Effect | What it needs |
|---|---|---|
| Supervisor approval pagination | Pending records in Approvals and the Reviews list stop at 200 rows with no notice. Approvals shows the oldest 200, so newer ones wait until those are cleared. Reviews shows the newest 200, so older ones are hidden | Paging, or at least a notice, on both lists |
| Supervisor employee filter | On the supervisor overview, the employee filter does not narrow pending approvals or the attention counts. Pending approvals says "whole team". The Right now tiles count that employee, but open a map of the whole team | Filtering those counts by employee in the API, and an employee filter on the map |
| Roster prepared statement | A migration that changes the type of a column the roster query returns gives "cached plan must not change result type" on open connections until they recycle. It also needs a direct or session-mode database connection, which company isolation already requires. Its speed is measured on 42 employees only | Restart the API after such a migration. Measure at real company sizes |

## Browser checks (Phase G)

Phase G opened every page in headless Chrome on Windows, as owner and supervisor, at phone, tablet and desktop widths, with sample data. That covers layout, keyboard use, accessibility and whether figures match the API. **The attendance workflows in the table below were not walked through by a person**, so they stay open:

| Area | Check | Critical |
|---|---|---|
| Sign-in | Temporary password forces the change-password screen, for owner and supervisor | Yes |
| Corrections | Supervisor sends a correction; record unchanged; owner sees it in Approvals, applies or rejects it; history shows who asked and who decided | Yes |
| Face review | Supervisor rejects with a reason; record not counted; owner overrides it from the record; audit shows both | Yes |
| Voided records | Disappear from every attendance, hours, overtime and pay figure, and stay visible in records | Yes |
| Offline records | Shown as pending in Approvals with phone time and evidence; approve and reject work for a supervisor; owner can override a rejection | Yes |
| Overtime | Overtime on a voided shift leaves the queue and totals | Yes |
| Pending hours | A pending record shows its label and "pending, not counted" on the attendance list and the board; hours and monthly reports show pending apart; approving moves it into the totals | Yes |
| Business time | With the computer set to another time zone, the dashboard still shows Indian times and today's Indian date; a manual record entered at a given time is stored as that time in India | Yes |
| Date ranges | "This month" and "Last month" give the right dates just after midnight in India | No |
| Photos | Delete button hidden for supervisors, works for owners with a reason | Yes |
| Retention | Settings shows the hold; the checkbox is disabled; "Run retention now" reports photos kept | No |
| Privacy page | Says photos are not deleted automatically yet | No |
| Offline setting | "Accept offline check-ins for (hours)" saves and takes effect | No |
| Google Maps | Real map on the production domain | No |

- Real Google Maps: the key refuses every address tested so far, so markers, geofence circles and workplace labels on a real map are not checked. Only the diagram fallback is.
- The phone screens changed in Phase G (Home, status card, success screen, History) were checked by typecheck and unit tests only. Nothing has run on a phone or emulator.
- The operations page (`/operations`): checked in headless Chrome 156 on Windows against development data only. Firefox, Safari and a production domain are not checked.
- The three new summary options in Settings: seen, and off by default, in the same browser. Turning one on and a summary reaching someone are not checked.

## Phone checks (QA stage: before release)

- A real push reaching a phone, including a shift reminder and the weekly summary, and the Shift reminders switch on the Account screen.


See [ANDROID-DEVICE-TEST-PLAN.md](ANDROID-DEVICE-TEST-PLAN.md). Nothing has been run on a real phone: Xiaomi, Oppo, Vivo and Samsung are all NOT VERIFIED. The Phase D APK must not be distributed, because its server address is a placeholder.

## External services

See [EXTERNAL-DEPENDENCIES.md](EXTERNAL-DEPENDENCIES.md): cloud S3, Docker, Google Maps, GitHub, legal review.

## Sign-off

| Area | Tested by | Date | Result |
|---|---|---|---|
| Browser checks | | | |
| Phone checks | | | |
| External services | | | |
