#!/usr/bin/env node
/**
 * One-time E2E environment setup (idempotent — later runs are hands-free).
 * Runs the container in E2E_SETUP mode, which:
 *
 *   1. installs + builds the plugin (container-local copy)
 *   2. installs the plugin into the e2e-dev profile
 *   3. creates the bot app (open-platform QR scan — scan with the TEST
 *      account; app name E2E_BOT_NAME, default DSH-E2E-TESTBOT; skipped
 *      when /state/creds.json already exists)
 *   4. performs the browser login (QR scan — same account; skipped when
 *      /state/web-session.json exists)
 *   5. extracts the test user open_id from the web session (skipped when
 *      /state/user.json exists)
 *   6. probes backend group create+delete end-to-end
 *
 * Every step that already has its state exported is skipped — re-running
 * the setup never re-scans a login that is already in e2e/.state/.
 *
 * Exit codes: 0 = ready (later `pnpm run e2e:ui` runs need no human),
 * other = failed.
 *
 * Env: E2E_BOT_NAME, E2E_IMAGE, E2E_APP_ID/SECRET.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const env = process.env;

const stateDir = join(ROOT, 'e2e', '.state');
const outputDir = join(ROOT, 'e2e', '.output');
const dockerImage = env.E2E_IMAGE ?? 'dsh-e2e-tools';
const appId = env.E2E_APP_ID ?? env.FEISHU_APP_ID;
const appSecret = env.E2E_APP_SECRET ?? env.FEISHU_APP_SECRET;

// Pre-create the state dir + setup log as the HOST user (the container maps
// to a different uid and appends to it).
const setupLog = join(stateDir, 'setup.log');
mkdirSync(stateDir, { recursive: true, mode: 0o777 });
mkdirSync(outputDir, { recursive: true, mode: 0o777 });
writeFileSync(setupLog, '', { flag: 'a', mode: 0o666 });

function log(step, msg) {
  console.log(`\n── ${step} ──\n${msg}`);
}

// The bot app name must be globally unique so the setup's search-for-bot step
// never matches a stale app from an earlier run. Each setup run derives a
// fresh name (`DSH-E2E-TESTBOT-<YYYYMMDDHHmmss>`) and persists it into the
// state dir for the launcher to reuse; E2E_BOT_NAME overrides explicitly.
function resolveBotName() {
  const explicit = env.E2E_BOT_NAME;
  if (explicit) return explicit;
  const nameFile = join(stateDir, 'bot-name');
  if (existsSync(nameFile)) {
    const saved = readFileSync(nameFile, 'utf8').trim();
    if (saved) return saved;
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ]/g, '')
    .replace(/\.\d{3}/, '')
    .slice(0, 14);
  const fresh = `DSH-E2E-TESTBOT-${stamp}`;
  writeFileSync(nameFile, `${fresh}\n`, 'utf8');
  return fresh;
}

const botName = resolveBotName();

const inspect = spawnSync('docker', ['image', 'inspect', dockerImage], { stdio: 'ignore' });
if (inspect.status !== 0) {
  log('docker', `image ${dockerImage} missing — building from Dockerfile.e2e`);
  const build = spawnSync('docker', ['build', '-f', join(ROOT, 'Dockerfile.e2e'), '-t', dockerImage, ROOT], {
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(2);
}

log('setup', 'running the one-time E2E environment setup in docker');
console.log(`state: ${stateDir}`);
console.log(`bot app name: ${botName}`);
console.log(
  'Scan the open-platform QR (bot-app setup) at setup.log, then the browser QR at qr.png — both with the TEST account.\n',
);

const res = spawnSync(
  'docker',
  [
    'run', '--rm', '--shm-size=1g',
    '-v', `${ROOT}:/repo:ro`,
    '-v', `${stateDir}:/state`,
    '-v', `${outputDir}:/output`,
    '-w', '/app',
    '-e', 'E2E_SETUP=1',
    '-e', 'E2E_STATE=/state',
    '-e', 'E2E_OUTPUT=/output',
    '-e', `E2E_BOT_NAME=${botName}`,
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
} else {
  console.log('\n✗ E2E setup failed — see the output above.');
}
process.exit(exit);
