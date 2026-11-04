/** The signed-in administrator's own company: name, contact and setup progress. */
import { Router } from 'express';
import { z } from 'zod';
import { one } from '../../db/pool.js';
import { mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';

async function loadOrg(orgId: string) {
  return one(
    `SELECT o.id, o.name, o.phone, o.created_at,
            (SELECT count(*)::int FROM workplaces w WHERE w.org_id = o.id) AS workplaces,
            (SELECT count(*)::int FROM shifts s JOIN workplaces w ON w.id = s.workplace_id WHERE w.org_id = o.id) AS shifts,
            (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.role = 'EMPLOYEE' AND u.is_active) AS employees,
            (SELECT count(*)::int FROM employee_shift_assignments a JOIN users u ON u.id = a.employee_id WHERE u.org_id = o.id AND a.effective_to IS NULL) AS shift_assignments,
            (SELECT count(*)::int FROM attendance_records ar JOIN users u ON u.id = ar.employee_id WHERE u.org_id = o.id) AS attendance_records
     FROM organizations o WHERE o.id = $1`,
    [orgId],
  );
}

export const organizationRouter = Router();
mount(organizationRouter, '/api/v1/organization', 'organization', [
  route({
    method: 'get',
    path: '/',
    summary: 'Own company, with counts used by the getting-started checklist',
    access: 'admin',
    handler: async ({ user }) => loadOrg(user.orgId),
  }),
  route({
    method: 'patch',
    path: '/',
    summary: 'Rename the company or change its contact phone',
    access: 'admin',
    ownerOnly: true,
    body: z.object({ name: z.string().trim().min(2).max(200).optional(), phone: z.string().trim().max(40).nullable().optional() }),
    handler: async ({ user, body, req }) => {
      const before = await loadOrg(user.orgId);
      await one(
        `UPDATE organizations SET name = COALESCE($2, name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END, updated_at = now() WHERE id = $1 RETURNING id`,
        [user.orgId, body.name ?? null, 'phone' in body, body.phone ?? null],
      );
      const after = await loadOrg(user.orgId);
      await audit({ actor: user, action: 'organization.update', resourceType: 'organization', resourceId: user.orgId, before: { name: before.name, phone: before.phone }, after: { name: after.name, phone: after.phone }, req });
      return after;
    },
  }),
]);
