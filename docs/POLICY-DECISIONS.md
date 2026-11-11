# Business decisions waiting for approval

Four rules the software must not invent. For each: what happens today (checked in the code and through the API, 10 November 2026), the options, what each changes for employees, supervisors, reports and payroll, and a recommendation. **Nothing here has been implemented.** Each choice is small to build once decided, and each would come with tests.

Write the decision next to each one (option and date), and it will be implemented as written.

---

## 1. Manual attendance on a scheduled day off

**Today.** An owner or supervisor can enter manual attendance for any shift and date, including a day the shift does not run (for example a Sunday on a Monday–Friday shift).
- Lateness is measured against that shift's start, so a 12:00 entry is "late by 180 minutes".
- The overview for that Sunday then shows 1 late and 0 present: the day was not rostered, so nobody was expected.
- The monthly report counts the hours but no present day.
- Payroll (when enabled) would pay those hours but count no extra day.

| Option | Effect |
|---|---|
| A. Refuse it | Simple and consistent. But a real extra day (stocktaking, an emergency) cannot be recorded at all, so people will record it on a wrong date |
| B. Allow it as an **extra day**, owner only, with a reason. Never late; counted as worked time and shown as "extra day" in reports | Real extra work is recorded truthfully, and lateness and attendance rates are not distorted. The overtime rules decide how it is paid |
| C. Keep today's behaviour | Misleading figures, described above |

**Recommendation: B.** Supervisors are refused (only an owner may add an extra day); the record is marked "extra day" with no lateness; the hours count as worked time. The weekly overtime rule then applies as it does now. Payroll treatment needs your payroll adviser before payroll is enabled.

---

## 2. Leave on a day where attendance already exists

**Today.** Leave can be approved for a day the employee already has counted attendance on.
- The overview counts that person as both present and on leave.
- The monthly report shows the day as worked and no leave.
- The leave request still counts in "approved this year" on the Approvals screen. There are no leave balances in this release.

| Option | Effect |
|---|---|
| A. Refuse full-day leave where counted attendance exists; allow half-day leave (already supported) | No double counting. If the attendance was wrong, it must be corrected or voided first (audited), and then the leave is approved |
| B. Leave replaces the attendance (the record is voided automatically) | Convenient, but a manager's click silently removes worked time from hours and payroll. Hard to notice and to audit |
| C. Keep today's behaviour | The same day counts twice in different reports |

**Recommendation: A.** The refusal names the attendance record to correct, so the manager fixes the cause on purpose and the audit log shows who did what. Pending (unverified) attendance would block leave in the same way until it is decided.

---

## 3. A stray or inaccurate GPS reading

**Today.**
- Before attendance is recorded, a **single** reading classed as outside the geofence re-locks attendance at once ("left before attendance was recorded"). The employee must wait for the arrival check again.
- After check-in, leaving needs several readings over a set time (`exitStabilizationSec` and `exitMinReadings` in Settings › Tracking), so one bad reading does nothing.
- There is no check for physically impossible jumps: a reading 50 km away, one second after one at the gate, is accepted as a position.
- Readings with poor accuracy are already treated as uncertain, not as outside (`classifyReading`: "insufficient accuracy" or "ambiguous").
- Mock-location flags block the check-in only.

| Option | Effect |
|---|---|
| A. Apply the same confirmation before check-in as after it: re-lock only after the existing exit rule (several readings over time) | One bad reading no longer delays an honest employee. Someone who really leaves is still caught within the same minute or two |
| B. Also disregard readings that imply an impossible speed (for example over 150 km/h from the last good reading) for every decision; keep them stored, flagged, and visible to managers | Stops the false "left" and "outside" alerts caused by GPS jumps, without deleting evidence |
| C. Keep today's behaviour | Occasional false re-locks and false outside alerts, mostly on low-end phones and near tall buildings |

**Recommendation: A and B together.** Nothing is deleted: the jumpy reading stays in the history with a flag, and only the automatic decisions ignore it. The speed limit and the confirmation time would be company settings, with the current values as defaults. Whether mock-location readings should also drive alerts (today only the check-in is blocked) is a separate, smaller question; the recommendation is to flag them and never let them **record** attendance.

---

## 4. What supervisors can see

**Today.** A supervisor is given one or more workplaces. They see **everyone working at those workplaces**: live map, attendance, reports, exports, approvals and notifications. That includes employees whose assigned supervisor is someone else, since two supervisors can share a workplace (in the sample, two share Whitefield). An employee rostered at another workplace counts for the workplace where the work happened. Company isolation is separate and is not affected: no supervisor sees another company.

| Option | Effect |
|---|---|
| A. Keep site-based visibility (today) | Works for shift leads who cover a whole site and for absences ("who is not here?"). But a supervisor sees and can act on a colleague's team, including approvals and personal details |
| B. Own team only: employees whose supervisor is them, everywhere | Least access, and clear responsibility. But nobody covers a team while its supervisor is away (the owner's backup approval still works), and the live map of a shared site shows only part of the people there |
| C. Own team for records, approvals, exports and personal details; whole site for the live map and today's headcount (names and status only) | Each team's records stay with its supervisor, and site safety and coverage still work. A small, read-only overlap remains on the live map |
| D. A company setting choosing A or C | Each customer chooses; the default must still be decided |

**Recommendation: C, as the default, with D (a company setting) to allow A for companies that want site-wide supervisors.**
- Approvals, corrections, exports and employee details follow the reporting line: this is personal data, and India's DPDP Act expects access to be limited to the purpose.
- The live map and today's headcount stay site-wide, because physical safety (an SOS, who is on site) is a site question.

Before building it, decide who covers a supervisor's team when they are away: today the owner gets overdue approvals after 24 hours.

---

## Also waiting (from earlier reports)

Listed in [PHASE-I-READINESS.md](PHASE-I-READINESS.md):
- half-day leave lateness;
- slow-network check-ins (D5) and the offline cold start (M2);
- minimum overtime;
- supervisor-recorded leave approved at once;
- reversing decided leave;
- offline arrival time;
- owner notification of supervisor entries;
- leave for a deactivated employee;
- duplicate workplace names;
- same-day reactivation;
- server-side phone attestation (Play Integrity).
