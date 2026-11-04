/**
 * The phone's real sync engine against the real API. Only the phone's storage and radio are stand-ins:
 * storage is JSON text that survives a "restart", and the network can be switched off, or can lose the
 * server's answer after the server acted. This is not a substitute for testing on real phones.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { createEmployee, createTestDatabase, fakeJpeg, mobileLogin, seedBase, WP } from './helpers.js';
// @ts-ignore  The phone's code, shared as source; checked by the mobile app's own typecheck.
import { addEvent, emptyOutbox, flushReadings, runOutbox } from '../../mobile/src/lib/sync/engine.ts';
// @ts-ignore
import { emptyQueue, enqueue, toWire } from '../../mobile/src/lib/tracking/queue-core.ts';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
let shiftId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
  shiftId = (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'Day','09:00','17:00','UTC',$2,10) RETURNING id`, [base.workplaceId, [1, 2, 3, 4, 5, 6, 7]])).id;
});
afterAll(async () => {
  await db.drop();
});

const ago = (minutes: number) => DateTime.utc().minus({ minutes }).toISO()!;
const offlineError = { status: 0, code: 'NETWORK_ERROR', message: 'Cannot reach the server.' };

/** A phone: what is on its disk, its radio, and its sign-in. Disk contents outlive `restart()`. */
function phone(userId: string, token: string) {
  const disk = { outbox: JSON.stringify(emptyOutbox()), queue: JSON.stringify(emptyQueue()) };
  const p = {
    online: false,
    /** Lose the server's answer on the next request, after the server has acted on it. */
    loseNextAnswer: false,
    token,
    requests: 0,
    disk,
    now: Date.now(),
    async call(method: 'post' | 'put', url: string, send: (r: request.Test) => request.Test) {
      if (!p.online) throw offlineError;
      p.requests++;
      const res = await send(request(app)[method](url));
      if (p.loseNextAnswer) {
        p.loseNextAnswer = false;
        throw offlineError;
      }
      if (res.status >= 400) throw { status: res.status, code: res.body?.error?.code ?? `HTTP_${res.status}`, message: res.body?.error?.message ?? 'failed' };
      return res.body;
    },
    api: (path: string, body: object) => p.call('post', `/api/v1${path}`, (r) => r.set({ Authorization: `Bearer ${p.token}` }).send(body)),
    outbox() {
      return {
        update: async (fn: (s: any) => any) => {
          const next = fn(JSON.parse(disk.outbox));
          disk.outbox = JSON.stringify(next);
          return next;
        },
        userId: async () => userId,
        now: () => p.now,
        send: async (e: any, progress: (x: any) => Promise<void>) => {
          if (e.kind === 'CHECK_OUT') {
            await p.api(`/tracking/sessions/${e.sessionId}/end`, { endedAt: e.checkOut.endedAt });
            return;
          }
          let { photoId, uploaded } = e;
          if (!photoId || !uploaded) {
            const img = fakeJpeg();
            const intent = await p.api('/attendance/intents', { sessionId: e.sessionId, idempotencyKey: e.id, contentType: 'image/jpeg', sizeBytes: img.length, capturedOffline: true });
            const u = new URL(intent.upload.url);
            await p.call('put', u.pathname + u.search, (r) => r.set('Content-Type', 'image/jpeg').send(img));
            photoId = intent.photoId;
            uploaded = true;
            await progress({ photoId, uploaded });
          }
          await p.api('/attendance', { sessionId: e.sessionId, photoId, idempotencyKey: e.id, evidence: e.checkIn.evidence, device: {}, capturedOffline: true });
        },
      };
    },
    readings() {
      return {
        update: async (fn: (s: any) => any) => {
          const next = fn(JSON.parse(disk.queue));
          disk.queue = JSON.stringify(next);
          return next;
        },
        userId: async () => userId,
        post: (b: any) => p.api('/tracking/locations', { sessionId: b.sessionId, source: b.source, readings: b.readings.map(toWire) }),
      };
    },
    /** What the app does on reconnect. */
    async sync() {
      const a = await flushReadings(p.readings());
      const b = await runOutbox(p.outbox());
      return { readings: a, outbox: b };
    },
    later(minutes: number) {
      p.now += minutes * 60_000;
    },
    events: () => JSON.parse(disk.outbox).events,
    queued: () => JSON.parse(disk.queue).items,
  };
  return p;
}

