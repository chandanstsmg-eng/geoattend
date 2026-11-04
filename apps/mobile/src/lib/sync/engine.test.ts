// The offline rules, with storage that survives a "restart" and a network that can be switched off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEvent, backoff, classify, dismissEvent, dueEvents, emptyOutbox, flushReadings, pendingFor, retryEvent, runOutbox, trimSynced, type OutboxDeps, type OutboxEvent, type OutboxState } from './engine.ts';
import { emptyQueue, enqueue, type QueuedReading, type QueueState } from '../tracking/queue-core.ts';

const NET = { status: 0, code: 'NETWORK_ERROR', message: 'offline' };

/** Stored as JSON text, as on the phone: every step really goes through serialisation. */
function disk(initial: OutboxState = emptyOutbox()) {
  let text = JSON.stringify(initial);
  return {
    read: () => JSON.parse(text) as OutboxState,
    update: async (fn: (s: OutboxState) => OutboxState) => {
      const next = fn(JSON.parse(text));
      text = JSON.stringify(next);
      return next;
    },
  };
}
const checkIn = (id = 'e1', sessionId = 's1', userId = 'u1', at = '2026-11-05T09:00:00.000Z') => ({
  id, kind: 'CHECK_IN' as const, userId, sessionId, shiftName: 'Day', capturedAt: at,
  checkIn: { photoUri: `file:///outbox/${id}.jpg`, sizeBytes: 100, evidence: { clientEventId: `ev-${id}`, latitude: 1, longitude: 1, accuracyM: 5, clientTime: at }, device: {} },
});
const checkOut = (id = 'e2', sessionId = 's1', at = '2026-11-05T17:00:00.000Z') => ({ id, kind: 'CHECK_OUT' as const, userId: 'u1', sessionId, shiftName: 'Day', capturedAt: at, checkOut: { endedAt: at } });

function deps(d: ReturnType<typeof disk>, send: OutboxDeps['send'], over: Partial<OutboxDeps> = {}): OutboxDeps {
  return { update: d.update, send, userId: async () => 'u1', now: () => Date.parse('2026-11-05T18:00:00.000Z'), ...over };
}

test('an event stays pending through a lost connection and is sent once it returns', async () => {
  const d = disk(addEvent(emptyOutbox(), checkIn()));
  let online = false;
  const ids: string[] = [];
  const send: OutboxDeps['send'] = async (e) => {
    ids.push(e.id);
    if (!online) throw NET;
  };
  const r1 = await runOutbox(deps(d, send));
  assert.equal(r1.stopped, 'offline');
  assert.equal(d.read().events[0]!.status, 'PENDING');
  assert.equal(d.read().events[0]!.attempts, 1);
  online = true;
  const later = Date.parse('2026-11-05T19:00:00.000Z');
  const r2 = await runOutbox(deps(d, send, { now: () => later }));
  assert.equal(r2.sent, 1);
  assert.equal(d.read().events[0]!.status, 'SYNCED');
  assert.deepEqual(ids, ['e1', 'e1']); // same id on every attempt: the server cannot count it twice
});

test('waits before retrying, longer each time, up to a limit', async () => {
  const d = disk(addEvent(emptyOutbox(), checkIn()));
  const now = Date.parse('2026-11-05T18:00:00.000Z');
  await runOutbox(deps(d, async () => { throw NET; }));
  assert.equal(d.read().events[0]!.nextAttemptAt, now + 15_000);
  let calls = 0;
  await runOutbox(deps(d, async () => { calls++; }));
  assert.equal(calls, 0); // not due yet
  assert.ok(backoff(2) > backoff(1));
  assert.equal(backoff(99), backoff(7));
});

