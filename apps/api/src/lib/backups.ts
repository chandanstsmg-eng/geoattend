/**
 * What is known about a backup, and how far it can be trusted. A file existing proves nothing, so a
 * backup counts only if its manifest says it was proven when made and every file it lists is still there:
 * with the same size in the quick check, and with the same SHA-256 in the deep one.
 *
 *   RESTORE_PROVEN  started as a real server and its tables compared with the live ones
 *   READABLE        pg_restore read its table of contents; it has not been restored
 *   FAILED          the backup itself reports a failure
 *
 * Written by scripts/backup-online.ts and scripts/backup.ts. Read by the backup-check job,
 * `npm run db:backup:verify` and `npm run db:backup:prune`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export type BackupResult = 'RESTORE_PROVEN' | 'READABLE' | 'FAILED';

export interface BackupManifest {
  version: 1;
  kind: 'online' | 'dump';
  status: BackupResult;
  createdAt: string;
  finishedAt: string;
  error?: string;
  databases?: string[];
  tablesMatching?: number;
  tablesDifferent?: string[];
  files: Array<{ path: string; size: number; sha256: string }>;
  /** The off-site copy, read back and checked byte for byte (scripts/backup-production.ts). */
  offsite?: { bucket: string; key: string; sha256: string; verifiedAt: string };
}

export type BackupStatus = 'OK' | 'NO_MANIFEST' | 'BAD_MANIFEST' | 'FAILED' | 'INCOMPLETE' | 'CORRUPT';

export interface BackupInfo {
  name: string;
  location: string;
  kind: 'online' | 'dump';
  status: BackupStatus;
  result: BackupResult | null;
  createdAt: string | null;
  sizeBytes: number;
  fileCount: number;
  problem: string | null;
}

export const MANIFEST = 'manifest.json';
const manifestPath = (location: string, kind: BackupInfo['kind']) => (kind === 'online' ? path.join(location, MANIFEST) : `${location}.manifest.json`);

export async function sha256(file: string) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

/** Every file in a backup folder with its size and SHA-256. */
export async function describeFolder(dir: string) {
  const files: BackupManifest['files'] = [];
  for (const rel of walk(dir).filter((f) => f !== MANIFEST)) {
    const full = path.join(dir, rel);
    files.push({ path: rel, size: fs.statSync(full).size, sha256: await sha256(full) });
  }
  return files;
}

/** Never replaces a manifest: a backup's record of itself is written once. */
export function writeManifest(location: string, m: BackupManifest) {
  fs.writeFileSync(manifestPath(location, m.kind), JSON.stringify(m, null, 1), { flag: 'wx' });
}

/** Checks one backup. `deep` reads every byte. */
export async function inspectBackup(location: string, kind: BackupInfo['kind'], deep = false): Promise<BackupInfo> {
  const info: BackupInfo = { name: path.basename(location), location, kind, status: 'NO_MANIFEST', result: null, createdAt: null, sizeBytes: 0, fileCount: 0, problem: 'No manifest, so nothing shows this backup was checked.' };
  let m: BackupManifest;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath(location, kind), 'utf8'));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return info;
    return { ...info, status: 'BAD_MANIFEST', problem: 'The manifest cannot be read.' };
  }
  if (!Array.isArray(m?.files) || !m.createdAt || !m.status) return { ...info, status: 'BAD_MANIFEST', problem: 'The manifest is incomplete.' };
  const known = { ...info, result: m.status, createdAt: m.createdAt, fileCount: m.files.length, sizeBytes: m.files.reduce((n, f) => n + f.size, 0) };
  if (m.status === 'FAILED') return { ...known, status: 'FAILED', problem: m.error ?? 'The backup reported a failure.' };
  if (!m.files.length) return { ...known, status: 'BAD_MANIFEST', problem: 'The manifest lists no files.' };
  const root = kind === 'online' ? location : path.dirname(location);
  for (const f of m.files) {
    const full = path.join(root, f.path);
    let size: number;
    try {
      size = fs.statSync(full).size;
    } catch {
      return { ...known, status: 'INCOMPLETE', problem: `${f.path} is missing.` };
    }
    if (size !== f.size) return { ...known, status: 'CORRUPT', problem: `${f.path} is ${size} bytes; it was ${f.size}.` };
    if (deep && (await sha256(full)) !== f.sha256) return { ...known, status: 'CORRUPT', problem: `${f.path} has changed since the backup was made.` };
  }
  return { ...known, status: 'OK', problem: null };
}

