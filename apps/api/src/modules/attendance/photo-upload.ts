import { config } from '../../config.js';
import { q, type Queryable } from '../../db/pool.js';
import { inspectObject } from '../../lib/storage.js';

/**
 * Whether a reserved photo really is in storage. The local driver marks a photo UPLOADED when it
 * receives the file. With S3 the phone uploads straight to the bucket and the API hears nothing,
 * so the object itself is checked here (it exists, is a real image of the declared type, is an
 * acceptable size) and only then is the photo marked UPLOADED.
 */
export async function confirmUpload(table: 'attendance_photos' | 'task_photos', p: any, db?: Queryable) {
  if (p.status === 'UPLOADED') return true;
  if (p.status !== 'PENDING_UPLOAD') return false;
  const obj = await inspectObject(p.object_key);
  if (!obj || obj.sizeBytes === 0 || obj.sizeBytes > config.storage.maxPhotoBytes || obj.type !== p.content_type) return false;
  if (table === 'attendance_photos') await q(`UPDATE attendance_photos SET status = 'UPLOADED', uploaded_at = now(), size_bytes = $2 WHERE id = $1`, [p.id, obj.sizeBytes], db);
  else await q(`UPDATE task_photos SET status = 'UPLOADED' WHERE id = $1`, [p.id], db);
  p.status = 'UPLOADED';
  return true;
}
