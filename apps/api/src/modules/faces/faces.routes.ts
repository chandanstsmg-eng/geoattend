/**
 * Face enrollment (employee, once) and face-check review (managers).
 *
 * Enrollment: five guided photos (front, left, right, up, down) are uploaded to private slots,
 * then submitted together. Each must show exactly one face, and the four turned photos must
 * look like the same person as the front one. The embeddings and photos become the employee's
 * primary face; re-enrolling needs an administrator to reset it first.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one, q, tx } from '../../db/pool.js';
import { config } from '../../config.js';
import { HttpError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { idParams, mount, route } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { siteFilter } from '../../lib/tenancy.js';
import { createDownloadUrl, createUploadUrl, inspectObject, newObjectKey, requestOrigin } from '../../lib/storage.js';
import { confirmUpload } from '../attendance/photo-upload.js';
import { correctAttendance, overrideFaceRejection } from '../attendance/attendance.service.js';
import { MODEL_NAME, faceEngine } from './engine.js';
import { readPhoto } from './faces.js';

export const POSES = ['FRONT', 'LEFT', 'RIGHT', 'UP', 'DOWN'] as const;
type Pose = (typeof POSES)[number];
const POSE_TEXT: Record<Pose, string> = {
  FRONT: 'looking straight at the camera',
  LEFT: 'turned to the left',
  RIGHT: 'turned to the right',
  UP: 'with the chin up',
  DOWN: 'with the chin down',
};
/** Turned or tilted photos of the same person still score well above this against the front one. */
const SAME_PERSON_MIN = 0.4;

export async function faceEnrollmentStatus(employeeId: string) {
  const p = await one(`SELECT enrolled_at, poses FROM employee_face_profiles WHERE employee_id = $1`, [employeeId]);
  return { enrolled: !!p, enrolledAt: p?.enrolled_at ?? null, matching: faceEngine.enabled(), poses: POSES };
}

