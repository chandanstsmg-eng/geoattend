import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attendanceStatus, hoursMinutes, recordForToday } from './attendance-status.ts';

test('a pending record is never shown as counted', () => {
  assert.equal(attendanceStatus('PENDING_VERIFICATION').counted, false);
  assert.equal(attendanceStatus('VOIDED').counted, false);
});

test('a missing or unknown status does not pass as verified', () => {
  for (const s of [undefined, null, '', 'SOMETHING_NEW']) {
    const v = attendanceStatus(s);
    assert.equal(v.counted, false);
    assert.notEqual(v.label, 'Verified');
  }
});

test('confirmed records count', () => {
  for (const s of ['VERIFIED', 'MANUAL_APPROVED', 'CORRECTED']) assert.equal(attendanceStatus(s).counted, true);
});

test('hours read naturally', () => {
  assert.equal(hoursMinutes(40), '40 min');
  assert.equal(hoursMinutes(60), '1 h 0 min');
  assert.equal(hoursMinutes(465), '7 h 45 min');
});

test('Home shows the running shift first, even from yesterday', () => {
  const night = { shift_date: '2026-11-06', in_progress: true };
  const today = { shift_date: '2026-11-07', in_progress: false };
  assert.equal(recordForToday([today, night], '2026-11-07'), night);
  assert.equal(recordForToday([today], '2026-11-07'), today);
  assert.equal(recordForToday([{ shift_date: '2026-11-05', in_progress: false }], '2026-11-07'), null);
});
