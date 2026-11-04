/**
 * Pure offline-queue logic (no React Native imports, unit-tested with `node --test`).
 * Readings are kept oldest-first; the queue is bounded and drops the OLDEST
 * readings when full, remembering how many were dropped.
 */
export interface QueuedReading {
  clientEventId: string;
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
  sessionId: string | null;
  items: QueuedReading[];
  /** Readings discarded because the queue was full (never uploaded). */
  dropped: number;
}

export const MAX_BATCH = 500;
export const DEFAULT_QUEUE_MAX = 2000;

export function emptyQueue(sessionId: string | null = null): QueueState {
  return { sessionId, items: [], dropped: 0 };
}

/** Append readings for `sessionId`. A different session resets the queue. Keeps at most `max` (drops oldest). */
export function enqueue(state: QueueState, sessionId: string, readings: QueuedReading[], max: number): QueueState {
  const base = state.sessionId === sessionId ? state : emptyQueue(sessionId);
  const seen = new Set(base.items.map((r) => r.clientEventId));
  const fresh = readings.filter((r) => !seen.has(r.clientEventId));
  const all = [...base.items, ...fresh].sort((a, b) => Date.parse(a.clientTime) - Date.parse(b.clientTime));
  const limit = Math.max(1, Math.floor(max) || DEFAULT_QUEUE_MAX);
  const overflow = Math.max(0, all.length - limit);
  return { sessionId, items: overflow ? all.slice(overflow) : all, dropped: base.dropped + overflow };
}

/** The next batch to upload: oldest first, same `source`, at most `max` readings. */
export function nextBatch(state: QueueState, max = MAX_BATCH): { source: QueuedReading['source']; readings: QueuedReading[] } | null {
  const first = state.items[0];
  if (!first) return null;
  const readings: QueuedReading[] = [];
  for (const r of state.items) {
    if (r.source !== first.source || readings.length >= Math.min(max, MAX_BATCH)) break;
    readings.push(r);
  }
  return { source: first.source, readings };
}

/** Remove readings the server answered (ACCEPTED, DUPLICATE and REJECTED all count as answered). */
export function removeAnswered(state: QueueState, answeredIds: Iterable<string>): QueueState {
  const ids = new Set(answeredIds);
  if (ids.size === 0) return state;
  return { ...state, items: state.items.filter((r) => !ids.has(r.clientEventId)) };
}

/** Strip the local-only `source` field before sending. */
export function toWire(r: QueuedReading) {
  const { source: _source, ...wire } = r;
  return wire;
}
