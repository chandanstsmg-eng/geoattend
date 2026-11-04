# Database migrations

Migrations are the numbered files in `apps/api/src/db/migrations`. Each runs once, in its own transaction, and the API applies pending ones at start-up. **Restarting an API that has a new migration file applies it**, so a merge changes any database that server uses.

Before applying one to a database that matters, follow "Before any risky migration" in [RUNBOOK.md](RUNBOOK.md).

## 021_attendance_and_payroll_history

Keeps history that later edits used to rewrite. Rollback: [migrations/021_rollback.sql](migrations/021_rollback.sql).

| Table | Change | Existing rows |
|---|---|---|
| `employee_profiles` | Adds `joined_on`, `left_on` and a check that they are in order | `left_on` filled for inactive employees, from the deactivation audit entry |
| `workplaces` | Adds `deactivated_on` | Filled for disabled workspaces from `updated_at` |
| `shift_revisions` | New table: a shift's definition before an edit | One row per disabled shift |
| `attendance_records` | Adds `original_recorded_at`, `approved_by`, `approved_at`, `manual_worked_minutes` | Unchanged; columns stay empty |
| `payroll_runs` | Adds `revision`, `superseded_at`, `superseded_by`, `supersede_reason` | All become revision 1 |
| `payroll_runs` | **Not additive:** `UNIQUE (org_id, month)` is replaced by a unique index over current runs | No data changes |
| `payroll_runs`, `payslips` | Triggers refuse `DELETE` | None |
| `attendance_work` (view) | Scheduled minutes come from the session; away time before arrival is not deducted; manual records use entered minutes | Same columns |

Limits:

- `joined_on` is not filled for existing employees, so they are not prorated until someone enters the date.
- Deactivation dates assume `Asia/Kolkata` for the backfill.
- Rollback removes anything written to the new columns, and refuses to run once a month has been reopened. In that case restore the backup.

## 022_device_history_and_final_voids

Rollback: [migrations/022_rollback.sql](migrations/022_rollback.sql).

| Table | Change | Existing rows |
|---|---|---|
| `device_registrations` | `status` now defaults to `PENDING` | Unchanged: approved phones stay approved |
| `device_status_history` | New table, written by a trigger on every status change | One row per phone recording its current status |
| `attendance_records` | Trigger refuses any change away from `VOIDED` | Unchanged |
| `review_requests` | Unique index: one open dispute per record | Unchanged. The migration stops if a record has two open disputes |

Limit: a mistaken void cannot be undone by anyone, including the owner. Migration 023 adds one exception, for rejected face checks.

## 023_face_rejection_override

Rollback: [migrations/023_rollback.sql](migrations/023_rollback.sql). **Not applied to any live database yet.**

| Object | Change | Existing rows |
|---|---|---|
| `attendance_records` | `verification_status` also allows `PENDING_VERIFICATION` | Unchanged |
| `attendance_void_is_final()` | Also allows the restore when a face check or offline record was rejected and the owner's override set `geoattend.face_override` for that transaction | Unchanged |

Every other void stays final. The override is the only code that sets the value, and it records the whole record before and after in review history and the audit log. Rolling back removes the exception and refuses to run while any record is waiting for verification; records already restored stay restored.
