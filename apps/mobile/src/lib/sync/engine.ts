/**
 * The offline sync rules, free of React Native so they run under `node --test` and against the real
 * API in apps/api/test/mobile-sync.test.ts. Storage and the network are passed in.
 *
 * The rules:
 *  - An event leaves the phone's list of pending work only on the server's answer.
 *  - Every event has one id, reused on every attempt, so a retry can never count twice.
 *  - A lost connection, a server error or an expired sign-in keeps everything.
 *  - A refusal is shown to the employee and kept, never retried in a loop or dropped silently.
 */
import { nextBatch, quarantine, removeAnswered, type Batch, type QueueState } from '../tracking/queue-core.ts';

export type EventKind = 'CHECK_IN' | 'CHECK_OUT';
export type EventStatus = 'PENDING' | 'SYNCED' | 'FAILED';

export interface CheckInPayload {
  photoUri: string;
  sizeBytes: number;
  evidence: { clientEventId: string; latitude: number; longitude: number; accuracyM: number; clientTime: string; altitudeM?: number | null; speedMps?: number | null; headingDeg?: number | null; isMocked?: boolean };
  device: Record<string, string | number | boolean | null>;
}
export interface CheckOutPayload {
  endedAt: string;
}

export interface OutboxEvent {
  /** Also the idempotency key on the server. */
  id: string;
  kind: EventKind;
  userId: string;
  sessionId: string;
  shiftName: string;
  capturedAt: string;
  status: EventStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  /** The server's refusal code, for FAILED events. */
  failureCode: string | null;
  syncedAt: string | null;
  /** Upload progress, kept so a restart does not send the photo again. */
  photoId: string | null;
  uploaded: boolean;
  checkIn?: CheckInPayload;
  checkOut?: CheckOutPayload;
}

export interface OutboxState {
  events: OutboxEvent[];
}

export const emptyOutbox = (): OutboxState => ({ events: [] });
/** Sent events stay listed for a while so the employee can see they went through. */
const KEEP_SYNCED = 10;
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];

export function backoff(attempts: number) {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]!;
}

export function addEvent(state: OutboxState, e: Omit<OutboxEvent, 'status' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'failureCode' | 'syncedAt' | 'photoId' | 'uploaded'>): OutboxState {
  // One check-in and one check-out per shift: pressing again changes nothing.
  if (state.events.some((x) => x.sessionId === e.sessionId && x.kind === e.kind && x.status !== 'FAILED')) return state;
  return { events: [...state.events, { ...e, status: 'PENDING', attempts: 0, nextAttemptAt: 0, lastError: null, failureCode: null, syncedAt: null, photoId: null, uploaded: false }] };
}

const patch = (s: OutboxState, id: string, p: Partial<OutboxEvent>): OutboxState => ({ events: s.events.map((e) => (e.id === id ? { ...e, ...p } : e)) });

/** Sent events beyond the display limit. Returned so their photos can be removed. */
export function trimSynced(s: OutboxState): { state: OutboxState; removed: OutboxEvent[] } {
  const synced = s.events.filter((e) => e.status === 'SYNCED').sort((a, b) => Date.parse(b.syncedAt ?? '') - Date.parse(a.syncedAt ?? ''));
  const removed = synced.slice(KEEP_SYNCED);
  const gone = new Set(removed.map((e) => e.id));
  return { state: { events: s.events.filter((e) => !gone.has(e.id)) }, removed };
}

export function retryEvent(s: OutboxState, id: string): OutboxState {
  return patch(s, id, { status: 'PENDING', nextAttemptAt: 0, lastError: null, failureCode: null });
}

/** A failed event the employee chose to dismiss. Only a refused or sent event can go. */
export function dismissEvent(s: OutboxState, id: string): OutboxState {
  return { events: s.events.filter((e) => e.id !== id || e.status === 'PENDING') };
}

export const pendingFor = (s: OutboxState, sessionId: string, kind: EventKind) => s.events.find((e) => e.sessionId === sessionId && e.kind === kind && e.status === 'PENDING') ?? null;

