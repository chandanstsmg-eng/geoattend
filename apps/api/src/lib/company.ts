/**
 * A company's standing on the platform: whether it is suspended, its edition, the optional modules it has,
 * its employee and supervisor limits, and where its subscription stands.
 *
 * The values live on the company's own row (organizations, migration 032). The platform copies an edition's
 * limits and modules onto a company when it assigns that edition and may then change them for that company;
 * editing an edition later does not change companies that already have it.
 *
 * An expired subscription never removes or hides data. After the grace period the company's administrators can
 * still sign in, read, report and export, but cannot change anything; employees keep recording attendance, so
 * no one's working time goes unrecorded. Suspension (a platform decision) stops every sign-in of the company.
 */
import { DateTime } from 'luxon';
import { asSystem, one, q, type Queryable } from '../db/pool.js';
import { HttpError } from './errors.js';

/** Optional modules. Everything else (attendance, GPS, leave, reports, exports, SOS, notifications) is in every edition. */
export const FEATURES = ['announcements', 'tasks', 'overtime', 'payroll'] as const;
export type Feature = (typeof FEATURES)[number];
export type Features = Record<Feature, boolean>;

/** Administrator routes that belong to an optional module, by their mount path. Employee routes are never gated. */
export const FEATURE_BY_BASE: Record<string, Feature> = {
  '/api/v1/broadcasts': 'announcements',
  '/api/v1/tasks': 'tasks',
  '/api/v1/overtime': 'overtime',
  '/api/v1/payroll': 'payroll',
};

export type SubscriptionState = 'ACTIVE' | 'TRIAL' | 'EXPIRING' | 'GRACE' | 'EXPIRED';

export interface CompanyStanding {
  status: 'ACTIVE' | 'SUSPENDED';
  editionCode: string;
  features: Features;
  employeeLimit: number | null;
  supervisorLimit: number | null;
  subscription: {
    status: 'TRIAL' | 'ACTIVE' | 'CANCELLED';
    startsOn: string | null;
    endsOn: string | null;
    state: SubscriptionState;
    /** Days until the end date (0 on the last day, negative after it); null without an end date. */
    daysLeft: number | null;
    /** Past the grace period: administrators may read and export, not change anything. */
    readOnly: boolean;
  };
}

/** Columns needed to work out a company's standing, for queries that join organizations as `o`. */
export const STANDING_COLUMNS = `o.status AS org_status, o.edition_code, o.features AS org_features, o.employee_limit, o.supervisor_limit,
  o.subscription_status, o.subscription_starts_on::text AS subscription_starts_on, o.subscription_ends_on::text AS subscription_ends_on`;

export const normalizeFeatures = (raw: unknown): Features => {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(FEATURES.map((k) => [k, f[k] === true])) as Features;
};

// ── Platform settings (read often, changed rarely): cached briefly per process ──
export interface PlatformSettings {
  signup: { enabled: boolean; editionCode: string; trialDays: number };
  subscriptions: { graceDays: number; warningDays: number };
  support: { email: string | null; phone: string | null };
}
export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  signup: { enabled: true, editionCode: 'STARTER', trialDays: 30 },
  subscriptions: { graceDays: 7, warningDays: 14 },
  support: { email: null, phone: null },
};
let cached: { at: number; value: PlatformSettings } | null = null;
const SETTINGS_TTL_MS = 30_000;

export function invalidatePlatformSettings() {
  cached = null;
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.value;
  const rows = await asSystem(() => q<{ key: keyof PlatformSettings; value: any }>('SELECT key, value FROM platform_settings'));
  const value = structuredClone(DEFAULT_PLATFORM_SETTINGS);
  for (const r of rows) if (r.key in value) (value as any)[r.key] = { ...(value as any)[r.key], ...r.value };
  cached = { at: Date.now(), value };
  return value;
}

