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
| Photos | Delete button hidden for supervisors, works for owners with a reason | Yes |
| Retention | Settings shows the hold; the checkbox is disabled; "Run retention now" reports photos kept | No |
| Privacy page | Says photos are not deleted automatically yet | No |
| Offline setting | "Accept offline check-ins for (hours)" saves and takes effect | No |
| Google Maps | Real map on the production domain | No |

## Phone checks (QA stage: before release)

See [ANDROID-DEVICE-TEST-PLAN.md](ANDROID-DEVICE-TEST-PLAN.md). Nothing has been run on a real phone.

## External services

See [EXTERNAL-DEPENDENCIES.md](EXTERNAL-DEPENDENCIES.md): cloud S3, Docker, Google Maps, GitHub, legal review.

## Sign-off

| Area | Tested by | Date | Result |
|---|---|---|---|
| Browser checks | | | |
| Phone checks | | | |
| External services | | | |
