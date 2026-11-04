/**
 * Tasks with proof of work. Administrators assign a task to one or more employees;
 * the employee completes it in the app with a photo (if required), a note and their
 * location; an administrator approves it or sends it back with a note.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one, q, tx } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { idParams, isoDate, mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { assertInOrg, employeeSite, siteFilter } from '../../lib/tenancy.js';
import { createDownloadUrl, createUploadUrl, inspectObject, newObjectKey, requestOrigin } from '../../lib/storage.js';
import { confirmUpload } from '../attendance/photo-upload.js';
import { config } from '../../config.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';

const SELECT = `
  SELECT t.*, u.full_name AS assignee_name, ep.employee_code, w.name AS workplace_name, cb.full_name AS created_by_name, rb.full_name AS reviewed_by_name,
         (SELECT p.id FROM task_photos p WHERE p.task_id = t.id AND p.status = 'ATTACHED' ORDER BY p.created_at DESC LIMIT 1) AS photo_id
  FROM tasks t JOIN users u ON u.id = t.assignee_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id
  LEFT JOIN workplaces w ON w.id = t.workplace_id LEFT JOIN users cb ON cb.id = t.created_by LEFT JOIN users rb ON rb.id = t.reviewed_by`;

async function loadTask(id: string) {
  const t = await one(`${SELECT} WHERE t.id = $1`, [id]);
  if (!t) throw notFound('Task');
  return t;
}

export const tasksRouter = Router();
mount(tasksRouter, '/api/v1/tasks', 'tasks', [
  // ── employee ──
  route({
    method: 'get',
    path: '/mine',
    summary: 'My tasks: to do, waiting for review, and recently finished',
    access: 'employee',
    handler: async ({ user }) =>
      q(
        `${SELECT} WHERE t.assignee_id = $1 AND (t.status IN ('OPEN', 'REOPENED', 'SUBMITTED') OR t.updated_at > now() - interval '14 days') AND t.status <> 'CANCELLED'
         ORDER BY (t.status IN ('OPEN', 'REOPENED')) DESC, t.due_date NULLS LAST, t.created_at DESC LIMIT 100`,
        [user.id],
      ),
  }),
  route({
    method: 'post',
    path: '/mine/:id/photo',
    summary: 'Reserve a private upload for the proof photo',
    access: 'employee',
    params: idParams,
    body: z.object({ contentType: z.enum(['image/jpeg', 'image/png']), sizeBytes: z.number().int().positive() }),
    handler: async ({ user, params, body, req }) => {
      const t = await one(`SELECT * FROM tasks WHERE id = $1 AND assignee_id = $2`, [params.id, user.id]);
      if (!t) throw notFound('Task');
      if (t.status !== 'OPEN' && t.status !== 'REOPENED') throw conflict('TASK_CLOSED', 'This task is not open.');
      if (body.sizeBytes > config.storage.maxPhotoBytes) throw badRequest('PHOTO_TOO_LARGE', 'Photo is too large.');
      const key = newObjectKey(user.id, body.contentType);
      const p = await one(`INSERT INTO task_photos (task_id, employee_id, object_key, content_type, declared_bytes) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [t.id, user.id, key, body.contentType, body.sizeBytes]);
      return { photoId: p.id, upload: await createUploadUrl(key, body.contentType, body.sizeBytes, requestOrigin(req)) };
    },
  }),
  route({
    method: 'post',
    path: '/mine/:id/done',
    summary: 'Mark a task done, with the uploaded photo, a note and the current location',
    access: 'employee',
    params: idParams,
    body: z.object({
      note: z.string().trim().max(1000).optional(),
      photoId: z.uuid().optional(),
      location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracyM: z.number().positive().max(5000) }).optional(),
    }),
    handler: async ({ user, params, body }) => {
      const outbox = new Outbox();
      await tx(async (db) => {
        const t = await one(`SELECT * FROM tasks WHERE id = $1 AND assignee_id = $2 FOR UPDATE`, [params.id, user.id], db);
        if (!t) throw notFound('Task');
        if (t.status !== 'OPEN' && t.status !== 'REOPENED') throw conflict('TASK_CLOSED', 'This task is not open.');
        if (t.requires_photo && !body.photoId) throw badRequest('PHOTO_REQUIRED', 'This task needs a photo.');
        if (body.photoId) {
          const p = await one(`SELECT * FROM task_photos WHERE id = $1 AND task_id = $2 AND employee_id = $3`, [body.photoId, t.id, user.id], db);
          if (!p || !(await confirmUpload('task_photos', p, db))) throw badRequest('PHOTO_MISSING', 'The photo was not uploaded. Try again.');
          const info = await inspectObject(p.object_key);
          if (!info || info.type !== p.content_type) throw badRequest('PHOTO_INVALID', 'The photo could not be read. Please take it again.');
          await q(`UPDATE task_photos SET status = 'ATTACHED' WHERE id = $1`, [p.id], db);
        }
        await q(
          `UPDATE tasks SET status = 'SUBMITTED', submitted_at = now(), submission_note = $2, submitted_lat = $3, submitted_lng = $4, submitted_accuracy_m = $5, updated_at = now() WHERE id = $1`,
          [t.id, body.note || null, body.location?.latitude ?? null, body.location?.longitude ?? null, body.location?.accuracyM ?? null],
          db,
        );
        await notify(db, outbox, {
          type: 'TASK_SUBMITTED',
          severity: 'INFO',
          body: `${user.fullName} finished “${t.title}”${body.photoId ? ' with a photo' : ''}. Check and approve it.`,
          employeeId: user.id,
          workplaceId: t.workplace_id,
          data: { taskId: t.id },
          dedupeKey: `task-submitted:${t.id}:${Date.now()}`,
        });
      });
      outbox.flush();
      return loadTask(params.id);
    },
  }),

  // ── administrator ──
  route({
    method: 'get',
    path: '/',
    summary: 'Tasks (filter by status, employee, due date)',
    access: 'admin',
    query: z.object({ status: z.enum(['OPEN', 'SUBMITTED', 'APPROVED', 'REOPENED', 'CANCELLED', 'ALL']).default('ALL'), assigneeId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
    handler: async ({ query, user }) =>
      q(
        `${SELECT} WHERE t.org_id = $1 AND ${siteFilter(`COALESCE(t.workplace_id, ${employeeSite('t.assignee_id')})`, '$2')}
           AND ($3 = 'ALL' OR t.status = $3) AND ($4::uuid IS NULL OR t.assignee_id = $4)
         ORDER BY (t.status = 'SUBMITTED') DESC, t.due_date NULLS LAST, t.created_at DESC LIMIT $5`,
        [user.orgId, user.sites, query.status, query.assigneeId ?? null, query.limit],
      ),
  }),
  route({
    method: 'post',
    path: '/',
    summary: 'Assign a task to one or more employees',
    access: 'admin',
    body: z.object({
      assigneeIds: z.array(z.uuid()).min(1).max(200),
      title: z.string().trim().min(1).max(200),
      details: z.string().trim().max(2000).optional(),
      dueDate: isoDate.optional(),
      requiresPhoto: z.boolean().default(true),
    }),
    handler: async ({ body, user, req, res }) => {
      for (const id of body.assigneeIds) await assertInOrg('employee', id, user.orgId, user.sites);
      const outbox = new Outbox();
      const ids = await tx(async (db) => {
        const created: string[] = [];
        for (const assignee of new Set(body.assigneeIds)) {
          const t = await one(
            `INSERT INTO tasks (org_id, assignee_id, workplace_id, title, details, due_date, requires_photo, created_by)
             VALUES ($1,$2,${employeeSite('$2::uuid')},$3,$4,$5,$6,$7) RETURNING id`,
            [user.orgId, assignee, body.title, body.details || null, body.dueDate ?? null, body.requiresPhoto, user.id],
            db,
          );
          created.push(t.id);
          await notify(db, outbox, {
            type: 'TASK_ASSIGNED',
            severity: 'INFO',
            audience: 'EMPLOYEE',
            title: 'New task',
            body: `${body.title}${body.dueDate ? ` — by ${body.dueDate}` : ''}`,
            employeeId: assignee,
            data: { taskId: t.id },
            dedupeKey: `task-assigned:${t.id}`,
          });
        }
        await audit({ actor: user, action: 'task.create', resourceType: 'task', after: { ...body, created: created.length }, req }, db);
        return created;
      });
      outbox.flush();
      res.status(201);
      return { created: ids.length, ids };
    },
  }),
  route({
    method: 'get',
    path: '/:id',
    summary: 'One task',
    access: 'admin',
    params: idParams,
    scope: 'task',
    handler: async ({ params }) => loadTask(params.id),
  }),
  route({
    method: 'post',
    path: '/:id/photo-url',
    summary: 'Short-lived link to the proof photo (audited)',
    access: 'admin',
    params: idParams,
    scope: 'task',
    handler: async ({ params, user, req }) => {
      const p = await one(`SELECT * FROM task_photos WHERE task_id = $1 AND status = 'ATTACHED' ORDER BY created_at DESC LIMIT 1`, [params.id]);
      if (!p) throw notFound('Photo');
      await audit({ actor: user, action: 'task_photo.view', resourceType: 'task', resourceId: params.id, req });
      return { url: await createDownloadUrl(p.object_key) };
    },
  }),
  route({
    method: 'post',
    path: '/:id/review',
    summary: 'Approve a finished task, or send it back with a note',
    access: 'admin',
    params: idParams,
    scope: 'task',
    body: z.object({ decision: z.enum(['APPROVED', 'REOPENED']), note: z.string().trim().max(500).optional() }),
    handler: async ({ params, body, user, req }) => {
      if (body.decision === 'REOPENED' && !body.note) throw badRequest('NOTE_REQUIRED', 'Tell the employee what to fix.');
      const outbox = new Outbox();
      await tx(async (db) => {
        const t = await one(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [params.id], db);
        if (t.status !== 'SUBMITTED') throw conflict('NOT_SUBMITTED', 'Only finished tasks can be reviewed.');
        await q(`UPDATE tasks SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4, updated_at = now() WHERE id = $1`, [params.id, body.decision, user.id, body.note || null], db);
        await audit({ actor: user, action: `task.${body.decision.toLowerCase()}`, resourceType: 'task', resourceId: params.id, reason: body.note, req }, db);
        await notify(db, outbox, {
          type: 'TASK_REVIEWED',
          severity: 'INFO',
          audience: 'EMPLOYEE',
          title: body.decision === 'APPROVED' ? 'Task approved' : 'Task sent back',
          body: body.decision === 'APPROVED' ? `“${t.title}” is approved.` : `“${t.title}” needs another look: ${body.note}`,
          employeeId: t.assignee_id,
          data: { taskId: t.id, status: body.decision },
          dedupeKey: `task-reviewed:${t.id}:${Date.now()}`,
        });
      });
      outbox.flush();
      return loadTask(params.id);
    },
  }),
  route({
    method: 'post',
    path: '/:id/cancel',
    summary: 'Cancel a task',
    access: 'admin',
    params: idParams,
    scope: 'task',
    handler: async ({ params, user, req }) => {
      await q(`UPDATE tasks SET status = 'CANCELLED', updated_at = now() WHERE id = $1 AND status <> 'APPROVED'`, [params.id]);
      await audit({ actor: user, action: 'task.cancel', resourceType: 'task', resourceId: params.id, req });
      return loadTask(params.id);
    },
  }),
]);
