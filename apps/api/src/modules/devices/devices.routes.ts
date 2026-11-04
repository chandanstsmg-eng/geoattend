/**
 * One approved phone per employee.
 *
 * At mobile sign-in (after the password is verified) `checkDeviceAtLogin` decides:
 *  - the employee's approved phone            → allowed
 *  - any other phone, including their first   → PENDING; an owner or supervisor approves it
 *  - a phone approved for another employee    → refused (shared phone / buddy punching)
 * No phone is ever approved without a person deciding. `assertApprovedDevice` repeats the check on
 * attendance actions, against the phone named in the access token, so a phone removed mid-shift stops
 * working at once. Every status change is kept in device_status_history (a database trigger).
 * Settings › workforce.deviceBinding: ENFORCE refuses, ALERT only notifies, OFF skips the check.
 * Demo accounts are exempt so one test phone can sign in as several demo employees.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { getPool, one, q, tx } from '../../db/pool.js';
import { HttpError, conflict, notFound } from '../../lib/errors.js';
import { idParams, mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { employeeSite, siteFilter } from '../../lib/tenancy.js';
import { getSettings } from '../settings/settings.service.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';

export type Platform = 'android' | 'ios' | 'web' | 'simulator' | 'unknown';

export async function checkDeviceAtLogin(u: { id: string; full_name: string; is_demo: boolean; org_id: string }, deviceId: string | undefined, platform: Platform, model: string | undefined) {
  const { workforce } = await getSettings(u.org_id);
  if (workforce.deviceBinding === 'OFF' || u.is_demo) return;
  const enforce = workforce.deviceBinding === 'ENFORCE';
  if (!deviceId) {
    if (enforce) throw new HttpError(403, 'DEVICE_REQUIRED', 'Please update the GeoAttend app to sign in.');
    return;
  }
  const outbox = new Outbox();
  try {
    const sharedWith = await one(
      `SELECT u.id, u.full_name FROM device_registrations d JOIN users u ON u.id = d.user_id
       WHERE d.device_id = $1 AND d.status = 'APPROVED' AND d.user_id <> $2 AND u.role = 'EMPLOYEE' AND u.is_active AND NOT u.is_demo AND u.org_id = $3 LIMIT 1`,
      [deviceId, u.id, u.org_id],
    );
    if (sharedWith) {
      await notify(getPool(), outbox, {
        type: 'SHARED_DEVICE',
        severity: 'CRITICAL',
        body: `${u.full_name} tried to sign in on the phone registered to ${sharedWith.full_name}. ${enforce ? 'The sign-in was refused.' : 'The sign-in was allowed (alert-only mode).'} One person marking attendance for another usually looks like this.`,
        employeeId: u.id,
        data: { deviceId, registeredTo: sharedWith.id },
        dedupeKey: `shared-device:${u.id}:${deviceId}:${new Date().toISOString().slice(0, 10)}`,
      });
      if (enforce) throw new HttpError(403, 'DEVICE_IN_USE', 'This phone is registered to another employee. Each person must sign in on their own phone.');
      return;
    }

    const own = await one('SELECT * FROM device_registrations WHERE user_id = $1 AND device_id = $2', [u.id, deviceId]);
    if (own?.status === 'APPROVED') return;
    if (own?.status === 'REVOKED') {
      if (enforce) throw new HttpError(403, 'DEVICE_REVOKED', 'This phone has been removed from your account. Ask your administrator.');
      return;
    }
    const reg = await one(
      `INSERT INTO device_registrations (user_id, device_id, platform, model_hint, status) VALUES ($1,$2,$3,$4,'PENDING')
       ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen_at = now(), platform = EXCLUDED.platform, model_hint = COALESCE(EXCLUDED.model_hint, device_registrations.model_hint)
       RETURNING id, status`,
      [u.id, deviceId, platform, model ?? null],
    );
    await notify(getPool(), outbox, {
      type: 'NEW_DEVICE',
      severity: 'WARNING',
      body: `${u.full_name} is signing in on a new ${platform === 'unknown' ? 'phone' : platform + ' phone'}${model ? ` (${model})` : ''}. Approve it in Approvals if they changed phones; otherwise reject it.`,
      employeeId: u.id,
      data: { deviceRegistrationId: reg.id, deviceId },
      dedupeKey: `new-device:${reg.id}`,
    });
    if (enforce) throw new HttpError(403, 'DEVICE_PENDING', 'This phone is not approved yet. Your administrator has been asked to approve it. Try again after they do.');
  } finally {
    outbox.flush();
  }
}

/** On attendance actions: the phone in the access token must still be approved. */
export async function assertApprovedDevice(user: { id: string; orgId: string; isDemo: boolean; deviceId?: string | null }) {
  const { workforce } = await getSettings(user.orgId);
  if (workforce.deviceBinding !== 'ENFORCE' || user.isDemo) return;
  if (!user.deviceId) throw new HttpError(403, 'DEVICE_REQUIRED', 'Sign in again to continue.');
  const d = await one('SELECT status FROM device_registrations WHERE user_id = $1 AND device_id = $2', [user.id, user.deviceId]);
  if (d?.status !== 'APPROVED') throw new HttpError(403, 'DEVICE_NOT_APPROVED', 'This phone is not approved for your account. Ask your administrator.');
}

