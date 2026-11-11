import { Router } from 'express';
import { z } from 'zod';
import { NOTIFICATION_TYPES } from '@geoattend/shared';
import { one, q } from '../../db/pool.js';
import { dayEndSql, dayStartSql } from '../../lib/dates.js';
import { config } from '../../config.js';
import { idParams, isoDate, mount, paging, route } from '../../lib/http.js';
import { addClient } from './live-hub.js';
import { employeeSite, siteFilter } from '../../lib/tenancy.js';

/** A notification belongs to its workplace, or to the employee's current workplace. */
const notificationSites = (param: string) => siteFilter(`COALESCE(n.workplace_id, ${employeeSite('n.employee_id')})`, param, 'n.employee_id');

/** The server posts to this address, so it may only be a browser vendor's push service, never an internal host. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /^web\.push\.apple\.com$/];
export function isPushService(endpoint: string) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

export const notificationsRouter = Router();
mount(notificationsRouter, '/api/v1/notifications', 'notifications', [
  route({
    method: 'get',
    path: '/',
    summary: 'Notification history with filters and read state',
    access: 'admin',
    query: z.object({
      type: z.enum(NOTIFICATION_TYPES).optional(),
      severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
      employeeId: z.uuid().optional(),
      workplaceId: z.uuid().optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      unread: z.enum(['true', 'false']).optional(),
      ...paging,
    }),
    handler: async ({ query, user }) => {
      // $9 = company, $10 = supervisor's sites; limit/offset follow.
      const where = `n.audience = 'ADMIN' AND n.org_id = $9 AND ${notificationSites('$10')} AND ($1::text IS NULL OR n.type = $1) AND ($2::text IS NULL OR n.severity = $2) AND ($3::uuid IS NULL OR n.employee_id = $3)
        AND ($4::uuid IS NULL OR n.workplace_id = $4) AND ($5::date IS NULL OR n.created_at >= ${dayStartSql('$5', '$9')}) AND ($6::date IS NULL OR n.created_at < ${dayEndSql('$6', '$9')})
        AND ($7::boolean IS NULL OR (nr.user_id IS NULL) = $7)`;
      const params = [query.type ?? null, query.severity ?? null, query.employeeId ?? null, query.workplaceId ?? null, query.from ?? null, query.to ?? null, query.unread === undefined ? null : query.unread === 'true', user.id, user.orgId, user.sites];
      const items = await q(
        `SELECT n.*, u.full_name AS employee_name, w.name AS workplace_name, nr.read_at,
                (SELECT json_agg(json_build_object('channel', d.channel, 'status', d.status, 'attempts', d.attempts, 'lastError', d.last_error)) FROM notification_deliveries d WHERE d.notification_id = n.id) AS deliveries
         FROM notifications n LEFT JOIN users u ON u.id = n.employee_id LEFT JOIN workplaces w ON w.id = n.workplace_id
         LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $8
         WHERE ${where} ORDER BY n.created_at DESC LIMIT $11 OFFSET $12`,
        [...params, query.limit, query.offset],
      );
      const counts = await one(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE nr.user_id IS NULL)::int AS unread
         FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $8 WHERE ${where}`,
        params,
      );
      return { items, total: counts.total, unread: counts.unread };
    },
  }),
  route({
    method: 'get',
    path: '/unread-count',
    summary: 'Unread count for the bell',
    access: 'admin',
    handler: async ({ user }) =>
      one(
        `SELECT count(*)::int AS unread, count(*) FILTER (WHERE n.severity = 'CRITICAL')::int AS critical FROM notifications n
         WHERE n.audience = 'ADMIN' AND n.org_id = $2 AND ${notificationSites('$3')} AND n.created_at > now() - interval '30 days'
           AND NOT EXISTS (SELECT 1 FROM notification_reads nr WHERE nr.notification_id = n.id AND nr.user_id = $1)`,
        [user.id, user.orgId, user.sites],
      ),
  }),
  route({
    method: 'post',
    path: '/:id/read',
    summary: 'Mark one notification read',
    access: 'admin',
    params: idParams,
    scope: 'notification',
    handler: async ({ params, user }) => {
      await q('INSERT INTO notification_reads (notification_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [params.id, user.id]);
      return { ok: true };
    },
  }),
  route({
    method: 'post',
    path: '/read-all',
    summary: 'Mark all notifications read',
    access: 'admin',
    handler: async ({ user }) => {
      await q(
        `INSERT INTO notification_reads (notification_id, user_id) SELECT n.id, $1 FROM notifications n WHERE n.audience = 'ADMIN' AND n.org_id = $2 AND ${notificationSites('$3')} ON CONFLICT DO NOTHING`,
        [user.id, user.orgId, user.sites],
      );
      return { ok: true };
    },
  }),
  route({
    method: 'get',
    path: '/stream',
    summary: 'Server-Sent Events: live session, attendance and notification events',
    access: 'admin',
    raw: true,
    handler: async ({ req, res, user }) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ serverTime: new Date() })}\n\n`);
      addClient(res, user.orgId, user.sites, user.id);
      req.on('close', () => res.end());
    },
  }),
  route({
    method: 'get',
    path: '/web-push/key',
    summary: 'VAPID public key (null when web push is not configured)',
    access: 'admin',
    handler: () => ({ publicKey: config.push.vapidPublicKey || null }),
  }),
  route({
    method: 'post',
    path: '/web-push/subscriptions',
    summary: 'Register this browser for web push',
    access: 'admin',
    body: z.object({ endpoint: z.url().max(1000).refine(isPushService, 'Not a browser push service'), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }),
    handler: async ({ body, user }) => {
      await q(
        `INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth WHERE web_push_subscriptions.user_id = EXCLUDED.user_id`,
        [user.id, body.endpoint, body.keys.p256dh, body.keys.auth],
      );
      return { ok: true };
    },
  }),
  route({
    method: 'post',
    path: '/web-push/unsubscribe',
    summary: 'Remove this browser from web push',
    access: 'admin',
    body: z.object({ endpoint: z.url().max(1000) }),
    handler: async ({ body, user }) => {
      await q('DELETE FROM web_push_subscriptions WHERE endpoint = $1 AND user_id = $2', [body.endpoint, user.id]);
      return { ok: true };
    },
  }),
]);
