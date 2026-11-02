import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['desktop.e2e.ts', 'transfers.e2e.ts'],
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
