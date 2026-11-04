/**
 * Phone events that arrive late, and the owner's override of a rejected face check.
 * Delayed events are judged on their evidence, flagged, and can never be earlier than the
 * session start the server recorded itself.
 */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { DEFAULT_SETTINGS, invalidateSettings, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { adminAgent, createEmployee, createTestDatabase, fakeJpeg, mobileLogin, seedBase, WP } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
let owner: Awaited<ReturnType<typeof adminAgent>>;
let sup: Awaited<ReturnType<typeof adminAgent>>;
let shiftId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
  owner = await adminAgent(app);
  const s = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) SELECT $1, password_hash, 'ADMIN', 'Sup', org_id FROM users WHERE id = $2 RETURNING id, email`, [`sup-${crypto.randomUUID()}@test.local`, base.adminId]);
  await q(`INSERT INTO administrator_profiles (user_id, access, site_ids) VALUES ($1,'SUPERVISOR',$2)`, [s.id, [base.workplaceId]]);
  sup = await adminAgent(app, s.email);
  shiftId = (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'Day','09:00','17:00','UTC',$2,10) RETURNING id`, [base.workplaceId, [1, 2, 3, 4, 5, 6, 7]])).id;
});
afterAll(async () => {
  await db.drop();
});
afterEach(async () => {
  await saveSettingsSection(DEFAULT_ORG_ID, 'tracking', DEFAULT_SETTINGS.tracking, null);
  invalidateSettings();
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const ago = (minutes: number) => DateTime.utc().minus({ minutes }).toISO()!;

/** An approved phone on an open session that started `minutes` ago, scheduled to start then too. */
async function onShift(minutes = 120, scheduledAgo = minutes) {
  const emp = await createEmployee({ workplaceId: base.workplaceId });
  await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2020-01-01')`, [emp.id, shiftId]);
  const token = await mobileLogin(app, emp.email);
  const date = DateTime.utc().minus({ minutes }).toISODate();
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,'TRACKING_ACTIVE',$7) RETURNING id`,
    [emp.id, shiftId, base.workplaceId, date, ago(scheduledAgo), DateTime.utc().plus({ hours: 4 }).toISO(), ago(minutes)],
  );
  return { emp, token, sessionId: s.id as string, date: date! };
}
const evidence = (clientTime: string, over: object = {}) => ({ clientEventId: crypto.randomUUID(), latitude: WP.lat, longitude: WP.lng, accuracyM: 8, clientTime, ...over });

/** The phone's offline upload: reserve a slot, put the photo, then submit. */
async function send(a: { token: string; sessionId: string }, clientTime: string, key = `offline-${crypto.randomUUID()}`, over: object = {}) {
  const img = fakeJpeg();
  const intent = await request(app).post('/api/v1/attendance/intents').set(auth(a.token)).send({ sessionId: a.sessionId, idempotencyKey: key, contentType: 'image/jpeg', sizeBytes: img.length, capturedOffline: true });
  if (intent.status !== 201) return intent;
  const u = new URL(intent.body.upload.url);
  await request(app).put(u.pathname + u.search).set('Content-Type', 'image/jpeg').send(img).expect(201);
  return request(app).post('/api/v1/attendance').set(auth(a.token)).send({ sessionId: a.sessionId, photoId: intent.body.photoId, idempotencyKey: key, evidence: evidence(clientTime, over), capturedOffline: true });
}
const record = (sessionId: string) => one(`SELECT * FROM attendance_records WHERE session_id = $1`, [sessionId]);
const session = (id: string) => one(`SELECT * FROM tracking_sessions WHERE id = $1`, [id]);

describe('a check-in saved without a connection', () => {
  it('counts from when it was captured, is flagged, and the session moves on', async () => {
    const a = await onShift(120, 125);
    const res = await send(a, ago(118));
    expect(res.status).toBe(201);
    const r = await record(a.sessionId);
    expect(r.risk_flags).toContain('OFFLINE_CAPTURE');
    expect(Math.abs(new Date(r.recorded_at).getTime() - Date.parse(ago(118)))).toBeLessThan(5000);
    expect(r.is_late).toBe(false);
    expect(r.device_meta.receivedAt).toBeTruthy();
    expect((await session(a.sessionId)).state).toBe('PRESENT');
  });

  it('without the flag is still refused as stale', async () => {
    const a = await onShift();
    const img = fakeJpeg();
    const key = `online-${crypto.randomUUID()}`;
    await q(`UPDATE tracking_sessions SET state = 'ATTENDANCE_READY' WHERE id = $1`, [a.sessionId]);
    const intent = await request(app).post('/api/v1/attendance/intents').set(auth(a.token)).send({ sessionId: a.sessionId, idempotencyKey: key, contentType: 'image/jpeg', sizeBytes: img.length }).expect(201);
    const u = new URL(intent.body.upload.url);
    await request(app).put(u.pathname + u.search).set('Content-Type', 'image/jpeg').send(img).expect(201);
    const res = await request(app).post('/api/v1/attendance').set(auth(a.token)).send({ sessionId: a.sessionId, photoId: intent.body.photoId, idempotencyKey: key, evidence: evidence(ago(30)) });
    expect(res.body.error.code).toBe('EVIDENCE_STALE');
  });

  it('sent twice creates one record', async () => {
    const a = await onShift();
    const key = `offline-${crypto.randomUUID()}`;
    expect((await send(a, ago(100), key)).status).toBe(201);
    const again = await request(app).post('/api/v1/attendance').set(auth(a.token)).send({ sessionId: a.sessionId, photoId: (await record(a.sessionId)).photo_id, idempotencyKey: key, evidence: evidence(ago(100)), capturedOffline: true });
    expect(again.status).toBe(200);
    expect(again.body.replay).toBe(true);
    expect(await q(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [a.sessionId])).toHaveLength(1);
  });

  it('a second, different check-in for the shift is refused', async () => {
    const a = await onShift();
    expect((await send(a, ago(100))).status).toBe(201);
    const second = await send(a, ago(90));
    expect(second.status).toBe(409);
    expect(await q(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [a.sessionId])).toHaveLength(1);
  });

  it('cannot use a changed phone clock to arrive before the session started', async () => {
    const a = await onShift(60, 180); // the employee really started two hours late
    const res = await send(a, ago(61)); // within the allowed skew, phone claims the earliest possible moment
    expect(res.status).toBe(201);
    const r = await record(a.sessionId);
    expect(new Date(r.recorded_at).getTime()).toBeGreaterThanOrEqual(new Date((await session(a.sessionId)).started_at).getTime());
    expect(r.is_late).toBe(true);
    expect(r.late_by_minutes).toBeGreaterThanOrEqual(115);
    const b = await onShift(60, 180);
    const earlier = await send(b, ago(170));
    expect(earlier.status).toBe(422);
    expect(earlier.body.error.code).toBe('EVIDENCE_INVALID');
    expect(await record(b.sessionId)).toBeFalsy();
  });

  it('must still have been inside the workplace', async () => {
    const a = await onShift();
    const res = await send(a, ago(100), undefined, { latitude: WP.lat + 0.05 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EVIDENCE_NOT_INSIDE');
    expect(await record(a.sessionId)).toBeFalsy();
  });

  it('is refused when too old, or when the company turned it off', async () => {
    const a = await onShift(60 * 30);
    const old = await send(a, ago(60 * 29));
    expect(old.status).toBe(422);
    expect(old.body.error.code).toBe('OFFLINE_TOO_OLD');
    await saveSettingsSection(DEFAULT_ORG_ID, 'tracking', { ...DEFAULT_SETTINGS.tracking, offlineAttendanceHours: 0 }, null);
    invalidateSettings();
    const b = await onShift();
    const off = await send(b, ago(100));
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('OFFLINE_ATTENDANCE_OFF');
  });

  it('is accepted after the server closed the session, if captured before that', async () => {
    const a = await onShift(300, 300);
    await q(`UPDATE tracking_sessions SET ended_at = $2, state = 'SHIFT_COMPLETED', authorization_status = 'EXPIRED' WHERE id = $1`, [a.sessionId, ago(30)]);
    expect((await send(a, ago(280))).status).toBe(201);
    expect((await session(a.sessionId)).state).toBe('SHIFT_COMPLETED');
    expect((await record(a.sessionId)).risk_flags).toContain('OFFLINE_CAPTURE');
  });

  it('is refused if captured after the session closed', async () => {
    const a = await onShift(300, 300);
    await q(`UPDATE tracking_sessions SET ended_at = $2, state = 'SHIFT_COMPLETED', authorization_status = 'EXPIRED' WHERE id = $1`, [a.sessionId, ago(60)]);
    const res = await send(a, ago(30));
    expect(res.status).toBe(409);
    expect(await record(a.sessionId)).toBeFalsy();
  });

  it('counts in the worked-time report', async () => {
    const a = await onShift(300, 300);
    await send(a, ago(295));
    await q(`UPDATE tracking_sessions SET ended_at = now(), state = 'SHIFT_COMPLETED', authorization_status = 'ENDED' WHERE id = $1`, [a.sessionId]);
    const w = await one(`SELECT worked_minutes FROM attendance_work WHERE attendance_id = $1`, [(await record(a.sessionId)).id]);
    expect(w.worked_minutes).toBeGreaterThan(200);
  });
});

describe('a shift ended without a connection', () => {
  const end = (a: { token: string; sessionId: string }, endedAt?: string) => request(app).post(`/api/v1/tracking/sessions/${a.sessionId}/end`).set(auth(a.token)).send(endedAt ? { endedAt } : {});

  it('ends when the employee ended it, audited', async () => {
    const a = await onShift(300, 300);
    await end(a, ago(60)).expect(200);
    const s = await session(a.sessionId);
    expect(Math.abs(new Date(s.ended_at).getTime() - Date.parse(ago(60)))).toBeLessThan(5000);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'session.end_offline' AND resource_id = $1`, [a.sessionId])).toHaveLength(1);
  });

  it('can be sent twice', async () => {
    const a = await onShift(300, 300);
    const at = ago(60);
    await end(a, at).expect(200);
    const first = (await session(a.sessionId)).ended_at;
    await end(a, at).expect(200);
    expect((await session(a.sessionId)).ended_at).toEqual(first);
  });

  it('corrects the automatic close to the real end time, and never moves it later', async () => {
    const a = await onShift(300, 300);
    await q(`UPDATE tracking_sessions SET ended_at = $2, state = 'SHIFT_COMPLETED', authorization_status = 'EXPIRED' WHERE id = $1`, [a.sessionId, ago(30)]);
    await end(a, ago(90)).expect(200);
    const s = await session(a.sessionId);
    expect(s.authorization_status).toBe('ENDED');
    expect(Math.abs(new Date(s.ended_at).getTime() - Date.parse(ago(90)))).toBeLessThan(5000);

    const b = await onShift(300, 300);
    const closed = ago(90);
    await q(`UPDATE tracking_sessions SET ended_at = $2, state = 'SHIFT_COMPLETED', authorization_status = 'EXPIRED' WHERE id = $1`, [b.sessionId, closed]);
    await end(b, ago(30)).expect(200);
    expect(new Date((await session(b.sessionId)).ended_at).toISOString()).toBe(new Date(closed).toISOString());
  });

  it('stays between the session start and now, whatever the phone clock says', async () => {
    const a = await onShift(120, 120);
    await end(a, DateTime.utc().plus({ hours: 5 }).toISO()!).expect(200);
    expect(new Date((await session(a.sessionId)).ended_at).getTime()).toBeLessThanOrEqual(Date.now());
    const b = await onShift(120, 120);
    await end(b, ago(600)).expect(200);
    const s = await session(b.sessionId);
    expect(new Date(s.ended_at).getTime()).toBe(new Date(s.started_at).getTime());
  });

  it('an administrator closing it first is not overwritten', async () => {
    const a = await onShift(300, 300);
    const closed = ago(30);
    await q(`UPDATE tracking_sessions SET ended_at = $2, state = 'SHIFT_COMPLETED', authorization_status = 'TERMINATED' WHERE id = $1`, [a.sessionId, closed]);
    await end(a, ago(90)).expect(200);
    const s = await session(a.sessionId);
    expect(s.authorization_status).toBe('TERMINATED');
    expect(new Date(s.ended_at).toISOString()).toBe(new Date(closed).toISOString());
  });
});

