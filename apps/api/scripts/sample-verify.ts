/**
 * Measures the sample company with the app's own definitions and compares it with the demo targets.
 *
 *   npm run demo:verify
 *
 * 90-day figures use the same roster / leave / no-show rules as the Overview (reports.routes.ts);
 * the "Overview" column is what the dashboard itself returns for its default 14-day window.
 * Exits with code 1 if any headline rate is more than 2 points off target.
 */
import { DateTime } from 'luxon';

process.env.PG_DATABASE ||= 'geoattend_demo';
const { config } = await import('../src/config.js');
const { ensureDatabase } = await import('../src/db/postgres.js');
const { closePool, initPool, one, q } = await import('../src/db/pool.js');
const { DEFAULT_ORG_ID } = await import('../src/lib/tenancy.js');
const { roster, withLeaveAndNoShow } = await import('../src/modules/reports/reports.routes.js');
const { dashboard, dashboardQuery } = await import('../src/modules/reports/analytics.routes.js');

if (!config.dbName.endsWith('_demo')) throw new Error(`demo:verify only reads *_demo databases (got "${config.dbName}").`);
initPool(await ensureDatabase());
const ORG = DEFAULT_ORG_ID;
const TZ = 'Asia/Kolkata';
const meta = await one(`SELECT * FROM sample_meta`);
const problem = new Set<string>(meta.problem_ids);
const today = DateTime.now().setZone(TZ).startOf('day');
const first = today.minus({ days: 89 });
const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const f = (x: number) => `${x.toFixed(1)}%`;

// ── 90 days, the Overview's rules ──
let expected = 0, present = 0, late = 0, absent = 0, problemAbsent = 0;
const dow = new Map<number, { present: number; late: number }>();
const absentBy = new Map<string, { name: string; n: number; expected: number }>();
for (let d = first; d <= today; d = d.plus({ days: 1 })) {
  const date = d.toISODate()!;
  const rows = await withLeaveAndNoShow(ORG, date, await roster(ORG, date, null, true, null));
  for (const r of rows) {
    if (r.on_leave || r.holiday) continue;
    // Today: only shifts with an outcome (checked in, no-show, or over) — not ones still to start.
    if (date === today.toISODate() && !r.attendance_id && !r.no_show && !r.ended_at) continue;
    expected++;
    const e = absentBy.get(r.employee_id) ?? { name: r.full_name, n: 0, expected: 0 };
    e.expected++;
    if (r.attendance_id) {
      present++;
      const w = dow.get(d.weekday) ?? { present: 0, late: 0 };
      w.present++;
      if (r.is_late) { late++; w.late++; }
      dow.set(d.weekday, w);
    } else {
      absent++;
      e.n++;
      if (problem.has(r.employee_id)) problemAbsent++;
    }
    absentBy.set(r.employee_id, e);
  }
}
const mc = await one(
  `SELECT count(*)::int AS records,
          count(*) FILTER (WHERE s.authorization_status = 'EXPIRED' OR (s.ended_at IS NULL AND s.scheduled_end_at < now()))::int AS missing
   FROM attendance_records ar JOIN tracking_sessions s ON s.id = ar.session_id
   WHERE ar.verification_status <> 'VOIDED' AND ar.shift_date BETWEEN $1 AND $2 AND s.scheduled_end_at < now()`,
  [first.toISODate(), today.toISODate()],
);
const hours = await one(
  `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY h) AS p50, percentile_cont(0.9) WITHIN GROUP (ORDER BY h) AS p90, max(h) AS max,
          avg(h) AS mean, count(*) FILTER (WHERE h > 9.5)::int AS long, count(*)::int AS n
   FROM (SELECT (aw.worked_minutes + aw.overtime_minutes) / 60.0 AS h FROM attendance_work aw JOIN tracking_sessions s ON s.id = aw.session_id
         WHERE NOT aw.in_progress AND s.authorization_status = 'ENDED') x`,
);

// ── what the Overview shows (default 14 days) ──
const owner = { id: meta.owner_id, role: 'ADMIN', email: 'owner@sample.test', fullName: 'Rohan Mehta', isDemo: false, orgId: ORG, access: 'OWNER', sites: null, via: 'cookie' } as any;
const dash: any = await dashboard(owner, dashboardQuery.parse({}));
const s14 = dash.summary;

