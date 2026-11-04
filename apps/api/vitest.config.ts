import { defineConfig } from 'vitest/config';

export default defineConfig({
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
    // mobile-sync.test.ts uses the phone's own source. Node loads it directly, as the mobile tests do: Vite would need
    // the mobile tsconfig, which extends a package that is not installed when these tests run.
    server: { deps: { external: [/apps[\\/]mobile[\\/]/] } },
  },
});
