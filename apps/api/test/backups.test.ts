/** Phase F: a backup counts only if it can be shown to be good. Uses a temporary folder, never data/backups. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupHealth, describeFolder, inspectBackup, listBackups, MANIFEST, planPrune, writeManifest, type BackupResult } from '../src/lib/backups.js';
import { checkBackups } from '../src/modules/ops/alerts.js';
import { config } from '../src/config.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoattend-backups-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const nameFor = (d: Date) => `pg-online-${d.toISOString().replace(/[:.]/g, '-')}`;

async function backup(at: Date, status: BackupResult = 'RESTORE_PROVEN', opts: { manifest?: boolean } = {}) {
  const location = path.join(dir, nameFor(at));
  fs.mkdirSync(path.join(location, 'base'), { recursive: true });
  fs.writeFileSync(path.join(location, 'PG_VERSION'), '18\n');
  fs.writeFileSync(path.join(location, 'base', 'data'), crypto.randomBytes(2048));
  if (opts.manifest !== false) writeManifest(location, { version: 1, kind: 'online', status, createdAt: at.toISOString(), finishedAt: at.toISOString(), files: await describeFolder(location) });
  return location;
}

describe('whether a backup can be trusted', () => {
  it('a proven backup passes the quick and the deep check', async () => {
    const b = await backup(hoursAgo(1));
    expect((await inspectBackup(b, 'online')).status).toBe('OK');
    expect(await inspectBackup(b, 'online', true)).toMatchObject({ status: 'OK', result: 'RESTORE_PROVEN', fileCount: 2, problem: null });
  });

  it('files alone prove nothing: without a manifest it does not count', async () => {
    const b = await backup(hoursAgo(1), 'RESTORE_PROVEN', { manifest: false });
    expect((await inspectBackup(b, 'online', true)).status).toBe('NO_MANIFEST');
  });

  it('a backup that reported failure does not count, however complete it looks', async () => {
    const b = await backup(hoursAgo(1), 'FAILED');
    expect((await inspectBackup(b, 'online', true)).status).toBe('FAILED');
  });

  it('a missing file is found', async () => {
    const b = await backup(hoursAgo(1));
    fs.rmSync(path.join(b, 'base', 'data'));
    expect(await inspectBackup(b, 'online')).toMatchObject({ status: 'INCOMPLETE', problem: 'base/data is missing.' });
  });

  it('a shortened file is found by the quick check', async () => {
    const b = await backup(hoursAgo(1));
    fs.truncateSync(path.join(b, 'base', 'data'), 100);
    expect((await inspectBackup(b, 'online')).status).toBe('CORRUPT');
  });

  it('one changed byte, same size, is found by the deep check', async () => {
    const b = await backup(hoursAgo(1));
    const f = path.join(b, 'base', 'data');
    const bytes = fs.readFileSync(f);
    bytes[1000] = bytes[1000]! ^ 0xff;
    fs.writeFileSync(f, bytes);
    expect((await inspectBackup(b, 'online')).status).toBe('OK'); // the quick check cannot see it
    expect((await inspectBackup(b, 'online', true)).status).toBe('CORRUPT');
  });

  it('an unreadable or empty manifest does not count', async () => {
    const b = await backup(hoursAgo(1));
    fs.writeFileSync(path.join(b, MANIFEST), '{not json');
    expect((await inspectBackup(b, 'online')).status).toBe('BAD_MANIFEST');
    fs.writeFileSync(path.join(b, MANIFEST), JSON.stringify({ status: 'RESTORE_PROVEN', createdAt: 'x', files: [] }));
    expect((await inspectBackup(b, 'online')).status).toBe('BAD_MANIFEST');
  });

  it('a manifest is never overwritten', async () => {
    const b = await backup(hoursAgo(1));
    expect(() => writeManifest(b, { version: 1, kind: 'online', status: 'RESTORE_PROVEN', createdAt: 'x', finishedAt: 'x', files: [] })).toThrow(/EEXIST/);
  });

  it('a dump is checked through the manifest beside it', async () => {
    const at = hoursAgo(1).toISOString();
    const file = path.join(dir, 'geoattend-2026-11-05T01-00-00-000Z.dump');
    fs.writeFileSync(file, 'PGDMP');
    writeManifest(file, { version: 1, kind: 'dump', status: 'READABLE', createdAt: at, finishedAt: at, files: [{ path: path.basename(file), size: 5, sha256: crypto.createHash('sha256').update('PGDMP').digest('hex') }] });
    expect((await listBackups(dir, true))[0]).toMatchObject({ kind: 'dump', status: 'OK', result: 'READABLE' });
    fs.writeFileSync(file, 'XXXXX');
    expect((await listBackups(dir, true))[0]!.status).toBe('CORRUPT');
  });
});

describe('monitoring', () => {
  it('is off when nobody asked for it, and says so', async () => {
    expect(await backupHealth(dir, 0)).toMatchObject({ status: 'off' });
  });

  it('no backups at all is a failure', async () => {
    expect(await backupHealth(dir, 26)).toMatchObject({ status: 'fail', message: 'There are no backups.' });
    expect(await backupHealth(path.join(dir, 'nowhere'), 26)).toMatchObject({ status: 'fail' });
  });

  it('a recent proven backup is healthy', async () => {
    await backup(hoursAgo(2));
    const h = await backupHealth(dir, 26);
    expect(h.status).toBe('ok');
    expect(h.lastGood?.ageHours).toBeCloseTo(2, 0);
  });

  it('too old is a failure', async () => {
    await backup(hoursAgo(30));
    expect((await backupHealth(dir, 26)).status).toBe('fail');
  });

  it('only unproven backups is a failure, and so is one only failed', async () => {
    await backup(hoursAgo(1), 'RESTORE_PROVEN', { manifest: false });
    await backup(hoursAgo(2), 'FAILED');
    expect(await backupHealth(dir, 26)).toMatchObject({ status: 'fail', message: 'None of the 2 backups is proven.' });
  });

  it('the newest failing with an older good one is a warning that names it', async () => {
    await backup(hoursAgo(5));
    await backup(hoursAgo(1), 'FAILED');
    expect(await backupHealth(dir, 26)).toMatchObject({ status: 'warn', newest: { status: 'FAILED' } });
  });

  it('a backup that can be read but was not restored is only a warning', async () => {
    await backup(hoursAgo(1), 'READABLE');
    expect((await backupHealth(dir, 26)).status).toBe('warn');
  });

  it('a damaged backup stops counting as the last good one', async () => {
    const b = await backup(hoursAgo(1));
    fs.rmSync(path.join(b, 'PG_VERSION'));
    expect((await backupHealth(dir, 26)).status).toBe('fail');
  });

  it('the hourly job fails while backups are in doubt, so it shows on the job list', async () => {
    const before = { ...config.backups };
    Object.assign(config.backups, { dir, maxAgeHours: 26 });
    try {
      await expect(checkBackups()).rejects.toThrow('There are no backups.');
      await backup(hoursAgo(1));
      await expect(checkBackups()).resolves.toBeUndefined();
    } finally {
      Object.assign(config.backups, before);
    }
  });
});

describe('removing old backups', () => {
  it('keeps the newest proven ones and picks only proven surplus', async () => {
    for (const h of [1, 2, 3, 4]) await backup(hoursAgo(h));
    const all = await listBackups(dir);
    expect(planPrune(all, 2).map((b) => b.name)).toEqual([nameFor(new Date(all[2]!.createdAt!)), nameFor(new Date(all[3]!.createdAt!))]);
  });

  it('never picks a failed, damaged or unproven backup', async () => {
    await backup(hoursAgo(1));
    await backup(hoursAgo(2), 'FAILED');
    await backup(hoursAgo(3), 'RESTORE_PROVEN', { manifest: false });
    const broken = await backup(hoursAgo(4));
    fs.rmSync(path.join(broken, 'PG_VERSION'));
    expect(planPrune(await listBackups(dir), 1)).toEqual([]);
  });

  it('never removes the last proven backup, even if told to keep none', async () => {
    await backup(hoursAgo(1));
    await backup(hoursAgo(2));
    const plan = planPrune(await listBackups(dir), 0);
    expect(plan).toHaveLength(1);
    expect((await listBackups(dir))[0]!.name).not.toBe(plan[0]!.name);
  });
});
