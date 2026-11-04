/**
 * Photo storage against a real S3-compatible server. Skipped unless S3_TEST_ENDPOINT is set:
 *   S3_TEST_ENDPOINT=http://127.0.0.1:8333 S3_TEST_BUCKET=geoattend-test S3_TEST_ACCESS_KEY=... S3_TEST_SECRET_KEY=... npm test
 * Nothing here is mocked: every upload, download and delete goes to that server.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../src/config.js';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { createDownloadUrl, deleteObject, inspectObject, readObject, resetStorageClients } from '../src/lib/storage.js';
import { confirmUpload } from '../src/modules/attendance/photo-upload.js';
import { createEmployee, createTestDatabase, fakeJpeg, mobileLogin, seedBase } from './helpers.js';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? 'geoattend-test';
const accessKeyId = process.env.S3_TEST_ACCESS_KEY ?? '';
const secretAccessKey = process.env.S3_TEST_SECRET_KEY ?? '';

describe.skipIf(!endpoint)('S3 photo storage (real server)', () => {
  let app: Express;
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let base: Awaited<ReturnType<typeof seedBase>>;
  const saved = { ...config.storage };
  const provider = config.faceMatch.provider;
  const direct = () => new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const POSES = ['FRONT', 'LEFT', 'RIGHT', 'UP', 'DOWN'];

  beforeAll(async () => {
    Object.assign(config.storage, { driver: 's3', s3Endpoint: endpoint, s3PublicEndpoint: '', s3Bucket: bucket, s3Region: 'us-east-1', s3AccessKeyId: accessKeyId, s3SecretAccessKey: secretAccessKey, s3ForcePathStyle: true });
    config.faceMatch.provider = 'off';
    resetStorageClients();
    await direct().send(new CreateBucketCommand({ Bucket: bucket })).catch(() => undefined);
    db = await createTestDatabase();
    base = await seedBase();
    app = createApp();
  });
  afterAll(async () => {
    Object.assign(config.storage, saved);
    config.faceMatch.provider = provider;
    resetStorageClients();
    await db.drop();
  });

  const slot = async (token: string, pose: string, bytes: Buffer) =>
    (await request(app).post('/api/v1/faces/me/photos').set(bearer(token)).send({ pose, contentType: 'image/jpeg', sizeBytes: bytes.length }).expect(201)).body;
  const put = (url: string, body: Buffer, type = 'image/jpeg') => fetch(url, { method: 'PUT', headers: { 'Content-Type': type }, body: new Uint8Array(body) });

  it('enrols a face from photos uploaded straight to the bucket (it always failed on S3 before)', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await mobileLogin(app, emp.email);
    const photos = [];
    for (const pose of POSES) {
      const bytes = fakeJpeg();
      const s = await slot(token, pose, bytes);
      expect(new URL(s.upload.url).host).toBe(new URL(endpoint!).host);
      expect((await put(s.upload.url, bytes)).ok).toBe(true);
      photos.push({ pose, photoId: s.photoId });
    }
    const res = await request(app).post('/api/v1/faces/me/enroll').set(bearer(token)).send({ photos });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const rows = await q(`SELECT status, size_bytes, uploaded_at FROM attendance_photos WHERE employee_id = $1`, [emp.id]);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.uploaded_at).toBeTruthy();
  });

  it('says a photo is missing when nothing reached the bucket, and never marks it uploaded', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await mobileLogin(app, emp.email);
    const photos = [];
    for (const pose of POSES) photos.push({ pose, photoId: (await slot(token, pose, fakeJpeg())).photoId });
    const res = await request(app).post('/api/v1/faces/me/enroll').set(bearer(token)).send({ photos });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PHOTO_MISSING');
    expect((await one(`SELECT count(*)::int AS n FROM attendance_photos WHERE employee_id = $1 AND status = 'UPLOADED'`, [emp.id])).n).toBe(0);
  });

  it('refuses a file that is not really an image', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await mobileLogin(app, emp.email);
    const bytes = Buffer.from('<script>not a photo</script>'.padEnd(200, ' '));
    const s = await slot(token, 'FRONT', bytes);
    expect((await put(s.upload.url, bytes)).ok).toBe(true);
    const p = await one(`SELECT * FROM attendance_photos WHERE id = $1`, [s.photoId]);
    expect(await confirmUpload('attendance_photos', p)).toBe(false);
    expect((await one(`SELECT status FROM attendance_photos WHERE id = $1`, [s.photoId])).status).toBe('PENDING_UPLOAD');
  });

  it('rejects an upload of a different size or type than the signed slot', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await mobileLogin(app, emp.email);
    const bytes = fakeJpeg();
    const s = await slot(token, 'FRONT', bytes);
    expect((await put(s.upload.url, Buffer.concat([bytes, Buffer.alloc(5000)]))).ok).toBe(false);
    expect((await put(s.upload.url, bytes, 'image/png')).ok).toBe(false);
  });

  it('serves a photo only through a signed link', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await mobileLogin(app, emp.email);
    const bytes = fakeJpeg();
    const s = await slot(token, 'FRONT', bytes);
    await put(s.upload.url, bytes);
    const key = (await one(`SELECT object_key FROM attendance_photos WHERE id = $1`, [s.photoId])).object_key;

    const link = await createDownloadUrl(key);
    const signed = await fetch(link);
    expect(signed.status).toBe(200);
    expect(Buffer.from(await signed.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await readObject(key)).equals(bytes)).toBe(true);

    const anonymous = await fetch(`${endpoint}/${bucket}/${key}`);
    expect(anonymous.status).toBeGreaterThanOrEqual(400);
    const tampered = new URL(link);
    tampered.searchParams.set('X-Amz-Signature', 'a'.repeat(64));
    expect((await fetch(tampered)).status).toBe(403);
  });

  it('deletes a photo from the bucket', async () => {
    const emp = await createEmployee({ workplaceId: base.workplaceId });
    const token = await mobileLogin(app, emp.email);
    const bytes = fakeJpeg();
    const s = await slot(token, 'FRONT', bytes);
    await put(s.upload.url, bytes);
    const key = (await one(`SELECT object_key FROM attendance_photos WHERE id = $1`, [s.photoId])).object_key;
    expect(await inspectObject(key)).toBeTruthy();
    await deleteObject(key);
    expect(await inspectObject(key)).toBeNull();
    await expect(direct().send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).rejects.toBeTruthy();
  });

  it('reports an outage as an outage, not as a successful or missing upload', async () => {
    const good = config.storage.s3Endpoint;
    config.storage.s3Endpoint = 'http://127.0.0.1:9';
    resetStorageClients();
    try {
      await expect(inspectObject('attendance/x/y.jpg')).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
      await expect(deleteObject('attendance/x/y.jpg')).rejects.toMatchObject({ status: 503 });
      await expect(readObject('attendance/x/y.jpg')).rejects.toMatchObject({ status: 503 });
    } finally {
      config.storage.s3Endpoint = good;
      resetStorageClients();
    }
  }, 60_000);

  it('signs links for the public address when the API reaches the bucket privately', async () => {
    config.storage.s3PublicEndpoint = 'https://photos.geoattend.in';
    resetStorageClients();
    try {
      expect(new URL(await createDownloadUrl('attendance/a/b.jpg')).host).toBe('photos.geoattend.in');
    } finally {
      config.storage.s3PublicEndpoint = '';
      resetStorageClients();
    }
  });

  it('keeps the bucket credentials out of signed links', async () => {
    const link = await createDownloadUrl('attendance/a/b.jpg');
    expect(link).not.toContain(secretAccessKey);
    expect(crypto.createHash('sha256').update(link).digest('hex')).toHaveLength(64);
  });
});
