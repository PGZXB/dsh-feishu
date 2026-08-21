/**
 * Playwright configuration for the real-client E2E suite. All knobs come
 * from the environment via {@link loadE2eConfig} (see `e2e/lib/config.ts`),
 * so the same config serves local and docker runs.
 *
 * @module e2e/playwright.config
 */

import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { loadE2eConfig } from './helpers/config.js';

const cfg = loadE2eConfig();

export default defineConfig({
  testDir: './scenarios',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  // One real bot chat at a time: scenarios share the chat and must not race.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: join(cfg.reportDir, 'playwright-output'),
  reporter: [['line'], ['json', { outputFile: join(cfg.reportDir, 'report.json') }]],
  use: {
    baseURL: cfg.baseUrl,
    viewport: { width: 1440, height: 900 },
    screenshot:
      cfg.screenshots === 'on' ? 'on' : cfg.screenshots === 'failure' ? 'only-on-failure' : 'off',
    video: cfg.video === 'off' ? 'off' : 'on',
    // Created by `pnpm run e2e:login` (the launcher runs it when missing).
    storageState: cfg.sessionState,
    trace: 'retain-on-failure',
  },
});
