/**
 * SOS for people working alone (security guards, field technicians, night shifts).
 * One press in the app sends the employee's location to their administrators as a
 * CRITICAL alert (in-app, browser push, e-mail). Pressing again while it is open
 * updates the location instead of creating a new alert.
 *
 * Broadcasts: a message to everyone in the company or one workplace, with read receipts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getPool, one, q, tx } from '../../db/pool.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { idParams, mount, route } from '../../lib/http.js';
import type { AuthUser } from '../../lib/auth.js';
import { getSettings } from '../settings/settings.service.js';
import { audit } from '../../lib/audit.js';
import { assertInOrg, employeeSite, siteFilter } from '../../lib/tenancy.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';

const location = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracyM: z.number().positive().max(5000) });

const SOS_SELECT = `
  SELECT s.*, u.full_name, ep.employee_code, ep.phone AS employee_phone, w.name AS workplace_name,
         ab.full_name AS acknowledged_by_name, rb.full_name AS resolved_by_name
  FROM sos_alerts s JOIN users u ON u.id = s.employee_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id
  LEFT JOIN workplaces w ON w.id = s.workplace_id LEFT JOIN users ab ON ab.id = s.acknowledged_by LEFT JOIN users rb ON rb.id = s.resolved_by`;

export const sosRouter = Router();
mount(sosRouter, '/api/v1/sos', 'sos', [
  route({
    method: 'post',
    path: '/mine',
    summary: 'Send an SOS with my location (or update the location of my open SOS)',
    access: 'employee',
    body: z.object({ location: location.optional(), message: z.string().trim().max(500).optional() }),
    handler: async ({ user, body }) => {
      const outbox = new Outbox();
      const row = await tx(async (db) => {
        const open = await one(`SELECT id FROM sos_alerts WHERE employee_id = $1 AND status <> 'RESOLVED' AND created_at > now() - interval '12 hours' FOR UPDATE`, [user.id], db);
        if (open) {
          return one(
            `UPDATE sos_alerts SET latitude = COALESCE($2, latitude), longitude = COALESCE($3, longitude), accuracy_m = COALESCE($4, accuracy_m),
               message = COALESCE($5, message), updated_at = now() WHERE id = $1 RETURNING *`,
            [open.id, body.location?.latitude ?? null, body.location?.longitude ?? null, body.location?.accuracyM ?? null, body.message || null],
            db,
          );
        }
        // On shift, the alert belongs to the workplace they are working at, so that site's supervisor and the
        // manager on the roster entry are told; otherwise to their home workplace.
        const shift = await one('SELECT id, workplace_id FROM tracking_sessions WHERE employee_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', [user.id], db);
        const s = await one(
          `INSERT INTO sos_alerts (org_id, employee_id, workplace_id, latitude, longitude, accuracy_m, message)
           VALUES ($1,$2,COALESCE($7::uuid, ${employeeSite('$2::uuid')}),$3,$4,$5,$6) RETURNING *`,
          [user.orgId, user.id, body.location?.latitude ?? null, body.location?.longitude ?? null, body.location?.accuracyM ?? null, body.message || null, shift?.workplace_id ?? null],
          db,
        );
        const where = body.location ? ` Location: https://www.google.com/maps?q=${body.location.latitude},${body.location.longitude} (±${Math.round(body.location.accuracyM)} m).` : ' The phone could not get a location.';
        await notify(db, outbox, {
          type: 'SOS',
          severity: 'CRITICAL',
          title: `SOS from ${user.fullName}`,
          body: `${user.fullName} pressed SOS${body.message ? `: “${body.message}”` : ''}.${where} Call them now.`,
          employeeId: user.id,
          workplaceId: s.workplace_id,
          sessionId: shift?.id ?? null,
          data: { sosId: s.id, location: body.location ?? null },
          dedupeKey: `sos:${s.id}`,
        });
        return s;
      });
      outbox.flush();
      return { id: row.id, status: row.status, createdAt: row.created_at };
    },
  }),
  route({
    method: 'get',
    path: '/mine',
    summary: 'My open SOS, if any (so the app can show "help is on the way")',
    access: 'employee',
    handler: async ({ user }) =>
      one(`${SOS_SELECT} WHERE s.employee_id = $1 AND s.status <> 'RESOLVED' AND s.created_at > now() - interval '12 hours' ORDER BY s.created_at DESC LIMIT 1`, [user.id]),
  }),
  route({
    method: 'get',
    path: '/',
    summary: 'SOS alerts: open first, then the last 30 days',
    access: 'admin',
    query: z.object({ open: z.enum(['true', 'false']).default('false') }),
    handler: async ({ query, user }) =>
      q(
        `${SOS_SELECT} WHERE s.org_id = $1 AND ${siteFilter(`COALESCE(s.workplace_id, ${employeeSite('s.employee_id')})`, '$2', 's.employee_id')}
           AND ($3::boolean IS NOT TRUE OR s.status <> 'RESOLVED') AND s.created_at > now() - interval '30 days'
         ORDER BY (s.status = 'OPEN') DESC, s.created_at DESC LIMIT 100`,
        [user.orgId, user.sites, query.open === 'true'],
      ),
  }),
  route({
    method: 'post',
    path: '/:id/acknowledge',
    summary: '"I am handling it" — the employee sees that help is coming',
    access: 'admin',
    params: idParams,
    scope: 'sos',
    handler: async ({ params, user, req }) => {
      const s = await one(`UPDATE sos_alerts SET status = 'ACKNOWLEDGED', acknowledged_by = $2, acknowledged_at = now(), updated_at = now() WHERE id = $1 AND status = 'OPEN' RETURNING *`, [params.id, user.id]);
      if (!s) throw conflict('SOS_NOT_OPEN', 'This SOS is already being handled.');
      await audit({ actor: user, action: 'sos.acknowledge', resourceType: 'sos', resourceId: params.id, req });
      const outbox = new Outbox();
      await notify(getPool(), outbox, {
        type: 'SOS',
        severity: 'INFO',
        audience: 'EMPLOYEE',
        title: 'Help is on the way',
        body: `${user.fullName} has seen your SOS and is handling it.`,
        employeeId: s.employee_id,
        data: { sosId: s.id },
        dedupeKey: `sos-ack:${s.id}`,
      });
      outbox.flush();
      return one(`${SOS_SELECT} WHERE s.id = $1`, [params.id]);
    },
  }),
  route({
    method: 'post',
    path: '/:id/resolve',
    summary: 'Close an SOS with what happened',
    access: 'admin',
    params: idParams,
    scope: 'sos',
    body: z.object({ note: z.string().trim().min(3).max(500) }),
    handler: async ({ params, body, user, req }) => {
      const done = await one(`UPDATE sos_alerts SET status = 'RESOLVED', resolved_by = $2, resolved_at = now(), resolution_note = $3, updated_at = now() WHERE id = $1 AND status <> 'RESOLVED' RETURNING id`, [params.id, user.id, body.note]);
      if (!done) throw conflict('ALREADY_RESOLVED', 'This SOS was already closed. Its resolution is kept as it was.');
      await audit({ actor: user, action: 'sos.resolve', resourceType: 'sos', resourceId: params.id, reason: body.note, req });
      return one(`${SOS_SELECT} WHERE s.id = $1`, [params.id]);
    },
  }),
]);

/** Supervisors publish only when the owner allows it (Settings › workforce). */
async function assertMayPublish(user: AuthUser) {
  if (user.access === 'OWNER') return;
  if (!(await getSettings(user.orgId)).workforce.supervisorAnnouncements) throw forbidden('The owner has turned off announcements by supervisors.');
}