async function shift(minutes = 240) {
  const emp = await createEmployee({ workplaceId: base.workplaceId });
  await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2020-01-01')`, [emp.id, shiftId]);
  const token = await mobileLogin(app, emp.email);
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,'TRACKING_ACTIVE',$5) RETURNING id`,
    [emp.id, shiftId, base.workplaceId, DateTime.utc().minus({ minutes }).toISODate(), ago(minutes), DateTime.utc().plus({ hours: 4 }).toISO()],
  );
  return { emp, token, sessionId: s.id as string, phone: phone(emp.id, token) };
}
const reading = (sessionId: string, userId: string, at: string) => ({ clientEventId: crypto.randomUUID(), sessionId, userId, latitude: WP.lat, longitude: WP.lng, accuracyM: 8, clientTime: at, source: 'BACKGROUND' as const });
const checkIn = (sessionId: string, userId: string, at: string) => ({
  id: `att-${crypto.randomUUID()}`, kind: 'CHECK_IN' as const, userId, sessionId, shiftName: 'Day', capturedAt: at,
  checkIn: { photoUri: 'file:///x.jpg', sizeBytes: 100, evidence: { clientEventId: crypto.randomUUID(), latitude: WP.lat, longitude: WP.lng, accuracyM: 8, clientTime: at }, device: {} },
});
const checkOut = (sessionId: string, userId: string, at: string) => ({ id: `end-${crypto.randomUUID()}`, kind: 'CHECK_OUT' as const, userId, sessionId, shiftName: 'Day', capturedAt: at, checkOut: { endedAt: at } });
const records = (sessionId: string) => q(`SELECT * FROM attendance_records WHERE session_id = $1`, [sessionId]);

describe('a working day without a connection', () => {
  it('reaches the server once the connection returns, with the times it happened', async () => {
    const s = await shift();
    const p = s.phone;
    const arrive = ago(230);
    const leave = ago(20);
    await p.readings().update((st: any) => enqueue(st, [reading(s.sessionId, s.emp.id, ago(235)), reading(s.sessionId, s.emp.id, ago(100))], 2000));
    await p.outbox().update((st: any) => addEvent(addEvent(st, checkIn(s.sessionId, s.emp.id, arrive)), checkOut(s.sessionId, s.emp.id, leave)));

    // Nothing gets through, nothing is lost.
    const off = await p.sync();
    expect(off.outbox.stopped).toBe('offline');
    expect(p.queued()).toHaveLength(2);
    expect(p.events().map((e: any) => e.status)).toEqual(['PENDING', 'PENDING']);
    expect(await records(s.sessionId)).toHaveLength(0);

    // The connection returns.
    p.online = true;
    p.later(60);
    const on = await p.sync();
    expect(on.readings.sent).toBe(2);
    expect(on.outbox.sent).toBe(2);
    expect(p.queued()).toHaveLength(0);
    expect(p.events().map((e: any) => e.status)).toEqual(['SYNCED', 'SYNCED']);

    const [r] = await records(s.sessionId);
    expect(r.risk_flags).toContain('OFFLINE_CAPTURE');
    expect(Math.abs(new Date(r.recorded_at).getTime() - Date.parse(arrive))).toBeLessThan(1000);
    const sess = await one(`SELECT ended_at, state FROM tracking_sessions WHERE id = $1`, [s.sessionId]);
    expect(Math.abs(new Date(sess.ended_at).getTime() - Date.parse(leave))).toBeLessThan(1000);
    expect(sess.state).toBe('SHIFT_COMPLETED');
    const w = await one(`SELECT worked_minutes FROM attendance_work WHERE attendance_id = $1`, [r.id]);
    expect(w.worked_minutes).toBeGreaterThan(200);
    expect((await one(`SELECT count(*)::int n FROM location_updates WHERE session_id = $1`, [s.sessionId])).n).toBeGreaterThanOrEqual(2);
  });

  it('survives the app being killed halfway through sending', async () => {
    const s = await shift();
    const p = s.phone;
    await p.outbox().update((st: any) => addEvent(st, checkIn(s.sessionId, s.emp.id, ago(200))));
    p.online = true;
    // The radio dies right after the photo reached the server.
    const send = p.outbox().send;
    await runOutbox({
      ...p.outbox(),
      send: async (e: any, progress: any) => {
        await send(e, async (x: any) => {
          await progress(x);
          p.online = false;
        });
      },
    });
    expect(await records(s.sessionId)).toHaveLength(0);
    const saved = p.events()[0];
    expect(saved).toMatchObject({ status: 'PENDING', uploaded: true });

    // A new app process: only the disk carries over.
    const after = phone(s.emp.id, s.token);
    after.disk.outbox = p.disk.outbox;
    after.online = true;
    after.now = saved.nextAttemptAt + 1;
    const r = await after.sync();
    expect(r.outbox.sent).toBe(1);
    expect(await records(s.sessionId)).toHaveLength(1);
  });

  it('counts once when the answer is lost after the server recorded it', async () => {
    const s = await shift();
    const p = s.phone;
    await p.readings().update((st: any) => enqueue(st, [reading(s.sessionId, s.emp.id, ago(150))], 2000));
    p.online = true;
    p.loseNextAnswer = true;
    await flushReadings(p.readings());
    expect(p.queued()).toHaveLength(1); // the phone cannot know it arrived, so it keeps it
    await flushReadings(p.readings());
    expect(p.queued()).toHaveLength(0);
    expect((await one(`SELECT count(*)::int n FROM location_updates WHERE session_id = $1`, [s.sessionId])).n).toBe(1);

    await p.outbox().update((st: any) => addEvent(st, checkIn(s.sessionId, s.emp.id, ago(200))));
    const send = p.outbox().send;
    await runOutbox({
      ...p.outbox(),
      send: async (e: any, progress: any) => {
        await send(e, async (x: any) => {
          await progress(x);
          p.loseNextAnswer = true; // the submit that follows reaches the server, its answer does not reach the phone
        });
      },
    });
    expect(await records(s.sessionId)).toHaveLength(1);
    expect(p.events()[0].status).toBe('PENDING');
    p.later(5);
    const r = await runOutbox(p.outbox());
    expect(r.sent).toBe(1);
    expect(p.events()[0].status).toBe('SYNCED');
    expect(await records(s.sessionId)).toHaveLength(1);
  });

  it('an expired sign-in loses nothing, and everything goes after signing in again', async () => {
    const s = await shift();
    const p = s.phone;
    await p.readings().update((st: any) => enqueue(st, [reading(s.sessionId, s.emp.id, ago(150))], 2000));
    await p.outbox().update((st: any) => addEvent(st, checkIn(s.sessionId, s.emp.id, ago(200))));
    p.online = true;
    p.token = 'expired-or-revoked';
    const r = await p.sync();
    expect(r.readings.stopped).toBe('signed-out');
    expect(r.outbox.stopped).toBe('signed-out');
    expect(p.queued()).toHaveLength(1);
    expect(p.events()[0].status).toBe('PENDING');

    p.token = await mobileLogin(app, s.emp.email);
    const again = await p.sync();
    expect(again.readings.sent).toBe(1);
    expect(again.outbox.sent).toBe(1);
    expect(await records(s.sessionId)).toHaveLength(1);
  });

  it('a refusal stays on the phone with the reason, and the shift end still goes', async () => {
    const s = await shift();
    const p = s.phone;
    const far = checkIn(s.sessionId, s.emp.id, ago(200));
    far.checkIn.evidence.latitude = WP.lat + 0.05;
    await p.outbox().update((st: any) => addEvent(addEvent(st, far), checkOut(s.sessionId, s.emp.id, ago(20))));
    p.online = true;
    await p.sync();
    const [a, b] = p.events();
    expect(a).toMatchObject({ status: 'FAILED', failureCode: 'EVIDENCE_NOT_INSIDE' });
    expect(a.lastError).toBeTruthy();
    expect(b.status).toBe('SYNCED');
    expect(await records(s.sessionId)).toHaveLength(0);
  });

  it('readings from a shift the server already closed are kept', async () => {
    const s = await shift(300);
    const p = s.phone;
    await q(`UPDATE tracking_sessions SET ended_at = $2, state = 'SHIFT_COMPLETED', authorization_status = 'EXPIRED' WHERE id = $1`, [s.sessionId, ago(30)]);
    await p.readings().update((st: any) => enqueue(st, [reading(s.sessionId, s.emp.id, ago(200))], 2000));
    p.online = true;
    await flushReadings(p.readings());
    expect(p.queued()).toHaveLength(0);
    expect((await one(`SELECT count(*)::int n FROM location_updates WHERE session_id = $1`, [s.sessionId])).n).toBe(1);
  });
});
