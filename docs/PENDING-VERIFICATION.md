# Pending verification

Work that is built and passes automated tests, but has **not** been checked the way a person would use it. None of it may be reported as verified until it is signed off here. Critical attendance workflows must pass before production.

## Browser checks (QA stage: Phase G)

Not done. These passed builds and API tests only.

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

## Phone checks (QA stage: before release)

See [ANDROID-DEVICE-TEST-PLAN.md](ANDROID-DEVICE-TEST-PLAN.md). Nothing has been run on a real phone: Xiaomi, Oppo, Vivo and Samsung are all NOT VERIFIED. The Phase D APK must not be distributed, because its server address is a placeholder.

## External services

See [EXTERNAL-DEPENDENCIES.md](EXTERNAL-DEPENDENCIES.md): cloud S3, Docker, Google Maps, GitHub, legal review.

## Sign-off

| Area | Tested by | Date | Result |
|---|---|---|---|
| Browser checks | | | |
| Phone checks | | | |
| External services | | | |
