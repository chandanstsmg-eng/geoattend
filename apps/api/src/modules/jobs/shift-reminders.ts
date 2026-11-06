/**
 * Reminders before a shift, for companies that turned them on (alerts.shiftReminderMinutes). An
 * employee is told that many minutes before the shift starts, by the shift's own time zone, unless
 * they turned reminders off, are on approved leave, the workplace has a holiday, or they have already
 * started. Once per employee, shift and date. These go out as a phone push: with push off, or no
 * phone registered, the employee sees nothing.
 */
import { DateTime } from 'luxon';
import { getPool, q } from '../../db/pool.js';
import { instanceFor } from '../../lib/shift-window.js';
import { eachCompany, eachRecord, throwIfAny, type Failure } from './runner.js';
import { assignedShifts, shiftsAlreadyStarted } from './no-show.js';
import { getSettings } from '../settings/settings.service.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { approvedLeaveOn } from '../leave/leave.routes.js';
import { holidaysOn } from '../holidays/holidays.routes.js';

const companiesWithReminders = async () =>
  (await q(`SELECT org_id FROM application_settings WHERE key = 'alerts' AND COALESCE((value->>'shiftReminderMinutes')::int, 0) > 0`)).map((r) => r.org_id as string);

export const sweepShiftReminders = (now = new Date()) => eachCompany((orgId) => remindersForCompany(orgId, now), companiesWithReminders);

async function remindersForCompany(orgId: string, now: Date) {
  const minutes = (await getSettings(orgId)).alerts.shiftReminderMinutes ?? 0;
  if (minutes <= 0) return;

  const due: Array<{ employeeId: string; shiftId: string; shiftName: string; workplaceId: string; workplaceName: string; shiftDate: string; startsAt: Date; timezone: string }> = [];
  for (const r of await assignedShifts()) {
    if (!r.shift_reminders) continue;
    const today = DateTime.fromJSDate(now, { zone: r.timezone }).startOf('day');
    for (const offset of [0, 1]) {
      const day = today.plus({ days: offset }); // +1 catches a shift just after midnight
      if (!r.days_of_week.includes(day.weekday)) continue;
      const inst = instanceFor(r, day, 0, 0);
      if (inst.shiftDate < r.effective_from || (r.effective_to && inst.shiftDate > r.effective_to)) continue;
      // Only before the start. After it, a late reminder would be wrong: the no-show check takes over.
      if (now.getTime() < inst.startsAt.getTime() - minutes * 60_000 || now >= inst.startsAt) continue;
      due.push({ employeeId: r.employee_id, shiftId: r.shift_id, shiftName: r.shift_name, workplaceId: r.workplace_id, workplaceName: r.workplace_name, shiftDate: inst.shiftDate, startsAt: inst.startsAt, timezone: r.timezone });
    }
  }
  if (!due.length) return;

  const started = await shiftsAlreadyStarted(due);
  const keyOf = (d: (typeof due)[number]) => `shift-reminder:${d.employeeId}:${d.shiftId}:${d.shiftDate}`;
  const sent = new Set((await q(`SELECT dedupe_key FROM notifications WHERE dedupe_key = ANY($1)`, [due.map(keyOf)])).map((r) => r.dedupe_key));
  const outbox = new Outbox();
  const failures: Failure[] = [];
  const byDate = new Map<string, typeof due>();
  for (const d of due) byDate.set(d.shiftDate, [...(byDate.get(d.shiftDate) ?? []), d]);
  for (const [date, list] of byDate) {
    const onLeave = await approvedLeaveOn(date, list.map((d) => d.employeeId));
    const holidays = await holidaysOn(date, [...new Set(list.map((d) => d.workplaceId))]);
    const remind = list.filter((d) => !started.has(`${d.employeeId}|${d.shiftId}|${d.shiftDate}`) && !onLeave.has(d.employeeId) && !holidays.has(d.workplaceId) && !sent.has(keyOf(d)));
    failures.push(...await eachRecord(remind, (d) =>
      notify(getPool(), outbox, {
        type: 'SHIFT_REMINDER',
        severity: 'INFO',
        audience: 'EMPLOYEE',
        body: `${d.shiftName} at ${d.workplaceName} starts at ${DateTime.fromJSDate(d.startsAt, { zone: d.timezone }).toFormat('HH:mm')}.`,
        employeeId: d.employeeId,
        data: { shiftId: d.shiftId, shiftDate: d.shiftDate },
        dedupeKey: keyOf(d),
      }),
    ));
  }
  outbox.flush();
  throwIfAny(failures);
}
