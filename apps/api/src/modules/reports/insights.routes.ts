/**
 * Daily close and "needs attention" patterns — so an owner can trust the numbers
 * without reading every record.
 */
import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { one, q } from '../../db/pool.js';
import { dayStartSql, orgToday } from '../../lib/dates.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isoDate, mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { getSettings } from '../settings/settings.service.js';
import { attended, isPending, roster, withLeaveAndNoShow } from './reports.routes.js';
import { attendanceCounts, employeeSite, siteFilter } from '../../lib/tenancy.js';

const DAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

/** The day at a glance, plus everything that still needs a decision. */
export async function daySummary(orgId: string, date: string) {
  const rows = await withLeaveAndNoShow(orgId, date, await roster(orgId, date, null, true));
  const today = await orgToday(orgId);
  const past = date < today;
  const absent = rows.filter((r) => !r.attendance_id && !r.on_leave && !r.holiday && (past || r.no_show || r.ended_at));
  const openSessions = rows.filter((r) => r.session_id && !r.ended_at);
  const reviews = await q(
    `SELECT r.id, r.kind, r.reason, u.full_name FROM review_requests r JOIN users u ON u.id = r.employee_id
     LEFT JOIN attendance_records ar ON ar.id = r.attendance_id LEFT JOIN tracking_sessions s ON s.id = r.session_id
     WHERE u.org_id = $1 AND r.status = 'OPEN' AND r.kind IN ('MANUAL_REVIEW', 'DISPUTE') AND COALESCE(ar.shift_date, s.shift_date) = $2`,
    [orgId, date],
  );
  const counts = {
    scheduled: rows.length,
    present: rows.filter(attended).length,
    pendingVerification: rows.filter(isPending).length,
    late: rows.filter((r) => r.is_late).length,
    onLeave: rows.filter((r) => r.on_leave && !r.attendance_id).length,
    holiday: rows.filter((r) => r.holiday && !r.attendance_id).length,
    absent: absent.length,
    leftEarly: rows.filter((r) => r.left_early).length,
    overtimeMinutes: rows.reduce((n, r) => n + (r.overtime_minutes ?? 0), 0),
  };
  const toDecide = [
    ...absent.map((r) => ({ type: 'ABSENT', employeeId: r.employee_id, name: r.full_name, text: `${r.full_name}: no attendance and no leave (${r.shift_name})` })),
    ...reviews.map((r) => ({ type: r.kind, employeeId: null, name: r.full_name, text: `${r.full_name}: ${r.kind === 'DISPUTE' ? 'disputes a record' : 'asks to be marked present'} — “${r.reason}”` })),
    ...openSessions.map((r) => ({ type: 'OPEN_SESSION', employeeId: r.employee_id, name: r.full_name, text: `${r.full_name}: shift still running` })),
    ...rows.filter(isPending).map((r) => ({ type: 'PENDING_VERIFICATION', employeeId: r.employee_id, name: r.full_name, text: `${r.full_name}: record sent late from the phone, waiting for verification` })),
  ];
  return { date, counts, toDecide };
}

/** Past days of `month` (YYYY-MM) that had rostered shifts but were never confirmed (Daily close). */
export async function unconfirmedDays(orgId: string, month: string) {
  const first = DateTime.fromISO(`${month}-01`);
  const last = DateTime.min(first.endOf('month').startOf('day'), DateTime.fromISO(await orgToday(orgId)).minus({ days: 1 }));
  const closed = new Set((await q(`SELECT close_date FROM day_closes WHERE org_id = $1 AND close_date BETWEEN $2 AND $3`, [orgId, first.toISODate(), last.toISODate()])).map((r) => r.close_date));
  const days: string[] = [];
  for (let d = first; d <= last; d = d.plus({ days: 1 })) {
    const date = d.toISODate()!;
    if (!closed.has(date) && (await roster(orgId, date, null, true)).length) days.push(date);
  }
  return days;
}

