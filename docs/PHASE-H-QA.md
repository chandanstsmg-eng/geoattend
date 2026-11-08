# Phase H: independent final QA

Run on 7 November 2026 on branch `phase-h-final-qa`, from `production-remediation` at `b2639ec`. Nothing was deployed, the live database was not touched, and payroll stayed off.

**How it was done.**
- **Isolated stack:** a fresh restore of the day's backup, running the branch's code on its own ports.
- **Independent testers:** four testers, each with no knowledge of the earlier phases, worked in parallel on separate tracks:
  - the full workflow plus GPS and attendance cases;
  - calculations and exports;
  - security and permissions;
  - a code audit of every product area and the Android app.
- **Test companies:** the testers created their own new companies through sign-up and drove the running API as the dashboard and the phone app would. They checked every result against the database and against figures they worked out themselves.
- **Browsers:** each browser was opened in its own engine.

**What this is not.** No phone, emulator, Safari or production domain was available. The phone was simulated at the API level, so real GPS hardware, operating-system permission dialogs, background tracking and battery behaviour are **NOT VERIFIED**.

## Results by area

| Area | Result |
|---|---|
| Workflow, steps 1–18: sign-up to CSV export | PASS |
| Workflow, step 19: history after later edits | FAIL, then fixed (H8) |
| GPS and attendance cases: 19 kinds | PASS after H4 |
| Permissions, 189 routes, IDOR across 3 companies | PASS |
| SQL injection, stored XSS, CSRF, CORS, JWT, refresh, lockout, uploads, audit, operations token | PASS |
| Hours, lateness, overtime, rounding, weekly limit, voided and pending records, corrections, monthly summary | PASS, about 250 checks against independent arithmetic |
| Dashboard against raw SQL | PASS after H9 and H10, except the gaps listed below |
| CSV exports: columns, totals, filters, formula injection, scope | PASS |
| Payroll stays off | PASS. One read-only route still answers; see LOW items |
| Chrome 156, Edge 156 | PASS. Console errors and 4 axe nodes come from Google Maps' own code and its refusal of the test key |
| Firefox (Playwright build 159, not stock Firefox) | PASS, 199/199 |
| WebKit (Playwright build, not Safari) | PASS after H7. In WebKit, Tab skips links unless the user changes a setting, which is Safari's default |
| Safari, real Firefox, real Android phones, Google Maps with the real key | NOT VERIFIED |
| Crash recovery: API killed mid-run | PASS. No data lost, no job stuck, 12 of 15 jobs ran within 16 s of restart |
| Backup | PASS. Fresh backup, restore proven, 96/96 tables match |
| Off-machine backup, Linux shutdown, external monitoring | BLOCKED |

## Defects found and fixed

All fixes have tests in `apps/api/test/final-qa.test.ts`, and each test was shown to fail when its fix is undone. The exception is H7, which was checked in WebKit: the page failed on 7 of 8 loads before the fix and 0 of 8 after.

| # | Severity | Defect | Fix |
|---|---|---|---|
| H1 | CRITICAL | Removing a started roster entry deleted it outright unless a tracked session existed. Past absences vanished and rates rose after the fact. Two testers found this independently | A started entry now ends yesterday; only an entry not yet started is removed |
| H2 | CRITICAL | A supervisor could enter counted attendance alone, with any length (24 h for a 2.5 h shift), with no owner approval | Worked time cannot exceed the shift. A supervisor's entry is pending and not counted, and only an owner can approve it, as with supervisor corrections |
| H3 | HIGH | Manual attendance could be dated in the future, and it counted | Future dates and times are refused |
| H4 | HIGH | A revoked phone could still send locations and permission reports, keeping a shift alive | All 11 phone shift actions check the phone is still approved |
| H5 | HIGH | An SOS went to the home workplace's supervisor, not the one where the employee was working | The SOS follows the open shift's workplace and roster manager; owners are told as before |
| H6 | HIGH | No password recovery for administrators; a sole owner who forgot their password was locked out permanently | Owners can reset another administrator, from the Supervisors page or the API. A server operator can reset a locked-out owner with `npm run admin:reset-password -w @geoattend/api -- <email>`. Both are audited |
| H7 | HIGH | In WebKit, the map page showed "This page could not be shown" when Google Maps failed. This was a Phase G regression: the switch to the fallback diagram unmounted Google's markers, which throw in that engine | An error boundary around the map stays mounted across the switch and shows the diagram |
| H8 | MEDIUM | The attendance CSV rewrote past local times when a shift's time zone changed | Uses the shift's time zone of that day |
| H9 | MEDIUM | The attendance rate counted work on holidays and leave days as present but not as expected | Those days are left out of both |
| H10 | MEDIUM | The dashboard's pending corrections left out supervisor corrections waiting for an owner | Counted for owners, as in Approvals |

