/**
 * End-to-end tests of the HTTP API against a real (throw-away) PostgreSQL database.
 * Scenario numbers refer to the test plan in docs/TEST-PLAN.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { config } from '../src/config.js';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { sweepAbsences, sweepExpiredWindows, sweepStale } from '../src/modules/jobs/sweeper.js';
import { runRetention } from '../src/modules/jobs/retention.js';
import { sweepOverdueBreaks } from '../src/modules/tracking/breaks.service.js';
import { sweepOvertime } from '../src/modules/tracking/overtime.service.js';
import { getSettings, invalidateSettings, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { csvCell } from '../src/lib/csv.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { adminAgent, createEmployee, createTestDatabase, deviceClock, fakeJpeg, mobileLogin, reading, seedBase } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
});
afterAll(async () => {
  await db.drop();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Employee with an open session, permissions granted. */
async function onShift() {
  const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
  const token = await mobileLogin(app, emp.email);
  const start = await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: base.shiftId, deviceId: 'test-device-001' }).expect(201);
  const sessionId = start.body.session.id as string;
  expect(start.body.session.state).toBe('SHIFT_START_PENDING');
  const perm = await request(app)
    .post(`/api/v1/tracking/sessions/${sessionId}/permissions`)
    .set(bearer(token))
    .send({ foreground: 'granted', background: 'granted', locationServicesEnabled: true })
    .expect(200);
  expect(perm.body.session.state).toBe('TRACKING_ACTIVE');
  const clock = deviceClock();
  const send = async (...readings: any[]) =>
    (await request(app).post('/api/v1/tracking/locations').set(bearer(token)).send({ sessionId, source: 'BACKGROUND', readings }).expect(200)).body;
  return { emp, token, sessionId, clock, send };
}

async function makeReady() {
  const ctx = await onShift();
  await ctx.send(reading(5, 6, ctx.clock(0)));
  const res = await ctx.send(reading(4, 6, ctx.clock(11)));
  expect(res.status.session.state).toBe('ATTENDANCE_READY');
  return ctx;
}

async function capture(ctx: Awaited<ReturnType<typeof onShift>>, key = `idem-${crypto.randomUUID()}`) {
  const img = fakeJpeg();
  const intent = await request(app).post('/api/v1/attendance/intents').set(bearer(ctx.token)).send({ sessionId: ctx.sessionId, idempotencyKey: key, contentType: 'image/jpeg', sizeBytes: img.length }).expect(201);
  const u = new URL(intent.body.upload.url);
  await request(app).put(u.pathname + u.search).set('Content-Type', 'image/jpeg').send(img).expect(201);
  return { photoId: intent.body.photoId as string, key };
}

async function present() {
  const ctx = await makeReady();
  const { photoId, key } = await capture(ctx);
  const res = await request(app)
    .post('/api/v1/attendance')
    .set(bearer(ctx.token))
    .send({ sessionId: ctx.sessionId, photoId, idempotencyKey: key, evidence: reading(3, 5, ctx.clock(2)) })
    .expect(201);
  return { ...ctx, attendanceId: res.body.attendance.id as string, key, photoId };
}

describe('authentication & authorisation', () => {
  it('rejects unauthenticated requests', async () => {
    await request(app).get('/api/v1/employees').expect(401);
    await request(app).get('/api/v1/tracking/live').expect(401);
  });

  it('keeps employees and admins in their own apps', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const r = await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: 'Test-password-123', client: 'web' }).expect(403);
    expect(r.body.error.code).toBe('WRONG_APP');
  });

  it('requires a CSRF token for cookie-authenticated writes', async () => {
    const { agent, csrf } = await adminAgent(app);
    const bad = await agent.post('/api/v1/notifications/read-all').expect(403);
    expect(bad.body.error.code).toBe('CSRF_FAILED');
    await agent.post('/api/v1/notifications/read-all').set('X-CSRF-Token', csrf).expect(200);
  });

  it('rotates refresh tokens and revokes the family on re-use', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const login = await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: 'Test-password-123', client: 'mobile' }).expect(200);
    const r1 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    await q(`UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE user_id = $1 AND revoked_at IS NOT NULL`, [emp.id]); // past the retry grace
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401); // re-use
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401); // family revoked
  });

  it('(16) blocks cross-employee access to sessions, history and photos', async () => {
    const a = await present();
    const b = await onShift();
    await request(app).get(`/api/v1/tracking/sessions/${a.sessionId}`).set(bearer(b.token)).expect(403);
    await request(app).post('/api/v1/tracking/locations').set(bearer(b.token)).send({ sessionId: a.sessionId, readings: [reading(1, 5, new Date().toISOString())] }).expect(403);
    await request(app).get(`/api/v1/employees/${a.emp.id}/location-history?from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z`).set(bearer(b.token)).expect(403);
    await request(app).post(`/api/v1/attendance/${a.attendanceId}/photo-url`).set(bearer(b.token)).expect(403);
    await request(app).get('/api/v1/tracking/live').set(bearer(b.token)).expect(403);
    await request(app).post(`/api/v1/tracking/sessions/${a.sessionId}/end`).set(bearer(b.token)).expect(403);
  });
});