/** Events to try now: this employee's, due, oldest first; a check-out waits for its shift's check-in. */
export function dueEvents(s: OutboxState, userId: string | null, now: number): OutboxEvent[] {
  if (!userId) return [];
  const pending = s.events.filter((e) => e.status === 'PENDING' && e.userId === userId).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  return pending.filter((e) => e.nextAttemptAt <= now && !(e.kind === 'CHECK_OUT' && pending.some((x) => x.kind === 'CHECK_IN' && x.sessionId === e.sessionId)));
}

export interface SyncFailure {
  status: number;
  code: string;
  message: string;
}

export type Verdict = 'retry' | 'signed-out' | 'blocked' | 'already-done' | 'photo-again' | 'refused';

/** What a failed attempt means for the event. */
export function classify(e: SyncFailure): Verdict {
  if (e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500) return 'retry';
  if (e.status === 401) return 'signed-out';
  // A rooted phone or an emulator is refused by the server and no one can approve that away: the event is
  // refused (shown with the reason), not held forever, so it no longer blocks the shift's check-out or
  // makes the server alert the manager every few minutes (Phase I review).
  if (e.code === 'DEVICE_NOT_TRUSTED') return 'refused';
  // The employee or an administrator can clear these; nothing about the event itself is wrong.
  if (e.code === 'PASSWORD_CHANGE_REQUIRED' || e.code.startsWith('DEVICE_')) return 'blocked';
  if (e.code === 'DUPLICATE_SUBMISSION' || e.code === 'ALREADY_RECORDED') return 'already-done';
  if (e.code === 'PHOTO_EXPIRED' || e.code === 'PHOTO_MISSING') return 'photo-again';
  return 'refused';
}

export const asFailure = (err: unknown): SyncFailure => {
  const e = err as Partial<SyncFailure> | null;
  return { status: typeof e?.status === 'number' ? e.status : 0, code: e?.code ?? 'UNKNOWN', message: e?.message ?? String(err) };
};

export interface OutboxDeps {
  /** Runs a read-modify-write of the stored list as one step. */
  update: (fn: (s: OutboxState) => OutboxState) => Promise<OutboxState>;
  /** Does the work for one event. Calls `progress` so a restart can continue. Rejects with a SyncFailure. */
  send: (e: OutboxEvent, progress: (p: Pick<OutboxEvent, 'photoId' | 'uploaded'>) => Promise<void>) => Promise<void>;
  userId: () => Promise<string | null>;
  now: () => number;
  /** Removes a sent event's saved photo. */
  cleanup?: (e: OutboxEvent) => Promise<void>;
}

export interface OutboxResult {
  sent: number;
  /** Why it stopped early, if it did. */
  stopped: 'offline' | 'signed-out' | 'blocked' | null;
  message: string | null;
}

export async function runOutbox(d: OutboxDeps): Promise<OutboxResult> {
  const userId = await d.userId();
  let sent = 0;
  const seen = new Set<string>();
  for (;;) {
    const next = dueEvents(await d.update((s) => s), userId, d.now()).find((e) => !seen.has(e.id));
    if (!next) return { sent, stopped: null, message: null };
    seen.add(next.id);
    await d.update((s) => patch(s, next.id, { attempts: next.attempts + 1 }));
    try {
      await d.send({ ...next, attempts: next.attempts + 1 }, async (p) => {
        await d.update((s) => patch(s, next.id, p));
        Object.assign(next, p);
      });
      await d.update((s) => patch(s, next.id, { status: 'SYNCED', syncedAt: new Date(d.now()).toISOString(), lastError: null }));
      await d.cleanup?.(next).catch(() => undefined);
      sent++;
    } catch (err) {
      const f = asFailure(err);
      const v = classify(f);
      const attempts = next.attempts + 1;
      if (v === 'already-done') {
        await d.update((s) => patch(s, next.id, { status: 'SYNCED', syncedAt: new Date(d.now()).toISOString(), lastError: null }));
        await d.cleanup?.(next).catch(() => undefined);
        sent++;
      } else if (v === 'photo-again') {
        // The upload slot is gone: the same photo goes up again on the next try, waiting longer each time
        // (a fixed 15 s re-uploaded the photo four times a minute for as long as the server kept refusing).
        await d.update((s) => patch(s, next.id, { photoId: null, uploaded: false, nextAttemptAt: d.now() + backoff(attempts), lastError: f.message }));
      } else if (v === 'refused') {
        await d.update((s) => patch(s, next.id, { status: 'FAILED', lastError: f.message, failureCode: f.code }));
      } else {
        await d.update((s) => patch(s, next.id, { lastError: f.message, nextAttemptAt: v === 'retry' ? d.now() + backoff(attempts) : 0 }));
        return { sent, stopped: v === 'retry' ? 'offline' : v, message: f.message };
      }
    }
  }
}

