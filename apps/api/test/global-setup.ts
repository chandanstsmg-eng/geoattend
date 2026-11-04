import fs from 'node:fs';
import path from 'node:path';

// Test photos (STORAGE_LOCAL_DIR in vitest.config.ts) are shared by all test files; clear them once at the end.
export function teardown() {
  fs.rmSync(path.resolve('data/test-photos'), { recursive: true, force: true });
}