export const facesRouter = Router();
mount(facesRouter, '/api/v1/faces', 'faces', [
  // ── employee ──
  route({
    method: 'get',
    path: '/me',
    summary: 'Whether my face is enrolled, and the poses to capture',
    access: 'employee',
    handler: async ({ user }) => faceEnrollmentStatus(user.id),
  }),
  route({
    method: 'post',
    path: '/me/photos',
    summary: 'Reserve a private upload slot for one enrollment photo',
    access: 'employee',
    body: z.object({ pose: z.enum(POSES), contentType: z.literal('image/jpeg'), sizeBytes: z.number().int().positive() }),
    handler: async ({ user, body, req, res }) => {
      if (await one('SELECT 1 FROM employee_face_profiles WHERE employee_id = $1', [user.id])) {
        throw conflict('ALREADY_ENROLLED', 'Your face is already enrolled. Ask your administrator to reset it if it needs to be taken again.');
      }
      if (body.sizeBytes > config.storage.maxPhotoBytes) throw new HttpError(413, 'PHOTO_TOO_LARGE', 'Photo is too large.');
      const key = newObjectKey(user.id, body.contentType);
      const p = await one(
        `INSERT INTO attendance_photos (employee_id, session_id, object_key, content_type, declared_bytes, idempotency_key, upload_expires_at, purpose)
         VALUES ($1, NULL, $2, $3, $4, $5, now() + make_interval(secs => $6), 'ENROLLMENT') RETURNING id`,
        [user.id, key, body.contentType, body.sizeBytes, `enroll:${body.pose}:${crypto.randomUUID()}`, config.storage.uploadUrlTtlSec],
      );
      res.status(201);
      return { photoId: p.id as string, upload: await createUploadUrl(key, body.contentType, body.sizeBytes, requestOrigin(req)) };
    },
  }),
  route({
    method: 'post',
    path: '/me/enroll',
    summary: 'Submit the five enrollment photos; they become my primary face',
    access: 'employee',
    body: z.object({
      photos: z.array(z.object({ pose: z.enum(POSES), photoId: z.uuid() })).length(POSES.length),
      deviceId: z.string().min(8).max(128).optional(),
    }),
    handler: async ({ user, body, req }) => {
      const byPose = new Map(body.photos.map((p) => [p.pose, p.photoId]));
      if (byPose.size !== POSES.length) throw badRequest('POSES_REQUIRED', 'One photo is needed for each of the five poses.');
      const rows = await q(`SELECT * FROM attendance_photos WHERE id = ANY($1::uuid[]) AND employee_id = $2 AND purpose = 'ENROLLMENT'`, [[...byPose.values()], user.id]);
      const photos = POSES.map((pose) => ({ pose, row: rows.find((r) => r.id === byPose.get(pose)) }));
      for (const p of photos) {
        if (!p.row || !(await confirmUpload('attendance_photos', p.row))) throw new HttpError(422, 'PHOTO_MISSING', `The photo ${POSE_TEXT[p.pose]} was not uploaded. Take it again.`, { pose: p.pose });
        const obj = await inspectObject(p.row.object_key);
        if (!obj || obj.type !== 'image/jpeg') throw new HttpError(422, 'PHOTO_INVALID', `The photo ${POSE_TEXT[p.pose]} could not be read. Take it again.`, { pose: p.pose });
      }

      // Fingerprint every pose; refuse photos without exactly one face, or that are not the same person.
      const embeddings: number[][] = [];
      if (faceEngine.enabled()) {
        for (const p of photos) {
          const r = await faceEngine.read(await readPhoto(p.row.object_key)).catch(() => null);
          if (!r || r.faces === 0 || !r.embedding) {
            throw new HttpError(422, r && r.faces > 1 ? 'MORE_THAN_ONE_FACE' : 'NO_FACE', r && r.faces > 1 ? `More than one face is in the photo ${POSE_TEXT[p.pose]}. Only you should be in the picture.` : `No clear face was found in the photo ${POSE_TEXT[p.pose]}. Use good light, remove sunglasses or a mask, and take it again.`, { pose: p.pose });
          }
          embeddings.push(r.embedding);
        }
        for (let i = 1; i < embeddings.length; i++) {
          if ((await faceEngine.similarity(embeddings[0]!, embeddings[i]!)) < SAME_PERSON_MIN) {
            throw new HttpError(422, 'NOT_SAME_PERSON', `The photo ${POSE_TEXT[photos[i]!.pose]} does not look like the same person as the front photo. Take all five photos again yourself.`, { pose: photos[i]!.pose });
          }
        }
      }

      await tx(async (db) => {
        const inserted = await one(
          `INSERT INTO employee_face_profiles (employee_id, poses, photo_ids, embeddings, model, device_id) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (employee_id) DO NOTHING RETURNING employee_id`,
          [user.id, POSES, photos.map((p) => p.row.id), JSON.stringify(embeddings), faceEngine.enabled() ? MODEL_NAME : 'none', body.deviceId ?? null],
          db,
        );
        if (!inserted) throw conflict('ALREADY_ENROLLED', 'Your face is already enrolled.');
        // Kept with the profile (no retention date) until an administrator resets the enrollment.
        await q(`UPDATE attendance_photos SET status = 'ATTACHED', retention_until = NULL WHERE id = ANY($1::uuid[])`, [photos.map((p) => p.row.id)], db);
      });
      await audit({ actor: user, action: 'face.enroll', resourceType: 'user', resourceId: user.id, after: { poses: POSES, matching: faceEngine.enabled() }, req });
      return faceEnrollmentStatus(user.id);
    },
  }),

  // ── administrators ──
  route({
    method: 'get',
    path: '/employees/:id',
    summary: "An employee's enrollment, with short-lived links to the photos (audited)",
    access: 'admin',
    params: idParams,
    scope: 'employee',
    handler: async ({ params, user, req }) => {
      const p = await one(`SELECT * FROM employee_face_profiles WHERE employee_id = $1`, [params.id]);
      if (!p) return { enrolled: false, matching: faceEngine.enabled() };
      const photos = await q(`SELECT id, object_key, status FROM attendance_photos WHERE id = ANY($1::uuid[])`, [p.photo_ids]);
      await audit({ actor: user, action: 'face_enrollment.view', resourceType: 'user', resourceId: params.id, req });
      return {
        enrolled: true,
        matching: faceEngine.enabled(),
        enrolledAt: p.enrolled_at,
        photos: await Promise.all(
          (p.poses as Pose[]).map(async (pose, i) => {
            const ph = photos.find((x) => x.id === p.photo_ids[i]);
            return { pose, url: ph && ph.status !== 'DELETED' ? await createDownloadUrl(ph.object_key) : null };
          }),
        ),
      };
    },
  }),
  route({
    method: 'post',
    path: '/employees/:id/reset',
    summary: 'Reset an enrollment so the employee takes the five photos again (reason required)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'employee',
    body: z.object({ reason: z.string().trim().min(3).max(500) }),
    handler: async ({ params, body, user, req }) => {
      const p = await one(`DELETE FROM employee_face_profiles WHERE employee_id = $1 RETURNING photo_ids`, [params.id]);
      if (!p) throw notFound('Face enrollment');
      // The old photos are removed by the retention job tonight.
      await q(`UPDATE attendance_photos SET retention_until = now() WHERE id = ANY($1::uuid[])`, [p.photo_ids]);
      await audit({ actor: user, action: 'face_enrollment.reset', resourceType: 'user', resourceId: params.id, reason: body.reason, req });
      return { enrolled: false };
    },
  }),
  route({
    method: 'get',
    path: '/reviews',
    summary: 'Attendance held because a start or end photo did not match the enrolled face',
    access: 'admin',
    handler: async ({ user }) =>
      q(
        `SELECT ar.id, ar.employee_id, ar.shift_date, ar.recorded_at, ar.workplace_id, ar.is_simulated,
                ar.face_status, ar.face_score, ar.end_face_status, ar.end_face_score, ar.challenge,
                u.full_name, ep.employee_code, w.name AS workplace_name, sh.name AS shift_name,
                (ar.photo_id IS NOT NULL AND sp.status <> 'DELETED') AS has_start_photo,
                (ar.end_photo_id IS NOT NULL AND np.status <> 'DELETED') AS has_end_photo
         FROM attendance_records ar
         JOIN users u ON u.id = ar.employee_id
         LEFT JOIN employee_profiles ep ON ep.user_id = u.id
         JOIN workplaces w ON w.id = ar.workplace_id
         JOIN shifts sh ON sh.id = ar.shift_id
         LEFT JOIN attendance_photos sp ON sp.id = ar.photo_id
         LEFT JOIN attendance_photos np ON np.id = ar.end_photo_id
         WHERE ar.face_review = 'PENDING' AND u.org_id = $1 AND ${siteFilter('ar.workplace_id', '$2')}
         ORDER BY ar.recorded_at DESC LIMIT 200`,
        [user.orgId, user.sites],
      ),
  }),
  route({
    method: 'post',
    path: '/reviews/:id/photos',
    summary: 'Short-lived links to compare: enrolled front photo, start and end photos (audited)',
    access: 'admin',
    params: idParams,
    scope: 'attendance',
    handler: async ({ params, user, req }) => {
      const r = await one(
        `SELECT ar.employee_id, sp.object_key AS start_key, sp.status AS start_status, np.object_key AS end_key, np.status AS end_status
         FROM attendance_records ar LEFT JOIN attendance_photos sp ON sp.id = ar.photo_id LEFT JOIN attendance_photos np ON np.id = ar.end_photo_id WHERE ar.id = $1`,
        [params.id],
      );
      if (!r) throw notFound('Attendance record');
      const front = await one(
        `SELECT p.object_key, p.status FROM employee_face_profiles f JOIN attendance_photos p ON p.id = f.photo_ids[1] WHERE f.employee_id = $1`,
        [r.employee_id],
      );
      await audit({ actor: user, action: 'face_review.view', resourceType: 'attendance_record', resourceId: params.id, req });
      const url = async (key: string | null, status: string | null) => (key && status && status !== 'DELETED' ? createDownloadUrl(key) : null);
      return { enrolled: await url(front?.object_key ?? null, front?.status ?? null), start: await url(r.start_key, r.start_status), end: await url(r.end_key, r.end_status) };
    },
  }),
  route({
    method: 'post',
    path: '/reviews/:id',
    summary: 'Decide a held record: approve keeps the attendance, reject marks the employee absent',
    access: 'admin',
    params: idParams,
    scope: 'attendance',
    body: z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(500).optional() }),
    handler: async ({ params, body, user, req }) => {
      if (body.decision === 'REJECT' && !body.note) throw badRequest('NOTE_REQUIRED', 'Say why the photo is rejected; the employee can see it in their history.');
      const r = await one(`SELECT id, face_review, employee_id FROM attendance_records WHERE id = $1`, [params.id]);
      if (!r) throw notFound('Attendance record');
      if (r.face_review !== 'PENDING') throw conflict('REVIEW_CLOSED', 'This face check has already been decided.');
      if (body.decision === 'REJECT') {
        // Voiding goes through the normal correction path, so it has history and an audit entry.
        await correctAttendance(user, params.id, { reason: `Face check rejected: ${body.note}`, verificationStatus: 'VOIDED' }, req);
      }
      await q(
        `UPDATE attendance_records SET face_review = $2, face_reviewed_by = $3, face_reviewed_at = now(), face_review_note = $4 WHERE id = $1`,
        [params.id, body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', user.id, body.note ?? null],
      );
      await audit({ actor: user, action: `face_review.${body.decision.toLowerCase()}`, resourceType: 'attendance_record', resourceId: params.id, reason: body.note, req });
      // A kept photo follows the normal retention period from here.
      return { id: params.id, faceReview: body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
    },
  }),
  route({
    method: 'post',
    path: '/reviews/:id/override',
    summary: 'Owner overrides a rejected face check: the attendance counts again (reason required, audited)',
    access: 'admin',
    ownerOnly: true,
    params: idParams,
    scope: 'attendance',
    body: z.object({ reason: z.string().trim().min(5).max(500) }),
    handler: async ({ params, body, user, req }) => {
      const r = await overrideFaceRejection(user, params.id, body.reason, req);
      return { id: r.id, verificationStatus: r.verification_status, faceReview: r.face_review };
    },
  }),
]);
