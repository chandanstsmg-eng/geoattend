import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { runRetention } from '../jobs/retention.js';
import { GEOFENCE_FLOOR_M, getSettings, saveSettingsSection, settingsSchema, type Settings } from './settings.service.js';

export const settingsRouter = Router();
mount(settingsRouter, '/api/v1/settings', 'settings', [
  route({
    method: 'get',
    path: '/',
    summary: 'All settings plus which optional integrations are configured',
    access: 'admin',
    ownerOnly: true,
    handler: async ({ user }) => ({
      settings: await getSettings(user.orgId),
      integrations: {
        demoMode: config.demoMode,
        storageDriver: config.storage.driver,
        webPush: !!config.push.vapidPrivateKey,
        email: !!config.email.smtpUrl,
        expoPush: config.push.expoPushEnabled,
        photoAutoDelete: config.photoAutoDeleteEnabled,
      },
    }),
  }),
  route({
    method: 'put',
    path: '/:section',
    summary: 'Replace one settings section (tracking | alerts | retention | geofence | privacy | workforce | digest | breaks)',
    access: 'admin',
    ownerOnly: true,
    params: z.object({ section: z.enum(['tracking', 'alerts', 'retention', 'geofence', 'privacy', 'workforce', 'digest', 'breaks']) }),
    body: z.object({ value: z.unknown(), reason: z.string().trim().max(500).optional() }),
    handler: async ({ params, body, user, req }) => {
      const section = params.section as keyof Settings;
      const before = await getSettings(user.orgId);
      const parsed = (settingsSchema.shape[section] as z.ZodType).safeParse(body.value);
      if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Invalid settings', z.flattenError(parsed.error));
      let value: any = parsed.data;
      if (section === 'geofence' && value.minRadiusM > value.maxRadiusM) throw badRequest('BAD_RANGE', 'Minimum radius must not exceed maximum.');
      if (section === 'geofence' && (value.minRadiusM < GEOFENCE_FLOOR_M || value.presetsM.some((p: number) => p < GEOFENCE_FLOOR_M)))
        throw badRequest('RADIUS_TOO_SMALL', `Geofences smaller than ${GEOFENCE_FLOOR_M} m lock out genuine workers (indoor GPS is often ±30–60 m).`);
      if (section === 'retention' && value.photoAutoDelete && !config.photoAutoDeleteEnabled) {
        throw conflict('PHOTO_DELETION_ON_HOLD', 'Automatic photo deletion is on hold until the retention rules have been legally reviewed.');
      }
      if (section === 'privacy') {
        // Any change to the notice text creates a new version that employees must acknowledge.
        const changed = value.text !== before.privacy.text || value.controller !== before.privacy.controller || value.contact !== before.privacy.contact;
        value = { ...value, version: changed ? before.privacy.version + 1 : before.privacy.version };
      }
      await saveSettingsSection(user.orgId, section, value, user.id);
      await audit({ actor: user, action: `settings.update.${section}`, resourceType: 'settings', resourceId: section, before: before[section], after: value, reason: body.reason, req });
      return getSettings(user.orgId);
    },
  }),
  route({
    method: 'post',
    path: '/retention/run',
    summary: "Run this company's retention policy now",
    access: 'admin',
    ownerOnly: true,
    handler: async ({ user }) => runRetention(user, user.orgId),
  }),
]);
