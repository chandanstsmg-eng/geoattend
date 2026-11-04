/**
 * Face check for shift photos.
 *
 *  - Primary face: on first use the employee enrolls five guided photos (front, left, right,
 *    up, down). Their embeddings are the reference; the photos are kept until an admin resets
 *    the enrollment. See faces.routes.ts.
 *  - Each start-of-shift (attendance) and end-of-shift photo is compared with the enrollment by
 *    the sweeper, a few per tick. A MATCH keeps the photo as evidence until the retention period (unless the company turns
 *    off workforce.keepMatchedPhotos: then only the result is kept). A MISMATCH or NO_FACE keeps the photo and holds the attendance record
 *    for a manager (face_review = PENDING): approving keeps it, rejecting voids it (absent).
 *  - Liveness instruction: when attendance unlocks, the app shows an instruction picked for
 *    this session ("Hold up 2 fingers"…), stored with the record for the reviewer.
 *
 * A failed match is a prompt to look, never proof: lighting, glasses or a new beard can lower
 * the score, which is why a person decides.
 */
import crypto from 'node:crypto';
import { getPool, one, q } from '../../db/pool.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { deleteObject, readObject } from '../../lib/storage.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { bestMatch, faceEngine } from './engine.js';
import { getSettings, photoDeletionAllowed } from '../settings/settings.service.js';

export const CHALLENGES = [
  { en: 'Hold up two fingers', hi: 'दो उंगलियाँ दिखाएँ' },
  { en: 'Show a thumbs-up', hi: 'अंगूठा ऊपर दिखाएँ' },
  { en: 'Touch your left ear', hi: 'अपना बायाँ कान छुएँ' },
  { en: 'Put your hand on your head', hi: 'हाथ सिर पर रखें' },
  { en: 'Hold up three fingers', hi: 'तीन उंगलियाँ दिखाएँ' },
  { en: 'Hand on your chin', hi: 'हाथ ठोड़ी पर रखें' },
  { en: 'Show an open palm', hi: 'खुली हथेली दिखाएँ' },
  { en: 'Point at the camera', hi: 'कैमरे की ओर उंगली करें' },
] as const;

/** The instruction for a shift session: fixed for the session, unpredictable before it starts. */
export function challengeFor(sessionId: string) {
  const h = crypto.createHmac('sha256', config.jwtSecret || 'geoattend').update(`challenge:${sessionId}`).digest();
  return CHALLENGES[h.readUInt32BE(0) % CHALLENGES.length]!;
}

export async function readPhoto(key: string): Promise<Buffer> {
  return readObject(key);
}

/** Deletes a checked photo's file and marks the row, keeping the record of what happened. */
export async function discardPhoto(photoId: string, objectKey: string, reason: string) {
  await deleteObject(objectKey);
  await q(`UPDATE attendance_photos SET status = 'DELETED', deleted_at = now(), deleted_reason = $2 WHERE id = $1`, [photoId, reason]);
}

type Status = 'MATCH' | 'MISMATCH' | 'NO_FACE' | 'NOT_CHECKED' | 'NO_PHOTO' | 'ERROR' | 'NOT_ENROLLED';

/** Compares one photo with the employee's enrollment. */
async function check(employeeId: string, objectKey: string): Promise<{ status: Status; score: number | null }> {
  const profile = await one(`SELECT embeddings FROM employee_face_profiles WHERE employee_id = $1`, [employeeId]);
  if (!profile) return { status: 'NOT_ENROLLED', score: null };
  const enrolled = (profile.embeddings as number[][]).filter((e) => e?.length);
  if (!faceEngine.enabled() || enrolled.length === 0) return { status: 'NOT_CHECKED', score: null };
  const reading = await faceEngine.read(await readPhoto(objectKey)).catch(() => null);
  if (!reading || reading.faces !== 1 || !reading.embedding) return { status: 'NO_FACE', score: null };
  const score = await bestMatch(reading.embedding, enrolled);
  return { status: score >= config.faceMatch.threshold ? 'MATCH' : 'MISMATCH', score };
}

