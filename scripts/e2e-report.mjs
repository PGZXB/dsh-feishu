#!/usr/bin/env node
/**
 * Run the standardized report generator (e2e/lib/report.ts, compiled to
 * e2e/.build/lib/report.js by the container) against a run directory:
 * reads `report.json` (Playwright) and writes the per-case + summary
 * layout (summary.json/html, cases/<id>/report.json/html, screenshots,
 * video.mp4). Runs inside the container after the scenarios.
 *
 * Usage: node scripts/e2e-report.mjs <runDir>
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node scripts/e2e-report.mjs <runDir>');
  process.exit(2);
}

const { generateRunReport } = await import(join(ROOT, 'e2e', '.build', 'lib', 'report.js'));
const require = createRequire(import.meta.url);
let playwrightVersion = 'unknown';
try {
  playwrightVersion = require('@playwright/test/package.json').version;
} catch {}

const environment = {
  runId: runDir.split('/').pop() ?? 'run',
  node: process.version,
  playwright: playwrightVersion,
  plugin: process.env.E2E_PLUGIN_VERSION ?? 'unknown',
  botName: process.env.E2E_BOT_NAME ?? '',
  video: process.env.E2E_VIDEO ?? '',
  screenshots: process.env.E2E_SCREENSHOTS ?? '',
  baseUrl: process.env.E2E_BASE_URL ?? '',
  appId: (process.env.E2E_APP_ID ?? '').slice(0, 12) + (process.env.E2E_APP_ID ? '…' : ''),
  generatedAt: new Date().toISOString(),
};

const summary = generateRunReport(runDir, environment);
console.log(
  `run report: ${summary.total} cases (${summary.passed} passed, ${summary.failed} failed) -> ${join(runDir, 'summary.html')}`,
);
