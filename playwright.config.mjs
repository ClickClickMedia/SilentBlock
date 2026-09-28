import { defineConfig } from '@playwright/test';

// Extension tests use one persistent Chromium profile per test, so run serially.
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