/** Checks pending start- and end-of-shift photos (a few per sweep). */
export async function sweepFaceChecks(limit = 10) {
  const due = await q(
    `SELECT ar.id, ar.employee_id, ar.workplace_id, ar.is_simulated, u.full_name, u.org_id,
            ar.face_status IS NULL AS start_due, ar.photo_id, sp.object_key AS start_key, sp.status AS start_photo_status,
            (ar.end_photo_id IS NOT NULL AND ar.end_face_status IS NULL) AS end_due, ar.end_photo_id, ep.object_key AS end_key, ep.status AS end_photo_status
     FROM attendance_records ar
     JOIN users u ON u.id = ar.employee_id
     LEFT JOIN attendance_photos sp ON sp.id = ar.photo_id
     LEFT JOIN attendance_photos ep ON ep.id = ar.end_photo_id
     WHERE (ar.face_status IS NULL OR (ar.end_photo_id IS NOT NULL AND ar.end_face_status IS NULL)) AND ar.created_at > now() - interval '3 days'
     ORDER BY ar.created_at LIMIT $1`,
    [limit],
  );
  const outbox = new Outbox();
  for (const r of due) {
    for (const which of ['start', 'end'] as const) {
      if (!r[`${which}_due`]) continue;
      const col = which === 'start' ? 'face' : 'end_face';
      const set = (status: Status, score: number | null = null) =>
        q(`UPDATE attendance_records SET ${col}_status = $2, ${col}_score = $3, ${col}_checked_at = now() WHERE id = $1`, [r.id, status, score]);
      const photoId = which === 'start' ? r.photo_id : r.end_photo_id;
      const key = r[`${which}_key`];
      try {
        if (!photoId || r[`${which}_photo_status`] !== 'ATTACHED') {
          await set('NO_PHOTO');
          continue;
        }
        const result = r.is_simulated ? { status: 'NOT_CHECKED' as const, score: null } : await check(r.employee_id, key);
        await set(result.status, result.score);
        if (result.status === 'MATCH') {
          // Verified. The photo stays as evidence until the retention period ends, unless the
          // company chose to keep only the result and the score.
          const settings = await getSettings(r.org_id);
          if (!settings.workforce.keepMatchedPhotos && photoDeletionAllowed(settings)) await discardPhoto(photoId, key, 'face matched — photo not kept');
        } else if (result.status === 'MISMATCH' || result.status === 'NO_FACE') {
          await q(
            `UPDATE attendance_records SET face_review = 'PENDING', risk_flags = CASE WHEN $2 = ANY(risk_flags) THEN risk_flags ELSE array_append(risk_flags, $2) END
             WHERE id = $1 AND face_review IS DISTINCT FROM 'REJECTED'`,
            [r.id, result.status === 'NO_FACE' ? 'NO_FACE' : 'FACE_MISMATCH'],
          );
          const when = which === 'start' ? 'start-of-shift' : 'end-of-shift';
          await notify(getPool(), outbox, {
            type: 'FACE_MISMATCH',
            severity: 'WARNING',
            body:
              result.status === 'NO_FACE'
                ? `${r.full_name}'s ${when} photo shows no single clear face. Review it in Approvals: approve to keep the attendance, or reject to mark absent.`
                : `${r.full_name}'s ${when} photo does not match their enrolled face (similarity ${Math.round(result.score ?? 0)}%). Review it in Approvals — this is a prompt to check, not proof.`,
            employeeId: r.employee_id,
            workplaceId: r.workplace_id,
            data: { attendanceId: r.id, which, score: result.score },
            dedupeKey: `face:${r.id}:${which}`,
            simulated: r.is_simulated,
          });
        }
      } catch (err) {
        logger.warn({ err, attendanceId: r.id, which }, 'face check failed');
        await set('ERROR');
        // An unchecked photo must not pass as checked (GPS-07): a manager looks at it in Approvals.
        await q(
          `UPDATE attendance_records SET face_review = 'PENDING', risk_flags = CASE WHEN 'FACE_CHECK_FAILED' = ANY(risk_flags) THEN risk_flags ELSE array_append(risk_flags, 'FACE_CHECK_FAILED') END
           WHERE id = $1 AND face_review IS DISTINCT FROM 'REJECTED' AND face_review IS DISTINCT FROM 'APPROVED'`,
          [r.id],
        ).catch(() => undefined);
      }
    }
  }
  outbox.flush();
  await sweepOvertimeFaceChecks(limit);
}

/**
 * Overtime start / end selfies are compared the same way, but kept either way: they are the
 * proof the approver looks at (deleted by retention). A mismatch is flagged for the approver.
 */
async function sweepOvertimeFaceChecks(limit: number) {
  const due = await q(
    `SELECT o.id, o.employee_id, o.workplace_id, o.is_simulated, u.full_name,
            o.start_face_status IS NULL AS start_due, o.start_photo_id, sp.object_key AS start_key, sp.status AS start_photo_status,
            (o.end_photo_id IS NOT NULL AND o.end_face_status IS NULL) AS end_due, o.end_photo_id, ep.object_key AS end_key, ep.status AS end_photo_status
     FROM overtime_entries o
     JOIN users u ON u.id = o.employee_id
     LEFT JOIN attendance_photos sp ON sp.id = o.start_photo_id
     LEFT JOIN attendance_photos ep ON ep.id = o.end_photo_id
     WHERE (o.start_face_status IS NULL OR (o.end_photo_id IS NOT NULL AND o.end_face_status IS NULL)) AND o.created_at > now() - interval '3 days'
     ORDER BY o.created_at LIMIT $1`,
    [limit],
  );
  const outbox = new Outbox();
  for (const r of due) {
    for (const which of ['start', 'end'] as const) {
      if (!r[`${which}_due`]) continue;
      const set = (status: Status, score: number | null = null) => q(`UPDATE overtime_entries SET ${which}_face_status = $2, ${which}_face_score = $3 WHERE id = $1`, [r.id, status, score]);
      try {
        if (!r[`${which}_photo_id`] || r[`${which}_photo_status`] !== 'ATTACHED') {
          await set('NO_PHOTO');
          continue;
        }
        const result = r.is_simulated ? { status: 'NOT_CHECKED' as const, score: null } : await check(r.employee_id, r[`${which}_key`]);
        await set(result.status, result.score);
        if (result.status === 'MISMATCH' || result.status === 'NO_FACE') {
          await notify(getPool(), outbox, {
            type: 'FACE_MISMATCH',
            severity: 'WARNING',
            body:
              result.status === 'NO_FACE'
                ? `${r.full_name}'s overtime ${which} photo shows no single clear face. Check it on the Overtime page before approving.`
                : `${r.full_name}'s overtime ${which} photo does not match their enrolled face (similarity ${Math.round(result.score ?? 0)}%). Check it on the Overtime page before approving — this is a prompt to look, not proof.`,
            employeeId: r.employee_id,
            workplaceId: r.workplace_id,
            data: { overtimeId: r.id, which, score: result.score },
            dedupeKey: `face-ot:${r.id}:${which}`,
            simulated: r.is_simulated,
          });
        }
      } catch (err) {
        logger.warn({ err, overtimeId: r.id, which }, 'overtime face check failed');
        await set('ERROR');
      }
    }
  }
  outbox.flush();
}
