/**
 * Shift-scoped location collection. The server decides everything; this module
 * only (1) collects readings while a session the employee explicitly started is
 * open, (2) queues them durably, (3) uploads them, and (4) obeys the server's
 * `tracking.shouldTrack` / window end.
 *
 * Used from the background task (no React) and from the UI.
 */
import { AppState, Platform } from 'react-native';
import * as Location from 'expo-location';
import { randomUUID } from 'expo-crypto';
import { api, ApiError, onAuthLost } from '../api/client';
import type { LocationsResponse, PermissionReport, SessionStatus } from '../api/types';
import { LOCATION_TASK } from '../config';
import { cancelLocal, notifyLocal, scheduleLocalAt } from '../notifications';
import { qk, queryClient } from '../queryClient';
import { getDeviceId } from '../secure';
import { emptyQueue, enqueue, nextBatch, removeAnswered, toWire, type QueuedReading } from './queue-core';
import { deviceStatus } from './device-status';
import { clearQueueAndMeta, defaultMeta, loadMeta, loadQueue, publish, saveQueue, updateMeta, withLock } from './store';

// ───────────────────────── readings ─────────────────────────

const finiteOrNull = (v: number | null | undefined, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;

/** Map an OS location fix to an API reading. Returns null for fixes the server could not accept (no accuracy). */
export function toReading(loc: Location.LocationObject, source: QueuedReading['source']): QueuedReading | null {
  const c = loc.coords;
  if (!(typeof c.accuracy === 'number' && c.accuracy > 0 && c.accuracy <= 5000)) return null;
  if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;
  return {
    clientEventId: randomUUID(),
    latitude: c.latitude,
    longitude: c.longitude,
    accuracyM: c.accuracy,
    clientTime: new Date(loc.timestamp).toISOString(),
    altitudeM: finiteOrNull(c.altitude, -1000, 20000),
    speedMps: finiteOrNull(c.speed, 0, 400),
    headingDeg: finiteOrNull(c.heading, 0, 360),
    isMocked: loc.mocked === true,
    source,
  };
}

const currentSource = (): QueuedReading['source'] => (AppState.currentState === 'active' ? 'FOREGROUND' : 'BACKGROUND');

/** Entry point for the background task and the foreground watcher. */
export async function recordLocations(locs: Location.LocationObject[], source: QueuedReading['source'] = currentSource()) {
  const meta = await loadMeta();
  if (!meta.sessionId) {
    // No open session on this device: never collect. Make sure the OS stops delivering.
    await stopLocationUpdatesSafe();
    stopForegroundWatcher();
    return;
  }
  if (meta.windowClosesAt && Date.now() > Date.parse(meta.windowClosesAt)) {
    await flush();
    await stopTracking({ reason: 'Your shift window has closed.', notify: true, byUser: false });
    return;
  }
  const readings = locs.map((l) => toReading(l, source)).filter((r): r is QueuedReading => r !== null);
  if (readings.length) {
    const sessionId = meta.sessionId;
    await withLock(async () => saveQueue(enqueue(await loadQueue(), sessionId, readings, meta.offlineQueueMax)));
  }
  await flush();
  await maybeCheckPermissions(meta.sessionId, meta.lastPermissionCheckAt);
}

// ───────────────────────── upload ─────────────────────────

export interface FlushOutcome {
  sent: number;
  remaining: number;
  error: string | null;
}

let flushInFlight: Promise<FlushOutcome> | null = null;

/** Upload queued readings, oldest first, ≤500 per request. Single-flight. */
export function flush(): Promise<FlushOutcome> {
  if (!flushInFlight) {
    flushInFlight = doFlush().finally(() => {
      flushInFlight = null;
    });
  }
  return flushInFlight;
}

async function doFlush(): Promise<FlushOutcome> {
  publish({ flushing: true });
  let sent = 0;
  try {
    for (let round = 0; round < 20; round++) {
      const [q, meta] = await Promise.all([loadQueue(), loadMeta()]);
      if (!meta.sessionId) {
        if (q.items.length) await withLock(() => saveQueue(emptyQueue()));
        return { sent, remaining: 0, error: null };
      }
      if (q.sessionId && q.sessionId !== meta.sessionId) {
        await withLock(() => saveQueue(emptyQueue(meta.sessionId)));
        continue;
      }
      const batch = nextBatch(q);
      if (!batch) return { sent, remaining: 0, error: null };
      const sessionId = meta.sessionId;
      await updateMeta((m) => ({ ...m, lastAttemptAt: new Date().toISOString() }));
      let res: LocationsResponse;
      try {
        res = await api<LocationsResponse>('/tracking/locations', {
          method: 'POST',
          body: { sessionId, source: batch.source, readings: batch.readings.map(toWire), device: await deviceStatus() },
          timeoutMs: 30_000,
        });
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', String(err));
        if (e.status === 400) {
          // The request itself was malformed: these readings can never be accepted. Drop them so the queue is not blocked.
          const ids = batch.readings.map((r) => r.clientEventId);
          await withLock(async () => {
            const cur = await loadQueue();
            await saveQueue({ ...removeAnswered(cur, ids), dropped: cur.dropped + ids.length });
          });
          await updateMeta((m) => ({ ...m, lastError: `Server rejected a batch: ${e.message}` }));
          continue;
        }
        if (e.status === 403 || e.status === 404) {
          await stopTracking({ reason: 'This shift session is no longer available on the server.', notify: true, byUser: false });
          return { sent, remaining: 0, error: e.message };
        }
        // Offline, timeout, 5xx, 429, or signed out (handled by onAuthLost): keep everything queued.
        await updateMeta((m) => ({ ...m, lastError: e.message }));
        const left = (await loadQueue()).items.length;
        return { sent, remaining: left, error: e.message };
      }
      const answered = res.results.map((r) => r.clientEventId);
      await withLock(async () => saveQueue(removeAnswered(await loadQueue(), answered)));
      sent += answered.length;
      await updateMeta((m) => ({ ...m, lastSentAt: new Date().toISOString(), lastError: null }));
      const stopped = await applyServerStatus(res.status);
      if (stopped) return { sent, remaining: 0, error: null };
      if (answered.length === 0) break; // defensive: never spin on a batch the server did not answer
    }
    return { sent, remaining: (await loadQueue()).items.length, error: null };
  } finally {
    publish({ flushing: false });
  }
}

// ───────────────────────── server status ─────────────────────────

/**
 * Apply a status object from the server. Returns true when tracking was stopped.
 * Only acts on the session this device is collecting for.
 */
export async function applyServerStatus(status: SessionStatus): Promise<boolean> {
  if (status.tracking.shouldTrack) queryClient.setQueryData(qk.status, status);
  const meta = await loadMeta();
  if (!meta.sessionId || meta.sessionId !== status.session.id) return false;
  if (!status.tracking.shouldTrack) {
    queryClient.setQueryData(qk.status, status);
    await stopTracking({ reason: humanStopReason(status.tracking.stopReason), notify: true, byUser: false });
    return true;
  }
  const becameAvailable = status.attendanceAvailable && !meta.attendanceAvailable;
  await updateMeta((m) => ({
    ...m,
    windowClosesAt: status.tracking.windowClosesAt,
    offlineQueueMax: status.tracking.offlineQueueMax,
    evidenceMaxAgeSec: status.tracking.evidenceMaxAgeSec,
    attendanceAvailable: status.attendanceAvailable,
    lastServerState: status.session.state,
  }));
  if (becameAvailable && AppState.currentState !== 'active') {
    // Arrival notification. Tapping it opens the shift screen — never the camera.
    await notifyLocal('Attendance is ready', 'Attendance is ready — open GeoAttend to capture your photo', { sessionId: status.session.id });
  }
  await warnBeforeAbsenceAlert(status, meta.lastServerState);
  await remindBreakEnd(status);
  return false;
}

const BREAK_REMINDER_ID = 'geoattend-break-end';

/** Scheduled with the OS, so it fires at the break's limit even when the app is suspended. */
async function remindBreakEnd(status: SessionStatus) {
  const b = status.break;
  const at = b ? Date.parse(b.endsAt) : 0;
  if (!b || b.overdueAt || status.session.isSimulated || at <= Date.now() + 5_000) {
    await cancelLocal(BREAK_REMINDER_ID);
    return;
  }
  await scheduleLocalAt(BREAK_REMINDER_ID, new Date(at), 'Break time is over', `Your ${b.label.toLowerCase()} break was ${b.maxMinutes} min. Head back and tap “End break”.`, { sessionId: status.session.id });
}

const ABSENCE_WARNING_ID = 'geoattend-absence-warning';

/**
 * Warn the employee before their manager is alerted, instead of only after:
 * right away when they leave the area (if the app is not on screen), and again a few
 * minutes before the absence threshold. The reminder is scheduled with the OS, so it
 * fires even when the app is suspended; returning cancels it.
 */
async function warnBeforeAbsenceAlert(status: SessionStatus, previousState: string | null) {
  const a = status.absence;
  if (!a || a.prolongedAt || status.session.state !== 'TEMPORARILY_AWAY' || status.session.isSimulated) {
    await cancelLocal(ABSENCE_WARNING_ID);
    return;
  }
  const alertAt = Date.parse(a.startedAt) + a.thresholdMinutes * 60_000;
  if (previousState !== 'TEMPORARILY_AWAY' && AppState.currentState !== 'active') {
    const left = Math.max(1, Math.round((alertAt - Date.now()) / 60_000));
    await notifyLocal('You have left the workplace area', `Come back within ${left} min, or your manager is alerted.`, { sessionId: status.session.id });
  }
  const warnBefore = Math.min(5, Math.max(1, Math.floor(a.thresholdMinutes / 3)));
  const warnAt = alertAt - warnBefore * 60_000;
  if (warnAt > Date.now() + 5_000) {
    await scheduleLocalAt(ABSENCE_WARNING_ID, new Date(warnAt), `${warnBefore} min left`, `You are still away from ${status.workplace.name}. Your manager is alerted in ${warnBefore} min unless you return.`, { sessionId: status.session.id });
  }
}

export function humanStopReason(r: string | null | undefined): string {
  if (!r) return 'Your shift session is closed.';
  if (r === 'shift ended by employee') return 'You ended your shift.';
  if (r.startsWith('terminated by administrator')) return `An administrator ended tracking (${r.replace(/^terminated by administrator:\s*/, '')}).`;
  return r.charAt(0).toUpperCase() + r.slice(1) + (r.endsWith('.') ? '' : '.');
}

/**
 * A fresh fix good enough for evidence. Phones (iPhones especially) report a coarse first fix
 * (30–100 m) and sharpen it over a few seconds; a single getCurrentPosition call often returns that
 * first fix, which the server then refuses as too inaccurate. Instead, watch at the best accuracy
 * and return the first fix within `targetAccuracyM`, or the best one seen after `settleMs`.
 * Fails only when no fix at all arrives within `timeoutMs`.
 */
export function bestFix(targetAccuracyM: number, opts: { settleMs?: number; timeoutMs?: number; onProgress?: (accuracyM: number) => void } = {}): Promise<Location.LocationObject> {
  const settleMs = opts.settleMs ?? 20_000;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  return new Promise((resolve, reject) => {
    let best: Location.LocationObject | null = null;
    let sub: Location.LocationSubscription | null = null;
    let done = false;
    const started = Date.now();
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      sub?.remove();
      if (best) resolve(best);
      else reject(err ?? new Error('Could not get a GPS fix. Move to an open area and retry.'));
    };
    // After the settle time, take the best so far; before the hard timeout, keep waiting for a first fix.
    const timer = setInterval(() => {
      const t = Date.now() - started;
      if ((best && t >= settleMs) || t >= timeoutMs) finish();
    }, 500);
    Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 }, (loc) => {
      const acc = loc.coords.accuracy;
      if (typeof acc !== 'number' || !(acc > 0)) return;
      if (!best || acc < (best.coords.accuracy ?? Infinity)) best = loc;
      opts.onProgress?.(Math.round(best.coords.accuracy ?? acc));
      if (acc <= targetAccuracyM) finish();
    })
      .then((s) => {
        sub = s;
        if (done) s.remove();
      })
      .catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
  });
}

