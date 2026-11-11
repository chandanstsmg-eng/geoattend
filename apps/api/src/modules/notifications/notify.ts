/**
 * Creating notifications.
 *
 * Every notification is persisted first (the in-app inbox is the record of
 * truth), then fanned out to optional channels via notification_deliveries,
 * which the sweeper sends with retry/back-off. `dedupeKey` (unique in the
 * database) suppresses repeats: the same key never produces a second alert.
 *
 * audience ADMIN    → admin inbox + SSE + web push / e-mail per alert policy
 * audience EMPLOYEE → the employee's registered devices via Expo push (if enabled)
 */
import { NOTIFICATION_LABELS, type NotificationType, type Severity } from '@geoattend/shared';
import { one, q, type Queryable } from '../../db/pool.js';
import { localDaySql, orgTimezoneSql } from '../../lib/dates.js';
import { config } from '../../config.js';
import { getSettings } from '../settings/settings.service.js';
import type { Outbox } from './live-hub.js';
import { DEFAULT_ORG_ID, employeeSite } from '../../lib/tenancy.js';

export interface NotifyInput {
  type: NotificationType;
  severity: Severity;
  body: string;
  title?: string;
  audience?: 'ADMIN' | 'EMPLOYEE';
  employeeId?: string | null;
  workplaceId?: string | null;
  sessionId?: string | null;
  data?: Record<string, unknown>;
  dedupeKey?: string;
  simulated?: boolean;
}

export async function notify(db: Queryable, outbox: Outbox, n: NotifyInput) {
  const audience = n.audience ?? 'ADMIN';
  // The company comes from the employee or workplace the notification is about.
  const row = await one(
    `INSERT INTO notifications (type, audience, severity, title, body, employee_id, workplace_id, session_id, data, dedupe_key, is_simulated, org_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             COALESCE((SELECT org_id FROM users WHERE id = $6), (SELECT org_id FROM workplaces WHERE id = $7)))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING *`,
    [
      n.type,
      audience,
      n.severity,
      n.title ?? NOTIFICATION_LABELS[n.type],
      n.body,
      n.employeeId ?? null,
      n.workplaceId ?? null,
      n.sessionId ?? null,
      JSON.stringify(n.data ?? {}),
      n.dedupeKey ?? null,
      n.simulated ?? false,
    ],
    db,
  );
  if (!row) return null; // suppressed duplicate

  if (audience === 'EMPLOYEE') {
    if (config.push.expoPushEnabled && n.employeeId && !n.simulated) {
      await q(
        `INSERT INTO notification_deliveries (notification_id, channel, target)
         SELECT $1, 'EXPO_PUSH', push_token FROM device_registrations
         WHERE user_id = $2 AND push_token IS NOT NULL AND last_seen_at > now() - interval '30 days'`,
        [row.id, n.employeeId],
        db,
      );
    }
    return row;
  }

  const settings = await getSettings(row.org_id, db);
  // Who gets push / e-mail: this company's administrators who are not away; supervisors only
  // for their own sites; overdue-approval escalations go to owners only.
  const site = row.workplace_id ?? (n.employeeId ? (await one(`SELECT ${employeeSite('$1')} AS wp`, [n.employeeId], db))?.wp : null);
  // The manager named on the roster entry for this session's shift and date is told as well.
  const manager = n.sessionId
    ? (
        await one(
          `SELECT esa.manager_id FROM tracking_sessions s JOIN employee_shift_assignments esa
             ON esa.employee_id = s.employee_id AND esa.shift_id = s.shift_id AND esa.effective_from <= s.shift_date AND (esa.effective_to IS NULL OR esa.effective_to >= s.shift_date)
           WHERE s.id = $1 AND esa.manager_id IS NOT NULL LIMIT 1`,
          [n.sessionId],
          db,
        )
      )?.manager_id ?? null
    : null;
  const recipients = `u.is_active AND u.role = 'ADMIN' AND u.org_id = $2 AND (${n.type === 'SOS' ? 'true OR ' : ''}ap.away_until IS NULL OR ap.away_until < ${localDaySql(orgTimezoneSql('$2'))})
    AND (ap.access = 'OWNER' OR ($4::boolean IS NOT TRUE AND (u.id = $5::uuid OR ($3::uuid = ANY(ap.site_ids)
         -- approved policy (Phase I): about an employee, only that employee's own supervisor at the site is told
         AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM employee_profiles tp WHERE tp.user_id = $6::uuid AND tp.supervisor_id = u.id))))))`;
  const ownersOnly = n.type === 'APPROVAL_OVERDUE';
  const always = n.type === 'SOS'; // a safety alert is never left to the inbox alone
  if ((always || settings.alerts.webPushTypes.includes(n.type)) && config.push.vapidPrivateKey) {
    await q(
      `INSERT INTO notification_deliveries (notification_id, channel, target)
       SELECT $1, 'WEB_PUSH', s.id::text FROM web_push_subscriptions s
       JOIN users u ON u.id = s.user_id
       JOIN administrator_profiles ap ON ap.user_id = u.id
       WHERE ap.notify_push AND ${recipients}`,
      [row.id, row.org_id, site, ownersOnly, manager, n.employeeId ?? null],
      db,
    );
  }
  if ((always || settings.alerts.emailTypes.includes(n.type)) && config.email.smtpUrl && !n.simulated) {
    const admins = await q<{ email: string }>(
      `SELECT u.email FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id
       WHERE ap.notify_email AND NOT u.is_demo AND $1::uuid IS NOT NULL AND ${recipients}`,
      [row.id, row.org_id, site, ownersOnly, manager, n.employeeId ?? null],
      db,
    );
    // ALERT_EMAIL_RECIPIENTS in .env belong to the original installation, not to companies that signed up later.
    const targets = new Set([...admins.map((a) => a.email), ...(row.org_id === DEFAULT_ORG_ID ? config.email.adminRecipients : [])]);
    for (const t of targets) {
      await q(`INSERT INTO notification_deliveries (notification_id, channel, target) VALUES ($1, 'EMAIL', $2)`, [row.id, t], db);
    }
  }
  outbox.push({ type: 'notification.created', notification: row });
  return row;
}
