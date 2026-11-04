/**
 * Browser API client. Same-origin requests to /api/v1 (proxied to the API by
 * Next.js) with httpOnly auth cookies. State-changing requests carry the
 * double-submit CSRF token. A 401 triggers one single-flight refresh + retry.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function csrfToken() {
  if (typeof document === 'undefined') return '';
  return decodeURIComponent(document.cookie.match(/(?:^|; )ga_csrf=([^;]+)/)?.[1] ?? '');
}

let refreshing: Promise<boolean> | null = null;
function refreshSession() {
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T = any>(path: string, opts: { method?: Method; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const send = () =>
    fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken() } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : method === 'GET' ? undefined : '{}',
    });

  let res = await send();
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    if (await refreshSession()) res = await send();
    if (res.status === 401) {
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      }
      throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again.');
    }
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'HTTP_' + res.status, json?.error?.message ?? `Request failed (${res.status})`, json?.error?.details);
  return json as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
}

export function errorMessage(err: unknown) {
  if (err instanceof ApiError) {
    const fields = (err.details as any)?.fieldErrors as Record<string, string[]> | undefined;
    if (fields && Object.keys(fields).length) return `${err.message}: ${Object.entries(fields).map(([k, v]) => `${k} — ${v.join(', ')}`).join('; ')}`;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
