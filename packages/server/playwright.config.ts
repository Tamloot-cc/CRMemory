import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/setup.ts',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  use: { headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  reporter: 'list',
});
