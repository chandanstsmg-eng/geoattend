import { Router } from 'express';
import { z } from 'zod';
import { one, q, tx } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { unlinkStaleSupervisors } from '../employees/employees.routes.js';
import { idParams, mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { canonicalTimezone, isValidTimezone } from '../../lib/shift-window.js';
import { siteFilter } from '../../lib/tenancy.js';
import { GEOFENCE_FLOOR_M, getSettings } from '../settings/settings.service.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';

const workplaceBody = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusM: z.number().min(10).max(1000),
  timezone: z.string().min(1).max(64).transform(canonicalTimezone),
  defaultGraceMinutes: z.number().int().min(0).max(240),
  absenceThresholdMinutes: z.number().int().min(1).max(480),
  /** Google place the address was resolved from (null when typed or placed by hand). */
  placeId: z.string().trim().max(300).nullable().optional(),
  /** People needed per day; the roster flags days with fewer (null = no target). */
  minStaff: z.number().int().min(0).max(10000).nullable().optional(),
});
// Defaults only on create — zod's .partial() would otherwise re-apply them on every PATCH.
const createBody = workplaceBody.extend({
  defaultGraceMinutes: workplaceBody.shape.defaultGraceMinutes.default(10),
  absenceThresholdMinutes: workplaceBody.shape.absenceThresholdMinutes.default(15),
});

const SELECT = `
  SELECT w.id, w.name, w.address, w.latitude, w.longitude, w.radius_m::float AS radius_m, w.timezone, w.default_grace_minutes,
         w.absence_threshold_minutes, w.is_active, w.is_demo, w.config_version, w.created_at, w.updated_at, w.place_id, w.min_staff,
         (SELECT json_agg(json_build_object('id', su.id, 'fullName', su.full_name) ORDER BY su.full_name)
            FROM users su JOIN administrator_profiles ap ON ap.user_id = su.id
            WHERE su.is_active AND ap.access = 'SUPERVISOR' AND w.id = ANY(ap.site_ids)) AS supervisors,
         (SELECT count(*)::int FROM workplace_assignments wa JOIN users u ON u.id = wa.employee_id WHERE wa.workplace_id = w.id AND wa.effective_to IS NULL AND u.is_active) AS employee_count,
         (SELECT count(*)::int FROM shifts s WHERE s.workplace_id = w.id AND s.is_active) AS shift_count,
         (SELECT count(*)::int FROM tracking_sessions ts WHERE ts.workplace_id = w.id AND ts.ended_at IS NULL) AS open_sessions
  FROM workplaces w`;

async function checkRadius(radiusM: number, orgId: string) {
  const { geofence } = await getSettings(orgId);
  const min = Math.max(GEOFENCE_FLOOR_M, geofence.minRadiusM);
  if (radiusM < min || radiusM > geofence.maxRadiusM) {
    throw badRequest('RADIUS_NOT_PERMITTED', `Radius must be between ${min} m and ${geofence.maxRadiusM} m.`);
  }
}

