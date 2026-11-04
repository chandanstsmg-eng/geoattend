/**
 * Minimal fetch client for the GeoAttend API. Usable from React and from the
 * background location task (no React dependencies).
 *
 * Refresh tokens ROTATE on every use and re-using an old one revokes the whole
 * family, so refresh is single-flight: concurrent 401s share one refresh call.
 */
import { API_URL } from '../config';
import { clearCredentials, getTokens, setTokens } from '../secure';
import type { RefreshResponse } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isNetwork() {
    return this.status === 0;
  }
}

type AuthLostListener = (reason: string) => void;
const authLostListeners = new Set<AuthLostListener>();
/** Called when the session can no longer be refreshed (the user must sign in again). */
export function onAuthLost(l: AuthLostListener): () => void {
  authLostListeners.add(l);
  return () => authLostListeners.delete(l);
}

let accessMemo: string | null = null;
let refreshInFlight: Promise<string> | null = null;

export function setAccessTokenMemo(t: string | null) {
  accessMemo = t;
}

async function currentAccessToken(): Promise<string | null> {
  if (accessMemo) return accessMemo;
  const t = await getTokens();
  accessMemo = t?.accessToken || null;
  return accessMemo;
}

async function rawFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (!API_URL) throw new ApiError(0, 'API_URL_MISSING', 'The app is not configured with an API address (EXPO_PUBLIC_API_URL).');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(API_URL + path, { ...init, signal: ctrl.signal });
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    throw new ApiError(0, aborted ? 'TIMEOUT' : 'NETWORK_ERROR', aborted ? 'The server did not respond in time.' : 'Cannot reach the GeoAttend server. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const e = body?.error;
  return new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? `Request failed (${res.status}).`, e?.details);
}

/** Clears credentials and notifies listeners. */
async function authLost(reason: string) {
  accessMemo = null;
  await clearCredentials();
  authLostListeners.forEach((l) => {
    try {
      l(reason);
    } catch {
      /* ignore listener errors */
    }
  });
}

/** Single-flight refresh. Resolves with the new access token. */
export function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const t = await getTokens();
    if (!t) {
      await authLost('not signed in');
      throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again.');
    }
    const res = await rawFetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }) }, 20_000);
    if (!res.ok) {
      const err = await toApiError(res);
      // 4xx: the refresh token is invalid / revoked / expired — the user must sign in again.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) await authLost(err.code);
      throw err;
    }
    const data = (await res.json()) as RefreshResponse;
    await setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    accessMemo = data.accessToken;
    return data.accessToken;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, timeoutMs = 20_000 } = opts;
  const send = async (token: string | null) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    return rawFetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs);
  };

  let token = auth ? await currentAccessToken() : null;
  if (auth && !token) token = await refreshAccessToken();
  let res = await send(token);
  if (auth && res.status === 401) {
    // Another call may already have refreshed while this one was in flight.
    const latest = accessMemo;
    token = latest && latest !== token ? latest : await refreshAccessToken();
    res = await send(token);
    if (res.status === 401) {
      await authLost('unauthorized after refresh');
      throw await toApiError(res);
    }
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
