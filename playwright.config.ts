import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  // Each test launches its own sandboxed app (hidden windows, in-memory clipboard, temp profile),
  // so tests are independent and can run in parallel without touching the desktop.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
