/**
 * Development-only demo simulator (mounted only when DEMO_MODE=true, which is
 * refused in production). It acts on fictional demo employees only and drives
 * them through the SAME services as real devices: startSession, ingest via the
 * state-machine engine, createIntent/submitAttendance, the sweeper.
 *
 * Simulated sessions have their own virtual clock (sim_clock_offset_sec): to
 * satisfy a 60-second stabilisation window or a 10-minute absence threshold
 * the simulator advances that clock instead of making you wait. Every record
 * produced is flagged is_simulated and shown as SIMULATED in the dashboard.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { offsetMeters } from '@geoattend/shared';
import { one, q, tx } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { deleteObject, requestOrigin } from '../../lib/storage.js';
import { getSettings, orgOfUser } from '../settings/settings.service.js';
import { employeeAssignment, endSession, ingestReadings, reportPermissions, sessionStatus, startSession } from '../tracking/tracking.service.js';
import { createIntent, submitAttendance } from '../attendance/attendance.service.js';
import { sweepAbsences, sweepStale } from '../jobs/sweeper.js';
import { simulatedCapturePng } from './placeholder-image.js';

const POSITIONS = ['far', 'outside', 'boundary', 'inside', 'weak_gps'] as const;
type Position = (typeof POSITIONS)[number];

async function demoEmployee(id: string) {
  const u = await one(`SELECT id, full_name, is_demo, is_active FROM users WHERE id = $1 AND role = 'EMPLOYEE'`, [id]);
  if (!u) throw notFound('Employee');
  if (!u.is_demo) throw forbidden('The simulator only acts on demo employees.');
  return u;
}

async function openSimSession(employeeId: string) {
  const s = await one(`SELECT * FROM tracking_sessions WHERE employee_id = $1 AND ended_at IS NULL`, [employeeId]);
  if (!s) throw conflict('NO_OPEN_SESSION', 'Start the demo shift first.');
  if (!s.is_simulated) throw conflict('REAL_DEVICE_SESSION', 'This employee’s open session comes from a real device; the simulator will not inject locations into it.');
  return s;
}

const simNow = (s: { sim_clock_offset_sec: number }) => new Date(Date.now() + s.sim_clock_offset_sec * 1000);

async function advanceClock(sessionId: string, seconds: number) {
  const r = await one(`UPDATE tracking_sessions SET sim_clock_offset_sec = sim_clock_offset_sec + $2 WHERE id = $1 AND is_simulated RETURNING sim_clock_offset_sec`, [sessionId, Math.max(0, Math.round(seconds))]);
  return r?.sim_clock_offset_sec as number;
}

function placeFor(position: Position, wp: { lat: number; lng: number; radius: number }) {
  const bearing = Math.random() * 2 * Math.PI;
  const at = (d: number) => offsetMeters({ lat: wp.lat, lng: wp.lng }, d * Math.cos(bearing), d * Math.sin(bearing));
  switch (position) {
    case 'far':
      return { ...at(350 + Math.random() * 100), accuracyM: 12 };
    case 'outside':
      return { ...at(wp.radius + 30 + Math.random() * 20), accuracyM: 9 };
    case 'boundary':
      return { ...at(wp.radius - 2), accuracyM: 14 };
    case 'inside':
      return { ...at(wp.radius * 0.3 * Math.random()), accuracyM: 7 };
    case 'weak_gps':
      return { ...at(wp.radius * 0.3), accuracyM: 65 };
  }
}

/**
 * Sends `count` readings at one position, advancing the session's virtual clock
 * between them so that any configured stabilisation window is satisfied when hold=true.
 */
