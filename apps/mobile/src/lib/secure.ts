/**
 * Credentials live in expo-secure-store only (Android Keystore / iOS Keychain).
 * AFTER_FIRST_UNLOCK lets the background location task read the token while the
 * phone is locked (iOS default WHEN_UNLOCKED would fail on the lock screen).
 */
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import type { ApiUser } from './api/types';

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
const K = {
  access: 'geoattend.accessToken',
  refresh: 'geoattend.refreshToken',
  user: 'geoattend.user',
  deviceId: 'geoattend.deviceId',
  refreshRequest: 'geoattend.refreshRequest',
};

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export async function getTokens(): Promise<Tokens | null> {
  const [accessToken, refreshToken] = await Promise.all([SecureStore.getItemAsync(K.access, OPTS), SecureStore.getItemAsync(K.refresh, OPTS)]);
  if (!refreshToken) return null;
  return { accessToken: accessToken ?? '', refreshToken };
}

export async function setTokens(t: Tokens): Promise<void> {
  // Refresh token first: if the app dies between the two writes we still hold the newest (rotated) refresh token.
  await SecureStore.setItemAsync(K.refresh, t.refreshToken, OPTS);
  await SecureStore.setItemAsync(K.access, t.accessToken, OPTS);
}

export async function clearCredentials(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(K.access, OPTS), SecureStore.deleteItemAsync(K.refresh, OPTS), SecureStore.deleteItemAsync(K.user, OPTS), SecureStore.deleteItemAsync(K.refreshRequest, OPTS)]);
}

/** The refresh being attempted, kept until it succeeds so a retry repeats the same request id. */
export async function getRefreshRequest(): Promise<{ token: string; id: string } | null> {
  try {
    const raw = await SecureStore.getItemAsync(K.refreshRequest, OPTS);
    return raw ? (JSON.parse(raw) as { token: string; id: string }) : null;
  } catch {
    return null;
  }
}
export async function setRefreshRequest(r: { token: string; id: string } | null): Promise<void> {
  if (r) await SecureStore.setItemAsync(K.refreshRequest, JSON.stringify(r), OPTS);
  else await SecureStore.deleteItemAsync(K.refreshRequest, OPTS);
}

export async function getCachedUser(): Promise<ApiUser | null> {
  const raw = await SecureStore.getItemAsync(K.user, OPTS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ApiUser;
  } catch {
    return null;
  }
}

export async function setCachedUser(u: ApiUser): Promise<void> {
  await SecureStore.setItemAsync(K.user, JSON.stringify(u), OPTS);
}

let deviceIdMemo: string | null = null;
/** Stable per-install identifier (uuid). Survives sign-out; cleared only by uninstall. */
export async function getDeviceId(): Promise<string> {
  if (deviceIdMemo) return deviceIdMemo;
  let id = await SecureStore.getItemAsync(K.deviceId, OPTS);
  if (!id) {
    id = randomUUID();
    await SecureStore.setItemAsync(K.deviceId, id, OPTS);
  }
  deviceIdMemo = id;
  return id;
}
