#!/usr/bin/env node
/**
 * E2E launcher (host side). The repo is mounted READ-ONLY into the container
 * and copied to the container's own filesystem there — build artifacts never
 * touch the host. Two small git-ignored dirs carry data out and back:
 *
 *   e2e/.state   — the one-time setup state (console session, app creds,
 *                  web session, test-user open_id) exported by e2e:setup
 *   e2e/.output  — one timestamped dir per run with the single-entry report
 *                  (summary.html → cases/<id>/report.html), `latest` symlink
 *
 *   1. prepares the state dir (e2e/.state) + a writable setup.log
 *   2. builds the e2e docker image when missing
 *   3. runs the container orchestration and propagates its exit code
 *
 * Env:
 *   E2E_VIDEO         off|webm|mp4   (default mp4)
 *   E2E_SCREENSHOTS   off|on|failure (default on)
 *   E2E_STATE / E2E_OUTPUT  state (sessions/QRs) and run-output dirs
 *   E2E_APP_ID / E2E_APP_SECRET  optional override of the bot app
 *   E2E_IMAGE         docker image (default dsh-e2e-tools)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const env = process.env;
const stateDir = join(ROOT, 'e2e', '.state');
const outputDir = join(ROOT, 'e2e', '.output');
const dockerImage = env.E2E_IMAGE ?? 'dsh-e2e-tools';
const appId = env.E2E_APP_ID ?? env.FEISHU_APP_ID;
const appSecret = env.E2E_APP_SECRET ?? env.FEISHU_APP_SECRET;
// The bot app name the setup created (persisted in the state dir); the
// report embeds it. Explicit E2E_BOT_NAME wins.
const botName =
  env.E2E_BOT_NAME ??
  (existsSync(join(stateDir, 'bot-name'))
    ? readFileSync(join(stateDir, 'bot-name'), 'utf8').trim()
    : 'DSH-E2E-TESTBOT');

// The in-container setup tees its QR to this file; pre-create it as the HOST
// user so the container (a different uid) can append and the host can read
// it. World-writable — git-ignored local state.
const setupLog = join(stateDir, 'setup.log');
mkdirSync(stateDir, { recursive: true, mode: 0o777 });
mkdirSync(outputDir, { recursive: true, mode: 0o777 });
writeFileSync(setupLog, '', { flag: 'a', mode: 0o666 });

function log(step, msg) {
  console.log(`\n── ${step} ──\n${msg}`);
}

// Build the image when missing (buildx state needs a writable ~/.docker —
// `DOCKER_CONFIG` can redirect it, see docs/e2e-testing.md).
const inspect = spawnSync('docker', ['image', 'inspect', dockerImage], { stdio: 'ignore' });
if (inspect.status !== 0) {
  log('docker', `image ${dockerImage} missing — building from e2e/Dockerfile`);
  const build = spawnSync(
    'docker',
    ['build', '-f', join(ROOT, 'e2e', 'Dockerfile'), '-t', dockerImage, ROOT],
    {
      stdio: 'inherit',
    },
  );
  if (build.status !== 0) {
    console.error('✗ docker build failed (docker available? DOCKER_CONFIG writable?)');
    process.exit(2);
  }
}

log('docker', `running the E2E stack in image ${dockerImage}`);
log('state', `setup state: ${stateDir}`);
log('output', `run reports: ${outputDir}`);

const res = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--shm-size=1g',
    // The repo is mounted READ-ONLY; the container copies it to /app.
    '-v',
    `${ROOT}:/repo:ro`,
    '-v',
    `${stateDir}:/state`,
    '-v',
    `${outputDir}:/output`,
    '-w',
    '/app',
    '-e',
    'E2E_STATE=/state',
    '-e',
    'E2E_OUTPUT=/output',
    '-e',
    `E2E_VIDEO=${env.E2E_VIDEO ?? 'mp4'}`,
    '-e',
    `E2E_SCREENSHOTS=${env.E2E_SCREENSHOTS ?? 'on'}`,
    '-e',
    `E2E_BASE_URL=${env.E2E_BASE_URL ?? 'https://www.feishu.cn/'}`,
    '-e',
    `E2E_BOT_NAME=${botName}`,
    ...(appId !== undefined ? ['-e', `E2E_APP_ID=${appId}`] : []),
    ...(appSecret !== undefined ? ['-e', `E2E_APP_SECRET=${appSecret}`] : []),
    ...(env.E2E_DEBUG !== undefined ? ['-e', `E2E_DEBUG=${env.E2E_DEBUG}`] : []),
    ...(env.FEISHU_DEBUG !== undefined ? ['-e', `FEISHU_DEBUG=${env.FEISHU_DEBUG}`] : []),
    '-e',
    'http_proxy=',
    '-e',
    'https_proxy=',
    '-e',
    'HTTP_PROXY=',
    '-e',
    'HTTPS_PROXY=',
    ...(env.E2E_DEBUG_DOM !== undefined ? ['-e', `E2E_DEBUG_DOM=${env.E2E_DEBUG_DOM}`] : []),
    dockerImage,
    'bash',
    '-c',
    'mkdir -p /app && tar --exclude=./node_modules --exclude=./lib --exclude=./_dev ' +
      '--exclude=.pnpm-store --exclude=.git --exclude=./e2e/.build ' +
      '--exclude=./e2e/.state --exclude=./e2e/.output -C /repo -cf - . | tar -C /app -xf - && ' +
      'node /app/e2e/scripts/e2e-container.mjs',
  ],
  { stdio: 'inherit' },
);
const exit = res.status ?? 1;

console.log(`\nE2E finished (exit ${exit})`);
if (exit === 0) {
  console.log(`report: ${join(outputDir, 'latest', 'summary.html')}`);
}
process.exit(exit);