/** Where a subscription stands on `today` (YYYY-MM-DD, UTC by default). The end date is the last day covered. */
export function subscriptionState(
  s: { status: 'TRIAL' | 'ACTIVE' | 'CANCELLED'; endsOn: string | null },
  rules: PlatformSettings['subscriptions'],
  today = DateTime.utc().toISODate()!,
): { state: SubscriptionState; daysLeft: number | null; readOnly: boolean } {
  if (!s.endsOn) return { state: s.status === 'TRIAL' ? 'TRIAL' : 'ACTIVE', daysLeft: null, readOnly: false };
  const daysLeft = Math.round(DateTime.fromISO(s.endsOn, { zone: 'utc' }).diff(DateTime.fromISO(today, { zone: 'utc' }), 'days').days);
  if (daysLeft >= 0) {
    const state = daysLeft <= rules.warningDays ? 'EXPIRING' : s.status === 'TRIAL' ? 'TRIAL' : 'ACTIVE';
    return { state, daysLeft, readOnly: false };
  }
  if (-daysLeft <= rules.graceDays) return { state: 'GRACE', daysLeft, readOnly: false };
  return { state: 'EXPIRED', daysLeft, readOnly: true };
}

export async function standingFromRow(r: any): Promise<CompanyStanding> {
  const rules = (await getPlatformSettings()).subscriptions;
  const sub = { status: r.subscription_status ?? 'ACTIVE', startsOn: r.subscription_starts_on ?? null, endsOn: r.subscription_ends_on ?? null };
  return {
    status: r.org_status ?? 'ACTIVE',
    editionCode: r.edition_code ?? 'ENTERPRISE',
    features: normalizeFeatures(r.org_features),
    employeeLimit: r.employee_limit ?? null,
    supervisorLimit: r.supervisor_limit ?? null,
    subscription: { ...sub, ...subscriptionState(sub, rules) },
  };
}

export async function loadStanding(orgId: string, db?: Queryable): Promise<CompanyStanding> {
  const r = await one(`SELECT ${STANDING_COLUMNS} FROM organizations o WHERE o.id = $1`, [orgId], db);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Company not found');
  return standingFromRow(r);
}

export const suspendedError = () => new HttpError(403, 'COMPANY_SUSPENDED', 'This company’s GeoAttend account is suspended. Contact GeoAttend support.');

/**
 * Refuses to add one more active employee or supervisor beyond the company's limit. Called inside the transaction
 * that adds them; the per-company lock makes two simultaneous additions wait for each other, so both cannot pass.
 */
export async function assertWithinLimit(kind: 'employee' | 'supervisor', orgId: string, db: Queryable) {
  await one(`SELECT pg_advisory_xact_lock(hashtextextended($1, 32))`, [`limit:${kind}:${orgId}`], db);
  const r = await one(
    kind === 'employee'
      ? `SELECT o.employee_limit AS lim, (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.role = 'EMPLOYEE' AND u.is_active) AS used FROM organizations o WHERE o.id = $1`
      : `SELECT o.supervisor_limit AS lim, (SELECT count(*)::int FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.org_id = o.id AND u.role = 'ADMIN' AND u.is_active AND ap.access = 'SUPERVISOR') AS used FROM organizations o WHERE o.id = $1`,
    [orgId],
    db,
  );
  if (r && r.lim !== null && r.used >= r.lim) {
    const noun = kind === 'employee' ? 'employees' : 'supervisors';
    throw new HttpError(403, 'PLAN_LIMIT_REACHED', `Your plan allows ${r.lim} active ${noun}, and all are in use. Deactivate one, or ask GeoAttend to raise the limit.`, { kind, limit: r.lim, used: r.used });
  }
}

/** Active employees and supervisors of a company (shown next to the limits). */
export async function companyUsage(orgId: string, db?: Queryable) {
  return (await one(
    `SELECT (SELECT count(*)::int FROM users u WHERE u.org_id = $1 AND u.role = 'EMPLOYEE' AND u.is_active) AS employees,
            (SELECT count(*)::int FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.org_id = $1 AND u.role = 'ADMIN' AND u.is_active AND ap.access = 'SUPERVISOR') AS supervisors,
            (SELECT count(*)::int FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.org_id = $1 AND u.role = 'ADMIN' AND u.is_active AND ap.access = 'OWNER') AS owners`,
    [orgId],
    db,
  ))!;
}