/**
 * User-initiated "Retry fresh fix": one high-accuracy reading sent right away.
 * Only for an open session (the caller passes the server status).
 */
export async function sendFreshFix(status: SessionStatus): Promise<{ accuracyM: number; status: SessionStatus | null }> {
  const loc = await bestFix(status.tracking.maxAccuracyM);
  const reading = toReading(loc, 'FOREGROUND');
  if (!reading) throw new Error('The phone returned a location without accuracy information. Retry.');
  const meta = await loadMeta();
  if (meta.sessionId === status.session.id) {
    await withLock(async () => saveQueue(enqueue(await loadQueue(), status.session.id, [reading], meta.offlineQueueMax)));
    const out = await flush();
    if (out.error) throw new Error(`Saved on the phone; not sent yet (${out.error}).`);
    return { accuracyM: reading.accuracyM, status: queryClient.getQueryData<SessionStatus | null>(qk.status) ?? null };
  }
  const res = await api<LocationsResponse>('/tracking/locations', { method: 'POST', body: { sessionId: status.session.id, source: 'FOREGROUND', readings: [toWire(reading)], device: await deviceStatus() } });
  queryClient.setQueryData(qk.status, res.status.tracking.shouldTrack ? res.status : null);
  return { accuracyM: reading.accuracyM, status: res.status };
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ───────────────────────── start / stop ─────────────────────────

export async function isUpdatesRunning(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    return false;
  }
}