async function simulateMove(employeeId: string, position: Position, hold: boolean) {
  const s = await openSimSession(employeeId);
  const wp = await one('SELECT latitude, longitude, radius_m FROM workplaces WHERE id = $1', [s.workplace_id]);
  const t = (await getSettings(await orgOfUser(employeeId))).tracking;
  const count = hold ? Math.max(t.entryMinReadings, t.exitMinReadings, t.returnMinReadings, 2) : 1;
  const span = hold ? Math.max(t.entryStabilizationSec, t.exitStabilizationSec, t.returnStabilizationSec) : 0;
  const step = count > 1 ? Math.ceil(span / (count - 1)) + 1 : 0;
  const p = placeFor(position, { lat: wp.latitude, lng: wp.longitude, radius: Number(wp.radius_m) });
  let advanced = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      await advanceClock(s.id, step);
      advanced += step;
    } else {
      await advanceClock(s.id, 1); // never collide with the previous reading's timestamp
      advanced += 1;
    }
    const fresh = await one('SELECT sim_clock_offset_sec FROM tracking_sessions WHERE id = $1', [s.id]);
    // jitter each fix by up to 1.5 m, as a real receiver would
    const j = offsetMeters({ lat: p.lat, lng: p.lng }, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
    await ingestReadings(
      s.id,
      employeeId,
      [{ clientEventId: crypto.randomUUID(), latitude: j.lat, longitude: j.lng, accuracyM: p.accuracyM, clientTime: simNow(fresh).toISOString(), source: 'SIMULATOR' }],
      'SIMULATOR',
    );
  }
  return { advancedSec: advanced, readings: count };
}

