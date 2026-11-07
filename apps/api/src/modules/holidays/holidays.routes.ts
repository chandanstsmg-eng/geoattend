/**
 * Holidays (per workplace or for every workplace). On a holiday nobody is expected:
 * no-show alerts are skipped and the roster shows the holiday name. Anyone who still
 * works can start their shift as usual. Weekly offs are the days a shift does not run.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one, q, type Queryable } from '../../db/pool.js';
import { orgToday } from '../../lib/dates.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertInOrg, siteFilter } from '../../lib/tenancy.js';
import { idParams, isoDate, mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';

// Fixed-date national holidays. Festival dates change every year, so admins add those themselves.
const NATIONAL = [
  ['01-26', 'Republic Day'],
  ['08-15', 'Independence Day'],
  ['10-02', 'Gandhi Jayanti'],
] as const;

/** Holiday name for each of `workplaceIds` on `date` (a company-wide holiday applies to all of that company's workplaces). */
export async function holidaysOn(date: string, workplaceIds: string[], db?: Queryable) {
  if (!workplaceIds.length) return new Map<string, string>();
  const rows = await q(
    `SELECT DISTINCT ON (w.id) w.id AS workplace_id, h.name FROM workplaces w
     JOIN holidays h ON h.org_id = w.org_id AND h.holiday_date = $1 AND (h.workplace_id IS NULL OR h.workplace_id = w.id)
     WHERE w.id = ANY($2::uuid[]) ORDER BY w.id, h.workplace_id NULLS LAST`, // a workplace's own holiday wins over a company-wide one
    [date, workplaceIds],
    db,
  );
  return new Map(rows.map((r) => [r.workplace_id as string, r.name as string]));
}

export const holidaysRouter = Router();
mount(holidaysRouter, '/api/v1/holidays', 'holidays', [
  route({
    method: 'get',
    path: '/',
    summary: 'Holidays in a date range (default: this year)',
    access: 'admin',
    query: z.object({ from: isoDate.optional(), to: isoDate.optional(), workplaceId: z.uuid().optional() }),
    handler: async ({ query, user }) => {
      const year = (await orgToday(user.orgId)).slice(0, 4);
      return q(
        `SELECT h.*, w.name AS workplace_name FROM holidays h LEFT JOIN workplaces w ON w.id = h.workplace_id
         WHERE h.org_id = $4 AND h.holiday_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR h.workplace_id IS NULL OR h.workplace_id = $3)
           AND (h.workplace_id IS NULL OR ${siteFilter('h.workplace_id', '$5')})
         ORDER BY h.holiday_date, w.name NULLS FIRST`,
        [query.from ?? `${year}-01-01`, query.to ?? `${year}-12-31`, query.workplaceId ?? null, user.orgId, user.sites],
      );
    },
  }),
  route({
    method: 'post',
    path: '/',
    summary: 'Add a holiday (for one workplace, or all when workplaceId is omitted)',
    access: 'admin',
    ownerOnly: true,
    body: z.object({ date: isoDate, name: z.string().trim().min(1).max(120), workplaceId: z.uuid().nullable().optional() }),
    handler: async ({ body, user, req, res }) => {
      if (body.workplaceId) await assertInOrg('workplace', body.workplaceId, user.orgId);
      const row = await one(
        `INSERT INTO holidays (workplace_id, holiday_date, name, created_by, org_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,
        [body.workplaceId ?? null, body.date, body.name, user.id, user.orgId],
      );
      if (!row) throw conflict('HOLIDAY_EXISTS', 'There is already a holiday on this date for this workplace.');
      await audit({ actor: user, action: 'holiday.create', resourceType: 'holiday', resourceId: row.id, after: body, req });
      res.status(201);
      return row;
    },
  }),
  route({
    method: 'post',
    path: '/national',
    summary: 'Add the fixed-date national holidays for a year (all workplaces)',
    access: 'admin',
    ownerOnly: true,
    body: z.object({ year: z.number().int().min(2020).max(2100) }),
    handler: async ({ body, user, req }) => {
      let added = 0;
      for (const [md, name] of NATIONAL) {
        const r = await one(`INSERT INTO holidays (workplace_id, holiday_date, name, created_by, org_id) VALUES (NULL,$1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [`${body.year}-${md}`, name, user.id, user.orgId]);
        if (r) added++;
      }
      await audit({ actor: user, action: 'holiday.add_national', resourceType: 'holiday', after: { year: body.year, added }, req });
      return { added };
    },
  }),
  route({
    method: 'delete',
    path: '/:id',
    summary: 'Remove a holiday',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'holiday',
    handler: async ({ params, user, req }) => {
      const h = await one('DELETE FROM holidays WHERE id = $1 RETURNING *', [params.id]);
      if (!h) throw notFound('Holiday');
      await audit({ actor: user, action: 'holiday.delete', resourceType: 'holiday', resourceId: params.id, before: h, req });
    },
  }),
]);
