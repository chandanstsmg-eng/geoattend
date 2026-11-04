// Run with: npm test  (node --test with native TypeScript type stripping, Node >= 22.18)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyQueue, enqueue, migrateQueue, nextBatch, quarantine, removeAnswered, toWire, type QueuedReading } from './queue-core.ts';

const t0 = Date.parse('2026-10-27T08:00:00.000Z');
function r(i: number, source: QueuedReading['source'] = 'BACKGROUND', sessionId = 's1', userId: string | null = 'u1'): QueuedReading {
  return { clientEventId: `id-${i}`, sessionId, userId, latitude: 12.9, longitude: 77.6, accuracyM: 10, clientTime: new Date(t0 + i * 1000).toISOString(), source };
}

test('bounded size drops the oldest readings and counts them', () => {
  let q = enqueue(emptyQueue(), [r(1), r(2), r(3)], 5);
  q = enqueue(q, [r(4), r(5), r(6), r(7)], 5);
  assert.deepEqual(q.items.map((x) => x.clientEventId), ['id-3', 'id-4', 'id-5', 'id-6', 'id-7']);
  assert.equal(q.dropped, 2);
});

test('keeps readings oldest-first even when appended out of order, ignores duplicates', () => {
  let q = enqueue(emptyQueue(), [r(5), r(2)], 10);
  q = enqueue(q, [r(2), r(3)], 10);
  assert.deepEqual(q.items.map((x) => x.clientEventId), ['id-2', 'id-3', 'id-5']);
});

test('a new session keeps the previous session\'s unsent readings', () => {
  let q = enqueue(emptyQueue(), [r(1), r(2)], 10);
  q = enqueue(q, [r(3, 'BACKGROUND', 's2')], 10);
  assert.equal(q.items.length, 3);
  assert.equal(q.dropped, 0);
  const b = nextBatch(q, 'u1')!;
  assert.equal(b.sessionId, 's1');
  assert.deepEqual(b.readings.map((x) => x.clientEventId), ['id-1', 'id-2']);
});

test('removes only answered ids', () => {
  let q = enqueue(emptyQueue(), [r(1), r(2), r(3), r(4)], 10);
  q = removeAnswered(q, ['id-1', 'id-3', 'unknown']);
  assert.deepEqual(q.items.map((x) => x.clientEventId), ['id-2', 'id-4']);
});

test('next batch is oldest first, one session and source, capped at 500', () => {
  const many = Array.from({ length: 700 }, (_, i) => r(i));
  let q = enqueue(emptyQueue(), many, 1000);
  let b = nextBatch(q, 'u1')!;
  assert.equal(b.readings.length, 500);
  assert.equal(b.readings[0]!.clientEventId, 'id-0');
  q = enqueue(emptyQueue(), [r(1, 'FOREGROUND'), r(2, 'FOREGROUND'), r(3, 'BACKGROUND')], 10);
  b = nextBatch(q, 'u1')!;
  assert.equal(b.source, 'FOREGROUND');
  assert.equal(b.readings.length, 2);
  assert.equal(nextBatch(emptyQueue(), 'u1'), null);
});

test('another employee on the same phone cannot send these readings', () => {
  const q = enqueue(emptyQueue(), [r(1), r(2, 'BACKGROUND', 's2', 'u2')], 10);
  assert.equal(nextBatch(q, 'u2')!.sessionId, 's2');
  assert.equal(nextBatch(q, 'u3'), null);
});

test('local fields never reach the server', () => {
  const w = toWire(r(1)) as Record<string, unknown>;
  for (const k of ['source', 'sessionId', 'userId']) assert.equal(k in w, false);
});

test('a refused reading is set aside, not lost', () => {
  const q = quarantine(enqueue(emptyQueue(), [r(1), r(2)], 10), ['id-1']);
  assert.deepEqual(q.items.map((x) => x.clientEventId), ['id-2']);
  assert.deepEqual(q.failed.map((x) => x.clientEventId), ['id-1']);
});

test('a queue saved by the previous app version keeps its readings', () => {
  const { sessionId: _s, userId: _u, ...old } = r(1);
  const q = migrateQueue({ sessionId: 's9', items: [old], dropped: 3 });
  assert.equal(q.items[0]!.sessionId, 's9');
  assert.equal(q.items[0]!.userId, null);
  assert.equal(q.dropped, 3);
  assert.deepEqual(q.failed, []);
  assert.deepEqual(migrateQueue(null), emptyQueue());
});