describe('arrival and attendance', () => {
  it('(1) keeps attendance locked outside the radius and explains the distance', async () => {
    const ctx = await onShift();
    const res = await ctx.send(reading(42, 5, ctx.clock(0)));
    expect(res.status.session.state).toBe('OUTSIDE_GEOFENCE');
    expect(res.status.attendanceAvailable).toBe(false);
    expect(res.status.guidance.message).toBe('42 m away. Unlocks within 30 m.');
    const intent = await request(app).post('/api/v1/attendance/intents').set(bearer(ctx.token)).send({ sessionId: ctx.sessionId, idempotencyKey: 'x'.repeat(20), contentType: 'image/jpeg', sizeBytes: 1000 }).expect(409);
    expect(intent.body.error.code).toBe('ATTENDANCE_LOCKED');
  });

  it('(2) unlocks after a stabilised entry with good accuracy and notifies', async () => {
    const ctx = await onShift();
    const first = await ctx.send(reading(5, 6, ctx.clock(0)));
    expect(first.status.session.state).toBe('ARRIVAL_CANDIDATE');
    expect(first.status.attendanceAvailable).toBe(false);
    const second = await ctx.send(reading(4, 6, ctx.clock(11)));
    expect(second.status.session.state).toBe('ATTENDANCE_READY');
    expect(second.status.guidance.title).toBe('Workplace location verified');
    const notes = await q(`SELECT type, audience FROM notifications WHERE session_id = $1`, [ctx.sessionId]);
    expect(notes).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'ARRIVED', audience: 'ADMIN' }), expect.objectContaining({ type: 'ATTENDANCE_READY', audience: 'EMPLOYEE' })]));
  });

  it('(3) does not unlock on insufficient GPS accuracy', async () => {
    const ctx = await onShift();
    await ctx.send(reading(5, 60, ctx.clock(0)));
    const res = await ctx.send(reading(5, 55, ctx.clock(15)));
    expect(res.status.session.state).toBe('TRACKING_ACTIVE');
    expect(res.status.guidance.title).toBe('GPS accuracy insufficient');
    const ev = await one(`SELECT count(*)::int AS n FROM geofence_events WHERE session_id = $1 AND event_type = 'ACCURACY_INSUFFICIENT'`, [ctx.sessionId]);
    expect(ev.n).toBe(1);
  });

  it('(4) rejects submission when the employee left before submitting', async () => {
    const ctx = await makeReady();
    const { photoId, key } = await capture(ctx);
    const away = await ctx.send(reading(90, 6, ctx.clock(3)));
    expect(away.status.session.state).toBe('OUTSIDE_GEOFENCE');
    const res = await request(app).post('/api/v1/attendance').set(bearer(ctx.token)).send({ sessionId: ctx.sessionId, photoId, idempotencyKey: key, evidence: reading(2, 5, ctx.clock(2)) }).expect(422);
    expect(['PHOTO_EXPIRED', 'NOT_ELIGIBLE']).toContain(res.body.error.code);
    expect((await one('SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1', [ctx.sessionId])).n).toBe(0);
  });

  it('(4b) re-validates the submitted evidence itself', async () => {
    const ctx = await makeReady();
    const { photoId, key } = await capture(ctx);
    const res = await request(app).post('/api/v1/attendance').set(bearer(ctx.token)).send({ sessionId: ctx.sessionId, photoId, idempotencyKey: key, evidence: reading(120, 5, ctx.clock(2)) }).expect(422);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    const st = await request(app).get(`/api/v1/tracking/sessions/${ctx.sessionId}`).set(bearer(ctx.token)).expect(200);
    expect(st.body.session.state).toBe('OUTSIDE_GEOFENCE');
    const fail = await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'ATTENDANCE_SUBMISSION_FAILED'`, [ctx.sessionId]);
    expect(fail).toBeTruthy();
  });

  it('rejects stale evidence and non-image uploads', async () => {
    const ctx = await makeReady();
    const intent = await request(app).post('/api/v1/attendance/intents').set(bearer(ctx.token)).send({ sessionId: ctx.sessionId, idempotencyKey: `k-${crypto.randomUUID()}`, contentType: 'image/jpeg', sizeBytes: 100 }).expect(201);
    const u = new URL(intent.body.upload.url);
    const bad = await request(app).put(u.pathname + u.search).set('Content-Type', 'image/jpeg').send(Buffer.from('<html>not an image</html>')).expect(415);
    expect(bad.body.error.code).toBe('NOT_AN_IMAGE');
    await request(app).put(u.pathname + 'x' + u.search).set('Content-Type', 'image/jpeg').send(fakeJpeg()).expect(404);
    const tampered = u.search.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    await request(app).put(u.pathname + tampered).set('Content-Type', 'image/jpeg').send(fakeJpeg()).expect(403);
    await request(app).put(u.pathname + u.search).set('Content-Type', 'image/jpeg').send(fakeJpeg()).expect(201);
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    const res = await request(app).post('/api/v1/attendance').set(bearer(ctx.token)).send({ sessionId: ctx.sessionId, photoId: intent.body.photoId, idempotencyKey: `k-${crypto.randomUUID()}`, evidence: reading(2, 5, old) }).expect(422);
    expect(res.body.error.code).toBe('EVIDENCE_STALE');
  });

  it('(5)(6) records attendance exactly once, with server time, and flags duplicates', async () => {
    const before = Date.now();
    const ctx = await present();
    const rec = await one('SELECT * FROM attendance_records WHERE id = $1', [ctx.attendanceId]);
    expect(rec.verification_status).toBe('VERIFIED');
    expect(new Date(rec.recorded_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    // Same idempotency key → same record, no side effects.
    const replay = await request(app).post('/api/v1/attendance').set(bearer(ctx.token)).send({ sessionId: ctx.sessionId, photoId: ctx.photoId, idempotencyKey: ctx.key, evidence: reading(3, 5, ctx.clock(1)) }).expect(200);
    expect(replay.body).toMatchObject({ replay: true, attendance: { id: ctx.attendanceId } });
    // Different key for the same shift → rejected and reported.
    const dup = await request(app).post('/api/v1/attendance').set(bearer(ctx.token)).send({ sessionId: ctx.sessionId, photoId: ctx.photoId, idempotencyKey: `other-${crypto.randomUUID()}`, evidence: reading(3, 5, ctx.clock(1)) }).expect(409);
    expect(dup.body.error.code).toBe('DUPLICATE_SUBMISSION');
    expect((await one('SELECT count(*)::int AS n FROM attendance_records WHERE employee_id = $1', [ctx.emp.id])).n).toBe(1);
    expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'DUPLICATE_SUBMISSION'`, [ctx.sessionId])).toBeTruthy();
    const st = await request(app).get(`/api/v1/tracking/sessions/${ctx.sessionId}`).set(bearer(ctx.token)).expect(200);
    expect(st.body.session.state).toBe('PRESENT');
    expect(st.body.attendance.id).toBe(ctx.attendanceId);
  });

  it('(7) refuses employees without the required assignment', async () => {
    const noWp = await createEmployee({});
    const t1 = await mobileLogin(app, noWp.email);
    await request(app).post('/api/v1/tracking/sessions').set(bearer(t1)).send({ shiftId: base.shiftId }).expect(403);
    const noShift = await createEmployee({ workplaceId: base.workplaceId });
    const t2 = await mobileLogin(app, noShift.email);
    await request(app).post('/api/v1/tracking/sessions').set(bearer(t2)).send({ shiftId: base.shiftId }).expect(403);
  });

  it('requires the privacy notice to be acknowledged before tracking', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId, ack: false });
    const t = await mobileLogin(app, emp.email);
    const r = await request(app).post('/api/v1/tracking/sessions').set(bearer(t)).send({ shiftId: base.shiftId }).expect(412);
    expect(r.body.error.code).toBe('NOTICE_ACK_REQUIRED');
    const notice = await request(app).get('/api/v1/me/privacy-notice').set(bearer(t)).expect(200);
    await request(app).post('/api/v1/me/privacy-notice/ack').set(bearer(t)).send({ version: notice.body.version }).expect(200);
    await request(app).post('/api/v1/tracking/sessions').set(bearer(t)).send({ shiftId: base.shiftId }).expect(201);
  });

  it('flags late arrivals', async () => {
    await q('UPDATE shifts SET arrival_grace_minutes = 0 WHERE id = $1', [base.shiftId]);
    try {
      const ctx = await present();
      const rec = await one('SELECT is_late, late_by_minutes FROM attendance_records WHERE id = $1', [ctx.attendanceId]);
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      expect(rec.is_late).toBe(Date.now() - startOfDay.getTime() > 60_000);
      if (rec.is_late) expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'LATE_ARRIVAL'`, [ctx.sessionId])).toBeTruthy();
    } finally {
      await q('UPDATE shifts SET arrival_grace_minutes = 240 WHERE id = $1', [base.shiftId]);
    }
  });
});

describe('presence monitoring', () => {
  it('(8)(9) opens an absence on a verified exit and closes it on return', async () => {
    const ctx = await present();
    let r = await ctx.send(reading(90, 6, ctx.clock(5)));
    expect(r.status.session.state).toBe('PRESENT'); // not yet stabilised
    r = await ctx.send(reading(95, 6, ctx.clock(21)));
    expect(r.status.session.state).toBe('TEMPORARILY_AWAY');
    const open = await one(`SELECT * FROM absence_intervals WHERE session_id = $1 AND status = 'OPEN'`, [ctx.sessionId]);
    expect(open).toBeTruthy();
    expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'GEOFENCE_EXIT'`, [ctx.sessionId])).toBeTruthy();
    await ctx.send(reading(3, 6, ctx.clock(5)));
    r = await ctx.send(reading(2, 6, ctx.clock(11)));
    expect(r.status.session.state).toBe('PRESENT');
    const closed = await one(`SELECT * FROM absence_intervals WHERE id = $1`, [open.id]);
    expect(closed.status).toBe('RETURNED');
    expect(closed.prolonged_at).toBeNull();
  });

  it('(10) raises one prolonged-absence alert after the threshold, with cooldown reminders', async () => {
    const ctx = await present();
    await ctx.send(reading(90, 6, ctx.clock(5)));
    await ctx.send(reading(95, 6, ctx.clock(21)));
    const later = new Date(Date.now() + 6 * 60_000); // workplace threshold is 5 min
    await sweepAbsences(later);
    await sweepAbsences(later);
    const st = await request(app).get(`/api/v1/tracking/sessions/${ctx.sessionId}`).set(bearer(ctx.token)).expect(200);
    expect(st.body.session.state).toBe('PROLONGED_ABSENCE');
    const alerts = await q(`SELECT * FROM notifications WHERE session_id = $1 AND type = 'PROLONGED_ABSENCE'`, [ctx.sessionId]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('CRITICAL');
    expect(alerts[0].data).toMatchObject({ thresholdMinutes: 5 });
    expect(alerts[0].data.lastKnown.lat).toBeTypeOf('number');
    await sweepAbsences(new Date(later.getTime() + 31 * 60_000)); // past the 30 min cooldown
    expect((await q(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'PROLONGED_ABSENCE'`, [ctx.sessionId])).length).toBe(2);
  });

  it('(11) flags stopped updates as an interruption, not a departure, and recovers', async () => {
    const ctx = await present();
    await sweepStale(new Date(Date.now() + 10 * 60_000));
    const st = await request(app).get(`/api/v1/tracking/sessions/${ctx.sessionId}`).set(bearer(ctx.token)).expect(200);
    expect(st.body.session.state).toBe('TRACKING_INTERRUPTED');
    expect(await one(`SELECT 1 FROM absence_intervals WHERE session_id = $1`, [ctx.sessionId])).toBeNull();
    const n = await one(`SELECT body FROM notifications WHERE session_id = $1 AND type = 'TRACKING_INTERRUPTED'`, [ctx.sessionId]);
    expect(n.body).toContain('does not mean the employee left');
    const r = await ctx.send(reading(2, 6, new Date().toISOString()));
    expect(r.status.session.state).toBe('PRESENT');
    expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'TRACKING_RESUMED'`, [ctx.sessionId])).toBeTruthy();
  });

  it('(12) stops collection when the shift ends', async () => {
    const ctx = await present();
    const end = await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/end`).set(bearer(ctx.token)).expect(200);
    expect(end.body.session.state).toBe('SHIFT_COMPLETED');
    expect(end.body.tracking.shouldTrack).toBe(false);
    const before = (await one('SELECT count(*)::int AS n FROM location_updates WHERE session_id = $1', [ctx.sessionId])).n;
    const r = await ctx.send(reading(2, 6, new Date().toISOString()));
    expect(r.results[0]).toMatchObject({ status: 'REJECTED', reason: 'SESSION_CLOSED' });
    expect(r.status.tracking.shouldTrack).toBe(false);
    expect((await one('SELECT count(*)::int AS n FROM location_updates WHERE session_id = $1', [ctx.sessionId])).n).toBe(before);
    // and the same shift cannot be restarted the same day
    await request(app).post('/api/v1/tracking/sessions').set(bearer(ctx.token)).send({ shiftId: base.shiftId }).expect(409);
  });

  it('closes sessions automatically when the shift window ends', async () => {
    const ctx = await onShift();
    await sweepExpiredWindows(new Date(Date.now() + 3 * 86400_000));
    const s = await one('SELECT state, authorization_status FROM tracking_sessions WHERE id = $1', [ctx.sessionId]);
    expect(s).toEqual({ state: 'SHIFT_COMPLETED', authorization_status: 'EXPIRED' });
  });

  it('(13) reports a revoked permission and resumes when it is granted again', async () => {
    const ctx = await present();
    const denied = await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/permissions`).set(bearer(ctx.token)).send({ foreground: 'denied', background: 'denied', locationServicesEnabled: true }).expect(200);
    expect(denied.body.session.state).toBe('TRACKING_PERMISSION_REQUIRED');
    expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'PERMISSION_REVOKED'`, [ctx.sessionId])).toBeTruthy();
    // "While using the app" only, or approximate location: still paused — the company requires both.
    const foregroundOnly = await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/permissions`).set(bearer(ctx.token)).send({ foreground: 'granted', background: 'denied', locationServicesEnabled: true }).expect(200);
    expect(foregroundOnly.body.session.state).toBe('TRACKING_PERMISSION_REQUIRED');
    expect(foregroundOnly.body.guidance.title).toBe('Allow location all the time');
    const approximate = await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/permissions`).set(bearer(ctx.token)).send({ foreground: 'granted', background: 'granted', precise: false, locationServicesEnabled: true }).expect(200);
    expect(approximate.body.session.state).toBe('TRACKING_PERMISSION_REQUIRED');
    const ok = await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/permissions`).set(bearer(ctx.token)).send({ foreground: 'granted', background: 'granted', precise: true, locationServicesEnabled: true }).expect(200);
    expect(ok.body.session.state).toBe('PRESENT');
  });

  it('(14) reconciles an offline batch idempotently and in device-time order', async () => {
    const ctx = await present();
    const rs = [reading(4, 6, ctx.clock(10)), reading(5, 6, ctx.clock(10)), reading(6, 6, ctx.clock(10))];
    const shuffled = [rs[2], rs[0], rs[1]];
    const first = await ctx.send(...shuffled);
    expect(first.results.map((r: any) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
    const again = await ctx.send(...rs);
    expect(again.results.every((r: any) => r.status === 'DUPLICATE')).toBe(true);
    const older = await ctx.send(reading(4, 6, new Date(new Date(rs[0]!.clientTime).getTime() - 5000).toISOString()));
    expect(older.results[0].status).toBe('ACCEPTED');
    const stored = await q('SELECT validation_status FROM location_updates WHERE session_id = $1 ORDER BY id DESC LIMIT 1', [ctx.sessionId]);
    expect(stored[0].validation_status).toBe('HISTORICAL');
  });

  it('rejects malformed coordinates and impossible timestamps', async () => {
    const ctx = await onShift();
    await request(app).post('/api/v1/tracking/locations').set(bearer(ctx.token)).send({ sessionId: ctx.sessionId, readings: [{ ...reading(1, 5, ctx.clock(0)), latitude: 123 }] }).expect(400);
    const future = await ctx.send(reading(1, 5, new Date(Date.now() + 10 * 60_000).toISOString()));
    expect(future.results[0]).toMatchObject({ status: 'REJECTED', reason: 'TIMESTAMP_IN_FUTURE' });
    const ancient = await ctx.send(reading(1, 5, new Date(Date.now() - 2 * 86400_000).toISOString()));
    expect(ancient.results[0].reason).toBe('TIMESTAMP_TOO_OLD');
    const island = await ctx.send({ ...reading(1, 5, ctx.clock(1)), latitude: 0, longitude: 0 });
    expect(island.results[0].reason).toBe('NULL_ISLAND');
  });

  it('(15) applies a geofence edit to on-shift employees from their next reading', async () => {
    const ctx = await onShift();
    const outside = await ctx.send(reading(60, 5, ctx.clock(0)));
    expect(outside.status.session.state).toBe('OUTSIDE_GEOFENCE');
    const { agent, csrf } = await adminAgent(app);
    const patched = await agent.patch(`/api/v1/workplaces/${base.workplaceId}`).set('X-CSRF-Token', csrf).send({ radiusM: 100, reason: 'test' }).expect(200);
    expect(patched.body.radius_m).toBe(100);
    expect(patched.body.absence_threshold_minutes).toBe(5); // a partial edit must not reset other fields
    expect(await one(`SELECT 1 FROM notifications WHERE type = 'GEOFENCE_CHANGED' AND workplace_id = $1`, [base.workplaceId])).toBeTruthy();
    const inside = await ctx.send(reading(60, 5, ctx.clock(5)));
    expect(inside.status.session.state).toBe('ARRIVAL_CANDIDATE');
    expect(await one(`SELECT 1 FROM audit_logs WHERE action = 'workplace.update' AND resource_id = $1`, [base.workplaceId])).toBeTruthy();
    // Below the 50 m floor (indoor GPS is often ±30–60 m) the radius is refused.
    const small = await agent.patch(`/api/v1/workplaces/${base.workplaceId}`).set('X-CSRF-Token', csrf).send({ radiusM: 30 }).expect(400);
    expect(small.body.error.code).toBe('RADIUS_NOT_PERMITTED');
    await q(`UPDATE workplaces SET radius_m = 30 WHERE id = $1`, [base.workplaceId]); // the fixture's radius for later tests
    const rejected = await agent.patch(`/api/v1/workplaces/${base.workplaceId}`).set('X-CSRF-Token', csrf).send({ radiusM: 5 }).expect(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('declared breaks', () => {
  async function breakSelfie(ctx: Awaited<ReturnType<typeof onShift>>) {
    const img = fakeJpeg();
    const slot = await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/breaks/photo`).set(bearer(ctx.token)).send({ contentType: 'image/jpeg', sizeBytes: img.length }).expect(201);
    const u = new URL(slot.body.upload.url);
    await request(app).put(u.pathname + u.search).set('Content-Type', 'image/jpeg').send(img).expect(201);
    return slot.body.photoId as string;
  }
  const startBreak = (ctx: Awaited<ReturnType<typeof onShift>>, body: Record<string, unknown>, expectStatus = 201) =>
    request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/breaks`).set(bearer(ctx.token)).send(body).expect(expectStatus);

  it('starts only from inside, suppresses the absence while away, and ends on return', async () => {
    const ctx = await present();
    const st0 = await request(app).get(`/api/v1/tracking/sessions/${ctx.sessionId}`).set(bearer(ctx.token)).expect(200);
    expect(st0.body.canStartBreak).toBe(true);
    expect(st0.body.breakOptions.types.map((t: any) => t.key)).toContain('LUNCH');

    const photoId = await breakSelfie(ctx);
    const res = await startBreak(ctx, { typeKey: 'LUNCH', note: 'canteen', photoId, evidence: reading(3, 5, ctx.clock(2)) });
    expect(res.body.session.state).toBe('ON_BREAK');
    expect(res.body.break).toMatchObject({ typeKey: 'LUNCH', paid: false, maxMinutes: 45, note: 'canteen', leftAt: null });
    expect(res.body.canStartBreak).toBe(false);
    expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'BREAK_STARTED'`, [ctx.sessionId])).toBeTruthy();
    expect(await one(`SELECT purpose, status FROM attendance_photos WHERE id = $1`, [photoId])).toEqual({ purpose: 'BREAK', status: 'ATTACHED' });

    // Leave: no absence, no exit alert — but location keeps flowing and the exit is noted on the break.
    await ctx.send(reading(90, 6, ctx.clock(5)));
    let r = await ctx.send(reading(95, 6, ctx.clock(21)));
    expect(r.status.session.state).toBe('ON_BREAK');
    expect(r.status.break.leftAt).toBeTruthy();
    expect(await one(`SELECT 1 FROM absence_intervals WHERE session_id = $1`, [ctx.sessionId])).toBeNull();
    expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'GEOFENCE_EXIT'`, [ctx.sessionId])).toBeNull();

    // Come back: the break closes by itself.
    await ctx.send(reading(3, 6, ctx.clock(5)));
    r = await ctx.send(reading(2, 6, ctx.clock(11)));
    expect(r.status.session.state).toBe('PRESENT');
    expect(r.status.break).toBeNull();
    expect((await one(`SELECT end_reason FROM session_breaks WHERE session_id = $1`, [ctx.sessionId])).end_reason).toBe('RETURNED');
    expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'BREAK_ENDED'`, [ctx.sessionId])).toBeTruthy();
  });

  it('refuses a break that is started outside, before attendance, or without the selfie', async () => {
    const early = await makeReady();
    const e = await startBreak(early, { typeKey: 'TEA', evidence: reading(3, 5, early.clock(2)) }, 409);
    expect(e.body.error.code).toBe('BREAK_NOT_ALLOWED');

    const ctx = await present();
    const noPhoto = await startBreak(ctx, { typeKey: 'TEA', evidence: reading(3, 5, ctx.clock(2)) }, 422);
    expect(noPhoto.body.error.code).toBe('PHOTO_REQUIRED');
    const unknown = await startBreak(ctx, { typeKey: 'NAP', photoId: await breakSelfie(ctx), evidence: reading(3, 5, ctx.clock(2)) }, 400);
    expect(unknown.body.error.code).toBe('UNKNOWN_BREAK_TYPE');
    const outside = await startBreak(ctx, { typeKey: 'TEA', photoId: await breakSelfie(ctx), evidence: reading(60, 5, ctx.clock(2)) }, 422);
    expect(outside.body.error.code).toBe('BREAK_OUTSIDE');
    expect(await one(`SELECT 1 FROM session_breaks WHERE session_id = $1`, [ctx.sessionId])).toBeNull();
    expect((await one(`SELECT state FROM tracking_sessions WHERE id = $1`, [ctx.sessionId])).state).toBe('PRESENT');
  });

  it('alerts once when a break runs over, and counts unpaid break time out of worked time', async () => {
    const ctx = await present();
    await startBreak(ctx, { typeKey: 'PERSONAL', photoId: await breakSelfie(ctx), evidence: reading(3, 5, ctx.clock(2)) });
    await sweepOverdueBreaks(new Date(Date.now() + 10 * 60_000));
    expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'BREAK_OVERDUE'`, [ctx.sessionId])).toBeNull(); // limit is 15 min
    const later = new Date(Date.now() + 16 * 60_000);
    await sweepOverdueBreaks(later);
    await sweepOverdueBreaks(later);
    const alerts = await q(`SELECT * FROM notifications WHERE session_id = $1 AND type = 'BREAK_OVERDUE' AND audience = 'ADMIN'`, [ctx.sessionId]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain('Still inside the workplace area');

    // Pretend the break started 20 minutes ago, then the employee ends it.
    await q(`UPDATE session_breaks SET started_at = now() - interval '20 minutes' WHERE session_id = $1`, [ctx.sessionId]);
    const end = await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/breaks/current/end`).set(bearer(ctx.token)).expect(200);
    expect(end.body.session.state).toBe('PRESENT');
    const work = await one(`SELECT break_minutes, unpaid_break_minutes FROM attendance_work WHERE attendance_id = $1`, [ctx.attendanceId]);
    expect(work.unpaid_break_minutes).toBeGreaterThanOrEqual(19);
    expect(work.break_minutes).toBe(work.unpaid_break_minutes);
    await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/breaks/current/end`).set(bearer(ctx.token)).expect(409);
  });

  it('closes an open break when the shift ends and shows breaks to the admin', async () => {
    const ctx = await present();
    await startBreak(ctx, { typeKey: 'TEA', photoId: await breakSelfie(ctx), evidence: reading(3, 5, ctx.clock(2)) });
    const { agent, csrf } = await adminAgent(app);
    const live = await agent.get('/api/v1/tracking/live').expect(200);
    expect(live.body.sessions.find((s: any) => s.id === ctx.sessionId)).toMatchObject({ state: 'ON_BREAK', break_label: 'Tea break', break_paid: true });
    const tl = await agent.get(`/api/v1/tracking/sessions/${ctx.sessionId}/timeline`).expect(200);
    const breakId = tl.body.breaks[0].id;
    const link = await agent.post(`/api/v1/tracking/sessions/${ctx.sessionId}/breaks/${breakId}/photo-url`).set('X-CSRF-Token', csrf).expect(200);
    await request(app).get(link.body.url).expect(200);
    await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/end`).set(bearer(ctx.token)).expect(200);
    expect((await one(`SELECT end_reason FROM session_breaks WHERE id = $1`, [breakId])).end_reason).toBe('SHIFT_ENDED');
  });
});

describe('anti-cheating', () => {
  const submit = async (ctx: Awaited<ReturnType<typeof onShift>>, device?: Record<string, unknown>) => {
    const { photoId, key } = await capture(ctx);
    return request(app).post('/api/v1/attendance').set(bearer(ctx.token)).send({ sessionId: ctx.sessionId, photoId, idempotencyKey: key, evidence: reading(3, 5, ctx.clock(2)), device });
  };

  it('refuses attendance when fake GPS was reported earlier in the shift, even if the final fix looks clean', async () => {
    const ctx = await onShift();
    await ctx.send(reading(5, 6, ctx.clock(0), { isMocked: true }));
    await ctx.send(reading(4, 6, ctx.clock(11)));
    const r = await submit(ctx);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('MOCK_LOCATION');
    expect(await one(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [ctx.sessionId])).toBeNull();
  });

  it('refuses attendance from a rooted phone or an emulator', async () => {
    const rooted = await makeReady();
    const r1 = await submit(rooted, { isPhysicalDevice: true, isRooted: true });
    expect(r1.status).toBe(422);
    expect(r1.body.error.code).toBe('DEVICE_NOT_TRUSTED');
    const emulator = await makeReady();
    expect((await submit(emulator, { isPhysicalDevice: false, isRooted: false })).body.error.code).toBe('DEVICE_NOT_TRUSTED');
    const fine = await makeReady();
    expect((await submit(fine, { isPhysicalDevice: true, isRooted: false })).status).toBe(201);
  });

  it('does not unlock attendance from a burst of readings with invented phone times (GPS-01)', async () => {
    const tracking = (await getSettings(DEFAULT_ORG_ID)).tracking;
    await saveSettingsSection(DEFAULT_ORG_ID, 'tracking', { ...tracking, entryMinServerSpanSec: 20 }, null);
    try {
      const ctx = await onShift();
      await ctx.send(reading(5, 6, ctx.clock(0)));
      const r = await ctx.send(reading(4, 6, ctx.clock(60)), reading(4, 6, ctx.clock(5))); // "65 s" on the phone, milliseconds at the server
      expect(r.status.session.state).toBe('ARRIVAL_CANDIDATE');
      expect(r.status.attendanceAvailable).toBe(false);
      expect((await one(`SELECT candidate_received_since FROM tracking_sessions WHERE id = $1`, [ctx.sessionId])).candidate_received_since).toBeTruthy();
    } finally {
      await saveSettingsSection(DEFAULT_ORG_ID, 'tracking', tracking, null);
    }
  });

  it('rejects readings stamped more than a minute in the future', async () => {
    const ctx = await onShift();
    const r = await ctx.send(reading(5, 6, new Date(Date.now() + 90_000).toISOString()));
    expect(r.results[0]).toMatchObject({ status: 'REJECTED', reason: 'TIMESTAMP_IN_FUTURE' });
  });
});

describe('overtime with approval', () => {
  async function overtimeSelfie(ctx: Awaited<ReturnType<typeof onShift>>, path = 'overtime/photo') {
    const img = fakeJpeg();
    const slot = await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/${path}`).set(bearer(ctx.token)).send({ contentType: 'image/jpeg', sizeBytes: img.length }).expect(201);
    const u = new URL(slot.body.upload.url);
    await request(app).put(u.pathname + u.search).set('Content-Type', 'image/jpeg').send(img).expect(201);
    return slot.body.photoId as string;
  }
  /** Present, with the scheduled end two hours ago (still inside the session, as the window is not swept). */
  async function afterShift() {
    const ctx = await present();
    await q(`UPDATE tracking_sessions SET scheduled_end_at = now() - interval '2 hours' WHERE id = $1`, [ctx.sessionId]);
    return ctx;
  }
  const startOvertime = async (ctx: Awaited<ReturnType<typeof onShift>>, northM = 800) =>
    (
      await request(app)
        .post(`/api/v1/tracking/sessions/${ctx.sessionId}/overtime`)
        .set(bearer(ctx.token))
        .send({ note: 'Finishing the delivery', photoId: await overtimeSelfie(ctx), evidence: reading(northM, 8, ctx.clock(20)) })
        .expect(201)
    ).body;

  it('starts only after the shift ends, may be worked anywhere, and survives the shift window', async () => {
    const early = await present();
    const st0 = await request(app).get(`/api/v1/tracking/sessions/${early.sessionId}`).set(bearer(early.token)).expect(200);
    expect(st0.body.canStartOvertime).toBe(false);
    const tooEarly = await request(app).post(`/api/v1/tracking/sessions/${early.sessionId}/overtime/photo`).set(bearer(early.token)).send({ contentType: 'image/jpeg', sizeBytes: 100 }).expect(409);
    expect(tooEarly.body.error.code).toBe('OVERTIME_TOO_EARLY');

    const ctx = await afterShift();
    expect((await request(app).get(`/api/v1/tracking/sessions/${ctx.sessionId}`).set(bearer(ctx.token)).expect(200)).body.canStartOvertime).toBe(true);
    const started = await startOvertime(ctx); // 800 m away: allowed, kept as evidence
    expect(started.session.state).toBe('ON_OVERTIME');
    expect(started.overtime).toMatchObject({ status: 'RUNNING', note: 'Finishing the delivery' });
    expect(started.canStartOvertime).toBe(false);
    expect(started.tracking.windowClosesAt).toBeNull();
    expect((await one(`SELECT start_distance_m FROM overtime_entries WHERE session_id = $1`, [ctx.sessionId])).start_distance_m).toBeGreaterThan(700);
    expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'OVERTIME_STARTED'`, [ctx.sessionId])).toBeTruthy();

    // Away from the workplace: no absence, location still recorded.
    await ctx.send(reading(900, 8, ctx.clock(10)));
    const r = await ctx.send(reading(950, 8, ctx.clock(25)));
    expect(r.status.session.state).toBe('ON_OVERTIME');
    expect(await one(`SELECT 1 FROM absence_intervals WHERE session_id = $1 AND status = 'OPEN'`, [ctx.sessionId])).toBeNull();

    // The shift window (end + grace) has passed, but overtime keeps the session open.
    await sweepExpiredWindows();
    expect((await one(`SELECT ended_at FROM tracking_sessions WHERE id = $1`, [ctx.sessionId])).ended_at).toBeNull();

    const { agent, csrf } = await adminAgent(app);
    const running = (await agent.get('/api/v1/overtime?status=RUNNING').expect(200)).body.find((o: any) => o.session_id === ctx.sessionId);
    expect(running.status).toBe('RUNNING');
    expect(running.readings).toBeGreaterThanOrEqual(3);
    expect(running.max_distance_m).toBeGreaterThan(900);
    const notYet = await agent.post(`/api/v1/overtime/${running.id}/decision`).set('X-CSRF-Token', csrf).send({ decision: 'APPROVE' }).expect(409);
    expect(notYet.body.error.code).toBe('OVERTIME_RUNNING');

    // End overtime with the end-of-shift selfie: it goes with the overtime.
    const endPhoto = await overtimeSelfie(ctx, 'end-photo');
    await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/end`).set(bearer(ctx.token)).send({ photoId: endPhoto }).expect(200);
    const o = await one(`SELECT * FROM overtime_entries WHERE session_id = $1`, [ctx.sessionId]);
    expect(o).toMatchObject({ end_reason: 'EMPLOYEE', end_photo_id: endPhoto, status: 'PENDING' });
    expect((await one(`SELECT end_photo_id FROM attendance_records WHERE id = $1`, [ctx.attendanceId])).end_photo_id).toBeNull();
    expect(await one(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'OVERTIME_ENDED'`, [ctx.sessionId])).toBeTruthy();
    expect((await agent.get('/api/v1/approvals/count').expect(200)).body.overtime).toBeGreaterThanOrEqual(1);
  });

  it('counts only approved minutes, never more than were worked, and tells the employee', async () => {
    const ctx = await afterShift();
    await startOvertime(ctx, 3);
    await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/end`).set(bearer(ctx.token)).send({}).expect(200);
    await q(`UPDATE overtime_entries SET started_at = ended_at - interval '90 minutes' WHERE session_id = $1`, [ctx.sessionId]);
    const id = (await one(`SELECT id FROM overtime_entries WHERE session_id = $1`, [ctx.sessionId])).id;

    let work = await one(`SELECT worked_minutes, scheduled_minutes, overtime_status, overtime_claimed_minutes, overtime_minutes FROM attendance_work WHERE attendance_id = $1`, [ctx.attendanceId]);
    expect(work).toMatchObject({ overtime_status: 'PENDING', overtime_claimed_minutes: 90, overtime_minutes: 0 });
    expect(work.worked_minutes).toBeLessThanOrEqual(work.scheduled_minutes); // regular time stops at the scheduled end

    const { agent, csrf } = await adminAgent(app);
    const tooMany = await agent.post(`/api/v1/overtime/${id}/decision`).set('X-CSRF-Token', csrf).send({ decision: 'APPROVE', minutes: 120 }).expect(400);
    expect(tooMany.body.error.code).toBe('MINUTES_TOO_HIGH');
    await agent.post(`/api/v1/overtime/${id}/decision`).set('X-CSRF-Token', csrf).send({ decision: 'REJECT' }).expect(400); // reason required
    const ok = await agent.post(`/api/v1/overtime/${id}/decision`).set('X-CSRF-Token', csrf).send({ decision: 'APPROVE', minutes: 60, note: 'Last 30 min was travel' }).expect(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', approved_minutes: 60 });

    work = await one(`SELECT overtime_status, overtime_minutes FROM attendance_work WHERE attendance_id = $1`, [ctx.attendanceId]);
    expect(work).toEqual({ overtime_status: 'APPROVED', overtime_minutes: 60 });
    expect(await one(`SELECT 1 FROM notifications WHERE employee_id = $1 AND type = 'OVERTIME_DECIDED' AND audience = 'EMPLOYEE'`, [ctx.emp.id])).toBeTruthy();
    expect(await one(`SELECT 1 FROM audit_logs WHERE action = 'overtime.approve' AND resource_id = $1`, [id])).toBeTruthy();

    const roster = (await agent.get('/api/v1/reports/overview').expect(200)).body.roster.find((r: any) => r.attendance_id === ctx.attendanceId);
    expect(roster).toMatchObject({ overtime_minutes: 60, overtime_status: 'APPROVED', overtime_claimed_minutes: 90 });
    const summary = (await agent.get('/api/v1/overtime/summary').expect(200)).body;
    expect(summary.approved_minutes).toBeGreaterThanOrEqual(60);
    const mine = (await request(app).get('/api/v1/overtime/mine').set(bearer(ctx.token)).expect(200)).body;
    expect(mine.rows[0]).toMatchObject({ status: 'APPROVED', approved_minutes: 60, claimed_minutes: 90, decision_note: 'Last 30 min was travel' });
  });

  it('approves in bulk, prompts at the shift end once, and ends overtime when the phone goes quiet', async () => {
    const a = await afterShift();
    await startOvertime(a);
    await request(app).post(`/api/v1/tracking/sessions/${a.sessionId}/end`).set(bearer(a.token)).send({}).expect(200);
    const id = (await one(`SELECT id FROM overtime_entries WHERE session_id = $1`, [a.sessionId])).id;
    const { agent, csrf } = await adminAgent(app);
    const bulk = await agent.post('/api/v1/overtime/decisions').set('X-CSRF-Token', csrf).send({ ids: [id, crypto.randomUUID()] }).expect(200);
    expect(bulk.body).toEqual({ approved: 1, skipped: 1 });

    const b = await afterShift();
    await sweepOvertime();
    await sweepOvertime();
    expect(await q(`SELECT 1 FROM notifications WHERE session_id = $1 AND type = 'OVERTIME_PROMPT' AND audience = 'EMPLOYEE'`, [b.sessionId])).toHaveLength(1);

    await startOvertime(b);
    await q(`UPDATE overtime_entries SET started_at = now() - interval '3 hours' WHERE session_id = $1`, [b.sessionId]);
    await q(`UPDATE tracking_sessions SET last_location_at = now() - interval '2 hours' WHERE id = $1`, [b.sessionId]);
    await sweepOvertime();
    const o = await one(`SELECT o.end_reason, o.ended_at, s.ended_at AS session_ended FROM overtime_entries o JOIN tracking_sessions s ON s.id = o.session_id WHERE o.session_id = $1`, [b.sessionId]);
    expect(o.end_reason).toBe('TRACKING_LOST');
    expect(o.session_ended).toBeTruthy();
    expect(new Date(o.ended_at).getTime()).toBeLessThan(Date.now() - 90 * 60_000); // at the last location, not now
  });
});

describe('roster: several workplaces and managers', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

  async function secondSite() {
    const wp = await one(
      `INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, absence_threshold_minutes, org_id) VALUES ('Second Site', 12.99, 77.59, 40, 'UTC', 5, $1) RETURNING id`,
      [base.orgId],
    );
    const shift = await one(
      `INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1, 'Site 2 all day', '00:00', '23:59', 'UTC', '{1,2,3,4,5,6,7}', 240) RETURNING id`,
      [wp.id],
    );
    const sup = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) VALUES ($1, 'x', 'ADMIN', 'Site Two Manager', $2) RETURNING id`, [`sup-${crypto.randomUUID()}@test.local`, base.orgId]);
    await q(`INSERT INTO administrator_profiles (user_id, access, site_ids) VALUES ($1, 'SUPERVISOR', $2)`, [sup.id, [wp.id]]);
    return { workplaceId: wp.id as string, shiftId: shift.id as string, managerId: sup.id as string };
  }

  it('lets an employee work this week at another workplace, under its manager', async () => {
    const site2 = await secondSite();
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const { agent, csrf } = await adminAgent(app);
    const added = await agent
      .post(`/api/v1/employees/${emp.id}/shifts`)
      .set('X-CSRF-Token', csrf)
      .send({ shiftId: site2.shiftId, effectiveFrom: day(-1), effectiveTo: day(6), managerId: site2.managerId })
      .expect(200);
    expect(added.body.shifts[0]).toMatchObject({ workplaceId: site2.workplaceId, managerName: 'Site Two Manager', effectiveTo: day(6) });

    const token = await mobileLogin(app, emp.email);
    const me = await request(app).get('/api/v1/me/assignment').set(bearer(token)).expect(200);
    expect(me.body.workplace.id).toBe(site2.workplaceId); // where today's shift is, not the home workplace
    expect(me.body.shifts[0].workplace.name).toBe('Second Site');
    const start = await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: site2.shiftId }).expect(201);
    expect(start.body.workplace.id).toBe(site2.workplaceId);

    // The roster's manager receives this session's alerts (a supervisor of that site anyway, so check the query path works).
    const n = await one(`SELECT id FROM notifications WHERE session_id = $1 AND type = 'SHIFT_STARTED'`, [start.body.session.id]);
    expect(n).toBeTruthy();

    // Changing the home workplace keeps the roster entry elsewhere.
    await request(app).post(`/api/v1/tracking/sessions/${start.body.session.id}/end`).set(bearer(token)).expect(200);
    const moved = await agent.put(`/api/v1/employees/${emp.id}/workplace`).set('X-CSRF-Token', csrf).send({ workplaceId: site2.workplaceId }).expect(200);
    expect(moved.body.shifts).toHaveLength(1);
  });

  it('refuses clashing entries but allows the same shift on other dates', async () => {
    const site2 = await secondSite();
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const { agent, csrf } = await adminAgent(app);
    const add = (body: Record<string, unknown>, status: number) => agent.post(`/api/v1/employees/${emp.id}/shifts`).set('X-CSRF-Token', csrf).send(body).expect(status);
    await add({ shiftId: base.shiftId, effectiveFrom: day(0), effectiveTo: day(6) }, 200);
    const clash = await add({ shiftId: site2.shiftId, effectiveFrom: day(3), effectiveTo: day(10) }, 409);
    expect(clash.body.error.code).toBe('ROSTER_CLASH');
    expect(clash.body.error.message).toContain('Test Site');
    await add({ shiftId: site2.shiftId, effectiveFrom: day(7), effectiveTo: day(13) }, 200); // next week, elsewhere
    await add({ shiftId: base.shiftId, effectiveFrom: day(14) }, 200); // back again, open-ended
    const bad = await add({ shiftId: base.shiftId, effectiveFrom: day(30), managerId: site2.managerId }, 400); // that supervisor cannot see Test Site
    expect(bad.body.error.code).toBe('BAD_MANAGER');

    const week = await agent.get(`/api/v1/roster?from=${day(0)}&to=${day(13)}`).expect(200);
    expect(week.body.filter((r: any) => r.employee_id === emp.id)).toHaveLength(2);
  });

  it('only allows a shift to start on rostered dates', async () => {
    const site2 = await secondSite();
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const { agent, csrf } = await adminAgent(app);
    await agent.post(`/api/v1/employees/${emp.id}/shifts`).set('X-CSRF-Token', csrf).send({ shiftId: site2.shiftId, effectiveFrom: day(7), effectiveTo: day(9) }).expect(200);
    const token = await mobileLogin(app, emp.email);
    const r = await request(app).post('/api/v1/tracking/sessions').set(bearer(token)).send({ shiftId: site2.shiftId }).expect(409);
    expect(r.body.error.code).toBe('OUTSIDE_SHIFT_WINDOW');
    const me = await request(app).get('/api/v1/me/assignment').set(bearer(token)).expect(200);
    expect(me.body.shifts[0].next.shiftDate >= day(7)).toBe(true);
  });
});

describe('admin workflows', () => {
  it('serves audited, short-lived photo links', async () => {
    const ctx = await present();
    const { agent, csrf } = await adminAgent(app);
    const link = await agent.post(`/api/v1/attendance/${ctx.attendanceId}/photo-url`).set('X-CSRF-Token', csrf).expect(200);
    const img = await request(app).get(link.body.url).expect(200);
    expect(img.headers['cache-control']).toContain('no-store');
    expect(await one(`SELECT 1 FROM audit_logs WHERE action = 'attendance_photo.view'`)).toBeTruthy();
  });

  it('requires a reason for corrections and keeps before/after history', async () => {
    const ctx = await present();
    const { agent, csrf } = await adminAgent(app);
    await agent.post(`/api/v1/attendance/${ctx.attendanceId}/corrections`).set('X-CSRF-Token', csrf).send({ isLate: true }).expect(400);
    const r = await agent.post(`/api/v1/attendance/${ctx.attendanceId}/corrections`).set('X-CSRF-Token', csrf).send({ reason: 'Bus strike — approved by HR', isLate: false }).expect(200);
    expect(r.body.verification_status).toBe('CORRECTED');
    const detail = await agent.get(`/api/v1/attendance/${ctx.attendanceId}`).expect(200);
    expect(detail.body.history[0]).toMatchObject({ kind: 'ADMIN_CORRECTION', status: 'APPLIED' });
    await expect(q(`UPDATE audit_logs SET action = 'tampered'`)).rejects.toThrow(/append-only/);
  });

  it('supports the manual-review workflow for persistent GPS problems', async () => {
    const ctx = await onShift();
    await ctx.send(reading(5, 80, ctx.clock(0)));
    const req1 = await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/review-request`).set(bearer(ctx.token)).send({ reason: 'GPS will not settle inside the building' }).expect(200);
    expect(req1.body.session.state).toBe('MANUAL_REVIEW_REQUIRED');
    const { agent, csrf } = await adminAgent(app);
    const list = await agent.get('/api/v1/attendance/reviews?status=OPEN&kind=MANUAL_REVIEW').expect(200);
    const review = list.body.find((r: any) => r.session_id === ctx.sessionId);
    const res = await agent.post(`/api/v1/attendance/reviews/${review.id}/resolve`).set('X-CSRF-Token', csrf).send({ decision: 'APPROVE', note: 'Verified by supervisor on site' }).expect(200);
    expect(res.body.status).toBe('APPROVED');
    const rec = await one('SELECT verification_status FROM attendance_records WHERE id = $1', [res.body.attendanceId]);
    expect(rec.verification_status).toBe('MANUAL_APPROVED');
  });

  it('exports CSV with formula-injection protection', async () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-12.5')).toBe('-12.5');
    const { agent } = await adminAgent(app);
    const today = new Date().toISOString().slice(0, 10);
    const r = await agent.get(`/api/v1/reports/attendance.csv?from=${today}&to=${today}`).expect(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text).toContain('Employee ID');
    const ov = await agent.get(`/api/v1/reports/overview?date=${today}`).expect(200);
    expect(ov.body.cards.assigned).toBeGreaterThan(0);
  });

  it('(17) pushes live updates to the dashboard over SSE', async () => {
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'Test-password-123', client: 'web' }) });
      const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const ctrl = new AbortController();
      const stream = await fetch(`http://127.0.0.1:${port}/api/v1/notifications/stream`, { headers: { cookie }, signal: ctrl.signal });
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      const reader = stream.body!.getReader();
      const ctx = await onShift();
      await ctx.send(reading(50, 5, ctx.clock(0)));
      let text = '';
      const deadline = Date.now() + 5000;
      while (!text.includes(ctx.sessionId) && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
      ctrl.abort();
      expect(text).toContain('event: session.updated');
      expect(text).toContain(ctx.sessionId);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('(20) retention removes old location history and photos only', async () => {
    const ctx = await present();
    await request(app).post(`/api/v1/tracking/sessions/${ctx.sessionId}/end`).set(bearer(ctx.token)).expect(200);
    await q(`UPDATE location_updates SET received_at = now() - interval '400 days' WHERE session_id = $1`, [ctx.sessionId]);
    await q(`UPDATE attendance_photos SET retention_until = now() - interval '1 day' WHERE id = $1`, [ctx.photoId]);
    const photo = await one('SELECT object_key FROM attendance_photos WHERE id = $1', [ctx.photoId]);
    const file = path.join(config.storage.localDir, photo.object_key);
    expect(fs.existsSync(file)).toBe(true);
    const live = await onShift();
    await live.send(reading(50, 5, live.clock(0)));
    await q(`UPDATE location_updates SET received_at = now() - interval '400 days' WHERE session_id = $1`, [live.sessionId]);
    config.photoAutoDeleteEnabled = true; // deletion is on hold by default: corrections-and-photos.test.ts
    await saveSettingsSection(DEFAULT_ORG_ID, 'retention', { ...(await getSettings(DEFAULT_ORG_ID)).retention, photoAutoDelete: true }, null);
    invalidateSettings();
    const summary = await runRetention(null, DEFAULT_ORG_ID);
    config.photoAutoDeleteEnabled = false;
    expect(summary!.photosDeleted).toBeGreaterThanOrEqual(1);
    expect((await one('SELECT count(*)::int AS n FROM location_updates WHERE session_id = $1', [ctx.sessionId])).n).toBe(0);
    expect((await one('SELECT count(*)::int AS n FROM location_updates WHERE session_id = $1', [live.sessionId])).n).toBe(1); // open session untouched
    expect(fs.existsSync(file)).toBe(false);
    expect((await one('SELECT status FROM attendance_photos WHERE id = $1', [ctx.photoId])).status).toBe('DELETED');
    expect(await one('SELECT 1 FROM attendance_records WHERE id = $1', [ctx.attendanceId])).toBeTruthy(); // record kept
  });
});

