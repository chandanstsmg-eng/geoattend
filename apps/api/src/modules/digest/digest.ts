/**
 * Daily summaries for owners who never open a laptop: at the company's chosen local
 * times, "who's in, who's missing, what needs me" goes to WhatsApp and e-mail. On the
 * 1st, last month's attendance summary (CSV) is e-mailed to the chosen recipients.
 * Each slot is claimed in digest_runs first, so it is sent at most once.
 */
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';
import { one, q } from '../../db/pool.js';
import { eachCompany } from '../jobs/runner.js';
import { DEFAULT_TIMEZONE, dayEndSql, dayStartSql } from '../../lib/dates.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { toCsv } from '../../lib/csv.js';
import { getSettings } from '../settings/settings.service.js';
import { daySummary } from '../reports/insights.routes.js';
import { monthlySummary } from '../reports/reports.routes.js';

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
      logger.info({ to, subject }, 'SMTP not configured; summary e-mail logged instead');
      return 'not configured (logged)';
    }
    await nodemailer.createTransport(config.email.smtpUrl).sendMail({ from: config.email.from, to, subject, text, attachments });
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
     WHERE s.key = 'digest' AND (jsonb_array_length(COALESCE(s.value->'whatsappNumbers', '[]')) > 0 OR jsonb_array_length(COALESCE(s.value->'emailRecipients', '[]')) > 0)`,
  )).map((r) => r.org_id as string);

export const sweepDigests = (now = new Date()) => eachCompany((orgId) => digestsForCompany(orgId, now), companiesWithDigests);

async function digestsForCompany(orgId: string, now: Date) {
  {
    {
      const { digest } = await getSettings(orgId);
      const org = await orgInfo(orgId);
      const local = DateTime.fromJSDate(now, { zone: org.timezone ?? DEFAULT_TIMEZONE });
      const date = local.toISODate()!;
      for (const t of digest.times) {
        const at = DateTime.fromISO(`${date}T${t}`, { zone: org.timezone ?? DEFAULT_TIMEZONE });
        const late = local.diff(at, 'minutes').minutes;
        if (late < 0 || late > LATE_LIMIT_MIN) continue;
        const slot = `${date} ${t}`;
        if (!(await claim(orgId, slot))) continue;
        const d = await composeDigest(orgId, date, `${local.toFormat('ccc d LLL')}, ${t}`);
        await record(orgId, slot, await sendDigest(orgId, d));
      }
      // Monthly report on the 1st, from 09:00 local, for the month that just ended.
      if (digest.monthlyReport && digest.emailRecipients.length && local.day === 1 && local.hour >= 9) {
        const month = local.minus({ months: 1 }).toFormat('yyyy-MM');
        const slot = `monthly ${month}`;
        if (await claim(orgId, slot)) {
          const s = await monthlySummary(orgId, month, null, false);
          const csv = toCsv(
            ['Employee ID', 'Employee', 'Workplace', 'Shifts', 'Present', 'Late', 'Paid leave', 'Unpaid leave', 'Holidays', 'Absent', 'Hours worked', 'Overtime hours', 'Left early', 'Pending days (not counted)', 'Pending hours (not counted)'],
            s.rows.map((r: any) => [r.employee_code, r.full_name, r.workplace_name, r.scheduled, r.present, r.late, r.paid_leave, r.unpaid_leave, r.holidays, r.absent, (r.worked_minutes / 60).toFixed(2), (r.overtime_minutes / 60).toFixed(2), r.left_early, r.pending_days, (r.pending_minutes / 60).toFixed(2)]),
          );
          const monthName = DateTime.fromISO(`${month}-01`).toFormat('LLLL yyyy');
          const result = await senders
            .email(digest.emailRecipients, `[GeoAttend] ${org.name} — attendance for ${monthName}`, `Attached: attendance summary for ${monthName} (${s.rows.length} employees).\n\nOpen the dashboard: ${config.dashboardUrl}`, [{ filename: `attendance_${month}.csv`, content: csv }])
            .catch((e: Error) => `failed: ${e.message}`);
          await record(orgId, slot, { email: result });
        }
      }
    }
  }
}