export const demoRouter = Router();
mount(demoRouter, '/api/v1/demo', 'demo', [
  route({
    method: 'get',
    path: '/status',
    summary: 'Demo employees, their simulated sessions and recent simulated events',
    access: 'admin',
    ownerOnly: true,
    handler: async ({ user }) => {
      const emps = await q(
        `SELECT u.id, u.full_name, u.email, ep.employee_code FROM users u JOIN employee_profiles ep ON ep.user_id = u.id
         WHERE u.is_demo AND u.role = 'EMPLOYEE' AND u.is_active AND u.org_id = $1 ORDER BY ep.employee_code`,
        [user.orgId],
      );
      const employees = await Promise.all(
        emps.map(async (e) => {
          const { workplace, shifts } = await employeeAssignment(e.id);
          const open = await one('SELECT id FROM tracking_sessions WHERE employee_id = $1 AND ended_at IS NULL', [e.id]);
          const last = open ? null : await one('SELECT id FROM tracking_sessions WHERE employee_id = $1 ORDER BY started_at DESC LIMIT 1', [e.id]);
          return {
            ...e,
            workplace: workplace && { id: workplace.id, name: workplace.name, latitude: workplace.latitude, longitude: workplace.longitude, radiusM: Number(workplace.radius_m) },
            shift: shifts[0] ? { id: shifts[0].id, name: shifts[0].name } : null,
            status: open ? await sessionStatus(open.id) : last ? await sessionStatus(last.id) : null,
          };
        }),
      );
      const timeline = await q(
        `SELECT n.id, n.type, n.severity, n.title, n.body, n.created_at, u.full_name AS employee_name FROM notifications n LEFT JOIN users u ON u.id = n.employee_id
         WHERE n.is_simulated AND n.audience = 'ADMIN' AND n.org_id = $1 ORDER BY n.created_at DESC LIMIT 40`,
        [user.orgId],
      );
      return { demoMode: true, employees, timeline, positions: POSITIONS };
    },
  }),
  route({
    method: 'post',
    path: '/employees/:id/start-shift',
    summary: 'Start the demo employee’s shift (permissions reported as granted)',
    access: 'admin',
    ownerOnly: true,
    params: z.object({ id: z.uuid() }),
    scope: 'employee',
    handler: async ({ params }) => {
      await demoEmployee(params.id);
      const { shifts } = await employeeAssignment(params.id);
      if (!shifts[0]) throw badRequest('NO_SHIFT', 'The demo employee has no shift assigned.');
      const s = await startSession(params.id, shifts[0].id, 'demo-simulator', 'SIMULATOR');
      await reportPermissions(s.id, params.id, { foreground: 'granted', background: 'granted', locationServicesEnabled: true, precise: true, deviceId: 'demo-simulator' }, 'SIMULATOR');
      return sessionStatus(s.id);
    },
  }),
  route({
    method: 'post',
    path: '/employees/:id/move',
    summary: 'Send simulated location reading(s) through the live engine',
    access: 'admin',
    ownerOnly: true,
    params: z.object({ id: z.uuid() }),
    scope: 'employee',
    body: z.object({ position: z.enum(POSITIONS), hold: z.boolean().default(true) }),
    handler: async ({ params, body }) => {
      await demoEmployee(params.id);
      const r = await simulateMove(params.id, body.position, body.hold);
      const s = await openSimSession(params.id).catch(() => null);
      return { ...r, status: s ? await sessionStatus(s.id) : null };
    },
  }),
  route({
    method: 'post',
    path: '/employees/:id/attendance',
    summary: 'Simulate a successful camera capture + attendance submission (synthetic image, flagged SIMULATED)',
    access: 'admin',
    ownerOnly: true,
    params: z.object({ id: z.uuid() }),
    scope: 'employee',
    handler: async ({ params, req }) => {
      await demoEmployee(params.id);
      const s = await openSimSession(params.id);
      if (s.state !== 'ATTENDANCE_READY' && s.state !== 'ATTENDANCE_SUBMISSION_PENDING') {
        throw conflict('ATTENDANCE_LOCKED', `Attendance is locked in state ${s.state}. Move the employee inside first — the simulator obeys the same rules as the app.`);
      }
      const png = simulatedCapturePng();
      const intent = await createIntent(params.id, { sessionId: s.id, idempotencyKey: `sim-${crypto.randomUUID()}`, contentType: 'image/png', sizeBytes: png.length }, requestOrigin(req), 'SIMULATOR');
      const put = await fetch(intent.upload.url, { method: 'PUT', headers: intent.upload.headers, body: new Uint8Array(png) });
      if (!put.ok) throw badRequest('UPLOAD_FAILED', `Simulated upload failed (${put.status}).`);
      const fresh = await one('SELECT * FROM tracking_sessions WHERE id = $1', [s.id]);
      const now = new Date(Date.now() + (fresh.sim_clock_offset_sec + 1) * 1000);
      await advanceClock(s.id, 1);
      const jitter = offsetMeters({ lat: fresh.last_latitude, lng: fresh.last_longitude }, 0.5, 0.5);
      const res = await submitAttendance(
        params.id,
        {
          sessionId: s.id,
          photoId: intent.photoId,
          idempotencyKey: `sim-${crypto.randomUUID()}`,
          evidence: { clientEventId: crypto.randomUUID(), latitude: jitter.lat, longitude: jitter.lng, accuracyM: fresh.last_accuracy_m ?? 8, clientTime: now.toISOString() },
          device: { simulator: true },
        },
        'SIMULATOR',
      );
      return { attendance: res.record, status: await sessionStatus(s.id) };
    },
  }),
  route({
    method: 'post',
    path: '/employees/:id/advance',
    summary: 'Advance the simulated session clock (e.g. to pass the absence threshold) and run the sweeper',
    access: 'admin',
    ownerOnly: true,
    params: z.object({ id: z.uuid() }),
    scope: 'employee',
    body: z.object({ minutes: z.number().int().min(1).max(240) }),
    handler: async ({ params, body, user }) => {
      await demoEmployee(params.id);
      const s = await openSimSession(params.id);
      if (s.last_latitude == null) throw conflict('NO_POSITION', 'Move the employee somewhere first.');
      // Time passes with the device still reporting from where it is (as a working phone would),
      // so the sweeper sees a live device and applies the absence threshold at the right moment.
      const { tracking } = await getSettings(user.orgId);
      const step = Math.max(30, Math.min(120, Math.floor(tracking.staleAfterSec / 2)));
      let remaining = body.minutes * 60;
      while (remaining > 0) {
        const dt = Math.min(step, remaining);
        remaining -= dt;
        const cur = await one('SELECT * FROM tracking_sessions WHERE id = $1', [s.id]);
        if (cur.ended_at) break;
        await advanceClock(s.id, dt);
        const p = offsetMeters({ lat: cur.last_latitude, lng: cur.last_longitude }, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2);
        await ingestReadings(
          s.id,
          params.id,
          [{ clientEventId: crypto.randomUUID(), latitude: p.lat, longitude: p.lng, accuracyM: cur.last_accuracy_m ?? 10, clientTime: new Date(Date.now() + (cur.sim_clock_offset_sec + dt) * 1000).toISOString(), source: 'SIMULATOR' }],
          'SIMULATOR',
        );
        await sweepAbsences();
      }
      return sessionStatus(s.id);
    },
  }),
  route({
    method: 'post',
    path: '/employees/:id/interrupt',
    summary: 'Simulate the device going silent beyond the stale timeout',
    access: 'admin',
    ownerOnly: true,
    params: z.object({ id: z.uuid() }),
    scope: 'employee',
    handler: async ({ params, user }) => {
      await demoEmployee(params.id);
      const s = await openSimSession(params.id);
      const { tracking } = await getSettings(user.orgId);
      await advanceClock(s.id, tracking.staleAfterSec + 5);
      await sweepStale();
      return sessionStatus(s.id);
    },
  }),
  route({
    method: 'post',
    path: '/employees/:id/revoke-permission',
    summary: 'Simulate the employee revoking location permission',
    access: 'admin',
    ownerOnly: true,
    params: z.object({ id: z.uuid() }),
    scope: 'employee',
    handler: async ({ params }) => {
      await demoEmployee(params.id);
      const s = await openSimSession(params.id);
      await reportPermissions(s.id, params.id, { foreground: 'denied', background: 'denied', locationServicesEnabled: true, deviceId: 'demo-simulator' }, 'SIMULATOR');
      return sessionStatus(s.id);
    },
  }),
  route({
    method: 'post',
    path: '/employees/:id/restore-permission',
    summary: 'Simulate the employee granting location permission again',
    access: 'admin',
    ownerOnly: true,
    params: z.object({ id: z.uuid() }),
    scope: 'employee',
    handler: async ({ params }) => {
      await demoEmployee(params.id);
      const s = await openSimSession(params.id);
      await reportPermissions(s.id, params.id, { foreground: 'granted', background: 'granted', locationServicesEnabled: true, deviceId: 'demo-simulator' }, 'SIMULATOR');
      return sessionStatus(s.id);
    },
  }),
  route({
    method: 'post',
    path: '/employees/:id/end-shift',
    summary: 'End the simulated shift (stops simulated tracking)',
    access: 'admin',
    ownerOnly: true,
    params: z.object({ id: z.uuid() }),
    scope: 'employee',
    handler: async ({ params }) => {
      await demoEmployee(params.id);
      const s = await openSimSession(params.id);
      await endSession(s.id, { id: params.id, role: 'EMPLOYEE' }, 'SIMULATOR');
      return sessionStatus(s.id);
    },
  }),
  route({
    method: 'post',
    path: '/reset',
    summary: 'Delete all data generated for demo employees so the demo can be replayed',
    access: 'admin',
    ownerOnly: true,
    handler: async ({ user, req }) => {
      const photos = await q(`SELECT p.object_key FROM attendance_photos p JOIN users u ON u.id = p.employee_id WHERE u.is_demo AND u.org_id = $1`, [user.orgId]);
      const counts = await tx(async (db) => {
        // Demo employees of this company only ($1 = the admin's company).
        const demo = `(SELECT id FROM users WHERE is_demo AND org_id = $1)`;
        const sessions = `(SELECT id FROM tracking_sessions WHERE employee_id IN ${demo})`;
        const org = [user.orgId];
        await q(`DELETE FROM notifications WHERE (is_simulated AND org_id = $1) OR employee_id IN ${demo} OR session_id IN ${sessions}`, org, db);
        await q(`DELETE FROM review_requests WHERE employee_id IN ${demo}`, org, db);
        await q(`DELETE FROM leave_requests WHERE employee_id IN ${demo}`, org, db);
        await q(`DELETE FROM employee_faces WHERE employee_id IN ${demo}`, org, db);
        const att = await q(`DELETE FROM attendance_records WHERE employee_id IN ${demo} RETURNING id`, org, db);
        await q(`DELETE FROM session_breaks WHERE employee_id IN ${demo}`, org, db);
        await q(`DELETE FROM attendance_photos WHERE employee_id IN ${demo}`, org, db);
        await q(`DELETE FROM permission_status_events WHERE employee_id IN ${demo}`, org, db);
        await q(`DELETE FROM absence_intervals WHERE employee_id IN ${demo}`, org, db);
        await q(`DELETE FROM geofence_events WHERE employee_id IN ${demo}`, org, db);
        await q(`DELETE FROM location_updates WHERE employee_id IN ${demo}`, org, db);
        const ses = await q(`DELETE FROM tracking_sessions WHERE employee_id IN ${demo} RETURNING id`, org, db);
        await audit({ actor: user, action: 'demo.reset', resourceType: 'demo', after: { sessions: ses.length, attendance: att.length }, req }, db);
        return { sessions: ses.length, attendance: att.length };
      });
      for (const p of photos) await deleteObject(p.object_key).catch(() => undefined);
      return counts;
    },
  }),
]);
