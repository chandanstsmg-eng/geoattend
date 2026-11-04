import fs from 'node:fs';
import path from 'node:path';

process.env.LOG_LEVEL ||= 'silent';
const { DATA_DIR } = await import('../src/config.js');
const { ensureDatabase } = await import('../src/db/postgres.js');

// Test files run in parallel. On a fresh checkout each would otherwise run initdb on the same folder.
export async function setup() {
  await ensureDatabase('postgres');
}

// Test photos (STORAGE_LOCAL_DIR in vitest.config.ts) are shared by all test files; clear them once at the end.
export function teardown() {
  fs.rmSync(path.join(DATA_DIR, 'test-photos'), { recursive: true, force: true });
}