// ── live: now, and projected for the presentation time ──
const P = DateTime.fromJSDate(meta.present_at).setZone(TZ);
const liveNow = await one(
  `SELECT count(*)::int AS open,
          count(*) FILTER (WHERE s.last_classification = 'OUTSIDE')::int AS outside,
          count(*) FILTER (WHERE s.state = 'TRACKING_INTERRUPTED' OR s.device_id LIKE '%:quiet')::int AS quiet
   FROM tracking_sessions s JOIN attendance_records ar ON ar.session_id = s.id WHERE s.ended_at IS NULL`,
);
const atP = await one(
  `SELECT (SELECT count(*) FROM tracking_sessions s WHERE s.ended_at IS NULL AND s.scheduled_end_at > $1)
        + (SELECT count(*) FROM sample_plan p WHERE NOT p.arrived AND p.arrive_at <= $1 AND p.scheduled_end_at > $1) AS on_shift,
          (SELECT count(*) FROM sample_plan p WHERE p.away_at IS NOT NULL AND p.away_at <= $1)
        + (SELECT count(*) FROM tracking_sessions s WHERE s.ended_at IS NULL AND s.last_classification = 'OUTSIDE' AND s.scheduled_end_at > $1) AS outside,
          (SELECT count(*) FROM sample_plan p WHERE p.quiet_at IS NOT NULL)
        + (SELECT count(*) FROM tracking_sessions s WHERE s.ended_at IS NULL AND s.device_id LIKE '%:quiet') AS quiet`,
  [P.toJSDate()],
);
await closePool();

const rows: Array<[string, number, number, number | null]> = [
  ['Attendance rate', 91, pct(present, expected), s14.attendanceRate * 100],
  ['Late arrivals (of check-ins)', 12, pct(late, present), (1 - s14.punctualityRate) * 100],
  ['No-shows / absent (of rostered)', 9, pct(absent, expected), pct(s14.absent, s14.expected)],
  ['  of which the 5 chronic absentees', 4, pct(problemAbsent, expected), null],
  ['Missing check-out (of finished shifts)', 6, pct(mc.missing, mc.records), pct(s14.incomplete, s14.completed + s14.incomplete)],
];
let fail = false;
console.log(`\nSample company — measured with the app's own rules (90 days ${first.toFormat('d LLL')}–${today.toFormat('d LLL')}; Overview = default 14 days)\n`);
console.log(`${'Metric'.padEnd(42)}${'Target'.padStart(8)}${'90 days'.padStart(10)}${'Overview'.padStart(10)}   Δ`);
for (const [name, target, actual, view] of rows) {
  const off = Math.abs(actual - target) > 2 || (view != null && Math.abs(view - target) > 2);
  if (off) fail = true;
  console.log(`${name.padEnd(42)}${f(target).padStart(8)}${f(actual).padStart(10)}${(view == null ? '—' : f(view)).padStart(10)}   ${off ? 'OFF BY >2 PTS' : 'ok'}`);
}
console.log(`\nChronic absentees carry ${f(pct(problemAbsent, absent))} of all absences. Most-absent employees:`);
for (const e of [...absentBy.values()].sort((a, b) => b.n / b.expected - a.n / a.expected).slice(0, 7)) console.log(`  ${e.name.padEnd(22)} ${String(e.n).padStart(3)} of ${e.expected} shifts missed (${f(pct(e.n, e.expected))})`);
console.log(`\nLate by weekday: ${([1, 2, 3, 4, 5, 6] as const).map((w) => `${DateTime.fromObject({ weekday: w }).toFormat('ccc')} ${f(pct(dow.get(w)?.late ?? 0, dow.get(w)?.present ?? 0))}`).join(' · ')}`);
console.log(`Hours per completed shift (incl. approved overtime): median ${Number(hours.p50).toFixed(2)} h · mean ${Number(hours.mean).toFixed(2)} h · p90 ${Number(hours.p90).toFixed(2)} h · max ${Number(hours.max).toFixed(2)} h · ${hours.long} of ${hours.n} over 9.5 h`);
console.log(`\nRight now (${DateTime.now().setZone(TZ).toFormat('HH:mm')}): ${liveNow.open} checked in, ${liveNow.outside} outside, ${liveNow.quiet} quiet/interrupted. Overview KPIs: checked in ${dash.kpis.checkedIn}, outside ${dash.kpis.outsideGeofence}, no-shows today ${dash.attention.noShowToday.length}.`);
console.log(`At ${P.toFormat('HH:mm')} (presentation): ${atP.on_shift} on shift, ${atP.outside} outside the geofence, ${atP.quiet} with tracking interrupted.\n`);
process.exit(fail ? 1 : 0);
