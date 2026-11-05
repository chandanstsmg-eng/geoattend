/**
 * No-show detection: a scheduled employee who has neither started the shift nor
 * marked attendance `noShowAfterMinutes` after it began, is not on approved
 * leave, and whose workplace has no holiday that day. Alerts the administrators once per (employee, shift, date) and sends
 * the employee a reminder. The dedupe keys make repeated sweeps harmless.
 */
import { DateTime } from 'luxon';
import { getPool, q } from '../../db/pool.js';
import { instanceFor } from '../../lib/shift-window.js';
import { getSettings } from '../settings/settings.service.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { approvedLeaveOn } from '../leave/leave.routes.js';
import { holidaysOn } from '../holidays/holidays.routes.js';

interface Candidate {
  employeeId: string;
  fullName: string;
  shiftId: string;
  shiftName: string;
  workplaceId: string;
  workplaceName: string;
  shiftDate: string;
  startsAt: Date;
}

export async function sweepNoShows(now = new Date()) {
  const rows = await q(
    `SELECT esa.employee_id, esa.effective_from, esa.effective_to, u.full_name, u.org_id,
            sh.id AS shift_id, sh.name AS shift_name, sh.start_time, sh.end_time, sh.timezone, sh.days_of_week,
            w.id AS workplace_id, w.name AS workplace_name
     FROM employee_shift_assignments esa
     JOIN users u ON u.id = esa.employee_id AND u.role = 'EMPLOYEE' AND u.is_active
     JOIN shifts sh ON sh.id = esa.shift_id AND sh.is_active
     JOIN workplaces w ON w.id = sh.workplace_id AND w.is_active
     WHERE esa.effective_to IS NULL OR esa.effective_to >= (now() AT TIME ZONE sh.timezone)::date - 1`,
  );

  const due: Candidate[] = [];
  for (const r of rows) {
    const { alerts } = await getSettings(r.org_id); // each company sets its own threshold (cached)
    if (alerts.noShowAfterMinutes <= 0) continue;
    const today = DateTime.fromJSDate(now, { zone: r.timezone }).startOf('day');
    for (const offset of [0, -1]) {
      const day = today.plus({ days: offset }); // -1 catches overnight shifts that began yesterday
      if (!r.days_of_week.includes(day.weekday)) continue;
      const inst = instanceFor(r, day, 0, 0);
      if (inst.shiftDate < r.effective_from || (r.effective_to && inst.shiftDate > r.effective_to)) continue;
      const alertAt = inst.startsAt.getTime() + alerts.noShowAfterMinutes * 60_000;
      if (now.getTime() < alertAt || now >= inst.endsAt) continue;
      due.push({ employeeId: r.employee_id, fullName: r.full_name, shiftId: r.shift_id, shiftName: r.shift_name, workplaceId: r.workplace_id, workplaceName: r.workplace_name, shiftDate: inst.shiftDate, startsAt: inst.startsAt });
    }
  }
  if (!due.length) return;

  // Drop anyone who started the session or has attendance (e.g. recorded by an admin).
  const started = await q(
    `SELECT employee_id, shift_id, shift_date FROM tracking_sessions WHERE (employee_id, shift_id, shift_date) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::date[]))
     UNION
     SELECT employee_id, shift_id, shift_date FROM attendance_records WHERE verification_status <> 'VOIDED' AND (employee_id, shift_id, shift_date) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::date[]))`,
    [due.map((d) => d.employeeId), due.map((d) => d.shiftId), due.map((d) => d.shiftDate)],
  );
  const done = new Set(started.map((s) => `${s.employee_id}|${s.shift_id}|${s.shift_date}`));

  const outbox = new Outbox();
  const byDate = new Map<string, Candidate[]>();
  for (const d of due) byDate.set(d.shiftDate, [...(byDate.get(d.shiftDate) ?? []), d]);
  for (const [date, list] of byDate) {
    const onLeave = await approvedLeaveOn(date, list.map((d) => d.employeeId));
    const holidays = await holidaysOn(date, [...new Set(list.map((d) => d.workplaceId))]);
    for (const d of list) {
      if (done.has(`${d.employeeId}|${d.shiftId}|${d.shiftDate}`) || onLeave.has(d.employeeId) || holidays.has(d.workplaceId)) continue;
      const lateBy = Math.round((now.getTime() - d.startsAt.getTime()) / 60_000);
      const key = `${d.employeeId}:${d.shiftId}:${d.shiftDate}`;
      await notify(getPool(), outbox, {
        type: 'NO_SHOW',
        severity: 'WARNING',
        body: `${d.fullName} has not started ${d.shiftName} at ${d.workplaceName}. It began ${lateBy} min ago and there is no approved leave for ${d.shiftDate}.`,
        employeeId: d.employeeId,
        workplaceId: d.workplaceId,
        data: { shiftId: d.shiftId, shiftDate: d.shiftDate, startsAt: d.startsAt, minutesSinceStart: lateBy },
        dedupeKey: `no-show:${key}`,
      });
      await notify(getPool(), outbox, {
        type: 'NO_SHOW',
        severity: 'WARNING',
        audience: 'EMPLOYEE',
        title: 'Your shift has started',
        body: `${d.shiftName} started ${lateBy} min ago. Open GeoAttend and tap Start shift, or apply for leave if you are not coming in.`,
        employeeId: d.employeeId,
        data: { shiftId: d.shiftId, shiftDate: d.shiftDate },
        dedupeKey: `no-show-employee:${key}`,
      });
    }
  }
  outbox.flush();
}
