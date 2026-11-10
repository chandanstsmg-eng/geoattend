import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onAuthLost, setAccessTokenMemo } from './api/client';
import type { ApiUser, LoginResponse } from './api/types';
import { deviceInfo, registerDevice } from './device';
import { queryClient } from './queryClient';
import { clearCredentials, getCachedUser, getTokens, setCachedUser, setTokens } from './secure';
import { reloadOutbox, syncOutbox } from './sync/outbox';
import { flush, stopTracking, withTimeout } from './tracking/runtime';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: Status;
  user: ApiUser | null;
  /** Set when the session ended unexpectedly (refresh failed) — shown on the login screen. */
  notice: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<ApiUser | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshUser = useCallback(async () => {
    const res = await api<{ user: ApiUser }>('/auth/me');
    setUser(res.user);
    await setCachedUser(res.user);
  }, []);

  // Restore the session from secure storage. Works offline with the cached profile.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [tokens, cached] = await Promise.all([getTokens(), getCachedUser()]);
      if (!alive) return;
      if (tokens && cached) {
        setAccessTokenMemo(tokens.accessToken || null);
        setUser(cached);
        setStatus('signedIn');
        refreshUser().catch(() => undefined);
        registerDevice().catch(() => undefined);
      } else {
        if (tokens) await clearCredentials();
        setStatus('signedOut');
      }
    })().catch(() => setStatus('signedOut'));
    return () => {
      alive = false;
    };
  }, [refreshUser]);

  // Refresh failure anywhere (UI or background task) → back to login.
  useEffect(
    () =>
      onAuthLost(() => {
        queryClient.clear();
        void reloadOutbox().catch(() => undefined);
        setUser(null);
        setNotice('Your session has expired. Please sign in again.');
        setStatus('signedOut');
      }),
    [],
  );

  const signIn = useCallback(async (email: string, password: string) => {
    // The server allows one approved phone per employee; it uses the id, platform and model to ask the admin.
    const { deviceId, platform, model } = await deviceInfo();
    const res = await api<LoginResponse>('/auth/login', { method: 'POST', auth: false, body: { email: email.trim(), password, client: 'mobile', deviceId, platform, model } });
    await setTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
    setAccessTokenMemo(res.accessToken);
    await setCachedUser(res.user);
    queryClient.clear();
    setNotice(null);
    setUser(res.user);
    setStatus('signedIn');
    registerDevice().catch(() => undefined);
    // Anything saved before the sign-in was lost goes now.
    void flush().then(() => syncOutbox()).catch(() => undefined);
  }, []);

  const signOut = useCallback(async () => {
    // Send what can be sent. The rest stays on the phone and goes when this employee signs in again.
    await withTimeout(flush().then(() => syncOutbox()), 10_000, 'flush timed out').catch(() => undefined);
    await stopTracking({ reason: 'You signed out. Location tracking has stopped.', notify: false, byUser: true });
    const tokens = await getTokens();
    if (tokens) {
      await api('/auth/logout', { method: 'POST', auth: false, body: { refreshToken: tokens.refreshToken }, timeoutMs: 8000 }).catch(() => undefined);
    }
    await clearCredentials();
    setAccessTokenMemo(null);
    queryClient.clear();
    // The saved items on screen were this employee's: hide them before the next person picks up the phone.
    void reloadOutbox().catch(() => undefined);
    setUser(null);
    setNotice(null);
    setStatus('signedOut');
  }, []);

  const value = useMemo(() => ({ status, user, notice, signIn, signOut, refreshUser }), [status, user, notice, signIn, signOut, refreshUser]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
