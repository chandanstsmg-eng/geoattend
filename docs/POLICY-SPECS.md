# Business policy specifications: waiting for approval

These are implementation specifications for the four rules in [POLICY-DECISIONS.md](POLICY-DECISIONS.md), in the direction chosen on 11 November 2026. **Nothing here is implemented.** Each rule ships alone, with its own tests and a full regression run, after approval.

Throughout, **"refused"** means the API answers 409 with the code given, the screen shows the message, and nothing is written.

---

## 1. Extra-day attendance

**What happens today.** `POST /api/v1/attendance/manual` takes an employee, shift, date, arrival time, worked minutes and a reason of at least 5 characters. It works on any date the employee is assigned to the shift, including a day the shift does not run. Lateness is measured against the shift's start.
- An owner's entry counts at once (`MANUAL_APPROVED`).
- A supervisor's entry waits for the owner (`PENDING_VERIFICATION`).
- The roster lists only the days a shift runs. So an entry on a day off counts as hours, but never as a present or expected day.

**Rule.**
1. The server decides whether the date is a working day for that shift: `days_of_week`, as it was on that date (`shift_revisions`).
2. **On a working day nothing changes.**
3. **On a non-working day**, the request must contain `extraDay: true`. Otherwise it is refused:
   - code `NOT_A_WORKING_DAY`;
   - message: "This shift does not run on <weekday>. To record work on a day off, add it as an extra day."
4. An extra day is **owner-only**. A supervisor gets 403 `EXTRA_DAY_OWNER_ONLY`; the supervisor can ask the owner to add it.
5. **The reason is mandatory**, 10 to 1,000 characters, for example "Stocktaking on Sunday". It is stored in the audit log, as for every manual entry.
6. **How the record is stored:**
   - verification status `MANUAL_APPROVED`, with the owner as approver;
   - `is_late` false and `late_by_minutes` 0;
   - flags `ADMIN_ENTERED` and `EXTRA_DAY`, in the existing `risk_flags` list.
7. **Audit:** action `attendance.extra_day`, with the reason, the full record and the weekday.

**Effect on reports and payroll.**
- **Hours and overtime:** no change. The worked minutes count as worked time, and the weekly overtime rule applies as it does to any other record.
- **Attendance rate and lateness:** an extra day is not an expected day, so the rate and punctuality are unaffected.
- **Monthly summary:** a new column "Extra days".
- **Day overview:** a row "Extra day" for that date.
- **Payroll:** no change to the calculation code. Whether an extra day earns a premium is a payroll setting for later (payroll stays off).

**Schema change:** none.