## Needs a decision

| # | Severity | Issue | Options |
|---|---|---|---|
| D1 | HIGH | If a phone loses the answer to a token refresh and retries more than 60 s later, the server treats it as token theft and signs it out, which stops tracking mid-shift on a poor network | (a) Keep it as is: strongest theft detection. (b) Accept a late retry while the newer token has never been used, which weakens theft detection. (c) Keep the server as is, and let the phone keep queuing readings while signed out, then send them after sign-in; this changes tracking code that has not been run on a phone. No option was applied, because each trades security against field reliability |
| D5 | MEDIUM | A slow network during check-in saves the record as offline, so it is pending until a person approves it | This follows the decision that late records are never verified automatically. Changing it means telling a timeout apart from being offline |
| M2 | MEDIUM | From Phase G: after an offline cold start, Continue shift and End shift are not reachable | Persist the shift assignment on the phone |

## Open, not fixed

**MEDIUM**
- **Half-day leave:** arriving for the second half is marked late, and a half-day leave day drops out of the expected shifts entirely.
- **Administrator passwords:**
  - A new administrator is signed out about 15 minutes after choosing their password.
  - Administrators cannot change a password that is not temporary.
  - There is no e-mail self-service reset, which needs working SMTP.
- **Approvals routing:** reviews, leave and phones follow the employee's home workplace, while offline records and face checks follow the record's workplace.
- **Long date ranges:** past 62 days, attendance figures are capped but hours are not, and nothing says so.
- **Leave:** approved leave cannot be cancelled or corrected by an administrator.
- **Reactivation:** reactivating an employee turns their time away into absences.
- **Roster backdating:** entries can be backdated without limit, by supervisors too.
- **Corrections:**
  - An owner can relabel any record as GPS-verified.
  - A check-out cannot be corrected.
  - Rejecting a late-sent shift end voids a GPS-verified check-in.
  - A manual record with no hours counts as present with 0 hours.
- **Weekly overtime:** it changes with the workplace or supervisor filter for people working at two sites.
- **Phone:**
  - Push tokens are not removed on sign-out or when a phone is revoked.
  - A refusal (waiting for approval, password change) is shown as "Offline".
  - No push arrives after a fresh install until the app restarts (Android 13+).
- **SOS:** administrators marked away get no SOS push.

**LOW**
- **Dashboard and reports:**
  - The per-workplace rows leave out disabled workplaces, so they don't add up to the headline.
  - The overtime page includes simulated data by default.
  - The bell and the inbox count unread differently.
  - The dashboard's employee filter does not narrow "overtime pending".
  - Several Reports exports drop the supervisor filter.
- **Security hardening:** a refresh reused within 60 s gets a new token (by design, see D1). The dashboard's security policy allows inline scripts; no injection point was found.
- **Payroll leftovers:** `GET /payroll/pay/:id` and the payslip page still answer while payroll is off. Both are read-only and owner-only.
- **Small workflow gaps:**
  - A resolved SOS can be resolved again.
  - Tasks can be assigned to deactivated employees.
  - A workplace announcement reaches only employees based there.
  - A workplace can be created at 0,0, where readings are always refused.
