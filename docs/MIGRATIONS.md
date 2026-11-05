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

Rollback: [migrations/023_rollback.sql](migrations/023_rollback.sql).

| Object | Change | Existing rows |
|---|---|---|
| `attendance_records` | `verification_status` also allows `PENDING_VERIFICATION` | Unchanged |
| `attendance_void_is_final()` | Also allows the restore when a face check or offline record was rejected and the owner's override set `geoattend.face_override` for that transaction | Unchanged |

Every other void stays final. The override is the only code that sets the value, and it records the whole record before and after in review history and the audit log. Rolling back removes the exception and refuses to run while any record is waiting for verification; records already restored stay restored.

## 024_pending_not_counted

Rollback: [migrations/024_rollback.sql](migrations/024_rollback.sql).

| Object | Change | Existing rows |
|---|---|---|
| `attendance_work_all` | New view: every record that is not voided, with its status | Unchanged |
| `attendance_work` | Same name and columns, now without records waiting for verification | Unchanged |

Views only. Reports, overtime and payroll inputs are built on `attendance_work`, so they count verified attendance only. Rolling back refuses to run while any record is waiting for verification, because it would start counting those records.

## 025_company_isolation

Rollback: [migrations/025_rollback.sql](migrations/025_rollback.sql). Details: [COMPANY-ISOLATION.md](COMPANY-ISOLATION.md).

| Object | Change | Existing rows |
|---|---|---|
| Role `geoattend_tenant` | New. Cannot log in, cannot bypass row-level security, owns nothing. Belongs to the server, not one database | None |
| `app_org()` | New function: the company of the current request | None |
| 45 company tables | Row-level security on, one policy each, access granted to the role | Unchanged |
| `attendance_work`, `attendance_work_all` | `security_invoker`, so they read with the caller's rights | Unchanged |

No row is changed and no table is rewritten; each table takes a brief exclusive lock. The tables stay owned by the migration user, which is not limited by the policies, so jobs and scripts behave as before.

The role is created once per server, so applying this migration to one database creates a role the other databases can see but do not use. Rolling back leaves it in place. A logical restore needs the role first: `npm run db:restore` creates it.