describe('location readings that arrive after the session closed', () => {
  const upload = (a: { token: string; sessionId: string }, readings: object[]) => request(app).post('/api/v1/tracking/locations').set(auth(a.token)).send({ sessionId: a.sessionId, source: 'BACKGROUND', readings });

  it('are kept as history if taken before it closed, and change nothing', async () => {
    const a = await onShift(300, 300);
    await q(`UPDATE tracking_sessions SET ended_at = $2, state = 'SHIFT_COMPLETED', authorization_status = 'EXPIRED' WHERE id = $1`, [a.sessionId, ago(30)]);
    const before = await session(a.sessionId);
    const r = evidence(ago(100));
    const res = await upload(a, [r, evidence(ago(10))]);
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.results.map((x: any) => [x.clientEventId, x.status]));
    expect(by[r.clientEventId]).toBe('ACCEPTED');
    expect(Object.values(by)).toContain('REJECTED');
    expect((await one(`SELECT validation_status FROM location_updates WHERE client_event_id = $1`, [r.clientEventId])).validation_status).toBe('HISTORICAL');
    expect(await session(a.sessionId)).toMatchObject({ state: before.state, ended_at: before.ended_at });
    expect((await upload(a, [r])).body.results[0].status).toBe('DUPLICATE');
  });
});