const SELECT = `
  SELECT d.id, d.user_id, d.device_id, d.platform, COALESCE(d.model, d.model_hint) AS model, d.os_version, d.app_version, d.status, d.status_note,
         d.last_seen_at, d.created_at, d.decided_at, u.full_name, ep.employee_code, db.full_name AS decided_by_name,
         (SELECT json_build_object('model', COALESCE(o.model, o.model_hint), 'platform', o.platform, 'lastSeenAt', o.last_seen_at)
            FROM device_registrations o WHERE o.user_id = d.user_id AND o.status = 'APPROVED' AND o.id <> d.id ORDER BY o.last_seen_at DESC LIMIT 1) AS current_phone
  FROM device_registrations d JOIN users u ON u.id = d.user_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id LEFT JOIN users db ON db.id = d.decided_by`;

async function decide(id: string, status: 'APPROVED' | 'REVOKED', note: string | undefined, admin: any, req: Request) {
  return tx(async (db) => {
    const d = await one('SELECT * FROM device_registrations WHERE id = $1 FOR UPDATE', [id], db);
    if (!d) throw notFound('Phone');
    if (status === 'APPROVED') {
      const other = await one(
        `SELECT u.full_name FROM device_registrations x JOIN users u ON u.id = x.user_id
         WHERE x.device_id = $1 AND x.status = 'APPROVED' AND x.user_id <> $2 AND u.is_active AND NOT u.is_demo AND u.org_id = $3 LIMIT 1`,
        [d.device_id, d.user_id, admin.orgId],
        db,
      );
      if (other) throw conflict('DEVICE_IN_USE', `This phone is approved for ${other.full_name}. Remove it from their account first.`);
      // One phone per employee: approving a new phone retires the old one and signs it out.
      const old = await q(`UPDATE device_registrations SET status = 'REVOKED', decided_by = $2, decided_at = now(), status_note = 'Replaced by a newer phone' WHERE user_id = $1 AND status = 'APPROVED' AND id <> $3 RETURNING device_id`, [d.user_id, admin.id, id], db);
      for (const o of old) await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`, [d.user_id, o.device_id], db);
    } else {
      await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`, [d.user_id, d.device_id], db);
    }
    await q(`UPDATE device_registrations SET status = $2, decided_by = $3, decided_at = now(), status_note = $4 WHERE id = $1`, [id, status, admin.id, note ?? null], db);
    await audit({ actor: admin, action: status === 'APPROVED' ? 'device.approve' : 'device.revoke', resourceType: 'device', resourceId: id, before: { status: d.status }, after: { status }, reason: note, req }, db);
    return one(`${SELECT} WHERE d.id = $1`, [id], db);
  });
}

export const devicesRouter = Router();
mount(devicesRouter, '/api/v1/devices', 'devices', [
  route({
    method: 'get',
    path: '/',
    summary: 'Registered phones (filter by status or employee)',
    access: 'admin',
    query: z.object({ status: z.enum(['APPROVED', 'PENDING', 'REVOKED']).optional(), employeeId: z.uuid().optional() }),
    handler: async ({ query, user }) =>
      q(`${SELECT} WHERE u.org_id = $3 AND ${siteFilter(employeeSite('u.id'), '$4')} AND ($1::text IS NULL OR d.status = $1) AND ($2::uuid IS NULL OR d.user_id = $2) AND u.role = 'EMPLOYEE' ORDER BY (d.status = 'PENDING') DESC, d.last_seen_at DESC LIMIT 200`, [query.status ?? null, query.employeeId ?? null, user.orgId, user.sites]),
  }),
  route({
    method: 'post',
    path: '/:id/approve',
    summary: "Approve a phone (the employee's previous phone is removed and signed out)",
    access: 'admin',
    params: idParams,
    scope: 'device',
    body: z.object({ note: z.string().trim().max(500).optional() }),
    handler: async ({ params, body, user, req }) => decide(params.id, 'APPROVED', body.note, user, req),
  }),
  route({
    method: 'get',
    path: '/:id/history',
    summary: 'Every status change of a phone, oldest first',
    access: 'admin',
    params: idParams,
    scope: 'device',
    handler: async ({ params }) =>
      q(`SELECT h.id, h.from_status, h.to_status, h.note, h.created_at, u.full_name AS changed_by_name FROM device_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.device_id = $1 ORDER BY h.id`, [params.id]),
  }),
  route({
    method: 'post',
    path: '/:id/revoke',
    summary: 'Reject a pending phone or remove an approved one (signs it out)',
    access: 'admin',
    params: idParams,
    scope: 'device',
    body: z.object({ note: z.string().trim().max(500).optional() }),
    handler: async ({ params, body, user, req }) => decide(params.id, 'REVOKED', body.note, user, req),
  }),
]);
