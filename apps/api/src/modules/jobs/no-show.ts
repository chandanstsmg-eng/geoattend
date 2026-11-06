/**
 * No-show detection: a scheduled employee who has neither started the shift nor
 * marked attendance `noShowAfterMinutes` after it began, is not on approved
 * leave, and whose workplace has no holiday that day. Alerts the administrators once per (employee, shift, date) and sends
 * the employee a reminder. The dedupe keys make repeated sweeps harmless.
 */
import { DateTime } from 'luxon';
import { getPool, q } from '../../db/pool.js';
import { instanceFor } from '../../lib/shift-window.js';
import { eachCompany, eachRecord, throwIfAny, type Failure } from './runner.js';
import { getSettings } from '../settings/settings.service.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { approvedLeaveOn } from '../leave/leave.routes.js';
import { holidaysOn } from '../holidays/holidays.routes.js';

interface Candidate {
  employeeId: string;
  reminders: boolean;
  fullName: string;
  shiftId: string;
  shiftName: string;
  workplaceId: string;
  workplaceName: string;
  shiftDate: string;
  startsAt: Date;
}

export const sweepNoShows = (now = new Date()) => eachCompany(() => noShowsForCompany(now));

/** Every current shift assignment of an active employee, with what is needed to work out its times. */
export const assignedShifts = () =>
  q(
    `SELECT esa.employee_id, esa.effective_from, esa.effective_to, u.full_name, u.org_id, COALESCE(ep.shift_reminders, true) AS shift_reminders,
            sh.id AS shift_id, sh.name AS shift_name, sh.start_time, sh.end_time, sh.timezone, sh.days_of_week,
            w.id AS workplace_id, w.name AS workplace_name
     FROM employee_shift_assignments esa
     JOIN users u ON u.id = esa.employee_id AND u.role = 'EMPLOYEE' AND u.is_active
     LEFT JOIN employee_profiles ep ON ep.user_id = u.id
     JOIN shifts sh ON sh.id = esa.shift_id AND sh.is_active
     JOIN workplaces w ON w.id = sh.workplace_id AND w.is_active
     WHERE esa.effective_to IS NULL OR esa.effective_to >= (now() AT TIME ZONE sh.timezone)::date - 1`,
  );

/** Which of these shifts someone started or has attendance for (e.g. recorded by an admin), as "employee|shift|date". */
export async function shiftsAlreadyStarted(list: Array<{ employeeId: string; shiftId: string; shiftDate: string }>) {
  const started = await q(
    `SELECT employee_id, shift_id, shift_date FROM tracking_sessions WHERE (employee_id, shift_id, shift_date) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::date[]))
     UNION
     SELECT employee_id, shift_id, shift_date FROM attendance_records WHERE verification_status <> 'VOIDED' AND (employee_id, shift_id, shift_date) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::date[]))`,
    [list.map((d) => d.employeeId), list.map((d) => d.shiftId), list.map((d) => d.shiftDate)],
  );
  return new Set(started.map((s) => `${s.employee_id}|${s.shift_id}|${s.shift_date}`));
}

async function noShowsForCompany(now: Date) {
  const rows = await assignedShifts();

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
      due.push({ employeeId: r.employee_id, reminders: r.shift_reminders, fullName: r.full_name, shiftId: r.shift_id, shiftName: r.shift_name, workplaceId: r.workplace_id, workplaceName: r.workplace_name, shiftDate: inst.shiftDate, startsAt: inst.startsAt });
    }
  }
  if (!due.length) return;

  const done = await shiftsAlreadyStarted(due);

  const outbox = new Outbox();
  const failures: Failure[] = [];
  const byDate = new Map<string, Candidate[]>();
  for (const d of due) byDate.set(d.shiftDate, [...(byDate.get(d.shiftDate) ?? []), d]);
  for (const [date, list] of byDate) {
    const onLeave = await approvedLeaveOn(date, list.map((d) => d.employeeId));
    const holidays = await holidaysOn(date, [...new Set(list.map((d) => d.workplaceId))]);
    const absent = list.filter((d) => !done.has(`${d.employeeId}|${d.shiftId}|${d.shiftDate}`) && !onLeave.has(d.employeeId) && !holidays.has(d.workplaceId));
    // Most of these were alerted on an earlier sweep: one query finds them, instead of an attempt each.
    const keyOf = (d: Candidate) => `${d.employeeId}:${d.shiftId}:${d.shiftDate}`;
    const sent = new Set((await q(`SELECT dedupe_key FROM notifications WHERE dedupe_key = ANY($1)`, [absent.flatMap((d) => [`no-show:${keyOf(d)}`, `no-show-employee:${keyOf(d)}`])])).map((r) => r.dedupe_key));
    const unsent = absent.filter((d) => !sent.has(`no-show:${keyOf(d)}`) || (d.reminders && !sent.has(`no-show-employee:${keyOf(d)}`)));
    failures.push(...await eachRecord(unsent, async (d) => {
      const lateBy = Math.round((now.getTime() - d.startsAt.getTime()) / 60_000);
      const key = keyOf(d);
      await notify(getPool(), outbox, {
        type: 'NO_SHOW',
        severity: 'WARNING',
        body: `${d.fullName} has not started ${d.shiftName} at ${d.workplaceName}. It began ${lateBy} min ago and there is no approved leave for ${d.shiftDate}.`,
        employeeId: d.employeeId,
        workplaceId: d.workplaceId,
        data: { shiftId: d.shiftId, shiftDate: d.shiftDate, startsAt: d.startsAt, minutesSinceStart: lateBy },
        dedupeKey: `no-show:${key}`,
      });
      if (!d.reminders) return; // the employee turned reminders off; the people above are still told
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
    }));
  }
  outbox.flush();
  throwIfAny(failures);
}