async function stopLocationUpdatesSafe() {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    // Task not registered — nothing to stop.
  }
}

let watcher: Location.LocationSubscription | null = null;
export const isForegroundWatcherActive = () => watcher !== null;

async function startForegroundWatcher(status: SessionStatus) {
  stopForegroundWatcher();
  watcher = await Location.watchPositionAsync(
    // Highest: on iOS "High" means ~10 m class (often reported as 30–60 m indoors); attendance needs the best the phone can do.
    { accuracy: Location.Accuracy.Highest, timeInterval: status.tracking.updateIntervalSec * 1000, distanceInterval: status.tracking.distanceFilterM },
    (loc) => {
      void recordLocations([loc], 'FOREGROUND');
    },
  );
}

function stopForegroundWatcher() {
  watcher?.remove();
  watcher = null;
}

export interface StartResult {
  mode: 'background' | 'foreground';
  backgroundGranted: boolean;
}

/**
 * Begin collecting for an open session. Must be called from a user action
 * while the app is in the foreground (Android forbids starting the location
 * foreground service from the background).
 */
export async function startTracking(status: SessionStatus): Promise<StartResult> {
  const sessionId = status.session.id;
  const bg = await Location.getBackgroundPermissionsAsync();
  const backgroundGranted = bg.status === 'granted';
  await updateMeta((m) => {
    const same = m.sessionId === sessionId;
    return {
      ...defaultMeta(),
      sessionId,
      windowClosesAt: status.tracking.windowClosesAt,
      offlineQueueMax: status.tracking.offlineQueueMax,
      evidenceMaxAgeSec: status.tracking.evidenceMaxAgeSec,
      attendanceAvailable: status.attendanceAvailable,
      lastServerState: status.session.state,
      lastSentAt: same ? m.lastSentAt : null,
      lastPermissionReport: same ? m.lastPermissionReport : null,
      backgroundGranted,
    };
  });
  await withLock(async () => {
    const q = await loadQueue();
    if (q.sessionId !== sessionId) await saveQueue(emptyQueue(sessionId));
  });

  let mode: StartResult['mode'] = 'background';
  try {
    await stopLocationUpdatesSafe();
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.Highest,
      timeInterval: status.tracking.updateIntervalSec * 1000,
      distanceInterval: status.tracking.distanceFilterM,
      deferredUpdatesInterval: status.tracking.updateIntervalSec * 1000,
      foregroundService: {
        notificationTitle: 'GeoAttend is tracking your shift',
        notificationBody: 'Location is shared with your employer until you end the shift.',
        notificationColor: '#1E2952',
        killServiceOnDestroy: false,
      },
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      activityType: Location.ActivityType.Other,
    });
    stopForegroundWatcher();
  } catch {
    // The OS refused the location task (e.g. iOS without "Always"): fall back to updates while the app is open.
    mode = 'foreground';
    await startForegroundWatcher(status);
  }
  await updateMeta((m) => ({ ...m, mode }));
  publish({ updatesRunning: true });
  // Get a first reading in promptly rather than waiting for the first interval.
  void bestFix(status.tracking.maxAccuracyM, { settleMs: 15_000 })
    .then((loc) => recordLocations([loc], 'FOREGROUND'))
    .catch(() => undefined);
  return { mode, backgroundGranted };
}

