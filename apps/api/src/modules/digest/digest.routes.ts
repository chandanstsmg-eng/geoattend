import { Router } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../../db/pool.js';
import { config } from '../../config.js';
import { mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { composeDigest, sendDigest } from './digest.js';

export const digestRouter = Router();
mount(digestRouter, '/api/v1/digest', 'digest', [
  route({
    method: 'get',
    path: '/',
    summary: 'Preview of the summary as it would be sent now, which channels are set up, and recent sends',
    access: 'admin',
    ownerOnly: true,
    handler: async ({ user }) => {
      const tz = (await one(`SELECT timezone FROM workplaces WHERE org_id = $1 ORDER BY is_active DESC, created_at LIMIT 1`, [user.orgId]))?.timezone ?? 'UTC';
      const local = DateTime.now().setZone(tz);
      return {
        preview: await composeDigest(user.orgId, local.toISODate()!, local.toFormat('ccc d LLL, HH:mm')),
        channels: { whatsapp: !!(config.whatsapp.token && config.whatsapp.phoneNumberId), email: !!config.email.smtpUrl },
        recent: await q(`SELECT slot, sent_at, results FROM digest_runs WHERE org_id = $1 ORDER BY sent_at DESC LIMIT 10`, [user.orgId]),
      };
    },
  }),
  route({
    method: 'post',
    path: '/test',
    summary: 'Send the summary now to everyone configured',
    access: 'admin',
    ownerOnly: true,
    handler: async ({ user, req }) => {
      const tz = (await one(`SELECT timezone FROM workplaces WHERE org_id = $1 ORDER BY is_active DESC, created_at LIMIT 1`, [user.orgId]))?.timezone ?? 'UTC';
      const local = DateTime.now().setZone(tz);
      const d = await composeDigest(user.orgId, local.toISODate()!, `${local.toFormat('ccc d LLL, HH:mm')} (test)`);
      const results = await sendDigest(user.orgId, d);
      await audit({ actor: user, action: 'digest.test', resourceType: 'digest', after: results, req });
      return { digest: d, results };
    },
  }),
]);
