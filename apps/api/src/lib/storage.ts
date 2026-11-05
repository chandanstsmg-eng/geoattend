/**
 * Private object storage for attendance photographs.
 *
 * Two drivers with the same contract:
 *  - local: files under STORAGE_LOCAL_DIR (outside any web root). Uploads and
 *    downloads go through API endpoints authorised by short-lived HMAC-signed
 *    tokens bound to one object key, content type and byte limit.
 *  - s3:    any S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, …) with
 *    pre-signed PUT/GET URLs. The bucket must be private (block public access).
 *
 * Nothing is ever served from a public URL, and every upload is re-validated
 * (size, declared type, magic bytes) before it can be attached to attendance.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { HttpError } from './errors.js';
import { logger } from './logger.js';

export type PhotoType = 'image/jpeg' | 'image/png';

interface TokenPayload {
  op: 'put' | 'get';
  key: string;
  exp: number; // epoch seconds
  ct?: PhotoType;
  max?: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signToken(p: TokenPayload) {
  const body = b64(JSON.stringify(p));
  const sig = crypto.createHmac('sha256', config.storage.signingKey).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string, op: TokenPayload['op']): TokenPayload {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new HttpError(403, 'BAD_TOKEN', 'Invalid storage token');
  const expected = crypto.createHmac('sha256', config.storage.signingKey).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new HttpError(403, 'BAD_TOKEN', 'Invalid storage token');
  }
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  if (p.op !== op) throw new HttpError(403, 'BAD_TOKEN', 'Invalid storage token');
  if (p.exp < Date.now() / 1000) throw new HttpError(403, 'TOKEN_EXPIRED', 'Storage link expired');
  if (!/^[a-z0-9/_-]+\.(jpg|png)$/i.test(p.key) || p.key.includes('..')) throw new HttpError(403, 'BAD_TOKEN', 'Invalid object key');
  return p;
}

export function detectImageType(head: Buffer): PhotoType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

export function newObjectKey(employeeId: string, contentType: PhotoType) {
  const d = new Date();
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  return `attendance/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${employeeId}/${crypto.randomUUID()}.${ext}`;
}

const newS3Client = (endpoint: string) =>
  new S3Client({
    region: config.storage.s3Region,
    endpoint: endpoint || undefined,
    forcePathStyle: config.storage.s3ForcePathStyle,
    // By default the SDK signs a checksum of the (empty) body into pre-signed upload links, so every
    // real upload would be refused. Photos are re-validated after upload instead.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: config.storage.s3AccessKeyId ? { accessKeyId: config.storage.s3AccessKeyId, secretAccessKey: config.storage.s3SecretAccessKey } : undefined,
  });

let s3: S3Client | null = null;
let s3Signer: S3Client | null = null;
function s3Client() {
  return (s3 ??= newS3Client(config.storage.s3Endpoint));
}
/** Links go to phones and browsers, so they are signed for the public address of the bucket. */
function s3LinkClient() {
  return (s3Signer ??= newS3Client(config.storage.s3PublicEndpoint || config.storage.s3Endpoint));
}
/** For tests that change the settings. */
export function resetStorageClients() {
  s3 = null;
  s3Signer = null;
}

const objectMissing = (err: any) => err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
/** Storage being down is not the same as a photo not being there, and must never read as success. */
function storageFailed(err: unknown, action: string) {
  logger.error({ err, action }, 'object storage failed');
  return new HttpError(503, 'STORAGE_UNAVAILABLE', 'Photo storage is temporarily unavailable. Please try again.');
}

const localPath = (key: string) => {
  const p = path.resolve(config.storage.localDir, key);
  if (!p.startsWith(path.resolve(config.storage.localDir) + path.sep)) throw new HttpError(400, 'BAD_KEY', 'Invalid object key');
  return p;
};

export interface UploadTicket {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
}