test('survives a restart in the middle of a send: the photo is not uploaded twice', async () => {
  const d = disk(addEvent(emptyOutbox(), checkIn()));
  // First run: the photo goes up, then the phone dies before the submit.
  await runOutbox(deps(d, async (_e, progress) => {
    await progress({ photoId: 'p1', uploaded: true });
    throw NET;
  }));
  // "Restart": a new engine reads only what is on disk.
  const e = d.read().events[0]!;
  assert.equal(e.status, 'PENDING');
  assert.equal(e.photoId, 'p1');
  assert.equal(e.uploaded, true);
  let saw: OutboxEvent | null = null;
  await runOutbox(deps(d, async (ev) => { saw = ev; }, { now: () => e.nextAttemptAt + 1 }));
  assert.equal(saw!.uploaded, true);
  assert.equal(d.read().events[0]!.status, 'SYNCED');
});

test('an expired sign-in keeps everything and stops', async () => {
  const d = disk(addEvent(addEvent(emptyOutbox(), checkIn()), checkOut()));
  let calls = 0;
  const r = await runOutbox(deps(d, async () => {
    calls++;
    throw { status: 401, code: 'UNAUTHENTICATED', message: 'Please sign in again.' };
  }));
  assert.equal(r.stopped, 'signed-out');
  assert.equal(calls, 1);
  assert.deepEqual(d.read().events.map((e) => e.status), ['PENDING', 'PENDING']);
  assert.equal(d.read().events[0]!.nextAttemptAt, 0); // goes straight away after signing in
});

test('nothing is sent while signed out, or by someone else on this phone', async () => {
  const d = disk(addEvent(emptyOutbox(), checkIn()));
  let calls = 0;
  await runOutbox(deps(d, async () => { calls++; }, { userId: async () => null }));
  await runOutbox(deps(d, async () => { calls++; }, { userId: async () => 'someone-else' }));
  assert.equal(calls, 0);
  assert.equal(d.read().events[0]!.status, 'PENDING');
});

for (const code of ['PASSWORD_CHANGE_REQUIRED', 'DEVICE_NOT_APPROVED', 'DEVICE_PENDING']) {
  test(`${code} waits for the employee or administrator and loses nothing`, async () => {
    const d = disk(addEvent(emptyOutbox(), checkIn()));
    const r = await runOutbox(deps(d, async () => { throw { status: 403, code, message: 'blocked' }; }));
    assert.equal(r.stopped, 'blocked');
    assert.equal(d.read().events[0]!.status, 'PENDING');
  });
}

test('already recorded on the server counts as sent', async () => {
  const d = disk(addEvent(emptyOutbox(), checkIn()));
  const r = await runOutbox(deps(d, async () => { throw { status: 409, code: 'DUPLICATE_SUBMISSION', message: 'dup' }; }));
  assert.equal(r.sent, 1);
  assert.equal(d.read().events[0]!.status, 'SYNCED');
});

test('a refusal is kept and shown, not retried, and does not block the next event', async () => {
  const d = disk(addEvent(addEvent(emptyOutbox(), checkIn('e1', 's1')), checkOut('e2', 's2')));
  const sent: string[] = [];
  await runOutbox(deps(d, async (e) => {
    if (e.id === 'e1') throw { status: 422, code: 'EVIDENCE_NOT_INSIDE', message: 'Not inside.' };
    sent.push(e.id);
  }));
  const [a, b] = d.read().events;
  assert.equal(a!.status, 'FAILED');
  assert.equal(a!.failureCode, 'EVIDENCE_NOT_INSIDE');
  assert.equal(a!.lastError, 'Not inside.');
  assert.ok(a!.checkIn); // photo and evidence still there
  assert.equal(b!.status, 'SYNCED');
  assert.deepEqual(sent, ['e2']);
  let again = 0;
  await runOutbox(deps(d, async () => { again++; }));
  assert.equal(again, 0);
  await d.update((s) => retryEvent(s, 'e1'));
  await runOutbox(deps(d, async () => { again++; }));
  assert.equal(again, 1);
});

test('an expired photo slot goes up again, keeping the event', async () => {
  const d = disk(addEvent(emptyOutbox(), checkIn()));
  await runOutbox(deps(d, async (_e, progress) => {
    await progress({ photoId: 'p1', uploaded: true });
    throw { status: 422, code: 'PHOTO_EXPIRED', message: 'expired' };
  }));
  const e = d.read().events[0]!;
  assert.equal(e.status, 'PENDING');
  assert.equal(e.photoId, null);
  assert.equal(e.uploaded, false);
});

