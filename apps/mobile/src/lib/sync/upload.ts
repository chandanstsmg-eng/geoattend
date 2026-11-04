/** Sends a photo to its private upload slot. Failures are ApiErrors the capture screen and the outbox both understand. */
import { File, UploadType } from 'expo-file-system';
import { ApiError } from '../api/client';
import type { IntentResponse } from '../api/types';

export async function putPhoto(uri: string, upload: IntentResponse['upload']): Promise<void> {
  let put;
  try {
    put = await new File(uri).upload(upload.url, { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: upload.headers });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The photo upload did not complete.');
  }
  if (put.status === 409 && put.body.includes('ALREADY_UPLOADED')) return; // a previous try already stored this slot
  if (put.status >= 200 && put.status < 300) return;
  let code = `UPLOAD_${put.status}`;
  let message = `The photo upload failed (${put.status}).`;
  try {
    const b = JSON.parse(put.body);
    code = b?.error?.code ?? code;
    message = b?.error?.message ?? message;
  } catch {
    /* S3 XML or empty body */
  }
  if (put.status === 413 || code === 'TOO_LARGE' || code === 'NOT_AN_IMAGE' || code === 'WRONG_TYPE') throw new ApiError(422, 'PHOTO_INVALID', message);
  if (code === 'SLOT_CLOSED' || put.status === 403) throw new ApiError(422, 'PHOTO_EXPIRED', 'The upload slot expired.');
  throw new ApiError(put.status >= 500 ? 0 : put.status, code, message);
}