/** `origin` is the API origin the client used (so phones on a LAN get a reachable URL). */
export async function createUploadUrl(key: string, contentType: PhotoType, declaredBytes: number, origin: string): Promise<UploadTicket> {
  const ttl = config.storage.uploadUrlTtlSec;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  if (config.storage.driver === 's3') {
    const url = await getSignedUrl(
      s3LinkClient(),
      new PutObjectCommand({ Bucket: config.storage.s3Bucket, Key: key, ContentType: contentType, ContentLength: declaredBytes }),
      { expiresIn: ttl, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return { url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresAt, maxBytes: declaredBytes };
  }
  const token = signToken({ op: 'put', key, ct: contentType, max: config.storage.maxPhotoBytes, exp: Math.floor(Date.now() / 1000) + ttl });
  return { url: `${origin}/api/v1/storage/upload?token=${token}`, method: 'PUT', headers: { 'Content-Type': contentType }, expiresAt, maxBytes: config.storage.maxPhotoBytes };
}

/** Local driver returns a same-origin relative URL (the dashboard proxies /api to the API). */
export async function createDownloadUrl(key: string) {
  const ttl = config.storage.downloadUrlTtlSec;
  if (config.storage.driver === 's3') {
    return getSignedUrl(s3LinkClient(), new GetObjectCommand({ Bucket: config.storage.s3Bucket, Key: key, ResponseCacheControl: 'private, no-store' }), { expiresIn: ttl });
  }
  const token = signToken({ op: 'get', key, exp: Math.floor(Date.now() / 1000) + ttl });
  return `/api/v1/storage/object?token=${token}`;
}

/** Local driver: persist an uploaded body (already size-limited by the body parser). */
export async function writeLocalObject(key: string, body: Buffer) {
  const p = localPath(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 'wx' — an object key can be written once only.
  await fs.promises.writeFile(p, body, { flag: 'wx', mode: 0o600 });
}

export function readLocalObject(key: string) {
  return fs.promises.readFile(localPath(key));
}

/** The whole object, from whichever driver is in use (the face check reads photos this way). */
export async function readObject(key: string): Promise<Buffer> {
  if (config.storage.driver !== 's3') return readLocalObject(key);
  try {
    const out = await s3Client().send(new GetObjectCommand({ Bucket: config.storage.s3Bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  } catch (err) {
    if (objectMissing(err)) throw new HttpError(404, 'NOT_FOUND', 'Photo not found');
    throw storageFailed(err, 'read');
  }
}

/** Confirms an object exists and is a real image of the declared type and an acceptable size. Null only when it is not there. */
export async function inspectObject(key: string): Promise<{ sizeBytes: number; type: PhotoType | null; sha256: string | null } | null> {
  if (config.storage.driver === 's3') {
    try {
      const head = await s3Client().send(new HeadObjectCommand({ Bucket: config.storage.s3Bucket, Key: key }));
      const part = await s3Client().send(new GetObjectCommand({ Bucket: config.storage.s3Bucket, Key: key, Range: 'bytes=0-15' }));
      const bytes = Buffer.from(await part.Body!.transformToByteArray());
      return { sizeBytes: head.ContentLength ?? 0, type: detectImageType(bytes), sha256: null };
    } catch (err) {
      if (objectMissing(err)) return null;
      throw storageFailed(err, 'inspect');
    }
  }
  try {
    const buf = await readLocalObject(key);
    return { sizeBytes: buf.length, type: detectImageType(buf), sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string) {
  if (config.storage.driver === 's3') {
    try {
      await s3Client().send(new DeleteObjectCommand({ Bucket: config.storage.s3Bucket, Key: key }));
    } catch (err) {
      throw storageFailed(err, 'delete');
    }
    return;
  }
  await fs.promises.rm(localPath(key), { force: true });
}

/** Throws unless photo storage can be reached: the bucket answers, or the folder can be written. */
export async function checkStorage() {
  if (config.storage.driver === 's3') {
    await s3Client().send(new HeadBucketCommand({ Bucket: config.storage.s3Bucket }));
    return;
  }
  fs.mkdirSync(config.storage.localDir, { recursive: true });
  await fs.promises.access(config.storage.localDir, fs.constants.R_OK | fs.constants.W_OK);
}

export function requestOrigin(req: { protocol: string; get(name: string): string | undefined }) {
  if (config.isProduction) return config.publicApiUrl; // never built from a client-supplied Host header
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : config.publicApiUrl;
}