export const workplacesRouter = Router();
mount(workplacesRouter, '/api/v1/workplaces', 'workplaces', [
  route({
    method: 'get',
    path: '/',
    summary: 'List workplaces',
    access: 'admin',
    query: z.object({ includeInactive: z.enum(['true', 'false']).default('true') }),
    handler: async ({ query, user }) =>
      q(`${SELECT} WHERE w.org_id = $2 AND ($1 OR w.is_active) AND ${siteFilter('w.id', '$3')} ORDER BY w.is_active DESC, w.name`, [query.includeInactive === 'true', user.orgId, user.sites]),
  }),
  route({
    method: 'post',
    path: '/',
    summary: 'Create a workplace and geofence',
    access: 'admin',
    ownerOnly: true,
    body: createBody,
    handler: async ({ body, user, req, res }) => {
      await checkRadius(body.radiusM, user.orgId);
      if (!isValidTimezone(body.timezone)) throw badRequest('BAD_TIMEZONE', 'Unknown time zone.');
      const w = await one(
        `INSERT INTO workplaces (name, address, latitude, longitude, radius_m, timezone, default_grace_minutes, absence_threshold_minutes, created_by, org_id, place_id, min_staff)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [body.name, body.address ?? null, body.latitude, body.longitude, body.radiusM, body.timezone, body.defaultGraceMinutes, body.absenceThresholdMinutes, user.id, user.orgId, body.placeId || null, body.minStaff ?? null],
      );
      const created = await one(`${SELECT} WHERE w.id = $1`, [w.id]);
      await audit({ actor: user, action: 'workplace.create', resourceType: 'workplace', resourceId: w.id, after: created, req });
      res.status(201);
      return created;
    },
  }),
  route({
    method: 'get',
    path: '/:id',
    summary: 'Workplace with shifts and assigned employees',
    access: 'admin',
    params: idParams,
    scope: 'workplace',
    handler: async ({ params }) => {
      const w = await one(`${SELECT} WHERE w.id = $1`, [params.id]);
      if (!w) throw notFound('Workplace');
      const shifts = await q('SELECT * FROM shifts WHERE workplace_id = $1 ORDER BY start_time', [params.id]);
      const employees = await q(
        `SELECT u.id, u.full_name, ep.employee_code, u.is_active, u.is_demo FROM workplace_assignments wa JOIN users u ON u.id = wa.employee_id
         JOIN employee_profiles ep ON ep.user_id = u.id WHERE wa.workplace_id = $1 AND wa.effective_to IS NULL ORDER BY u.full_name`,
        [params.id],
      );
      return { ...w, shifts, employees };
    },
  }),
  route({
    method: 'patch',
    path: '/:id',
    summary: 'Edit workplace / geofence (versioned, audited; on-shift employees are re-evaluated on their next reading)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'workplace',
    body: workplaceBody.partial().extend({ reason: z.string().trim().max(500).optional() }),
    handler: async ({ params, body, user, req }) => {
      if (body.radiusM !== undefined) await checkRadius(body.radiusM, user.orgId);
      if (body.timezone && !isValidTimezone(body.timezone)) throw badRequest('BAD_TIMEZONE', 'Unknown time zone.');
      const outbox = new Outbox();
      const after = await tx(async (db) => {
        const before = await one(`${SELECT} WHERE w.id = $1 FOR UPDATE OF w`, [params.id], db);
        if (!before) throw notFound('Workplace');
        const geoChanged =
          (body.latitude !== undefined && body.latitude !== before.latitude) ||
          (body.longitude !== undefined && body.longitude !== before.longitude) ||
          (body.radiusM !== undefined && body.radiusM !== before.radius_m);
        await q(
          `UPDATE workplaces SET name = COALESCE($2, name), address = CASE WHEN $3::boolean THEN $4 ELSE address END,
             latitude = COALESCE($5, latitude), longitude = COALESCE($6, longitude), radius_m = COALESCE($7, radius_m),
             timezone = COALESCE($8, timezone), default_grace_minutes = COALESCE($9, default_grace_minutes),
             absence_threshold_minutes = COALESCE($10, absence_threshold_minutes),
             place_id = CASE WHEN $12::boolean THEN $13 ELSE place_id END,
             min_staff = CASE WHEN $14::boolean THEN $15::int ELSE min_staff END,
             config_version = config_version + CASE WHEN $11 THEN 1 ELSE 0 END, updated_at = now()
           WHERE id = $1`,
          [params.id, body.name ?? null, 'address' in body, body.address ?? null, body.latitude ?? null, body.longitude ?? null, body.radiusM ?? null, body.timezone ?? null, body.defaultGraceMinutes ?? null, body.absenceThresholdMinutes ?? null, geoChanged, 'placeId' in body, body.placeId || null, 'minStaff' in body, body.minStaff ?? null],
          db,
        );
        const after = await one(`${SELECT} WHERE w.id = $1`, [params.id], db);
        await audit({ actor: user, action: 'workplace.update', resourceType: 'workplace', resourceId: params.id, before, after, reason: body.reason, req }, db);
        if (geoChanged && before.open_sessions > 0) {
          await notify(db, outbox, {
            type: 'GEOFENCE_CHANGED',
            severity: 'WARNING',
            body: `${user.fullName} changed the geofence of ${after.name} (radius ${before.radius_m} m → ${after.radius_m} m) while ${before.open_sessions} employee session(s) were open. New readings are evaluated against the new geofence; recorded attendance is unchanged.`,
            workplaceId: params.id,
            data: { before: { lat: before.latitude, lng: before.longitude, radiusM: before.radius_m }, after: { lat: after.latitude, lng: after.longitude, radiusM: after.radius_m }, version: after.config_version },
            dedupeKey: `geofence-changed:${params.id}:${after.config_version}`,
            simulated: before.is_demo,
          });
        }
        outbox.push({ type: 'workplace.updated', workplaceId: params.id });
        return after;
      });
      outbox.flush();
      return after;
    },
  }),
  route({
    method: 'put',
    path: '/:id/supervisors',
    summary: 'Choose which supervisors manage this workplace (adds or removes it from their sites)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'workplace',
    body: z.object({ supervisorIds: z.array(z.uuid()).max(200) }),
    handler: async ({ params, body, user, req }) => {
      const wanted = [...new Set(body.supervisorIds)];
      await tx(async (db) => {
        const valid = await q(
          `SELECT u.id FROM users u JOIN administrator_profiles ap ON ap.user_id = u.id
           WHERE u.org_id = $1 AND u.role = 'ADMIN' AND u.is_active AND ap.access = 'SUPERVISOR' AND u.id = ANY($2::uuid[])`,
          [user.orgId, wanted],
          db,
        );
        if (valid.length !== wanted.length) throw badRequest('BAD_SUPERVISOR', 'Choose active supervisors of your company.');
        const before = await q(`SELECT ap.user_id FROM administrator_profiles ap JOIN users u ON u.id = ap.user_id WHERE u.org_id = $1 AND $2::uuid = ANY(ap.site_ids)`, [user.orgId, params.id], db);
        await q(
          `UPDATE administrator_profiles ap SET site_ids = array_remove(ap.site_ids, $2::uuid)
           FROM users u WHERE u.id = ap.user_id AND u.org_id = $1 AND ap.access = 'SUPERVISOR' AND $2::uuid = ANY(ap.site_ids) AND NOT (ap.user_id = ANY($3::uuid[]))`,
          [user.orgId, params.id, wanted],
          db,
        );
        // A supervisor needs at least one site; refuse removing someone's only workplace.
        const orphan = await one(`SELECT u.full_name FROM administrator_profiles ap JOIN users u ON u.id = ap.user_id WHERE u.org_id = $1 AND u.is_active AND ap.access = 'SUPERVISOR' AND cardinality(ap.site_ids) = 0 LIMIT 1`, [user.orgId], db);
        if (orphan) throw conflict('SITES_REQUIRED', `${orphan.full_name} would have no workplace left. Give them another workplace first (Supervisors).`);
        await q(`UPDATE administrator_profiles SET site_ids = array_append(site_ids, $1::uuid) WHERE user_id = ANY($2::uuid[]) AND NOT ($1::uuid = ANY(site_ids))`, [params.id, wanted], db);
        await unlinkStaleSupervisors(db, user.orgId);
        await audit({ actor: user, action: 'workplace.supervisors', resourceType: 'workplace', resourceId: params.id, before: before.map((r) => r.user_id), after: wanted, req }, db);
      });
      return one(`${SELECT} WHERE w.id = $1`, [params.id]);
    },
  }),
  route({
    method: 'post',
    path: '/:id/status',
    summary: 'Enable or disable a workplace (history kept)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'workplace',
    body: z.object({ isActive: z.boolean(), reason: z.string().trim().max(500).optional() }),
    handler: async ({ params, body, user, req }) => {
      const before = await one('SELECT is_active FROM workplaces WHERE id = $1', [params.id]);
      if (!before) throw notFound('Workplace');
      await q(`UPDATE workplaces SET is_active = $2, deactivated_on = CASE WHEN $2 THEN NULL ELSE (now() AT TIME ZONE timezone)::date END, updated_at = now() WHERE id = $1`, [params.id, body.isActive]);
      await audit({ actor: user, action: body.isActive ? 'workplace.enable' : 'workplace.disable', resourceType: 'workplace', resourceId: params.id, before, after: { is_active: body.isActive }, reason: body.reason, req });
      return one(`${SELECT} WHERE w.id = $1`, [params.id]);
    },
  }),
]);
