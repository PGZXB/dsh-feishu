#!/usr/bin/env node
/**
 * One-time E2E environment setup (hands-free afterwards). Runs the
 * container in E2E_SETUP mode, which:
 *
 *   1. installs + builds the plugin (container-local copy)
 *   2. installs the plugin into the e2e-dev profile
 *   3. creates the bot app (console QR scan — scan with the TEST account;
 *      skipped when /exchange/creds.json already exists)
 *   4. performs the browser login (QR scan — same account; skipped when
 *      /exchange/web-session.json exists)
 *   5. verifies the chat exists (message the bot once if missing)
 *
 * Exit codes: 0 = ready (later `pnpm run e2e:ui` runs need no human),
 * 3 = chat missing (message the bot, re-run to finish), other = failed.
 *
 * Env: E2E_CHAT (required), E2E_BOT_NAME, E2E_IMAGE, E2E_APP_ID/SECRET.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const env = process.env;

const chat = env.E2E_CHAT;
if (!chat) {
  console.error('✗ E2E_CHAT is required (the chat to open), e.g. E2E_CHAT="DSH Agent (e2e)"');
  process.exit(2);
}
const exchange = env.E2E_EXCHANGE ?? join(ROOT, '_dev', 'e2e-exchange');
const dockerImage = env.E2E_IMAGE ?? 'dsh-e2e-tools';
const appId = env.E2E_APP_ID ?? env.FEISHU_APP_ID;
const appSecret = env.E2E_APP_SECRET ?? env.FEISHU_APP_SECRET;

// Pre-create the exchange + setup log as the HOST user (the container maps
// to a different uid and appends to it).
const setupLog = join(exchange, 'setup.log');
mkdirSync(exchange, { recursive: true, mode: 0o777 });
writeFileSync(setupLog, '', { flag: 'a', mode: 0o666 });

function log(step, msg) {
  console.log(`\n── ${step} ──\n${msg}`);
}

const inspect = spawnSync('docker', ['image', 'inspect', dockerImage], { stdio: 'ignore' });
if (inspect.status !== 0) {
  log('docker', `image ${dockerImage} missing — building from Dockerfile.e2e`);
  const build = spawnSync('docker', ['build', '-f', join(ROOT, 'Dockerfile.e2e'), '-t', dockerImage, ROOT], {
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(2);
}

log('setup', 'running the one-time E2E environment setup in docker');
console.log(`QR files + exported state land in ${exchange}`);
console.log('Scan the console QR (bot-app setup) at setup.log, then the browser QR at qr.png — both with the TEST account.\n');

const res = spawnSync(
  'docker',
  [
    'run', '--rm', '--shm-size=1g',
    '-v', `${ROOT}:/repo:ro`,
    '-v', `${exchange}:/exchange`,
    '-w', '/app',
    '-e', 'E2E_SETUP=1',
    '-e', `E2E_CHAT=${chat}`,
    '-e', 'E2E_EXCHANGE=/exchange',
    '-e', `E2E_BOT_NAME=${env.E2E_BOT_NAME ?? 'DSH Agent (e2e)'}`,
    ...(appId !== undefined ? ['-e', `E2E_APP_ID=${appId}`] : []),
    ...(appSecret !== undefined ? ['-e', `E2E_APP_SECRET=${appSecret}`] : []),
    '-e', 'http_proxy=', '-e', 'https_proxy=', '-e', 'HTTP_PROXY=', '-e', 'HTTPS_PROXY=',
    dockerImage,
    'bash', '-c',
    'mkdir -p /app && tar --exclude=./node_modules --exclude=./lib --exclude=./_dev ' +
      '--exclude=./.pnpm-store --exclude=./.git -C /repo -cf - . | tar -C /app -xf - && ' +
      'node /app/scripts/e2e-container.mjs',
  ],
  { stdio: 'inherit' },
);
const exit = res.status ?? 1;

if (exit === 0) {
  console.log('\n✅ E2E setup complete — `pnpm run e2e:ui` now runs hands-free.');
} else if (exit === 3) {
  console.log('\n⏳ Almost done: message the bot in the Feishu app, then re-run `pnpm run e2e:setup` to finish.');
} else {
  console.log('\n✗ E2E setup failed — see the output above.');
}
process.exit(exit);
