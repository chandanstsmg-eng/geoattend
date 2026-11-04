import express, { Router } from 'express';
import { z } from 'zod';
import { one, q } from '../../db/pool.js';
import { config } from '../../config.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { idParams, isoDate, mount, paging, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { assertInOrg, employeeSite, siteFilter } from '../../lib/tenancy.js';
import { createDownloadUrl, deleteObject, detectImageType, readLocalObject, requestOrigin, verifyToken, writeLocalObject } from '../../lib/storage.js';
import { readingSchema } from '../tracking/tracking.routes.js';
import { correctAttendance, createIntent, createManualAttendance, resolveReview, submitAttendance } from './attendance.service.js';

export const attendanceRouter = Router();
mount(attendanceRouter, '/api/v1/attendance', 'attendance', [
  route({
    method: 'post',
    path: '/intents',
    summary: 'Reserve a private photo upload (only when attendance is ready)',
    access: 'employee',
    body: z.object({
      sessionId: z.uuid(),
      idempotencyKey: z.string().min(16).max(100),
      contentType: z.enum(['image/jpeg', 'image/png']),
      sizeBytes: z.number().int().positive(),
    }),
    handler: async ({ user, body, req, res }) => {
      res.status(201);
      return createIntent(user.id, body, requestOrigin(req));
    },
  }),
  route({
    method: 'post',
    path: '/',
    summary: 'Submit attendance (server re-verifies eligibility; idempotent by idempotencyKey)',
    access: 'employee',
    body: z.object({
      sessionId: z.uuid(),
      photoId: z.uuid(),
      idempotencyKey: z.string().min(16).max(100),
      evidence: readingSchema,
      device: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).optional(),
    }),
    handler: async ({ user, body, res }) => {
      const { record, replay } = await submitAttendance(user.id, body);
      res.status(replay ? 200 : 201);
      return { attendance: { id: record.id, recordedAt: record.recorded_at, verificationStatus: record.verification_status, isLate: record.is_late, lateByMinutes: record.late_by_minutes }, replay };
    },
  }),

  // ── admin ──
  route({
    method: 'get',
    path: '/',
    summary: 'Attendance records with filters',
    access: 'admin',
    query: z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      workplaceId: z.uuid().optional(),
      employeeId: z.uuid().optional(),
      shiftId: z.uuid().optional(),
      status: z.enum(['VERIFIED', 'MANUAL_APPROVED', 'CORRECTED', 'DISPUTED', 'VOIDED']).optional(),
      late: z.enum(['true', 'false']).optional(),
      ...paging,
    }),
    handler: async ({ query, user }) => {
      // $8 = company, $9 = supervisor's sites (null for owners); limit/offset follow.
      const where = `ar.employee_id IN (SELECT id FROM users WHERE org_id = $8) AND ${siteFilter('ar.workplace_id', '$9')}
        AND ($1::date IS NULL OR ar.shift_date >= $1) AND ($2::date IS NULL OR ar.shift_date <= $2) AND ($3::uuid IS NULL OR ar.workplace_id = $3)
        AND ($4::uuid IS NULL OR ar.employee_id = $4) AND ($5::uuid IS NULL OR ar.shift_id = $5) AND ($6::text IS NULL OR ar.verification_status = $6)
        AND ($7::boolean IS NULL OR ar.is_late = $7)`;
      const params = [query.from ?? null, query.to ?? null, query.workplaceId ?? null, query.employeeId ?? null, query.shiftId ?? null, query.status ?? null, query.late === undefined ? null : query.late === 'true', user.orgId, user.sites];
      const rows = await q(
        // Check-out, worked time and approved overtime come from the same attendance_work view the
        // hours reports use, so the list and the exports always agree.
        `SELECT ar.*, u.full_name, ep.employee_code, w.name AS workplace_name, sh.name AS shift_name,
                p.status AS photo_status, p.deleted_at AS photo_deleted_at,
                s.ended_at AS checked_out_at, aw.worked_minutes, aw.overtime_minutes, aw.overtime_status, aw.in_progress, aw.break_minutes,
                (s.authorization_status = 'EXPIRED' OR (s.ended_at IS NULL AND s.state <> 'ON_OVERTIME' AND s.scheduled_end_at < now())) AS incomplete
         FROM attendance_records ar JOIN users u ON u.id = ar.employee_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id
         JOIN workplaces w ON w.id = ar.workplace_id JOIN shifts sh ON sh.id = ar.shift_id LEFT JOIN attendance_photos p ON p.id = ar.photo_id
         LEFT JOIN tracking_sessions s ON s.id = ar.session_id LEFT JOIN attendance_work aw ON aw.attendance_id = ar.id
         WHERE ${where} ORDER BY ar.shift_date DESC, ar.recorded_at DESC LIMIT $10 OFFSET $11`,
        [...params, query.limit, query.offset],
      );
      // Exception counts over every record matching the filters (not just this page). A record can
      // be in several of them (e.g. late and missing a check-out), so they are not added up.
      const summary = await one(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE ar.verification_status = 'VERIFIED')::int AS verified,
                count(*) FILTER (WHERE ar.is_late)::int AS late,
                count(*) FILTER (WHERE s.authorization_status = 'EXPIRED' OR (s.ended_at IS NULL AND s.state <> 'ON_OVERTIME' AND s.scheduled_end_at < now()))::int AS missing_checkout,
                count(*) FILTER (WHERE cardinality(array_remove(array_remove(COALESCE(ar.risk_flags, '{}'::text[]), 'SIMULATED'), 'BACKGROUND_LOCATION_UNAVAILABLE')) > 0)::int AS location_exceptions,
                count(*) FILTER (WHERE ar.verification_status = 'DISPUTED')::int AS disputed,
                count(*) FILTER (WHERE ar.session_id IS NULL)::int AS manual
         FROM attendance_records ar LEFT JOIN tracking_sessions s ON s.id = ar.session_id WHERE ${where}`,
        params,
      );
      return { items: rows, total: summary.total, summary };
    },
  }),
  route({
    method: 'get',
    path: '/reviews',
    summary: 'Review requests, disputes, technical issues and corrections',
    access: 'admin',
    query: z.object({ status: z.enum(['OPEN', 'APPROVED', 'REJECTED', 'CANCELLED', 'APPLIED', 'ACKNOWLEDGED']).optional(), kind: z.enum(['MANUAL_REVIEW', 'TECHNICAL_ISSUE', 'DISPUTE', 'ADMIN_CORRECTION']).optional(), attendanceId: z.uuid().optional() }),
    handler: async ({ query, user }) =>
      q(
        `SELECT r.*, u.full_name, rb.full_name AS resolved_by_name FROM review_requests r JOIN users u ON u.id = r.employee_id LEFT JOIN users rb ON rb.id = r.resolved_by
         WHERE u.org_id = $4 AND ${siteFilter(employeeSite('u.id'), '$5')} AND ($1::text IS NULL OR r.status = $1) AND ($2::text IS NULL OR r.kind = $2) AND ($3::uuid IS NULL OR r.attendance_id = $3)
         ORDER BY r.created_at DESC LIMIT 200`,
        [query.status ?? null, query.kind ?? null, query.attendanceId ?? null, user.orgId, user.sites],
      ),
  }),
  route({
    method: 'post',
    path: '/reviews/:id/resolve',
    summary: 'Approve / reject / acknowledge a review request',
    access: 'admin',
    params: idParams,
    scope: 'review',
    body: z.object({ decision: z.enum(['APPROVE', 'REJECT', 'ACKNOWLEDGE']), note: z.string().trim().min(3).max(1000) }),
    handler: async ({ user, params, body, req }) => resolveReview(user, params.id, body.decision, body.note, req),
  }),
  route({
    method: 'post',
    path: '/manual',
    summary: 'Create an attendance record without device evidence (audited, MANUAL_APPROVED)',
    access: 'admin',
    body: z.object({ employeeId: z.uuid(), shiftId: z.uuid(), shiftDate: isoDate, recordedAt: z.iso.datetime({ offset: true }), workedMinutes: z.number().int().min(0).max(1440).optional(), reason: z.string().trim().min(5).max(1000) }),
    handler: async ({ user, body, req, res }) => {
      await assertInOrg('employee', body.employeeId, user.orgId, user.sites);
      await assertInOrg('shift', body.shiftId, user.orgId, user.sites);
      res.status(201);
      return createManualAttendance(user, body, req);
    },
  }),
  route({
    method: 'get',
    path: '/:id',
    summary: 'Attendance record with review history',
    access: 'admin',
    params: idParams,
    scope: 'attendance',
    handler: async ({ params }) => {
      const rec = await one(
        `SELECT ar.*, u.full_name, ep.employee_code, w.name AS workplace_name, w.latitude AS wp_lat, w.longitude AS wp_lng, sh.name AS shift_name, p.status AS photo_status, p.retention_until AS photo_retention_until
         FROM attendance_records ar JOIN users u ON u.id = ar.employee_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id
         JOIN workplaces w ON w.id = ar.workplace_id JOIN shifts sh ON sh.id = ar.shift_id LEFT JOIN attendance_photos p ON p.id = ar.photo_id WHERE ar.id = $1`,
        [params.id],
      );
      if (!rec) throw notFound('Attendance record');
      const history = await q(`SELECT r.*, a.full_name AS by_name FROM review_requests r LEFT JOIN users a ON a.id = COALESCE(r.resolved_by, r.requested_by) WHERE r.attendance_id = $1 ORDER BY r.created_at`, [params.id]);
      return { record: rec, history };
    },
  }),
  route({
    method: 'post',
    path: '/photo-thumbnails',
    summary: 'Short-lived signed URLs for the photos of up to 50 attendance records on screen (one audit entry)',
    access: 'admin',
    body: z.object({ ids: z.array(z.uuid()).min(1).max(50) }),
    handler: async ({ body, user, req }) => {
      // Only records this administrator may see: same company and, for supervisors, their sites.
      const rows = await q(
        `SELECT ar.id, p.id AS photo_id, p.object_key FROM attendance_records ar JOIN attendance_photos p ON p.id = ar.photo_id
         WHERE ar.id = ANY($1::uuid[]) AND p.status = 'ATTACHED' AND NOT p.is_simulated
           AND ar.employee_id IN (SELECT id FROM users WHERE org_id = $2) AND ${siteFilter('ar.workplace_id', '$3')}`,
        [body.ids, user.orgId, user.sites],
      );
      if (rows.length) {
        await audit({ actor: user, action: 'attendance_photo.view_list', resourceType: 'attendance_photo', resourceId: null, after: { photos: rows.map((r) => r.photo_id) }, req });
      }
      const urls: Record<string, string> = {};
      for (const r of rows) urls[r.id] = await createDownloadUrl(r.object_key);
      return { urls, expiresInSec: config.storage.downloadUrlTtlSec };
    },
  }),
  route({
    method: 'post',
    path: '/:id/photo-url',
    summary: 'Short-lived signed URL for the attendance photo (access is audited)',
    access: 'admin',
    params: idParams,
    scope: 'attendance',
    handler: async ({ params, user, req }) => {
      const p = await one(`SELECT p.* FROM attendance_records ar JOIN attendance_photos p ON p.id = ar.photo_id WHERE ar.id = $1`, [params.id]);
      if (!p) throw notFound('Photo');
      if (p.status === 'DELETED') throw new HttpError(410, 'PHOTO_DELETED', `Photo deleted (${p.deleted_reason ?? 'retention'}).`);
      await audit({ actor: user, action: 'attendance_photo.view', resourceType: 'attendance_photo', resourceId: p.id, req });
      return { url: await createDownloadUrl(p.object_key), expiresInSec: config.storage.downloadUrlTtlSec, isSimulated: p.is_simulated };
    },
  }),
  route({
    method: 'post',
    path: '/:id/reference-photo-url',
    summary: "Short-lived URL of the employee's enrolled front photo, to compare side by side (audited)",
    access: 'admin',
    params: idParams,
    scope: 'attendance',
    handler: async ({ params, user, req }) => {
      const ref = await one(
        `SELECT p.*, f.enrolled_at FROM attendance_records ar JOIN employee_face_profiles f ON f.employee_id = ar.employee_id
         JOIN attendance_photos p ON p.id = f.photo_ids[1] WHERE ar.id = $1`,
        [params.id],
      );
      if (!ref || ref.status === 'DELETED') return { url: null };
      await audit({ actor: user, action: 'reference_photo.view', resourceType: 'attendance_photo', resourceId: ref.id, req });
      return { url: await createDownloadUrl(ref.object_key), setAt: ref.enrolled_at, enrolled: true };
    },
  }),
  route({
    method: 'post',
    path: '/:id/end-photo-url',
    summary: 'Short-lived signed URL for the end-of-shift photo (access is audited)',
    access: 'admin',
    params: idParams,
    scope: 'attendance',
    handler: async ({ params, user, req }) => {
      const p = await one(`SELECT p.* FROM attendance_records ar JOIN attendance_photos p ON p.id = ar.end_photo_id WHERE ar.id = $1`, [params.id]);
      if (!p) throw notFound('Photo');
      if (p.status === 'DELETED') throw new HttpError(410, 'PHOTO_DELETED', `Photo deleted (${p.deleted_reason ?? 'retention'}).`);
      await audit({ actor: user, action: 'attendance_photo.view', resourceType: 'attendance_photo', resourceId: p.id, req });
      return { url: await createDownloadUrl(p.object_key), expiresInSec: config.storage.downloadUrlTtlSec };
    },
  }),
  route({
    method: 'post',
    path: '/:id/photo/delete',
    summary: 'Delete an attendance photo before its retention date (reason required, audited)',
    access: 'admin',
    params: idParams,
    scope: 'attendance',
    body: z.object({ reason: z.string().trim().min(5).max(500) }),
    handler: async ({ params, body, user, req }) => {
      const p = await one(`SELECT p.* FROM attendance_records ar JOIN attendance_photos p ON p.id = ar.photo_id WHERE ar.id = $1`, [params.id]);
      if (!p) throw notFound('Photo');
      if (p.status !== 'DELETED') {
        await deleteObject(p.object_key);
        await q(`UPDATE attendance_photos SET status = 'DELETED', deleted_at = now(), deleted_reason = $2 WHERE id = $1`, [p.id, body.reason]);
        await audit({ actor: user, action: 'attendance_photo.delete', resourceType: 'attendance_photo', resourceId: p.id, reason: body.reason, req });
      }
      return { ok: true };
    },
  }),
  route({
    method: 'post',
    path: '/:id/corrections',
    summary: 'Correct an attendance record (mandatory reason, audited)',
    access: 'admin',
    params: idParams,
    scope: 'attendance',
    body: z.object({
      reason: z.string().trim().min(5).max(1000),
      verificationStatus: z.enum(['VERIFIED', 'MANUAL_APPROVED', 'CORRECTED', 'DISPUTED', 'VOIDED']).optional(),
      recordedAt: z.iso.datetime({ offset: true }).optional(),
      isLate: z.boolean().optional(),
      lateByMinutes: z.number().int().min(0).max(1440).optional(),
    }),
    handler: async ({ user, params, body, req }) => correctAttendance(user, params.id, body, req),
  }),
]);

// ── local storage driver endpoints (token-authorised, no session needed) ──
export const storageRouter = Router();
storageRouter.put('/upload', express.raw({ type: ['image/jpeg', 'image/png'], limit: config.storage.maxPhotoBytes }), async (req, res, next) => {
  try {
    if (config.storage.driver !== 'local') throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const t = verifyToken(String(req.query.token ?? ''), 'put');
    const ct = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (ct !== t.ct) throw new HttpError(415, 'WRONG_TYPE', 'Content type does not match the upload slot.');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'EMPTY', 'Empty upload');
    if (body.length > (t.max ?? config.storage.maxPhotoBytes)) throw new HttpError(413, 'TOO_LARGE', 'Photo too large');
    if (detectImageType(body) !== t.ct) throw new HttpError(415, 'NOT_AN_IMAGE', 'File is not a valid image of the declared type.');
    // An upload slot belongs to an attendance photo or a task photo.
    const att = await one(`SELECT id, status FROM attendance_photos WHERE object_key = $1`, [t.key]);
    const task = att ? null : await one(`SELECT id, status FROM task_photos WHERE object_key = $1`, [t.key]);
    const p = att ?? task;
    if (!p || p.status !== 'PENDING_UPLOAD') throw new HttpError(409, 'SLOT_CLOSED', 'This upload slot is no longer open.');
    try {
      await writeLocalObject(t.key, body);
    } catch (err: any) {
      if (err?.code === 'EEXIST') throw new HttpError(409, 'ALREADY_UPLOADED', 'This upload slot has already been used.');
      throw err;
    }
    if (att) await q(`UPDATE attendance_photos SET status = 'UPLOADED', uploaded_at = now(), size_bytes = $2 WHERE id = $1`, [p.id, body.length]);
    else await q(`UPDATE task_photos SET status = 'UPLOADED' WHERE id = $1`, [p.id]);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
storageRouter.get('/object', async (req, res, next) => {
  try {
    if (config.storage.driver !== 'local') throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const t = verifyToken(String(req.query.token ?? ''), 'get');
    const buf = await readLocalObject(t.key).catch(() => null);
    if (!buf) throw new HttpError(404, 'NOT_FOUND', 'Photo not found');
    res.setHeader('Content-Type', detectImageType(buf) ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buf);
  } catch (err) {
    next(err);
  }
});
