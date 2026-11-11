/**
 * Browser client for the platform console (GeoAttend's own administrators). Same shape as lib/api.ts, but its
 * own cookies: the platform CSRF token (ga_pcsrf), refresh at /platform/auth/refresh, and a 401 sends the person
 * to the platform sign-in, never to a company's. Paths are relative to /api/v1/platform.
 */
import { ApiError, REQUEST_TIMEOUT_MS, failureMessage } from './api';

export { ApiError, errorMessage, qs } from './api';

function csrfToken() {
  if (typeof document === 'undefined') return '';
  return decodeURIComponent(document.cookie.match(/(?:^|; )ga_pcsrf=([^;]+)/)?.[1] ?? '');
}

let refreshing: Promise<boolean> | null = null;
function refreshSession() {
  refreshing ??= fetch('/api/v1/platform/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function papi<T = any>(path: string, opts: { method?: Method; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const send = async () => {
    try {
      return await fetch(`/api/v1/platform${path}`, {
        method,
        credentials: 'same-origin',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken() } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : method === 'GET' ? undefined : '{}',
      });
    } catch (err) {
      const timeout = (err as Error)?.name === 'TimeoutError';
      throw new ApiError(0, timeout ? 'TIMEOUT' : 'NETWORK', failureMessage({ timeout, network: !timeout }));
    }
  };

  let res = await send();
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    if (await refreshSession()) res = await send();
    if (res.status === 401) {
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/platform/login')) {
        window.location.href = `/platform/login?next=${encodeURIComponent(window.location.pathname)}`;
      }
      throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again.');
    }
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'HTTP_' + res.status, failureMessage({ status: res.status, apiMessage: json?.error?.message }), json?.error?.details);
  return json as T;
}

export const pget = <T = any>(path: string) => papi<T>(path);
export const ppost = <T = any>(path: string, body?: unknown) => papi<T>(path, { method: 'POST', body: body ?? {} });
export const ppatch = <T = any>(path: string, body: unknown) => papi<T>(path, { method: 'PATCH', body });
export const pput = <T = any>(path: string, body: unknown) => papi<T>(path, { method: 'PUT', body });

// ── Shapes returned by the platform API ──
export const FEATURES = ['announcements', 'tasks', 'overtime', 'payroll'] as const;
export type Feature = (typeof FEATURES)[number];
export const FEATURE_LABEL: Record<Feature, string> = { announcements: 'Announcements', tasks: 'Tasks', overtime: 'Overtime', payroll: 'Payroll' };
export type SubState = 'ACTIVE' | 'TRIAL' | 'EXPIRING' | 'GRACE' | 'EXPIRED';

export interface PlatformAdmin {
  id: string;
  email: string;
  fullName: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

export interface Company {
  id: string;
  name: string;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
  status: 'ACTIVE' | 'SUSPENDED';
  statusReason: string | null;
  statusChangedAt: string | null;
  edition: { code: string; name: string };
  limits: { employees: number | null; supervisors: number | null };
  usage: { employees: number; supervisors: number; owners: number };
  features: Record<Feature, boolean>;
  subscription: { status: 'TRIAL' | 'ACTIVE' | 'CANCELLED'; startsOn: string | null; endsOn: string | null; state: SubState; daysLeft: number | null; readOnly: boolean };
  registration: Record<string, string>;
  registrationSource: string;
  lastSignInAt: string | null;
}

export interface Edition {
  code: string;
  name: string;
  description: string | null;
  limits: { employees: number | null; supervisors: number | null };
  features: Record<Feature, boolean>;
  defaultDurationDays: number;
  isActive: boolean;
  sortOrder: number;
  updatedAt: string;
  companies?: number;
}

export interface PlatformSettings {
  signup: { enabled: boolean; editionCode: string; trialDays: number };
  subscriptions: { graceDays: number; warningDays: number };
  support: { email: string | null; phone: string | null };
}

export const REGISTRATION_FIELDS: Array<{ key: string; label: string; type?: string }> = [
  { key: 'legalName', label: 'Legal name' },
  { key: 'registrationNumber', label: 'Registration number' },
  { key: 'taxId', label: 'Tax ID (GSTIN / PAN)' },
  { key: 'industry', label: 'Industry' },
  { key: 'addressLine', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'country', label: 'Country' },
  { key: 'contactName', label: 'Contact name' },
  { key: 'contactEmail', label: 'Contact e-mail', type: 'email' },
  { key: 'contactPhone', label: 'Contact phone' },
  { key: 'website', label: 'Website' },
  { key: 'notes', label: 'Notes' },
];

/** Registration values as the API expects them: blanks become null (cleared). */
export const registrationPayload = (r: Record<string, string>) => Object.fromEntries(REGISTRATION_FIELDS.map((f) => [f.key, r[f.key]?.trim() ? r[f.key]!.trim() : null]));
