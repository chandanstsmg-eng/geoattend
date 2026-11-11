/**
 * Backup approver: anything waiting more than a day for a decision (leave, an attendance
 * request, a record waiting for verification, a photo check, a correction, overtime, a new
 * phone) is raised to the company owners, so nothing stalls when a supervisor is busy or
 * away. Once per item (dedupe key). This only tells people: a decision is always a person's.
 */
import { getPool, q } from '../../db/pool.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { eachCompany, eachRecord, throwIfAny } from './runner.js';

const WAIT_HOURS = 24;

export const sweepOverdueApprovals = (now = new Date()) => eachCompany(() => overdueForCompany(now));

async function overdueForCompany(now: Date) {
  const items = await overdueItems(now);
  if (!items.length) return;
  const outbox = new Outbox();
  const failures = await eachRecord(items, async (it) => {
    const hours = Math.round((now.getTime() - new Date(it.created_at).getTime()) / 3600_000);
    await notify(getPool(), outbox, {
      type: 'APPROVAL_OVERDUE',
      severity: 'WARNING',
      body: `${it.full_name}'s ${it.what} has been waiting ${hours} hours for a decision. Open Approvals to answer it.`,
      employeeId: it.employee_id,
      data: { kind: it.kind, id: it.id },
      dedupeKey: `overdue:${it.kind}:${it.id}`,
    });
  });
  outbox.flush();
  throwIfAny(failures);
}

/** What the current company still has to be told about: waiting over a day, and not raised yet. */
export async function overdueItems(now = new Date()) {
  const cutoff = new Date(now.getTime() - WAIT_HOURS * 3600_000);
  // Items already raised are left out here (the same dedupe key notify() would refuse): otherwise every
  // run re-sent the whole backlog to notify(), one round trip each — 37 s for a 1,000-person company.
  return q(
    `SELECT x.* FROM (
     SELECT 'leave' AS kind, l.id, l.employee_id, u.full_name, l.created_at, 'a leave request' AS what FROM leave_requests l JOIN users u ON u.id = l.employee_id
       WHERE l.status = 'PENDING' AND l.created_at < $1
     UNION ALL
     SELECT 'review', r.id, r.employee_id, u.full_name, r.created_at,
            CASE r.kind WHEN 'DISPUTE' THEN 'an attendance dispute' WHEN 'MANUAL_REVIEW' THEN 'a request to be marked present' ELSE 'a technical issue' END
       FROM review_requests r JOIN users u ON u.id = r.employee_id
       WHERE r.status = 'OPEN' AND r.kind IN ('MANUAL_REVIEW', 'DISPUTE', 'TECHNICAL_ISSUE') AND r.created_at < $1
     UNION ALL
     SELECT 'device', d.id, d.user_id, u.full_name, d.created_at, 'a new phone' FROM device_registrations d JOIN users u ON u.id = d.user_id
       WHERE d.status = 'PENDING' AND u.is_active AND d.created_at < $1
     UNION ALL
     SELECT 'verification', ar.id, ar.employee_id, u.full_name, ar.created_at, 'attendance record sent late from the phone' FROM attendance_records ar JOIN users u ON u.id = ar.employee_id
       WHERE ar.verification_status = 'PENDING_VERIFICATION' AND NOT ar.is_simulated AND ar.created_at < $1
     UNION ALL
     SELECT 'photo-check', ar.id, ar.employee_id, u.full_name, ar.created_at, 'attendance photo check' FROM attendance_records ar JOIN users u ON u.id = ar.employee_id
       WHERE ar.face_review = 'PENDING' AND ar.verification_status <> 'VOIDED' AND NOT ar.is_simulated AND ar.created_at < $1
     UNION ALL
     SELECT 'correction', r.id, r.employee_id, u.full_name, r.created_at, 'attendance correction' FROM review_requests r JOIN users u ON u.id = r.employee_id
       WHERE r.status = 'OPEN' AND r.kind = 'ADMIN_CORRECTION' AND r.created_at < $1
     UNION ALL
     SELECT 'overtime', o.id, o.employee_id, u.full_name, o.created_at, 'overtime' FROM overtime_entries o JOIN users u ON u.id = o.employee_id
       WHERE o.status = 'PENDING' AND o.ended_at IS NOT NULL AND o.created_at < $1
     ) x
     WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.dedupe_key = 'overdue:' || x.kind || ':' || x.id)`,
    [cutoff],
  );
}