**Tests:**
- a working-day entry is unchanged;
- a day off without `extraDay` is refused;
- a supervisor is refused;
- the reason is required, and too short is refused;
- an extra day is never late;
- hours include it, and the rate does not;
- the audit row is written;
- a shift revision changes which days are working days;
- company isolation (another company's employee or shift answers 404).

**Files:**
- `attendance/attendance.routes.ts` and `attendance/attendance.service.ts` (`createManualAttendance`);
- `reports/reports.routes.ts` (monthly summary);
- dashboard: the manual-entry form and the monthly table;
- tests.

**Question for you:** may an employee also check in from the app on a day off, or only an owner record it? The recommendation is owner-recorded only.

---

## 2. Leave on a day that already has attendance

**What happens today.** Leave is refused only when it overlaps other pending or approved leave. Attendance on those days is not checked. A half-day leave on an attended day removes that day from both expected and present on the dashboard.

**Rule.**
1. **Full-day leave**, whether requested by an employee, recorded by an administrator or approved from pending, is refused when any date in the range has attendance that is not voided:
   - this includes records still waiting for verification;
   - code `LEAVE_ON_ATTENDED_DAY`;
   - message: "<Name> has attendance on <dates>. Correct or void that attendance first, or choose a half day."
   - The answer lists each record (id, date, shift, status) so the screen can link to them.
2. **The check runs again at approval**, because attendance can appear between the request and the decision.
3. **Half-day leave** on an attended day is **allowed**. That is its purpose: worked half a day, on leave for the other half. Proposed handling:
   - the day counts as **present** and as **expected**, so it is in the attendance rate;
   - it shows as "Half-day leave" on the roster and in the monthly summary, as leave 0.5 days;
   - **lateness:** today the arrival is measured against the shift start. The recommendation is to keep that, because there is no morning or afternoon marker on a half day. Measuring from the middle of the shift needs that marker added, which is a schema change.
   - Half-day leave on a day **without** attendance stays as today: not expected, not absent.
4. **The reverse case** (attendance arriving on a day of approved full-day leave) is not refused: the person came to work. The record is flagged `ON_APPROVED_LEAVE`, and the approver is notified to cancel or shorten the leave.
5. **Days already counted twice** stay as they are. A read-only report lists them for you to correct one by one.
6. **Audit:** a refusal changes nothing, so it is not audited. Approvals and recordings are audited as today.

**Effect on payroll:** none on the calculation code. Leave days and worked days no longer overlap, which is what payroll will need.

**Schema change:** none.

**Tests:**
- employee request, administrator recording and approval are each refused on an attended day;
- a pending record also blocks;
- a voided record does not block;
- a half day is allowed and counts as present and expected;
- a multi-day range with one attended day is refused and names that day;
- attendance created after the request makes the approval refuse it;
- check-in on a leave day is flagged and the approver notified;
- the overlap report;
- company isolation.

**Files:**
- `leave/leave.routes.ts` (`validate`, record and decide);
- `attendance/attendance.service.ts` (the flag on check-in);
- `reports/reports.routes.ts` and `reports/analytics.routes.ts` (half-day counting);
- dashboard: the leave forms and approvals;
- mobile: the leave request message;
- tests.

**Question for you:** confirm the half-day counting (present and expected), and that lateness stays measured from the shift start.

---

## 3. Suspicious GPS readings

**What happens today.**
- **Before check-in**, one reading classed as outside re-locks attendance at once.
- **After check-in**, leaving needs several readings over a set time: `exitStabilizationSec` and `exitMinReadings` in Settings › Tracking.
- There is no speed check. A reading 50 km away one second after one at the gate is accepted.
- Mock-location readings block the check-in only.

**Rule.**
1. **Confirmation before check-in.** In `ATTENDANCE_READY` and `ATTENDANCE_SUBMISSION_PENDING`, an outside reading starts an exit candidate, as it does after check-in. Attendance re-locks only when the existing exit rule is met.
   - An inside reading cancels the candidate.
   - A submission pending at that moment is cancelled only when the exit is confirmed.
   - This is in `tracking/engine.ts` only. The demo simulator uses the same engine.
2. **Impossible jumps.** For each reading, the server compares it with the **last reading that was not flagged** in the same session:
   - the distance between the two;
   - the device-time difference, at least 1 s;
   - so the implied speed.
   - Above **150 km/h**, a new company setting with that default in Settings › Tracking, the reading is a jump.
   - Readings with poor accuracy already count as uncertain and are not compared.
3. **A jump is stored, flagged and kept. It is never discarded.** The reading is saved in `location_updates` like any other, with its flag and implied speed. It does not take part in automatic decisions: arrival, departure, outside alerts and the live map position. The next reading is compared with the last good one, so a single jump cannot make the following readings look like jumps.
4. **Audit and visibility:**
   - every flagged reading writes an audit row, `location.implausible_jump`, with the session, the reading, the implied speed and the last good reading;
   - the employee's trail shows flagged points greyed out, with "Ignored: implied 1,240 km/h";
   - managers get **one** notification per session when the first jump is flagged ("GPS jumps on <name>'s phone; ignored"), not one per reading.
5. **Mock locations:** unchanged. The check-in stays blocked and the reading stays stored with `is_mocked`. Mock readings would also be excluded from automatic decisions the same way, if you approve that.

**Schema change: needed, and only for rule 3.** A new migration (031) would add two columns to `location_updates`:
- `suspect_reason TEXT NULL`;
- `implied_speed_kmh REAL NULL`.

Nullable columns are added without rewriting the table, and the rollback drops them. Without this change, the flag could live only in the audit log, which makes the trail and the reports slower and more awkward to build. **It needs your approval as a schema change.**

**Tests:**
- in the engine, one outside reading before check-in no longer re-locks, a confirmed exit still does, and an inside reading cancels the candidate;
- a 150 km/h boundary on both sides;
- a jump is stored and flagged but changes no state;
- the reading after a jump is compared with the last good one;
- the audit row is written, and only one notification goes out per session;
- poor-accuracy readings are not compared;
- the simulator gives unchanged results;
- the existing 40 GPS tests still pass.

**Files:**
- `tracking/engine.ts`, `tracking/tracking.service.ts` (`ingestLocked`);
- settings (the new limit);
- migration 031 and its rollback;
- the trail view (`employees.routes.ts`, `tracking.routes.ts`) and the dashboard trail;
- tests.

**Question for you:** is 150 km/h right? It allows a fast highway, and GPS noise when stationary is far above it.

---

## 4. Supervisor visibility

**What happens today.** A supervisor's scope is their workplaces (`administrator_profiles.site_ids`). They see everyone working at those workplaces, including employees whose assigned supervisor (`employee_profiles.supervisor_id`) is someone else. This scope is applied in 99 places across 24 API files. Owners see the whole company. Company isolation is separate and unaffected.

**Rule, as instructed: "assigned employees and workplaces only; owner retains company-wide access".**
1. **Owner:** unchanged, company-wide.
2. **Supervisor:** sees an employee's records only when **both** of these hold:
   - the employee is assigned to them (`supervisor_id`);
   - the record's workplace is one of their workplaces.
3. This covers:
   - attendance, corrections and approvals;
   - leave and overtime;
   - reports, exports and the dashboard;
   - notifications;
   - employee details, faces, devices and tasks.
4. **One shared definition.** A single function says "who this caller may see" and replaces the workplace-only check in all 99 places, so the rule cannot drift between screens.
5. **The live map, today's headcount and SOS:** see question (b) below. The recommendation is site-wide, showing names and status only, for physical safety.
6. **An employee with no assigned supervisor** is visible only to owners. A list shows those employees, so nobody is left unsupervised by accident.
7. **Approvals when a supervisor is away:** they go to the owner after 24 hours, as today.

**Schema change:** none. `employee_profiles.supervisor_id` already exists and is indexed.

**Tests:**
- supervisor A cannot see, approve or export supervisor B's employee at a shared workplace;
- A still sees their own;
- an employee moved to another supervisor changes scope immediately;
- an employee with no supervisor is owner-only;
- the owner is unchanged;
- each of the 24 files' routes is checked with a cross-supervisor call (the same pattern as the 121 isolation tests);
- the live map follows the answer to question (b).

**Files:** `lib/tenancy.ts`, `lib/auth.ts`, the 24 route files listed by `grep "user.sites"`, the dashboard filters, and tests. This is the largest of the four changes.

**Questions for you:**
- **(a)** "Assigned employees and workplaces": does a supervisor see the employees assigned to them **at their workplaces** only (recommended), or their employees anywhere, plus everyone at their workplaces?
- **(b)** Do the live map, today's headcount and SOS stay site-wide (recommended, for safety), or follow the same rule?

---

## Order and size

| Order | Rule | Size | Schema change |
|---|---|---|---|
| 1 | Leave on attended days | Small | No |
| 2 | Extra-day attendance | Small | No |
| 3 | Supervisor visibility | Large | No |
| 4 | Suspicious GPS readings | Medium | **Yes** (migration 031, two nullable columns) |
