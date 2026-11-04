import { Router } from 'express';
import { z } from 'zod';
import { one, q } from '../../db/pool.js';
import { isoDate, mount, paging, route } from '../../lib/http.js';
import { siteFilter } from '../../lib/tenancy.js';

export const geofenceEventsRouter = Router();
mount(geofenceEventsRouter, '/api/v1/geofence-events', 'geofence-events', [
  route({
    method: 'get',
    path: '/',
    summary: 'Geofence events (entries, exits, returns, accuracy problems)',
    access: 'admin',
    query: z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      employeeId: z.uuid().optional(),
      workplaceId: z.uuid().optional(),
      eventType: z.string().max(40).optional(),
      ...paging,
    }),
    handler: async ({ query, user }) =>
      q(
        `SELECT g.*, u.full_name, w.name AS workplace_name FROM geofence_events g JOIN users u ON u.id = g.employee_id JOIN workplaces w ON w.id = g.workplace_id
         WHERE u.org_id = $8 AND ${siteFilter('g.workplace_id', '$9')} AND ($1::date IS NULL OR g.event_time >= $1::date) AND ($2::date IS NULL OR g.event_time < $2::date + 1)
           AND ($3::uuid IS NULL OR g.employee_id = $3) AND ($4::uuid IS NULL OR g.workplace_id = $4) AND ($5::text IS NULL OR g.event_type = $5)
         ORDER BY g.event_time DESC LIMIT $6 OFFSET $7`,
        [query.from ?? null, query.to ?? null, query.employeeId ?? null, query.workplaceId ?? null, query.eventType ?? null, query.limit, query.offset, user.orgId, user.sites],
      ),
  }),
]);

export const absenceRouter = Router();
mount(absenceRouter, '/api/v1/absence-intervals', 'absence', [
  route({
    method: 'get',
    path: '/',
    summary: 'Absence intervals (workplace exits during shifts)',
    access: 'admin',
    query: z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      employeeId: z.uuid().optional(),
      workplaceId: z.uuid().optional(),
      status: z.enum(['OPEN', 'RETURNED', 'SHIFT_ENDED']).optional(),
      prolongedOnly: z.enum(['true', 'false']).optional(),
      ...paging,
    }),
    handler: async ({ query, user }) => {
      const where = `a.employee_id IN (SELECT id FROM users WHERE org_id = $7) AND ${siteFilter('a.workplace_id', '$8')}
           AND ($1::date IS NULL OR a.started_at >= $1::date) AND ($2::date IS NULL OR a.started_at < $2::date + 1)
           AND ($3::uuid IS NULL OR a.employee_id = $3) AND ($4::uuid IS NULL OR a.workplace_id = $4) AND ($5::text IS NULL OR a.status = $5)
           AND ($6::boolean IS NOT TRUE OR a.prolonged_at IS NOT NULL)`;
      const params = [query.from ?? null, query.to ?? null, query.employeeId ?? null, query.workplaceId ?? null, query.status ?? null, query.prolongedOnly === 'true', user.orgId, user.sites];
      const items = await q(
        `SELECT a.*, u.full_name, ep.employee_code, w.name AS workplace_name,
                ROUND(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, now()) - a.started_at)) / 60)::int AS duration_minutes
         FROM absence_intervals a JOIN users u ON u.id = a.employee_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id JOIN workplaces w ON w.id = a.workplace_id
         WHERE ${where} ORDER BY a.started_at DESC LIMIT $9 OFFSET $10`,
        [...params, query.limit, query.offset],
      );
      const total = await one(`SELECT count(*)::int AS n FROM absence_intervals a WHERE ${where}`, params);
      return { items, total: total.n };
    },
  }),
]);

export const auditRouter = Router();
mount(auditRouter, '/api/v1/audit-logs', 'audit', [
  route({
    method: 'get',
    path: '/',
    summary: 'Audit log (append-only)',
    access: 'admin',
    ownerOnly: true,
    query: z.object({
      action: z.string().max(80).optional(),
      resourceType: z.string().max(60).optional(),
      resourceId: z.string().max(80).optional(),
      actorId: z.uuid().optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      ...paging,
    }),
    handler: async ({ query, user }) => {
      const where = `a.org_id = $7 AND ($1::text IS NULL OR a.action ILIKE $1 || '%') AND ($2::text IS NULL OR a.resource_type = $2) AND ($3::text IS NULL OR a.resource_id = $3)
        AND ($4::uuid IS NULL OR a.actor_id = $4) AND ($5::date IS NULL OR a.created_at >= $5::date) AND ($6::date IS NULL OR a.created_at < $6::date + 1)`;
      const params = [query.action ?? null, query.resourceType ?? null, query.resourceId ?? null, query.actorId ?? null, query.from ?? null, query.to ?? null, user.orgId];
      const items = await q(`SELECT a.*, u.full_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT $8 OFFSET $9`, [...params, query.limit, query.offset]);
      const total = await one(`SELECT count(*)::int AS n FROM audit_logs a WHERE ${where}`, params);
      return { items, total: total.n };
    },
  }),
]);
