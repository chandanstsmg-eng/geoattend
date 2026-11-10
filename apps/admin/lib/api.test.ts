import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureMessage } from './api.ts';

test('no connection and no answer in time get plain advice, not browser text', () => {
  assert.match(failureMessage({ network: true }), /Cannot reach GeoAttend/);
  assert.match(failureMessage({ timeout: true }), /taking too long/);
  assert.doesNotMatch(failureMessage({ network: true }), /fetch/i);
});

test('a proxy error without a message from the API says GeoAttend is not responding', () => {
  for (const status of [500, 502, 503, 504]) assert.match(failureMessage({ status }), /not responding/);
});

test("the API's own messages are kept, including sign-in's own rate-limit message", () => {
  assert.equal(failureMessage({ status: 409, apiMessage: 'Already decided.' }), 'Already decided.');
  assert.equal(failureMessage({ status: 500, apiMessage: 'Something specific' }), 'Something specific');
  assert.equal(failureMessage({ status: 429, apiMessage: 'Too many sign-in attempts. Try again in 15 minutes.' }), 'Too many sign-in attempts. Try again in 15 minutes.');
});

test('the general rate limit becomes advice', () => {
  assert.match(failureMessage({ status: 429, apiMessage: 'Too many requests' }), /Wait a minute/);
  assert.match(failureMessage({ status: 429 }), /Wait a minute/);
});