/** Stop collecting, discard the queue and remember why. Safe to call repeatedly. */
export async function stopTracking(opts: { reason: string; notify: boolean; byUser: boolean }) {
  const meta = await loadMeta();
  await stopLocationUpdatesSafe();
  stopForegroundWatcher();
  await cancelLocal(ABSENCE_WARNING_ID);
  const wasTracking = meta.sessionId !== null;
  await clearQueueAndMeta({ sessionId: meta.sessionId, reason: opts.reason, at: new Date().toISOString(), byUser: opts.byUser });
  publish({ updatesRunning: false });
  if (opts.notify && wasTracking) await notifyLocal('Location tracking stopped', opts.reason);
}

// Signing out (or losing the session) always stops collection.
onAuthLost(() => {
  void stopTracking({ reason: 'You were signed out. Location tracking has stopped.', notify: true, byUser: false });
});

// ───────────────────────── permissions ─────────────────────────

export async function readPermissionSnapshot(): Promise<PermissionReport> {
  const [fg, bg, services] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    Location.hasServicesEnabledAsync().catch(() => false),
  ]);
  const precise = Platform.OS === 'android' ? (fg.android ? fg.android.accuracy === 'fine' : null) : fg.ios ? fg.ios.accuracy === 'full' : null;
  return {
    foreground: fg.status as PermissionReport['foreground'],
    background: bg ? (bg.status as PermissionReport['background']) : 'unavailable',
    locationServicesEnabled: services,
    precise,
  };
}