describe('a record sent late waits for a person', () => {
  const decide = (who: typeof owner, id: string, body: object) => who.agent.post(`/api/v1/attendance/${id}/verification`).set('X-CSRF-Token', who.csrf).send(body);
  async function late() {
    const a = await onShift();
    const at = ago(100);
    await send(a, at);
    return { ...a, at, id: (await record(a.sessionId)).id as string };
  }

  it('is never recorded as verified, and keeps what the phone sent', async () => {
    const a = await late();
    const r = await record(a.sessionId);
    expect(r.verification_status).toBe('PENDING_VERIFICATION');
    expect(new Date(r.evidence_client_time).toISOString()).toBe(new Date(a.at).toISOString());
    expect(r).toMatchObject({ evidence_latitude: WP.lat, evidence_longitude: WP.lng, evidence_accuracy_m: 8 });
    expect(r.device_meta.receivedAt).toBeTruthy();
    expect(r.photo_id).toBeTruthy();
  });

  it('keeps the device time as sent, even when the arrival was held to the session start', async () => {
    const a = await onShift(60, 180);
    const claimed = ago(61);
    await send(a, claimed);
    const r = await record(a.sessionId);
    expect(new Date(r.evidence_client_time).toISOString()).toBe(new Date(claimed).toISOString());
    expect(new Date(r.recorded_at).getTime()).toBeGreaterThan(new Date(r.evidence_client_time).getTime());
  });

  it('shows in the supervisor\'s approvals with its evidence, and counts provisionally', async () => {
    const a = await late();
    const list = (await sup.agent.get('/api/v1/approvals').expect(200)).body;
    const v = list.verifications.find((x: any) => x.id === a.id);
    expect(v.risk_flags).toContain('OFFLINE_CAPTURE');
    expect(v.received_at).toBeTruthy();
    expect(list.counts.verifications).toBeGreaterThanOrEqual(1);
    expect((await sup.agent.get('/api/v1/attendance?status=PENDING_VERIFICATION').expect(200)).body.items.some((x: any) => x.id === a.id)).toBe(true);
    expect(await q(`SELECT 1 FROM attendance_work WHERE attendance_id = $1`, [a.id])).toHaveLength(1);
  });

  it('a supervisor approves it: approved by a person, not verified by the server', async () => {
    const a = await late();
    await decide(sup, a.id, { decision: 'APPROVE' }).expect(400);
    await decide(sup, a.id, { decision: 'APPROVE', note: 'Gate register agrees' }).expect(200);
    const r = await record(a.sessionId);
    expect(r.verification_status).toBe('MANUAL_APPROVED');
    expect(r.approved_by).toBeTruthy();
    expect(r.risk_flags).toContain('OFFLINE_CAPTURE');
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'attendance.verify' AND resource_id = $1`, [a.id])).toHaveLength(1);
    expect((await one(`SELECT before_data FROM review_requests WHERE attendance_id = $1`, [a.id])).before_data.verification_status).toBe('PENDING_VERIFICATION');
    expect((await decide(sup, a.id, { decision: 'APPROVE', note: 'Twice' }).expect(409)).body.error.code).toBe('NOT_PENDING');
  });

  it('a supervisor rejects it with a reason: it stops counting, the evidence stays, the employee sees why', async () => {
    const a = await late();
    await decide(sup, a.id, { decision: 'REJECT', note: 'Was not on site' }).expect(200);
    const r = await record(a.sessionId);
    expect(r.verification_status).toBe('VOIDED');
    expect(r.risk_flags).toContain('VERIFICATION_REJECTED');
    expect((await one(`SELECT status FROM attendance_photos WHERE id = $1`, [r.photo_id])).status).toBe('ATTACHED');
    expect(await q(`SELECT 1 FROM attendance_work WHERE attendance_id = $1`, [a.id])).toHaveLength(0);
    const mine = (await request(app).get('/api/v1/me/attendance').set(auth(a.token)).expect(200)).body.attendance;
    expect(mine[0].rejection_note).toBe('Was not on site');
  });

  it('only an owner can bring a rejected one back, and it is never verified', async () => {
    const a = await late();
    await decide(sup, a.id, { decision: 'REJECT', note: 'Was not on site' }).expect(200);
    const override = (who: typeof owner) => who.agent.post(`/api/v1/faces/reviews/${a.id}/override`).set('X-CSRF-Token', who.csrf).send({ reason: 'Register shows they were here' });
    await override(sup).expect(403);
    await override(owner).expect(200);
    expect((await record(a.sessionId)).verification_status).toBe('CORRECTED');
  });

  it('nothing turns it into verified: not a correction, not a supervisor, not the database rule', async () => {
    const a = await late();
    expect((await owner.agent.post(`/api/v1/attendance/${a.id}/corrections`).set('X-CSRF-Token', owner.csrf).send({ reason: 'Just mark it fine', verificationStatus: 'VERIFIED' }).expect(409)).body.error.code).toBe('NEEDS_VERIFICATION');
    await owner.agent.post(`/api/v1/attendance/${a.id}/corrections`).set('X-CSRF-Token', owner.csrf).send({ reason: 'Bus strike that morning', isLate: false }).expect(200);
    expect((await record(a.sessionId)).verification_status).toBe('PENDING_VERIFICATION');
  });

  it('a supervisor of another site cannot decide it', async () => {
    const a = await late();
    const other = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, absence_threshold_minutes, org_id) VALUES ('Other', 1, 1, 100, 'UTC', 5, $1) RETURNING id`, [DEFAULT_ORG_ID]);
    const s2 = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) SELECT $1, password_hash, 'ADMIN', 'Elsewhere', org_id FROM users WHERE id = $2 RETURNING id, email`, [`sup-${crypto.randomUUID()}@test.local`, base.adminId]);
    await q(`INSERT INTO administrator_profiles (user_id, access, site_ids) VALUES ($1,'SUPERVISOR',$2)`, [s2.id, [other.id]]);
    await decide(await adminAgent(app, s2.email), a.id, { decision: 'APPROVE', note: 'Not my site' }).expect(404);
  });

  it('a shift end sent late puts a verified record back in front of a person, keeping the device time', async () => {
    const a = await onShift(300, 300);
    await q(`UPDATE tracking_sessions SET state = 'ATTENDANCE_READY' WHERE id = $1`, [a.sessionId]);
    const r = await one(
      `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status) VALUES ($1,$2,$3,$4,$5,$6,30,'VERIFIED') RETURNING id`,
      [a.emp.id, base.workplaceId, shiftId, a.sessionId, a.date, crypto.randomUUID()],
    );
    const sentTime = ago(60);
    await request(app).post(`/api/v1/tracking/sessions/${a.sessionId}/end`).set(auth(a.token)).send({ endedAt: sentTime }).expect(200);
    await request(app).post(`/api/v1/tracking/sessions/${a.sessionId}/end`).set(auth(a.token)).send({ endedAt: sentTime }).expect(200);
    const after = await one(`SELECT verification_status, risk_flags FROM attendance_records WHERE id = $1`, [r.id]);
    expect(after.verification_status).toBe('PENDING_VERIFICATION');
    expect(after.risk_flags.filter((f: string) => f === 'OFFLINE_END')).toHaveLength(1);
    expect((await one(`SELECT after_data FROM audit_logs WHERE action = 'session.end_offline' AND resource_id = $1`, [a.sessionId])).after_data.deviceTime).toBe(sentTime);
  });
});

describe('moving an employee to another shift', () => {
  it('applies from its effective date and leaves past attendance alone', async () => {
    const a = await onShift(60 * 24 * 3, 60 * 24 * 3);
    const day = DateTime.utc().minus({ days: 3 }).toISODate()!;
    await q(`INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, recorded_at, is_late, late_by_minutes) VALUES ($1,$2,$3,$4,$5,$6,30,'VERIFIED',$7,true,5)`, [a.emp.id, base.workplaceId, shiftId, a.sessionId, a.date, crypto.randomUUID(), ago(60 * 24 * 3 - 5)]);
    const old = await record(a.sessionId);
    await q(`UPDATE tracking_sessions SET ended_at = $2, state = 'SHIFT_COMPLETED', authorization_status = 'ENDED' WHERE id = $1`, [a.sessionId, ago(60 * 24 * 3 - 480)]);
    const work = await one(`SELECT worked_minutes, scheduled_minutes FROM attendance_work WHERE attendance_id = $1`, [old.id]);
    const month = day.slice(0, 7);
    const row = async () => (await owner.agent.get(`/api/v1/reports/monthly?month=${month}`).expect(200)).body.rows.find((x: any) => x.employee_id === a.emp.id);
    const before = await row();

    const night = await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,$2,'22:00','06:00','UTC',$3,5) RETURNING id`, [base.workplaceId, `Night ${crypto.randomUUID().slice(0, 6)}`, [1, 2, 3, 4, 5, 6, 7]]);
    const tomorrow = DateTime.utc().plus({ days: 1 }).toISODate()!;
    await q(`UPDATE employee_shift_assignments SET effective_to = $2 WHERE employee_id = $1`, [a.emp.id, DateTime.utc().toISODate()]);
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,$3)`, [a.emp.id, night.id, tomorrow]);

    const after = await record(a.sessionId);
    expect(after.shift_id).toBe(old.shift_id);
    expect(after.recorded_at).toEqual(old.recorded_at);
    expect(after.is_late).toBe(old.is_late);
    expect(after.late_by_minutes).toBe(old.late_by_minutes);
    expect(await one(`SELECT worked_minutes, scheduled_minutes FROM attendance_work WHERE attendance_id = $1`, [old.id])).toEqual(work);
    expect(await row()).toEqual(before);
    const roster = (d: string) => q(`SELECT shift_id FROM employee_shift_assignments WHERE employee_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)`, [a.emp.id, d]);
    expect((await roster(DateTime.utc().toISODate()!))[0].shift_id).toBe(shiftId);
    expect((await roster(tomorrow))[0].shift_id).toBe(night.id);
  });
});

describe('a rejected face check', () => {
  async function rejected() {
    const a = await onShift();
    await send(a, ago(100));
    const r = await record(a.sessionId);
    await q(`UPDATE attendance_records SET face_review = 'PENDING' WHERE id = $1`, [r.id]);
    return { ...a, id: r.id as string };
  }
  const reject = (id: string, note: string | undefined = 'Not the same person') => sup.agent.post(`/api/v1/faces/reviews/${id}`).set('X-CSRF-Token', sup.csrf).send({ decision: 'REJECT', note });
  const override = (who: typeof owner, id: string, reason?: string) => who.agent.post(`/api/v1/faces/reviews/${id}/override`).set('X-CSRF-Token', who.csrf).send({ reason });
  const roster = async (a: { date: string; emp: { id: string } }) => (await owner.agent.get(`/api/v1/reports/monthly?month=${a.date.slice(0, 7)}`).expect(200)).body.rows.find((x: any) => x.employee_id === a.emp.id);

  it('a supervisor rejects at once, with a reason, and it stops counting while the evidence stays', async () => {
    const a = await rejected();
    await sup.agent.post(`/api/v1/faces/reviews/${a.id}`).set('X-CSRF-Token', sup.csrf).send({ decision: 'REJECT' }).expect(400);
    await reject(a.id).expect(200);
    const r = await one(`SELECT verification_status, face_review, face_review_note, photo_id FROM attendance_records WHERE id = $1`, [a.id]);
    expect(r).toMatchObject({ verification_status: 'VOIDED', face_review: 'REJECTED', face_review_note: 'Not the same person' });
    expect((await one(`SELECT status FROM attendance_photos WHERE id = $1`, [r.photo_id])).status).toBe('ATTACHED');
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'face_review.reject' AND resource_id = $1`, [a.id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM attendance_work WHERE attendance_id = $1`, [a.id])).toHaveLength(0);
    expect((await roster(a))?.present ?? 0).toBe(0);
  });

  it('an owner can override it: it counts again and the whole story stays', async () => {
    const a = await rejected();
    await reject(a.id).expect(200);
    await override(owner, a.id).expect(400);
    await override(owner, a.id, 'Checked in person, it was them').expect(200);
    const r = await one(`SELECT verification_status, face_review, face_review_note FROM attendance_records WHERE id = $1`, [a.id]);
    expect(r).toMatchObject({ verification_status: 'CORRECTED', face_review: 'APPROVED' });
    expect(r.face_review_note).toContain('Checked in person');
    expect(await q(`SELECT 1 FROM attendance_work WHERE attendance_id = $1`, [a.id])).toHaveLength(1);
    expect((await roster(a)).present).toBe(1);
    const history = await one(`SELECT before_data, resolved_by FROM review_requests WHERE attendance_id = $1 AND reason LIKE 'Rejection overridden%'`, [a.id]);
    expect(history.before_data).toMatchObject({ verification_status: 'VOIDED', face_review: 'REJECTED', face_review_note: 'Not the same person' });
    expect(history.resolved_by).toBe(base.adminId);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'face_review.override' AND resource_id = $1`, [a.id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'face_review.reject' AND resource_id = $1`, [a.id])).toHaveLength(1);
  });

  it('a supervisor cannot override', async () => {
    const a = await rejected();
    await reject(a.id).expect(200);
    expect((await override(sup, a.id, 'I changed my mind').expect(403)).body.error.code).toBe('OWNER_ONLY');
    expect((await one(`SELECT verification_status FROM attendance_records WHERE id = $1`, [a.id])).verification_status).toBe('VOIDED');
  });

  it('only a rejected face check can be overridden; other voids stay final', async () => {
    const a = await onShift();
    await send(a, ago(100));
    const id = (await record(a.sessionId)).id;
    await owner.agent.post(`/api/v1/attendance/${id}/corrections`).set('X-CSRF-Token', owner.csrf).send({ reason: 'Fraud confirmed', verificationStatus: 'VOIDED' }).expect(200);
    expect((await override(owner, id, 'Try to lift this').expect(409)).body.error.code).toBe('NOT_FACE_REJECTED');
    await expect(q(`UPDATE attendance_records SET verification_status = 'VERIFIED' WHERE id = $1`, [id])).rejects.toThrow(/cannot be restored/);
  });

  it('outside the override transaction the database still refuses, even for a rejected face check', async () => {
    const a = await rejected();
    await reject(a.id).expect(200);
    await expect(q(`UPDATE attendance_records SET verification_status = 'VERIFIED' WHERE id = $1`, [a.id])).rejects.toThrow(/cannot be restored/);
  });

  it('the employee sees why', async () => {
    const a = await rejected();
    await reject(a.id).expect(200);
    const mine = (await request(app).get('/api/v1/me/attendance').set(auth(a.token)).expect(200)).body.attendance;
    expect(mine[0]).toMatchObject({ verification_status: 'VOIDED', face_review: 'REJECTED', face_review_note: 'Not the same person' });
  });
});