test('a check-out waits for its check-in, and goes when the check-in is refused', () => {
  const s = addEvent(addEvent(emptyOutbox(), checkIn()), checkOut());
  const now = Date.parse('2026-11-05T18:00:00.000Z');
  assert.deepEqual(dueEvents(s, 'u1', now).map((e) => e.id), ['e1']);
  const failed = { events: s.events.map((e) => (e.id === 'e1' ? { ...e, status: 'FAILED' as const } : e)) };
  assert.deepEqual(dueEvents(failed, 'u1', now).map((e) => e.id), ['e2']);
});

test('pressing again does not add a second check-in; after a refusal a new one can be saved', () => {
  let s = addEvent(emptyOutbox(), checkIn('e1'));
  s = addEvent(s, checkIn('e2'));
  assert.equal(s.events.length, 1);
  assert.equal(pendingFor(s, 's1', 'CHECK_IN')!.id, 'e1');
  s = { events: s.events.map((e) => ({ ...e, status: 'FAILED' as const })) };
  assert.equal(addEvent(s, checkIn('e2')).events.length, 2);
});

test('a pending event cannot be dismissed; a refused one can', () => {
  let s = addEvent(emptyOutbox(), checkIn());
  s = dismissEvent(s, 'e1');
  assert.equal(s.events.length, 1);
  s = { events: s.events.map((e) => ({ ...e, status: 'FAILED' as const })) };
  assert.equal(dismissEvent(s, 'e1').events.length, 0);
});

test('only old sent events are trimmed', () => {
  const synced = Array.from({ length: 12 }, (_, i) => ({ ...addEvent(emptyOutbox(), checkIn(`e${i}`, `s${i}`)).events[0]!, status: 'SYNCED' as const, syncedAt: new Date(1000 + i).toISOString() }));
  const pending = addEvent(emptyOutbox(), checkIn('p', 'sp')).events[0]!;
  const { state, removed } = trimSynced({ events: [...synced, pending] });
  assert.equal(removed.length, 2);
  assert.deepEqual(removed.map((e) => e.id).sort(), ['e0', 'e1']);
  assert.ok(state.events.some((e) => e.id === 'p'));
});

test('classifies what the server can say', () => {
  assert.equal(classify({ status: 503, code: 'STORAGE_UNAVAILABLE', message: '' }), 'retry');
  assert.equal(classify({ status: 429, code: 'RATE_LIMITED', message: '' }), 'retry');
  assert.equal(classify({ status: 408, code: 'TIMEOUT', message: '' }), 'retry');
  assert.equal(classify({ status: 0, code: 'TIMEOUT', message: '' }), 'retry');
  assert.equal(classify({ status: 409, code: 'MONTH_LOCKED', message: '' }), 'refused');
  assert.equal(classify({ status: 422, code: 'OFFLINE_TOO_OLD', message: '' }), 'refused');
});

// ── location readings ──

const reading = (i: number, sessionId = 's1', userId: string | null = 'u1'): QueuedReading => ({ clientEventId: `r${i}`, sessionId, userId, latitude: 1, longitude: 1, accuracyM: 5, clientTime: new Date(1_000_000 + i * 1000).toISOString(), source: 'BACKGROUND' });
function qdisk(q: QueueState) {
  let text = JSON.stringify(q);
  return { read: () => JSON.parse(text) as QueueState, update: async (fn: (s: QueueState) => QueueState) => { const n = fn(JSON.parse(text)); text = JSON.stringify(n); return n; } };
}
const ok = (b: { readings: QueuedReading[] }) => ({ results: b.readings.map((r) => ({ clientEventId: r.clientEventId, status: 'ACCEPTED' })), status: null });
const user = async () => 'u1';

