/**
 * Backup approver: anything waiting more than a day for a decision (leave, an attendance
 * request, a new phone) is raised to the company owners, so nothing stalls when a
 * supervisor is busy or away. Once per item (dedupe key).
 */
import { getPool, q } from '../../db/pool.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { eachCompany, eachRecord, throwIfAny } from './runner.js';

const WAIT_HOURS = 24;

export const sweepOverdueApprovals = (now = new Date()) => eachCompany(() => overdueForCompany(now));

async function overdueForCompany(now: Date) {
  const cutoff = new Date(now.getTime() - WAIT_HOURS * 3600_000);
  const items = await q(
    `SELECT 'leave' AS kind, l.id, l.employee_id, u.full_name, l.created_at, 'a leave request' AS what FROM leave_requests l JOIN users u ON u.id = l.employee_id
       WHERE l.status = 'PENDING' AND l.created_at < $1
     UNION ALL
     SELECT 'review', r.id, r.employee_id, u.full_name, r.created_at,
            CASE r.kind WHEN 'DISPUTE' THEN 'an attendance dispute' WHEN 'MANUAL_REVIEW' THEN 'a request to be marked present' ELSE 'a technical issue' END
       FROM review_requests r JOIN users u ON u.id = r.employee_id
       WHERE r.status = 'OPEN' AND r.kind IN ('MANUAL_REVIEW', 'DISPUTE', 'TECHNICAL_ISSUE') AND r.created_at < $1
     UNION ALL
     SELECT 'device', d.id, d.user_id, u.full_name, d.created_at, 'a new phone' FROM device_registrations d JOIN users u ON u.id = d.user_id
       WHERE d.status = 'PENDING' AND u.is_active AND d.created_at < $1`,
    [cutoff],
  );
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
