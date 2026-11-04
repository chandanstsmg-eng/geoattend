import { defineConfig } from 'vitest/config';

export default defineConfig({
  // mobile-sync.test.ts loads the phone's source, and the mobile tsconfig needs packages CI has not installed here.
  esbuild: { tsconfigRaw: '{}' },
  test: {
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DEMO_MODE: 'true',
      PAYROLL_ENABLED: 'true', // tests of the switched-off state set config.payrollEnabled themselves
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_DIR: 'data/test-photos',
      // Tests run without a .env (CI, fresh checkouts) and never use the developer's secrets.
      JWT_SECRET: 'test-only-jwt-secret-not-used-anywhere-else',
      STORAGE_SIGNING_KEY: 'test-only-signing-key-not-used-anywhere-else',
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
  },
});
