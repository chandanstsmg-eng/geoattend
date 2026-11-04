/**
 * Persistent tracking state (AsyncStorage): the bounded offline queue and a
 * small metadata record. All read-modify-write cycles go through `withLock`
 * so the background task and the UI never interleave writes in one JS runtime.
 *
 * A tiny in-memory snapshot + listener set feeds the UI (useSyncExternalStore).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_QUEUE_MAX, emptyQueue, type QueueState } from './queue-core';

const QUEUE_KEY = 'geoattend.queue.v1';
const META_KEY = 'geoattend.tracking.v1';

export interface TrackingMeta {
  /** Session the device is authorised to collect for. null = collect nothing. */
  sessionId: string | null;
  windowClosesAt: string | null;
  offlineQueueMax: number;
  evidenceMaxAgeSec: number;
  /** Last value of status.attendanceAvailable seen by the device (for the arrival notification edge). */
  attendanceAvailable: boolean;
  lastSentAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastServerState: string | null;
  /** JSON of the last permission report the server accepted. */
  lastPermissionReport: string | null;
  lastPermissionCheckAt: string | null;
  /** background = OS location task; foreground = in-app watcher only (app must stay open). */
  mode: 'background' | 'foreground' | null;
  backgroundGranted: boolean | null;
  stopped: { sessionId: string | null; reason: string; at: string; byUser: boolean } | null;
}

export const defaultMeta = (): TrackingMeta => ({
  sessionId: null,
  windowClosesAt: null,
  offlineQueueMax: DEFAULT_QUEUE_MAX,
  evidenceMaxAgeSec: 60,
  attendanceAvailable: false,
  lastSentAt: null,
  lastAttemptAt: null,
  lastError: null,
  lastServerState: null,
  lastPermissionReport: null,
  lastPermissionCheckAt: null,
  mode: null,
  backgroundGranted: null,
  stopped: null,
});

let chain: Promise<unknown> = Promise.resolve();
/** Serialises async critical sections (single JS runtime). */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

export const loadQueue = () => readJson<QueueState>(QUEUE_KEY, emptyQueue());
export const loadMeta = () => readJson<TrackingMeta>(META_KEY, defaultMeta());

export async function saveQueue(q: QueueState) {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  publish({ queueLength: q.items.length, dropped: q.dropped });
}

export async function saveMeta(m: TrackingMeta) {
  await AsyncStorage.setItem(META_KEY, JSON.stringify(m));
  publish({ meta: m });
}

/** Locked read-modify-write of the metadata. */
export function updateMeta(fn: (m: TrackingMeta) => TrackingMeta | void): Promise<TrackingMeta> {
  return withLock(async () => {
    const m = await loadMeta();
    const next = fn(m) ?? m;
    await saveMeta(next);
    return next;
  });
}

// ── UI snapshot ──

export interface TrackingSnapshot {
  loaded: boolean;
  queueLength: number;
  dropped: number;
  meta: TrackingMeta;
  updatesRunning: boolean | null;
  flushing: boolean;
}

let snapshot: TrackingSnapshot = { loaded: false, queueLength: 0, dropped: 0, meta: defaultMeta(), updatesRunning: null, flushing: false };
const listeners = new Set<() => void>();

export function publish(patch: Partial<TrackingSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}
export const getSnapshot = () => snapshot;
export function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Reload the snapshot from storage (e.g. after the headless task ran in another JS context). */
export async function reloadSnapshot() {
  const [q, m] = await Promise.all([loadQueue(), loadMeta()]);
  publish({ loaded: true, queueLength: q.items.length, dropped: q.dropped, meta: m });
}

export async function clearQueueAndMeta(stopped: TrackingMeta['stopped']) {
  await withLock(async () => {
    await saveQueue(emptyQueue());
    await saveMeta({ ...defaultMeta(), stopped });
  });
}
