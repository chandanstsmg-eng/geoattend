/**
 * Pure offline-queue logic (no React Native imports, unit-tested with `node --test`).
 * Readings are kept oldest-first and each one remembers its session and employee, so a reading
 * outlives the session it belongs to: ending a shift, losing the sign-in or starting the next
 * shift never discards it. Only the server's answer removes one. The single exception is the size
 * limit, which drops the OLDEST readings and counts them.
 */
export interface QueuedReading {
  clientEventId: string;
  sessionId: string;
  /** Who it belongs to. Another person signing in on this phone must not send it. */
  userId: string | null;
  latitude: number;
  longitude: number;
  accuracyM: number;
  clientTime: string;
  altitudeM?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
  isMocked?: boolean;
  source: 'FOREGROUND' | 'BACKGROUND';
}

export interface QueueState {
  items: QueuedReading[];
  /** Readings discarded because the queue was full (never uploaded). */
  dropped: number;
  /** The server refused these for good (malformed, or the session is not this employee's). Kept, not sent again. */
  failed: QueuedReading[];
}

export const MAX_BATCH = 500;
export const DEFAULT_QUEUE_MAX = 2000;
const MAX_FAILED = 200;

export function emptyQueue(): QueueState {
  return { items: [], dropped: 0, failed: [] };
}

/** Brings a stored queue up to date. Version 1 held one session's readings without per-reading ids. */
export function migrateQueue(raw: unknown): QueueState {
  const q = (raw ?? {}) as Partial<QueueState> & { sessionId?: string | null };
  const items = Array.isArray(q.items) ? q.items : [];
  return {
    items: items.map((r) => ({ ...r, sessionId: r.sessionId ?? q.sessionId ?? '', userId: r.userId ?? null })).filter((r) => r.sessionId),
    dropped: typeof q.dropped === 'number' ? q.dropped : 0,
    failed: Array.isArray(q.failed) ? q.failed : [],
  };
}

/** Append readings. Keeps at most `max` overall (drops oldest). */
export function enqueue(state: QueueState, readings: QueuedReading[], max: number): QueueState {
  const seen = new Set(state.items.map((r) => r.clientEventId));
  const fresh = readings.filter((r) => !seen.has(r.clientEventId));
  const all = [...state.items, ...fresh].sort((a, b) => Date.parse(a.clientTime) - Date.parse(b.clientTime));
  const limit = Math.max(1, Math.floor(max) || DEFAULT_QUEUE_MAX);
  const overflow = Math.max(0, all.length - limit);
  return { ...state, items: overflow ? all.slice(overflow) : all, dropped: state.dropped + overflow };
}

export interface Batch {
  sessionId: string;
  source: QueuedReading['source'];
  readings: QueuedReading[];
}

/** The next batch this employee can send: oldest first, one session and source, at most `max` readings. */
export function nextBatch(state: QueueState, userId: string | null, max = MAX_BATCH): Batch | null {
  const mine = state.items.filter((r) => r.userId === userId || r.userId === null);
  const first = mine[0];
  if (!first) return null;
  const readings: QueuedReading[] = [];
  for (const r of mine) {
    if (r.sessionId !== first.sessionId || r.source !== first.source || readings.length >= Math.min(max, MAX_BATCH)) break;
    readings.push(r);
  }
  return { sessionId: first.sessionId, source: first.source, readings };
}

/** Remove readings the server answered (ACCEPTED, DUPLICATE and REJECTED all count as answered). */
export function removeAnswered(state: QueueState, answeredIds: Iterable<string>): QueueState {
  const ids = new Set(answeredIds);
  if (ids.size === 0) return state;
  return { ...state, items: state.items.filter((r) => !ids.has(r.clientEventId)) };
}

/** Move readings the server will never accept out of the way, keeping them visible. */
export function quarantine(state: QueueState, ids: Iterable<string>): QueueState {
  const set = new Set(ids);
  const moved = state.items.filter((r) => set.has(r.clientEventId));
  return { ...state, items: state.items.filter((r) => !set.has(r.clientEventId)), failed: [...state.failed, ...moved].slice(-MAX_FAILED) };
}

/** Strip the local-only fields before sending. */
export function toWire(r: QueuedReading | (Omit<QueuedReading, 'sessionId' | 'userId'> & { sessionId?: string; userId?: string | null })) {
  const { source: _source, sessionId: _sessionId, userId: _userId, ...wire } = r;
  return wire;
}
