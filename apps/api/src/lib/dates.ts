/**
 * Business dates.
 *
 * Timestamps are stored in UTC. A "business date" (today, a report range, a month) is the date on the
 * wall of the workplace: a shift's date comes from the shift's time zone, and anything company-wide
 * from the company's zone, which is the zone of its first active workplace, or Asia/Kolkata if it has
 * none yet. Nothing here depends on the time zone of the server or of the database connection, and
 * SQL's CURRENT_DATE must not be used: it is the connection's date, and between 00:00 and 05:30 IST
 * that is still yesterday.
 */
import { Settings } from 'luxon';
import { one, type Queryable } from '../db/pool.js';
import { todayIn } from './shift-window.js';

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

// Plain date arithmetic (DateTime.fromISO('2026-11-05')) must not vary with the server's zone.
Settings.defaultZone = 'utc';

/** SQL for a company's time zone; `org` is an expression holding its id. */
export const orgTimezoneSql = (org: string) =>
  `COALESCE((SELECT tzw.timezone FROM workplaces tzw WHERE tzw.org_id = ${org} ORDER BY tzw.is_active DESC, tzw.created_at LIMIT 1), '${DEFAULT_TIMEZONE}')`;

/** SQL for today's date in a zone (an expression such as `sh.timezone`). */
export const localDaySql = (zone: string) => `(now() AT TIME ZONE ${zone})::date`;

/** SQL for the instant a company's business day `date` begins, for comparing with timestamps. */
export const dayStartSql = (date: string, org: string) => `((${date})::date::timestamp AT TIME ZONE ${orgTimezoneSql(org)})`;

/** SQL for the instant after a company's business day `date` ends. */
export const dayEndSql = (date: string, org: string) => `(((${date})::date + 1)::timestamp AT TIME ZONE ${orgTimezoneSql(org)})`;

/** The time zone of one workplace of the company, or of the company. */
export async function orgTimezone(orgId: string, workplaceId: string | null = null, db?: Queryable): Promise<string> {
  const w = await one(`SELECT timezone FROM workplaces WHERE org_id = $2 AND ($1::uuid IS NULL OR id = $1) ORDER BY is_active DESC, created_at LIMIT 1`, [workplaceId, orgId], db);
  return w?.timezone ?? DEFAULT_TIMEZONE;
}

/** Today's business date (YYYY-MM-DD). */
export async function orgToday(orgId: string, workplaceId: string | null = null, now = new Date(), db?: Queryable) {
  return todayIn(await orgTimezone(orgId, workplaceId, db), now);
}
