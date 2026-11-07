import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attendanceStatus, hoursMinutes, recordForToday, shownGuidance } from './attendance-status.ts';

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

const present = { tone: 'success' as const, title: 'Present', message: 'Attendance recorded.' };
const session = { stateLabel: 'Present' };

test('a pending record does not borrow the wording of a recorded one', () => {
  const g = shownGuidance({ guidance: present, session, attendance: { verificationStatus: 'PENDING_VERIFICATION' } });
  assert.equal(g.tone, 'warning');
  assert.equal(g.title, 'Waiting for manager check');
  assert.equal(g.badge, 'Checked in');
  assert.doesNotMatch(`${g.title} ${g.message}`, /recorded|Present/);
});

test('a pending record with a stale location keeps the location warning', () => {
  const g = shownGuidance({ guidance: { tone: 'warning', title: 'Present — location not updating', message: 'Recent location updates are missing.' }, session, attendance: { verificationStatus: 'PENDING_VERIFICATION' } });
  assert.doesNotMatch(g.title, /Present/);
  assert.match(g.message, /location updates are missing/);
});

test('a voided or unknown record does not read as present either', () => {
  assert.equal(shownGuidance({ guidance: present, session, attendance: { verificationStatus: 'VOIDED' } }).title, 'Not counted');
  assert.equal(shownGuidance({ guidance: present, session, attendance: { verificationStatus: 'SOMETHING_NEW' } }).title, 'Being checked');
});

test('confirmed records and other situations keep the server wording', () => {
  assert.equal(shownGuidance({ guidance: present, session, attendance: { verificationStatus: 'VERIFIED' } }).title, 'Present');
  assert.equal(shownGuidance({ guidance: present, session, attendance: null }).title, 'Present');
  const away = { tone: 'warning' as const, title: 'Away from workplace', message: '40 m outside.' };
  assert.equal(shownGuidance({ guidance: away, session, attendance: { verificationStatus: 'PENDING_VERIFICATION' } }).title, 'Away from workplace');
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
