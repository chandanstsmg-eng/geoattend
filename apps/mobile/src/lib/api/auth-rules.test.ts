import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionIsGone, singleFlight } from './auth-rules.ts';

test('only a real refusal ends the sign-in', () => {
  for (const s of [400, 401, 403]) assert.equal(sessionIsGone(s), true, String(s));
  for (const s of [0, 404, 408, 409, 429, 500, 502, 503]) assert.equal(sessionIsGone(s), false, String(s));
});

test('concurrent refreshes share one call, so a rotated token is never reused', async () => {
  let calls = 0;
  let release: (v: string) => void = () => undefined;
  const refresh = singleFlight(() => {
    calls++;
    return new Promise<string>((r) => { release = r; });
  });
  const all = [refresh(), refresh(), refresh()];
  release('token');
  assert.deepEqual(await Promise.all(all), ['token', 'token', 'token']);
  assert.equal(calls, 1);
});

test('a failed refresh can be tried again', async () => {
  let calls = 0;
  const refresh = singleFlight(async () => {
    if (++calls === 1) throw new Error('offline');
    return 'token';
  });
  await assert.rejects(refresh());
  assert.equal(await refresh(), 'token');
});