// ───────────────────────── location readings ─────────────────────────

export interface ReadingsResponse<S = unknown> {
  results: { clientEventId: string; status: string }[];
  status: S;
}

export interface FlushDeps<S = unknown> {
  update: (fn: (q: QueueState) => QueueState) => Promise<QueueState>;
  post: (batch: Batch) => Promise<ReadingsResponse<S>>;
  userId: () => Promise<string | null>;
  /** The server's status for a session, after each accepted batch. Returns true to stop sending. */
  onStatus?: (status: S, sessionId: string) => Promise<boolean>;
  /** The server will never take this session's readings (not found, or not this employee's). */
  onSessionGone?: (sessionId: string) => Promise<void>;
}

export interface FlushResult {
  sent: number;
  remaining: number;
  error: string | null;
  stopped: 'offline' | 'signed-out' | 'blocked' | null;
}

export async function flushReadings<S>(d: FlushDeps<S>): Promise<FlushResult> {
  const userId = await d.userId();
  let sent = 0;
  let limit = 500;
  const remaining = async () => (await d.update((q) => q)).items.filter((r) => r.userId === userId || r.userId === null).length;
  if (!userId) return { sent, remaining: (await d.update((q) => q)).items.length, error: null, stopped: 'signed-out' };

  for (let round = 0; round < 40; round++) {
    const batch = nextBatch(await d.update((q) => q), userId, limit);
    if (!batch) return { sent, remaining: 0, error: null, stopped: null };
    const ids = batch.readings.map((r) => r.clientEventId);
    let res: ReadingsResponse<S>;
    try {
      res = await d.post(batch);
    } catch (err) {
      const f = asFailure(err);
      if (f.status === 400) {
        // One bad reading must not cost the good ones: halve until it is alone, then set it aside.
        if (ids.length > 1) {
          limit = Math.max(1, Math.floor(ids.length / 2));
          continue;
        }
        await d.update((q) => quarantine(q, ids));
        limit = 500;
        continue;
      }
      const v = classify(f);
      if (v === 'refused') {
        // 403 / 404 on the session itself: it is gone or not this employee's. Stop sending it, keep the readings.
        await d.update((q) => quarantine(q, q.items.filter((r) => r.sessionId === batch.sessionId).map((r) => r.clientEventId)));
        await d.onSessionGone?.(batch.sessionId);
        continue;
      }
      return { sent, remaining: await remaining(), error: f.message, stopped: v === 'signed-out' ? 'signed-out' : v === 'blocked' ? 'blocked' : 'offline' };
    }
    const answered = res.results.map((r) => r.clientEventId);
    await d.update((q) => removeAnswered(q, answered));
    sent += answered.length;
    if (await d.onStatus?.(res.status, batch.sessionId)) return { sent, remaining: await remaining(), error: null, stopped: null };
    if (answered.length === 0) break; // never spin on a batch the server did not answer
  }
  return { sent, remaining: await remaining(), error: null, stopped: null };
}