describe('demo simulator (same rules as the live system)', () => {
  it('drives a demo employee through arrival, attendance, departure, prolonged absence, return, interruption and end', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    await q('UPDATE users SET is_demo = true WHERE id = $1', [emp.id]);
    const { agent, csrf } = await adminAgent(app);
    const post = (p: string, body: object = {}) => agent.post(`/api/v1/demo/employees/${emp.id}${p}`).set('X-CSRF-Token', csrf).send(body);

    expect((await post('/start-shift').expect(200)).body.session.state).toBe('TRACKING_ACTIVE');
    expect((await post('/attendance').expect(409)).body.error.code).toBe('ATTENDANCE_LOCKED');
    expect((await post('/move', { position: 'outside' }).expect(200)).body.status.session.state).toBe('OUTSIDE_GEOFENCE');
    expect((await post('/move', { position: 'inside' }).expect(200)).body.status.session.state).toBe('ATTENDANCE_READY');
    const att = await post('/attendance').expect(200);
    expect(att.body.status.session.state).toBe('PRESENT');
    expect(att.body.attendance.is_simulated).toBe(true);
    expect((await post('/move', { position: 'outside' }).expect(200)).body.status.session.state).toBe('TEMPORARILY_AWAY');
    expect((await post('/advance', { minutes: 6 }).expect(200)).body.session.state).toBe('PROLONGED_ABSENCE');
    expect((await post('/move', { position: 'inside' }).expect(200)).body.status.session.state).toBe('PRESENT');
    expect((await post('/interrupt').expect(200)).body.session.state).toBe('TRACKING_INTERRUPTED');
    expect((await post('/end-shift').expect(200)).body.session.state).toBe('SHIFT_COMPLETED');

    const flagged = await one(`SELECT bool_and(lu.is_simulated) AS all_sim, count(*)::int AS n FROM location_updates lu JOIN tracking_sessions s ON s.id = lu.session_id WHERE s.employee_id = $1`, [emp.id]);
    expect(flagged.all_sim).toBe(true);

    // The simulator refuses real (non-demo) employees.
    const real = await createEmployee({ workplaceId: base.workplaceId, shiftId: base.shiftId });
    await agent.post(`/api/v1/demo/employees/${real.id}/start-shift`).set('X-CSRF-Token', csrf).expect(403);

    await agent.post('/api/v1/demo/reset').set('X-CSRF-Token', csrf).expect(200);
    expect((await one('SELECT count(*)::int AS n FROM tracking_sessions WHERE employee_id = $1', [emp.id])).n).toBe(0);
  });
});