test('readings stay queued through a lost connection, a server error and an expired sign-in', async () => {
  for (const err of [NET, { status: 503, code: 'X', message: 'x' }, { status: 429, code: 'RATE_LIMITED', message: 'x' }, { status: 401, code: 'UNAUTHENTICATED', message: 'x' }]) {
    const d = qdisk(enqueue(emptyQueue(), [reading(1), reading(2)], 100));
    const r = await flushReadings({ update: d.update, userId: user, post: async () => { throw err; } });
    assert.equal(d.read().items.length, 2);
    assert.equal(r.remaining, 2);
    assert.ok(r.stopped);
  }
});

test('a phone not yet approved keeps its readings', async () => {
  const d = qdisk(enqueue(emptyQueue(), [reading(1)], 100));
  let gone = 0;
  const r = await flushReadings({ update: d.update, userId: user, post: async () => { throw { status: 403, code: 'DEVICE_NOT_APPROVED', message: 'x' }; }, onSessionGone: async () => { gone++; } });
  assert.equal(r.stopped, 'blocked');
  assert.equal(d.read().items.length, 1);
  assert.equal(gone, 0);
});

test('readings from a finished shift are still sent after the next one starts', async () => {
  const d = qdisk(enqueue(emptyQueue(), [reading(1, 's1'), reading(2, 's1'), reading(3, 's2')], 100));
  const sessions: string[] = [];
  await flushReadings({ update: d.update, userId: user, post: async (b) => { sessions.push(b.sessionId); return ok(b); } });
  assert.deepEqual(sessions, ['s1', 's2']);
  assert.equal(d.read().items.length, 0);
});

test('one malformed reading does not cost the rest of the batch', async () => {
  const d = qdisk(enqueue(emptyQueue(), Array.from({ length: 9 }, (_, i) => reading(i)), 100));
  const r = await flushReadings({
    update: d.update,
    userId: user,
    post: async (b) => {
      if (b.readings.some((x) => x.clientEventId === 'r4')) throw { status: 400, code: 'VALIDATION_FAILED', message: 'bad' };
      return ok(b);
    },
  });
  assert.equal(r.sent, 8);
  assert.equal(d.read().items.length, 0);
  assert.deepEqual(d.read().failed.map((x) => x.clientEventId), ['r4']);
});

test('a session the server no longer has is set aside, and the next one still goes', async () => {
  const d = qdisk(enqueue(emptyQueue(), [reading(1, 's1'), reading(2, 's1'), reading(3, 's2')], 100));
  const gone: string[] = [];
  const r = await flushReadings({
    update: d.update,
    userId: user,
    post: async (b) => {
      if (b.sessionId === 's1') throw { status: 404, code: 'NOT_FOUND', message: 'no' };
      return ok(b);
    },
    onSessionGone: async (id) => { gone.push(id); },
  });
  assert.deepEqual(gone, ['s1']);
  assert.equal(r.sent, 1);
  assert.equal(d.read().failed.length, 2);
});

test('nothing is sent while signed out', async () => {
  const d = qdisk(enqueue(emptyQueue(), [reading(1)], 100));
  let calls = 0;
  const r = await flushReadings({ update: d.update, userId: async () => null, post: async (b) => { calls++; return ok(b); } });
  assert.equal(calls, 0);
  assert.equal(r.stopped, 'signed-out');
  assert.equal(d.read().items.length, 1);
});

test('a batch retried after a timeout the server had in fact processed is harmless', async () => {
  const d = qdisk(enqueue(emptyQueue(), [reading(1), reading(2)], 100));
  const stored = new Set<string>();
  let first = true;
  const post = async (b: { readings: QueuedReading[] }) => {
    const results = b.readings.map((r) => { const dup = stored.has(r.clientEventId); stored.add(r.clientEventId); return { clientEventId: r.clientEventId, status: dup ? 'DUPLICATE' : 'ACCEPTED' }; });
    if (first) { first = false; throw { status: 0, code: 'TIMEOUT', message: 'timeout' }; }
    return { results, status: null };
  };
  await flushReadings({ update: d.update, userId: user, post });
  assert.equal(d.read().items.length, 2);
  await flushReadings({ update: d.update, userId: user, post });
  assert.equal(d.read().items.length, 0);
  assert.equal(stored.size, 2);
});