export const insightsRouter = Router();
mount(insightsRouter, '/api/v1/insights', 'insights', [
  route({
    method: 'get',
    path: '/day',
    summary: 'A day at a glance, what still needs a decision, and whether it is confirmed',
    access: 'admin',
    ownerOnly: true,
    query: z.object({ date: isoDate }),
    handler: async ({ query, user }) => {
      const closed = await one(`SELECT d.*, u.full_name AS closed_by_name FROM day_closes d JOIN users u ON u.id = d.closed_by WHERE d.org_id = $1 AND d.close_date = $2`, [user.orgId, query.date]);
      return { ...(await daySummary(user.orgId, query.date)), closed };
    },
  }),
  route({
    method: 'post',
    path: '/day/close',
    summary: "Confirm a day's attendance (keeps a snapshot of the summary)",
    access: 'admin',
    ownerOnly: true,
    body: z.object({ date: isoDate, note: z.string().trim().max(500).optional() }),
    handler: async ({ body, user, req }) => {
      if (body.date > (await orgToday(user.orgId))) throw badRequest('FUTURE_DAY', 'You can only confirm today or earlier days.');
      const summary = await daySummary(user.orgId, body.date);
      const row = await one(
        `INSERT INTO day_closes (org_id, close_date, closed_by, note, summary) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,
        [user.orgId, body.date, user.id, body.note || null, JSON.stringify(summary)],
      );
      if (!row) throw conflict('DAY_CLOSED', 'This day is already confirmed.');
      await audit({ actor: user, action: 'day.close', resourceType: 'day', resourceId: body.date, after: summary.counts, reason: body.note, req });
      return row;
    },
  }),
  route({
    method: 'post',
    path: '/day/reopen',
    summary: 'Undo a day confirmation (reason required)',
    access: 'admin',
    ownerOnly: true,
    body: z.object({ date: isoDate, reason: z.string().trim().min(3).max(500) }),
    handler: async ({ body, user, req }) => {
      const row = await one(`DELETE FROM day_closes WHERE org_id = $1 AND close_date = $2 RETURNING *`, [user.orgId, body.date]);
      if (!row) throw notFound('Confirmation');
      await audit({ actor: user, action: 'day.reopen', resourceType: 'day', resourceId: body.date, reason: body.reason, req });
      return { ok: true };
    },
  }),
  route({
    method: 'get',
    path: '/unconfirmed',
    summary: 'Past days in a month that had shifts but were never confirmed',
    access: 'admin',
    ownerOnly: true,
    query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }),
    handler: async ({ query, user }) => ({ month: query.month, days: await unconfirmedDays(user.orgId, query.month) }),
  }),
  route({
    method: 'get',
    path: '/attention',
    summary: 'Employees with a repeating pattern in the last N days (late, no-shows, leaving early…)',
    access: 'admin',
    query: z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }),
    handler: async ({ query, user }) => {
      const { workforce } = await getSettings(user.orgId);
      const since = DateTime.fromISO(await orgToday(user.orgId)).minus({ days: query.days }).toISODate()!;
      const rows = await q(
        `WITH emp AS (SELECT u.id, u.full_name, ep.employee_code FROM users u JOIN employee_profiles ep ON ep.user_id = u.id
                      WHERE u.org_id = $1 AND u.role = 'EMPLOYEE' AND u.is_active AND ${siteFilter(employeeSite('u.id'), '$4', 'u.id')})
         SELECT e.id, e.full_name, e.employee_code,
           (SELECT count(*)::int FROM attendance_records ar WHERE ar.employee_id = e.id AND ar.is_late AND ar.shift_date >= $2 AND ${attendanceCounts()}) AS late,
           (SELECT array_agg(EXTRACT(ISODOW FROM ar.shift_date)::int) FROM attendance_records ar WHERE ar.employee_id = e.id AND ar.is_late AND ar.shift_date >= $2 AND ${attendanceCounts()}) AS late_days,
           (SELECT count(*)::int FROM notifications n WHERE n.employee_id = e.id AND n.audience = 'ADMIN' AND n.type = 'NO_SHOW' AND n.created_at >= ${dayStartSql('$2', '$1')}) AS no_shows,
           (SELECT count(*)::int FROM absence_intervals a WHERE a.employee_id = e.id AND a.prolonged_at IS NOT NULL AND a.started_at >= ${dayStartSql('$2', '$1')}) AS prolonged,
           (SELECT count(*)::int FROM notifications n WHERE n.employee_id = e.id AND n.type = 'TRACKING_INTERRUPTED' AND n.created_at >= ${dayStartSql('$2', '$1')}) AS interrupted,
           (SELECT count(*)::int FROM attendance_work aw WHERE aw.employee_id = e.id AND aw.shift_date >= $2 AND aw.ended_early_minutes >= $3) AS left_early,
           (SELECT count(*)::int FROM notifications n WHERE n.employee_id = e.id AND n.type IN ('MOCK_LOCATION_FLAGGED', 'SHARED_DEVICE', 'FACE_MISMATCH') AND n.created_at >= ${dayStartSql('$2', '$1')}) AS integrity
         FROM emp e`,
        [user.orgId, since, workforce.leftEarlyMinutes > 0 ? workforce.leftEarlyMinutes : 1e6, user.sites], // 0 = "left early" flag switched off
      );
      const items = rows
        .map((r) => {
          const notes: Array<{ kind: string; text: string; weight: number }> = [];
          if (r.integrity > 0) notes.push({ kind: 'integrity', text: `${r.integrity} fake-GPS / shared-phone / photo flag${r.integrity > 1 ? 's' : ''}`, weight: 10 * r.integrity });
          if (r.no_shows >= 2) notes.push({ kind: 'no_show', text: `${r.no_shows} no-shows`, weight: 4 * r.no_shows });
          if (r.late >= 3) {
            const byDay = new Map<number, number>();
            for (const d of r.late_days ?? []) byDay.set(d, (byDay.get(d) ?? 0) + 1);
            const [topDay, topCount] = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
            const mostly = topCount >= 3 && topCount / r.late >= 0.5 ? `, mostly on ${DAYS[topDay - 1]}` : '';
            notes.push({ kind: 'late', text: `late ${r.late} times${mostly}`, weight: 2 * r.late });
          }
          if (r.prolonged >= 2) notes.push({ kind: 'away', text: `away too long ${r.prolonged} times`, weight: 3 * r.prolonged });
          if (r.left_early >= 3) notes.push({ kind: 'left_early', text: `left early ${r.left_early} times`, weight: 2 * r.left_early });
          if (r.interrupted >= 3) notes.push({ kind: 'tracking', text: `tracking stopped ${r.interrupted} times — check their phone settings`, weight: r.interrupted });
          return { employeeId: r.id, fullName: r.full_name, employeeCode: r.employee_code, notes, weight: notes.reduce((n, x) => n + x.weight, 0) };
        })
        .filter((x) => x.notes.length)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 20);
      return { days: query.days, items };
    },
  }),
]);
