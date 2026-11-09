import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamUpstreamHeaders } from './stream-headers.ts';

test('the live-updates proxy passes the client address on to the API', () => {
  const h = streamUpstreamHeaders(new Headers({ cookie: 'ga_access=x', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.example.in' }));
  assert.equal(h['x-forwarded-for'], '203.0.113.9');
  assert.equal(h['x-forwarded-proto'], 'https');
  assert.equal(h['x-forwarded-host'], 'app.example.in');
  assert.equal(h.cookie, 'ga_access=x');
  assert.equal(h.accept, 'text/event-stream');
});

test('without a front proxy nothing is invented', () => {
  const h = streamUpstreamHeaders(new Headers({ authorization: 'Bearer secret', host: 'localhost:3400' }));
  assert.deepEqual(h, { cookie: '', accept: 'text/event-stream' });
});