const ANNOUNCEMENT_SELECT = `
  SELECT b.*, w.name AS workplace_name, u.full_name AS sent_by, eu.full_name AS updated_by_name,
         (SELECT count(*)::int FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.read_at IS NOT NULL) AS read_count
  FROM broadcasts b LEFT JOIN workplaces w ON w.id = b.workplace_id LEFT JOIN users u ON u.id = b.created_by LEFT JOIN users eu ON eu.id = b.updated_by`;

// Announcements (called "messages" before; the API path is kept for existing apps).
export const broadcastsRouter = Router();
mount(broadcastsRouter, '/api/v1/broadcasts', 'broadcasts', [
  route({
    method: 'post',
    path: '/',
    summary: 'Publish an announcement to everyone (owners), or to one workplace',
    access: 'admin',
    body: z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(2000), workplaceId: z.uuid().nullable().optional(), pinned: z.boolean().default(false) }),
    handler: async ({ body, user, req, res }) => {
      await assertMayPublish(user);
      // Supervisors can only message their own workplaces.
      if (body.workplaceId) await assertInOrg('workplace', body.workplaceId, user.orgId, user.sites);
      else if (user.sites) throw conflict('CHOOSE_WORKPLACE', 'Choose one of your workplaces to send to.');
      const outbox = new Outbox();
      const b = await tx(async (db) => {
        const people = await q(
          `SELECT u.id FROM users u WHERE u.org_id = $1 AND u.role = 'EMPLOYEE' AND u.is_active AND ($2::uuid IS NULL OR ${employeeSite('u.id')} = $2)`,
          [user.orgId, body.workplaceId ?? null],
          db,
        );
        const b = await one(
          `INSERT INTO broadcasts (org_id, workplace_id, title, body, recipients, created_by, pinned) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [user.orgId, body.workplaceId ?? null, body.title, body.body, people.length, user.id, body.pinned],
          db,
        );
        for (const p of people) {
          await q(`INSERT INTO broadcast_recipients (broadcast_id, employee_id) VALUES ($1,$2)`, [b.id, p.id], db);
          await notify(db, outbox, { type: 'BROADCAST', severity: 'INFO', audience: 'EMPLOYEE', title: body.title, body: body.body.slice(0, 200), employeeId: p.id, data: { broadcastId: b.id }, dedupeKey: `broadcast:${b.id}:${p.id}` });
        }
        await audit({ actor: user, action: 'broadcast.send', resourceType: 'broadcast', resourceId: b.id, after: { title: body.title, recipients: people.length, workplaceId: body.workplaceId ?? null }, req }, db);
        return b;
      });
      outbox.flush();
      res.status(201);
      return b;
    },
  }),
  route({
    method: 'get',
    path: '/',
    summary: 'Announcements (pinned first) with read counts; supervisors see their workplaces’ only',
    access: 'admin',
    query: z.object({ status: z.enum(['live', 'archived', 'all']).default('live'), workplaceId: z.uuid().optional(), search: z.string().trim().max(100).optional() }),
    handler: async ({ user, query }) =>
      q(
        `${ANNOUNCEMENT_SELECT}
         WHERE b.org_id = $1 AND (b.workplace_id IS NULL AND $2::uuid[] IS NULL OR ${siteFilter('b.workplace_id', '$2')} AND b.workplace_id IS NOT NULL)
           AND ($3 = 'all' OR ($3 = 'archived') = (b.archived_at IS NOT NULL)) AND ($4::uuid IS NULL OR b.workplace_id = $4)
           AND ($5::text IS NULL OR b.title ILIKE '%' || $5 || '%' OR b.body ILIKE '%' || $5 || '%')
         ORDER BY (b.pinned AND b.archived_at IS NULL) DESC, b.created_at DESC LIMIT 200`,
        [user.orgId, user.sites, query.status, query.workplaceId ?? null, query.search || null],
      ),
  }),
  route({
    method: 'patch',
    path: '/:id',
    summary: 'Edit or pin an announcement (owners: any; supervisors: their own)',
    access: 'admin',
    params: idParams,
    scope: 'broadcast',
    body: z.object({ title: z.string().trim().min(1).max(120).optional(), body: z.string().trim().min(1).max(2000).optional(), pinned: z.boolean().optional() }),
    handler: async ({ params, body, user, req }) => {
      await assertMayPublish(user);
      const before = await one('SELECT * FROM broadcasts WHERE id = $1', [params.id]);
      if (user.access !== 'OWNER' && before.created_by !== user.id) throw forbidden('Only the owner or the author can change this announcement.');
      await q(
        `UPDATE broadcasts SET title = COALESCE($2, title), body = COALESCE($3, body), pinned = COALESCE($4, pinned), updated_at = now(), updated_by = $5 WHERE id = $1`,
        [params.id, body.title ?? null, body.body ?? null, body.pinned ?? null, user.id],
      );
      await audit({ actor: user, action: 'broadcast.update', resourceType: 'broadcast', resourceId: params.id, before: { title: before.title, body: before.body, pinned: before.pinned }, after: body, req });
      return one(`${ANNOUNCEMENT_SELECT} WHERE b.id = $1`, [params.id]);
    },
  }),
  route({
    method: 'post',
    path: '/:id/archive',
    summary: 'Archive (hide from workers) or restore an announcement; it is never deleted',
    access: 'admin',
    params: idParams,
    scope: 'broadcast',
    body: z.object({ archived: z.boolean() }),
    handler: async ({ params, body, user, req }) => {
      await assertMayPublish(user);
      const before = await one('SELECT created_by FROM broadcasts WHERE id = $1', [params.id]);
      if (user.access !== 'OWNER' && before.created_by !== user.id) throw forbidden('Only the owner or the author can archive this announcement.');
      await q(`UPDATE broadcasts SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) END, updated_at = now(), updated_by = $3 WHERE id = $1`, [params.id, body.archived, user.id]);
      await audit({ actor: user, action: body.archived ? 'broadcast.archive' : 'broadcast.restore', resourceType: 'broadcast', resourceId: params.id, req });
      return one(`${ANNOUNCEMENT_SELECT} WHERE b.id = $1`, [params.id]);
    },
  }),
  route({
    method: 'get',
    path: '/:id/reads',
    summary: 'Who has and has not read a message',
    access: 'admin',
    params: idParams,
    scope: 'broadcast',
    handler: async ({ params }) =>
      q(
        `SELECT r.employee_id, r.read_at, u.full_name, ep.employee_code FROM broadcast_recipients r JOIN users u ON u.id = r.employee_id
         LEFT JOIN employee_profiles ep ON ep.user_id = u.id WHERE r.broadcast_id = $1 ORDER BY r.read_at NULLS FIRST, u.full_name`,
        [params.id],
      ),
  }),
  route({
    method: 'get',
    path: '/mine',
    summary: 'Announcements addressed to me (pinned first, then newest; archived ones are hidden)',
    access: 'employee',
    handler: async ({ user }) =>
      q(
        `SELECT b.id, b.title, b.body, b.created_at, b.updated_at, b.pinned, r.read_at, u.full_name AS sent_by, w.name AS workplace_name
         FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id
         LEFT JOIN users u ON u.id = b.created_by LEFT JOIN workplaces w ON w.id = b.workplace_id
         WHERE r.employee_id = $1 AND b.archived_at IS NULL ORDER BY b.pinned DESC, b.created_at DESC LIMIT 50`,
        [user.id],
      ),
  }),
  route({
    method: 'post',
    path: '/mine/:id/read',
    summary: 'Mark a message as read',
    access: 'employee',
    params: idParams,
    handler: async ({ user, params }) => {
      const marked = await one(`UPDATE broadcast_recipients SET read_at = COALESCE(read_at, now()) WHERE broadcast_id = $1 AND employee_id = $2 RETURNING broadcast_id`, [params.id, user.id]);
      if (!marked) throw notFound('Message');
      return { ok: true };
    },
  }),
]);