/** Whether tracking can run with this permission state. The company may also require "Allow all the time" and precise location. */
export function permissionUsable(p: PermissionReport, rules?: { requireBackground?: boolean; requirePrecise?: boolean }) {
  if (p.foreground !== 'granted' || !p.locationServicesEnabled) return false;
  if (rules?.requireBackground && p.background !== 'granted') return false;
  if (rules?.requirePrecise && p.precise === false) return false;
  return true;
}

/** Report the device's permission state to the server when it changed (or when forced). */
export async function reportPermissionsIfChanged(sessionId: string, force = false): Promise<{ report: PermissionReport; status: SessionStatus | null }> {
  const report = await readPermissionSnapshot();
  const key = JSON.stringify(report);
  const meta = await loadMeta();
  await updateMeta((m) => ({ ...m, lastPermissionCheckAt: new Date().toISOString() }));
  if (!force && meta.sessionId === sessionId && meta.lastPermissionReport === key) return { report, status: null };
  const status = await api<SessionStatus>(`/tracking/sessions/${sessionId}/permissions`, {
    method: 'POST',
    body: { ...report, clientTime: new Date().toISOString(), deviceId: await getDeviceId() },
  });
  await updateMeta((m) => (m.sessionId === sessionId ? { ...m, lastPermissionReport: key, backgroundGranted: report.background === 'granted' } : m));
  queryClient.setQueryData(qk.status, status.tracking.shouldTrack ? status : null);
  await applyServerStatus(status);
  return { report, status };
}

/** Remember a report already sent (used right after starting a session). */
export async function rememberPermissionReport(sessionId: string, report: PermissionReport) {
  await updateMeta((m) => (m.sessionId === sessionId ? { ...m, lastPermissionReport: JSON.stringify(report), lastPermissionCheckAt: new Date().toISOString() } : m));
}

const PERMISSION_CHECK_EVERY_MS = 5 * 60_000;
async function maybeCheckPermissions(sessionId: string, lastAt: string | null) {
  if (lastAt && Date.now() - Date.parse(lastAt) < PERMISSION_CHECK_EVERY_MS) return;
  try {
    await reportPermissionsIfChanged(sessionId);
  } catch {
    // Offline: retried on the next reading / app foreground.
  }
}

// ───────────────────────── reconcile ─────────────────────────

/**
 * Align the device with the server on app start / foreground:
 *  - updates running but no open session (or another session) → stop them;
 *  - open session but updates not running → leave stopped; the UI shows a
 *    "Tracking is not running — tap to resume" banner (never restart silently).
 */
export async function reconcile(): Promise<{ status: SessionStatus | null; running: boolean; offline: boolean }> {
  const running = (await isUpdatesRunning()) || isForegroundWatcherActive();
  const meta = await loadMeta();
  let status: SessionStatus | null;
  try {
    status = (await api<{ status: SessionStatus | null }>('/tracking/sessions/current')).status;
  } catch {
    if (!meta.sessionId && running) {
      await stopLocationUpdatesSafe();
      stopForegroundWatcher();
    }
    const nowRunning = meta.sessionId ? running : false;
    publish({ updatesRunning: nowRunning });
    return { status: null, running: nowRunning, offline: true };
  }
  queryClient.setQueryData(qk.status, status && status.tracking.shouldTrack ? status : null);
  if (!status || !status.tracking.shouldTrack) {
    if (running || meta.sessionId) {
      await stopTracking({ reason: humanStopReason(status?.tracking.stopReason ?? 'shift session is closed'), notify: false, byUser: false });
    }
    return { status, running: false, offline: false };
  }
  if (running && meta.sessionId !== status.session.id) {
    // Updates for a session this device no longer knows about: stop and let the employee resume explicitly.
    await stopLocationUpdatesSafe();
    stopForegroundWatcher();
    publish({ updatesRunning: false });
    return { status, running: false, offline: false };
  }
  if (meta.sessionId === status.session.id) {
    await applyServerStatus(status);
    if (running) void flush();
  }
  publish({ updatesRunning: running });
  return { status, running, offline: false };
}
