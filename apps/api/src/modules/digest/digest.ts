/**
 * Daily summaries for owners who never open a laptop: at the company's chosen local
 * times, "who's in, who's missing, what needs me" goes to WhatsApp and e-mail. On the
 * 1st, last month's attendance summary (CSV) is e-mailed to the chosen recipients. If the
 * company chose them, on Mondays last week's goes to those recipients, each supervisor gets
 * their own sites, and each employee is told their own week in the app.
 * Each slot is claimed in digest_runs first, so it is sent at most once.
 */
import { DateTime } from 'luxon';
import { getPool, one, q } from '../../db/pool.js';
import { eachCompany, eachRecord, throwIfAny } from '../jobs/runner.js';
import { DEFAULT_TIMEZONE, dayEndSql, dayStartSql } from '../../lib/dates.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { mailer } from '../../lib/mailer.js';
import { toCsv } from '../../lib/csv.js';
import { getSettings } from '../settings/settings.service.js';
import { daySummary } from '../reports/insights.routes.js';
import { monthlySummary, periodSummary } from '../reports/reports.routes.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';

/** Do not send a summary more than this long after its time (e.g. the server was down). */
const LATE_LIMIT_MIN = 180;

export interface Digest {
  company: string;
  when: string;
  /** One line — WhatsApp template variables cannot contain line breaks. */
  line: string;
  /** Longer text for e-mail. */
  text: string;
}