- **Rounding:** `hours.csv` rounds each row to 0.01 h, so the column total drifts slightly from the exact minutes.
- **Phone:**
  - The break reminder survives the end of a shift.
  - Preview builds can ship with no server address.
  - Every notification tap opens the shift screen.
  - Home's holiday check uses the phone's date.
- **Map ID:** none is configured; production needs a real one for advanced markers.
- **Duplicate request:** the supervisor's notifications page fetched two counts twice in one measurement.

**By design, not a defect:** an owner or supervisor can change an overtime decision with "Change decision". It is audited and blocked once a payroll month is closed.

## Performance (sample company, 42 employees, 90 days)

| Measure | Result |
|---|---|
| Page loads, 94 at 3 widths, owner and supervisor | 0 failed, 0 axe violations, no sideways scrolling, mostly 0.8–1.7 s; map 2.4–3.7 s (Google's script) |
| 90-day dashboard | about 490 ms |
| 90-day attendance CSV, 512 KB | 214–231 ms (198 ms before H8, within noise) |
| Monthly report | about 145 ms |
| 500 employees, 200 attendance rows | 6 ms, 28 ms |

Larger companies are not measured. The sample has 42 employees and about 2,900 shifts.

## Finalisation: resolution of the open findings (8 November 2026)

Every fix below has a test in `apps/api/test/final-qa.test.ts` or `apps/mobile/src/lib/api/auth-rules.test.ts`. Each API fix was undone on its own to confirm its test then fails.

### D1: a lost token refresh (HIGH), resolved

**What happened before.** If a refresh reached the server but the phone never got the answer, the phone kept its old token. The server accepted a retry only within 60 seconds; after that it treated the old token as stolen, revoked every sign-in of that phone, and tracking stopped.

**The fix, which does not loosen theft detection:**
- **The phone** creates a one-time request id for each refresh and saves it before sending. It repeats that id only when retrying the same refresh, and clears it on success or sign-out. Refreshes still run one at a time.
- **The server** stores the new token encrypted with AES-256-GCM. The key is derived from the old raw token and that request id. Raw tokens are stored only as hashes, so a copy of the database cannot open it.
- **A true retry** (same old token, same request id, new token not yet used, account active, sign-in not revoked) gets the *same* new token back. No second live token is created, and nothing is logged as theft.
- **Everything else is unchanged.** An old token without the matching id, or after its new token has been used, still revokes the whole family and is audited as reuse. Sign-out, revocation, deactivation and expiry still end the sign-in.
- **Queued records:** check-ins, check-outs and readings stay on the phone across a sign-out and are sent after the next sign-in (unchanged).
- **A further hole closed:** the new tests showed that, within 60 seconds of a refresh, an old token could revive a sign-in that had just been signed out. The 60-second retry now also requires the newer token to be still valid.
- **Database:** migration `030_refresh_redelivery` adds two nullable columns to `refresh_tokens`. Rollback: `docs/migrations/030_rollback.sql`.
- **Compatibility:** older app builds send no request id and behave exactly as before.

**Not verified on a phone.** This is tested on the server and in the phone's rule tests only.

### Half-day leave: rules confirmed and pinned by tests
| Situation | Monthly summary and payroll basis | Dashboard rate |
|---|---|---|
| Worked on a paid half day | 0.5 present, 0.5 paid leave | Left out of expected and present |
| Did not work on an unpaid half day | 0.5 unpaid leave, 0.5 absent | Left out |
| A half day across two dates | Refused (`BAD_RANGE`) | — |

**Not decided, and not invented:** a leave request records only "half day", not which half, so the system cannot know whether a 13:00 arrival is late. A late arrival is still marked as on any other day. Deciding it needs a business rule, such as recording first or second half on the request.

### Analytics and exports, resolved
- **Long ranges:** attendance figures now cover the whole range, up to a year (366 days), so they always describe the same days as hours. A longer request is answered for its latest year: the response gives the period covered (`from`) and the one asked for (`requestedFrom`), and sets `limited`. The custom range picker stops at a year.
- **Supervisor filter:** it now applies to the attendance, absences and daily-summary exports and to the monthly summary and its CSV. The monthly summary also follows the employee filter. The Reports page says so.
- **Dashboard employee filter:** it now narrows pending overtime and pending corrections.
- **Scope unchanged:** these exports remain owner-only, and supervisors still get 403.

### Other findings resolved
| # | Finding | Fix |
|---|---|---|
| AT1 | An owner could relabel any record as GPS-verified | Refused with `NOT_GPS_VERIFIED`; only the phone and server set it. The option is shown only for records already verified |
| AT4 | A manual record without hours counted as present with 0 hours | Hours are required, up to the shift's length |
| R2 | Reactivating an employee turned their time away into absences | Deactivation ends roster entries on the last working day and removes ones not started; the owner rosters them again on return |
| R3 | Rosters could be backdated without limit, by supervisors too | Only the owner can roster a past day |
| A2 | A new administrator was signed out about 15 minutes after choosing a password | This browser gets a fresh sign-in; every other sign-in still ends |
| D2 | Push tokens survived sign-out and revocation | Cleared on phone sign-out, revocation and replacement |
| S1 | Administrators marked away got no SOS | An SOS ignores "away" |
| LOW | An SOS could be resolved twice; tasks could go to deactivated employees; `GET /payroll/pay/:id` answered with payroll off | Refused (`ALREADY_RESOLVED`, `INACTIVE_EMPLOYEE`, `PAYROLL_DISABLED`) |

### Deferred on purpose
| # | Severity | Finding | Impact | Reason |
|---|---|---|---|---|
| Half-day lateness | MEDIUM | Second-half arrivals are marked late | Late counts can be high for half-day leave | Needs a business rule; the data does not say which half |
| OT1 | MEDIUM | Weekly overtime differs in workplace- or supervisor-filtered views for people working at two sites | Those filtered views only. Company-wide figures, the monthly summary and the payroll basis see every site and are correct | The fix changes the core hours engine shared by every report; too risky to change at the end of QA without a dedicated pass |
| SC1 | MEDIUM | Approvals routes some items by the employee's home workplace and others by the record's workplace | A supervisor of the other site may not see an item; owners always do | It changes authorization scope across Approvals and needs its own design and tests |
| L1 | MEDIUM | Approved leave cannot be cancelled or corrected by an administrator | A mistaken leave stays | It needs a rule for cancelling leave already taken, which affects payroll |
| AT2 | MEDIUM | A check-out cannot be corrected | Workaround: void the record and enter it manually | New correction field and rules |
| AT3 | MEDIUM | Rejecting a late-sent shift end voids a GPS-verified check-in | The whole day is lost to a late end | The pending-record flow needs a "reject the end only" decision |
| D5 | MEDIUM | A slow network during check-in saves the record as pending | A person must approve it | This follows your rule that late records are never verified automatically |
| M2 | MEDIUM | Offline cold start: Continue and End shift unreachable | — | Waiting for a decision (Phase G) |
| D3, D4, D6–D9 | MEDIUM and LOW | Phone wording and push timing | — | Phone UI changes cannot be verified without a device |
| Admin password | LOW | No dashboard menu to change a non-temporary password; no e-mail self-service reset | Owners can reset others; an operator can reset an owner | The e-mail reset needs working SMTP |
| AN2, AN3, N1 | LOW | Disabled-workplace rows, the simulated-data default on Overtime, and unread counts | Small reporting differences | Low impact |
| Null island, rounding, CSP, Map ID, duplicate request | LOW | See the LOW list above | — | Configuration, or no user effect |