/** The backups in `dir`, newest first (by the name, which holds the time). */
function backupsIn(dir: string) {
  if (!fs.existsSync(dir)) return [];
  const found: Array<{ name: string; kind: BackupInfo['kind'] }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith('pg-online-')) found.push({ name: e.name, kind: 'online' });
    else if (e.isFile() && /^geoattend-.*\.dump$/.test(e.name)) found.push({ name: e.name, kind: 'dump' });
  }
  return found.sort((a, b) => b.name.replace(/^\D+/, '').localeCompare(a.name.replace(/^\D+/, '')));
}

export async function listBackups(dir: string, deep = false) {
  const out: BackupInfo[] = [];
  for (const b of backupsIn(dir)) out.push(await inspectBackup(path.join(dir, b.name), b.kind, deep));
  return out;
}

export interface BackupHealth {
  status: 'ok' | 'warn' | 'fail' | 'off';
  message: string;
  newest: { name: string; status: BackupStatus } | null;
  lastGood: { name: string; at: string; result: BackupResult | null; ageHours: number } | null;
  total: number;
}

/** Whether there is a recent backup that can be trusted. Quick: sizes only. */
export async function backupHealth(dir: string, maxAgeHours: number, now = new Date()): Promise<BackupHealth> {
  if (maxAgeHours <= 0) return { status: 'off', message: 'Backups are not monitored on this server (BACKUP_MAX_AGE_HOURS is 0).', newest: null, lastGood: null, total: 0 };
  // Newest first, and only as far as the first good one: this runs on every health check.
  const all = backupsIn(dir);
  let newest: BackupHealth['newest'] = null;
  let good: BackupInfo | undefined;
  for (const b of all) {
    const info = await inspectBackup(path.join(dir, b.name), b.kind);
    newest ??= { name: info.name, status: info.status };
    if (info.status === 'OK') {
      good = info;
      break;
    }
  }
  if (!good) return { status: 'fail', message: all.length ? `None of the ${all.length} backups is proven.` : 'There are no backups.', newest, lastGood: null, total: all.length };
  const ageHours = Math.round(((now.getTime() - new Date(good.createdAt!).getTime()) / 3600_000) * 10) / 10;
  const lastGood = { name: good.name, at: good.createdAt!, result: good.result, ageHours };
  if (ageHours > maxAgeHours) return { status: 'fail', message: `The newest proven backup is ${ageHours} hours old; the limit is ${maxAgeHours}.`, newest, lastGood, total: all.length };
  if (newest?.status !== 'OK') return { status: 'warn', message: `The newest backup is ${newest?.status}; the last proven one is ${ageHours} hours old.`, newest, lastGood, total: all.length };
  if (good.result !== 'RESTORE_PROVEN') return { status: 'warn', message: 'The newest backup can be read, but has not been restored.', newest, lastGood, total: all.length };
  return { status: 'ok', message: `Proven backup ${ageHours} hours old.`, newest, lastGood, total: all.length };
}

/**
 * Which backups may go: only proven ones beyond the newest `keep`. A failed or unproven backup is never
 * chosen, because nothing shows it is surplus, and neither is anything when too few proven ones remain.
 */
export function planPrune(all: BackupInfo[], keep: number) {
  return all.filter((b) => b.status === 'OK').slice(Math.max(keep, 1));
}
