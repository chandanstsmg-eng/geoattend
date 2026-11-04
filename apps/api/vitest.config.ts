import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', DEMO_MODE: 'true', STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: 'data/test-photos' },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
  },
});
