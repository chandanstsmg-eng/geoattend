// Run with: npm test  (node --test with native TypeScript type stripping, Node >= 22.18)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyQueue, enqueue, nextBatch, removeAnswered, toWire, type QueuedReading } from './queue-core.ts';

const t0 = Date.parse('2026-10-27T08:00:00.000Z');
function r(i: number, source: QueuedReading['source'] = 'BACKGROUND'): QueuedReading {
  return { clientEventId: `id-${i}`, latitude: 12.9, longitude: 77.6, accuracyM: 10, clientTime: new Date(t0 + i * 1000).toISOString(), source };
}

test('bounded size drops the oldest readings and counts them', () => {
  let q = emptyQueue('s1');
  q = enqueue(q, 's1', [r(1), r(2), r(3)], 5);
  q = enqueue(q, 's1', [r(4), r(5), r(6), r(7)], 5);
  assert.equal(q.items.length, 5);
  assert.deepEqual(q.items.map((x) => x.clientEventId), ['id-3', 'id-4', 'id-5', 'id-6', 'id-7']);
  assert.equal(q.dropped, 2);
});

test('keeps readings oldest-first even when appended out of order, ignores duplicates', () => {
  let q = enqueue(emptyQueue(), 's1', [r(5), r(2)], 10);
  q = enqueue(q, 's1', [r(2), r(3)], 10);
  assert.deepEqual(q.items.map((x) => x.clientEventId), ['id-2', 'id-3', 'id-5']);
});

test('a new session resets the queue', () => {
  let q = enqueue(emptyQueue(), 's1', [r(1), r(2)], 1);
  assert.equal(q.dropped, 1);
  q = enqueue(q, 's2', [r(3)], 10);
  assert.equal(q.sessionId, 's2');
  assert.deepEqual(q.items.map((x) => x.clientEventId), ['id-3']);
  assert.equal(q.dropped, 0);
});

test('removes only answered ids', () => {
  let q = enqueue(emptyQueue(), 's1', [r(1), r(2), r(3), r(4)], 10);
  q = removeAnswered(q, ['id-1', 'id-3', 'unknown']);
  assert.deepEqual(q.items.map((x) => x.clientEventId), ['id-2', 'id-4']);
});

test('next batch is oldest first, same source, capped at 500', () => {
  const many = Array.from({ length: 700 }, (_, i) => r(i));
  let q = enqueue(emptyQueue(), 's1', many, 1000);
  let b = nextBatch(q)!;
  assert.equal(b.readings.length, 500);
  assert.equal(b.readings[0]!.clientEventId, 'id-0');
  q = enqueue(emptyQueue(), 's1', [r(1, 'FOREGROUND'), r(2, 'FOREGROUND'), r(3, 'BACKGROUND')], 10);
  b = nextBatch(q)!;
  assert.equal(b.source, 'FOREGROUND');
  assert.equal(b.readings.length, 2);
  assert.equal(nextBatch(emptyQueue()), null);
  assert.equal('source' in toWire(r(1)), false);
});
