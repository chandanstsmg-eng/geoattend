import { Router } from 'express';
import { HttpError } from '../../lib/errors.js';
import { DateTime } from 'luxon';
import { one, q } from '../../db/pool.js';
import { orgTimezone } from '../../lib/dates.js';
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
      const local = DateTime.now().setZone(await orgTimezone(user.orgId));
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
      // Sends real messages to configured numbers, so a loop must not turn it into a relay.
      if (await one(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND action = 'digest.test' AND created_at > now() - interval '5 minutes' LIMIT 1`, [user.orgId])) {
        throw new HttpError(429, 'RATE_LIMITED', 'A test summary was sent a moment ago. Try again in five minutes.');
      }
      const local = DateTime.now().setZone(await orgTimezone(user.orgId));
      const d = await composeDigest(user.orgId, local.toISODate()!, `${local.toFormat('ccc d LLL, HH:mm')} (test)`);
      const results = await sendDigest(user.orgId, d);
      await audit({ actor: user, action: 'digest.test', resourceType: 'digest', after: results, req });
      return { digest: d, results };
    },
  }),
]);