/** Sending is pluggable so tests (and "send a test") can see exactly what goes out. */
export const senders = {
  async whatsapp(to: string, d: Digest): Promise<string> {
    if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) {
      logger.info({ company: d.company, when: d.when }, 'WhatsApp not configured; summary not sent');
      return 'not configured (logged)';
    }
    const res = await fetch(`https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: config.whatsapp.template,
          language: { code: config.whatsapp.language },
          components: [{ type: 'body', parameters: [d.company, d.when, d.line].map((text) => ({ type: 'text', text: text.slice(0, 1000) })) }],
        },
      }),
    });
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return 'sent';
  },
  async email(to: string[], subject: string, text: string, attachments: Array<{ filename: string; content: string }> = []): Promise<string> {
    if (!config.email.smtpUrl) {
      logger.info({ recipients: to.length }, 'SMTP not configured; summary not e-mailed');
      return 'not configured (logged)';
    }
    await mailer().sendMail({ from: config.email.from, to, subject, text, attachments });
    return 'sent';
  },
};

async function orgInfo(orgId: string) {
  return one(
    `SELECT o.name, (SELECT w.timezone FROM workplaces w WHERE w.org_id = o.id ORDER BY w.is_active DESC, w.created_at LIMIT 1) AS timezone FROM organizations o WHERE o.id = $1`,
    [orgId],
  );
}

/** The summary for `date` as of now. */
export async function composeDigest(orgId: string, date: string, when: string): Promise<Digest> {
  const org = await orgInfo(orgId);
  const s = await daySummary(orgId, date);
  const c = s.counts;
  const missing = s.toDecide.filter((t) => t.type === 'ABSENT').map((t) => t.name);
  const waiting = await one(
    `SELECT (SELECT count(*)::int FROM leave_requests l JOIN users u ON u.id = l.employee_id WHERE l.status = 'PENDING' AND u.org_id = $1)
          + (SELECT count(*)::int FROM review_requests r JOIN users u ON u.id = r.employee_id WHERE r.status = 'OPEN' AND r.kind IN ('MANUAL_REVIEW', 'DISPUTE', 'TECHNICAL_ISSUE') AND u.org_id = $1)
          + (SELECT count(*)::int FROM device_registrations d JOIN users u ON u.id = d.user_id WHERE d.status = 'PENDING' AND u.org_id = $1) AS n`,
    [orgId],
  );
  const alerts = await one(
    `SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND audience = 'ADMIN' AND severity = 'CRITICAL' AND created_at >= ${dayStartSql('$2', '$1')} AND created_at < ${dayEndSql('$2', '$1')}`,
    [orgId, date],
  );
  const names = (l: string[]) => (l.length ? ` (${l.slice(0, 5).join(', ')}${l.length > 5 ? ` +${l.length - 5}` : ''})` : '');
  const parts = [
    c.scheduled ? `Present ${c.present}/${c.scheduled}` : 'No shifts scheduled',
    c.late ? `Late ${c.late}` : null,
    c.pendingVerification ? `Waiting for verification ${c.pendingVerification}` : null,
    c.onLeave ? `On leave ${c.onLeave}` : null,
    c.holiday ? `Holiday ${c.holiday}` : null,
    c.absent ? `Not in ${c.absent}${names(missing)}` : null,
    alerts.n ? `${alerts.n} critical alert${alerts.n > 1 ? 's' : ''}` : null,
    waiting.n ? `${waiting.n} approval${waiting.n > 1 ? 's' : ''} waiting` : null,
  ].filter(Boolean);
  const line = parts.join(' · ');
  const text = [
    `${org.name} — ${when}`,
    '',
    ...parts.map((p) => `• ${p}`),
    c.leftEarly ? `• Left early ${c.leftEarly}` : null,
    '',
    `Open the dashboard: ${config.dashboardUrl}`,
  ]
    .filter((x) => x !== null)
    .join('\n');
  return { company: org.name, when, line, text };
}

/**
 * Claims a slot; true when this call won it (and must send). A slot can be claimed again, up to three
 * times and five minutes apart, if nothing was delivered: every recipient failed, or the server stopped
 * before recording the result. If some recipients got it, it is not sent again.
 */
async function claim(orgId: string, slot: string) {
  return !!(await one(
    `INSERT INTO digest_runs (org_id, slot) VALUES ($1, $2)
     ON CONFLICT (org_id, slot) DO UPDATE SET attempts = digest_runs.attempts + 1, failed = false, results = '{}', sent_at = now()
     WHERE (digest_runs.failed OR digest_runs.results = '{}') AND digest_runs.attempts < 3 AND digest_runs.sent_at < now() - interval '5 minutes'
     RETURNING slot`,
    [orgId, slot],
  ));
}

const isFailure = (v: string) => v.startsWith('failed');

/** Stores the outcome. Throws if anything failed, so the job shows up as failing. */
async function record(orgId: string, slot: string, results: Record<string, string>) {
  const outcomes = Object.values(results);
  const nothingDelivered = outcomes.length > 0 && outcomes.every(isFailure);
  await q(`UPDATE digest_runs SET results = $3, failed = $4 WHERE org_id = $1 AND slot = $2`, [orgId, slot, JSON.stringify(results), nothingDelivered]);
  if (outcomes.some(isFailure)) throw new Error(`Summary ${slot}: ${outcomes.filter(isFailure).length} of ${outcomes.length} recipients failed`);
}

/** Sends one digest to everyone configured; returns a result per recipient. */
export async function sendDigest(orgId: string, d: Digest) {
  const { digest } = await getSettings(orgId);
  const results: Record<string, string> = {};
  for (const n of digest.whatsappNumbers) results[`whatsapp:${n}`] = await senders.whatsapp(n, d).catch((e: Error) => `failed: ${e.message}`);
  if (digest.emailRecipients.length) {
    results.email = await senders.email(digest.emailRecipients, `[GeoAttend] ${d.company} — ${d.when}`, d.text).catch((e: Error) => `failed: ${e.message}`);
  }
  return results;
}

/** Companies with someone to send a summary to. */
const companiesWithDigests = async () =>
  (await q(
    `SELECT DISTINCT s.org_id FROM application_settings s
     WHERE s.key = 'digest' AND (jsonb_array_length(COALESCE(s.value->'whatsappNumbers', '[]')) > 0 OR jsonb_array_length(COALESCE(s.value->'emailRecipients', '[]')) > 0
       OR s.value->>'supervisorSummaries' = 'true' OR s.value->>'employeeSummaries' = 'true')`,
  )).map((r) => r.org_id as string);

export const sweepDigests = (now = new Date()) => eachCompany((orgId) => digestsForCompany(orgId, now), companiesWithDigests);

/** Claims a slot, produces it and records the result. A failure leaves the slot open for another try. */
async function attempt(orgId: string, slot: string, produce: () => Promise<Record<string, string>>) {
  if (!(await claim(orgId, slot))) return;
  let results: Record<string, string>;
  try {
    results = await produce();
  } catch (err) {
    await q(`UPDATE digest_runs SET failed = true WHERE org_id = $1 AND slot = $2`, [orgId, slot]);
    throw err;
  }
  await record(orgId, slot, results);
}

const SUMMARY_HEADERS = ['Employee ID', 'Employee', 'Workplace', 'Shifts', 'Present', 'Late', 'Paid leave', 'Unpaid leave', 'Holidays', 'Absent', 'Hours worked', 'Overtime hours', 'Left early', 'Pending days (not counted)', 'Pending hours (not counted)'];
const summaryCsv = (rows: any[]) =>
  toCsv(SUMMARY_HEADERS, rows.map((r) => [r.employee_code, r.full_name, r.workplace_name, r.scheduled, r.present, r.late, r.paid_leave, r.unpaid_leave, r.holidays, r.absent, (r.worked_minutes / 60).toFixed(2), (r.overtime_minutes / 60).toFixed(2), r.left_early, r.pending_days, (r.pending_minutes / 60).toFixed(2)]));

const delivered = (to: string[], subject: string, text: string, filename: string, csv: string) =>
  senders.email(to, subject, text, [{ filename, content: csv }]).catch((e: Error) => `failed: ${e.message}`);

/** What an employee reads about their week. Pending days are named as not counted. */
export function weekLine(r: any) {
  const hours = (r.worked_minutes / 60).toFixed(1);
  const pending = r.pending_days ? ` ${r.pending_days} day${r.pending_days === 1 ? '' : 's'} waiting for verification, not counted yet.` : '';
  return `Last week: present ${r.present} of ${r.scheduled} days, ${hours} hours.${r.late ? ` Late ${r.late}.` : ''}${pending}`;
}

async function digestsForCompany(orgId: string, now: Date) {
  const { digest } = await getSettings(orgId);
  const org = await orgInfo(orgId);
  const zone = org.timezone ?? DEFAULT_TIMEZONE;
  const local = DateTime.fromJSDate(now, { zone });
  const date = local.toISODate()!;
  const work: Array<() => Promise<unknown>> = [];

  for (const t of digest.times) {
    const late = local.diff(DateTime.fromISO(`${date}T${t}`, { zone }), 'minutes').minutes;
    if (late < 0 || late > LATE_LIMIT_MIN) continue;
    work.push(() => attempt(orgId, `${date} ${t}`, async () => sendDigest(orgId, await composeDigest(orgId, date, `${local.toFormat('ccc d LLL')}, ${t}`))));
  }

  // Monthly report from 09:00 local on the 1st, for the month that just ended. A server that was down
  // on the 1st catches up by the 3rd; the claimed slot means it is still sent only once.
  if (digest.monthlyReport && digest.emailRecipients.length && local.day <= 3 && (local.day > 1 || local.hour >= 9)) {
    const month = local.minus({ months: 1 }).toFormat('yyyy-MM');
    work.push(() =>
      attempt(orgId, `monthly ${month}`, async () => {
        const s = await monthlySummary(orgId, month, null, false);
        const monthName = DateTime.fromISO(`${month}-01`).toFormat('LLLL yyyy');
        return { email: await delivered(digest.emailRecipients, `[GeoAttend] ${org.name} — attendance for ${monthName}`, `Attached: attendance summary for ${monthName} (${s.rows.length} employees).\n\nOpen the dashboard: ${config.dashboardUrl}`, `attendance_${month}.csv`, summaryCsv(s.rows)) };
      }),
    );
  }

  // Weekly summaries from 09:00 local on Monday, for the Monday-to-Sunday week that just ended; catches up by Wednesday.
  if (local.weekday <= 3 && (local.weekday > 1 || local.hour >= 9)) {
    const monday = local.startOf('week').minus({ weeks: 1 });
    const from = monday.toISODate()!;
    const to = monday.plus({ days: 6 }).toISODate()!;
    const label = `${monday.toFormat('d LLL')} to ${monday.plus({ days: 6 }).toFormat('d LLL yyyy')}`;
    let summary: ReturnType<typeof periodSummary> | null = null;
    const week = () => (summary ??= periodSummary(orgId, from, to, null, false)); // worked out once, and only if a slot needs it

    if (digest.weeklyReport && digest.emailRecipients.length) {
      work.push(() =>
        attempt(orgId, `weekly ${from}`, async () => {
          const s = await week();
          return { email: await delivered(digest.emailRecipients, `[GeoAttend] ${org.name} — attendance for ${label}`, `Attached: attendance summary for ${label} (${s.rows.length} employees).\n\nOpen the dashboard: ${config.dashboardUrl}`, `attendance_${from}.csv`, summaryCsv(s.rows)) };
        }),
      );
    }

    if (digest.supervisorSummaries) {
      const supervisors = await q(
        `SELECT u.id, u.email, ap.site_ids, ARRAY(SELECT ep.user_id FROM employee_profiles ep WHERE ep.supervisor_id = u.id) AS team FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id
         WHERE u.org_id = $1 AND u.is_active AND NOT u.is_demo AND ap.access = 'SUPERVISOR' AND ap.notify_email AND cardinality(ap.site_ids) > 0`,
        [orgId],
      );
      for (const sup of supervisors) {
        work.push(() =>
          attempt(orgId, `weekly ${from} supervisor ${sup.id}`, async () => {
            // Their own sites and their own team, nothing else (approved policy, Phase I).
            const rows = (await week()).rows.filter((r: any) => sup.site_ids.includes(r.workplace_id) && sup.team.includes(r.employee_id));
            return { email: await delivered([sup.email], `[GeoAttend] Your sites — attendance for ${label}`, `Attached: attendance summary for your sites, ${label} (${rows.length} employees).\n\nOpen the dashboard: ${config.dashboardUrl}`, `attendance_${from}.csv`, summaryCsv(rows)) };
          }),
        );
      }
    }

    if (digest.employeeSummaries) {
      work.push(() =>
        attempt(orgId, `weekly ${from} employees`, async () => {
          const outbox = new Outbox();
          const s = await week();
          const failures = await eachRecord(s.rows, (r: any) =>
            notify(getPool(), outbox, { type: 'WEEKLY_SUMMARY', severity: 'INFO', audience: 'EMPLOYEE', body: weekLine(r), employeeId: r.employee_id, data: { from, to }, dedupeKey: `weekly-summary:${r.employee_id}:${from}` }),
          );
          outbox.flush();
          throwIfAny(failures);
          return { employees: `${s.rows.length} told` };
        }),
      );
    }
  }

  throwIfAny(await eachRecord(work, (run) => run())); // one summary failing does not hold up the next
}
