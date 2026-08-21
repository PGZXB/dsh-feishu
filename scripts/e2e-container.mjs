#!/usr/bin/env node
/**
 * In-container E2E orchestration. The repo is mounted READ-ONLY at /repo and
 * copied to the container-local /app; every build artifact (node_modules,
 * lib, the pnpm store, the dsh home) stays in the container and vanishes
 * with it. Only the /exchange mount (a small host dir) carries data out:
 *
 *   /exchange/setup.log        — the bot-app setup QR (ASCII) for the user
 *   /exchange/console-session.json — the setup tool's console session
 *   /exchange/creds.json       — {appId, appSecret} of the bot app
 *   /exchange/web-qr.png       — the browser login QR (rotates)
 *   /exchange/web-session.json — the browser storageState
 *   /exchange/report/          — screenshots, videos, html, manifest.json
 *
 * Flow (the README install-from-source flow, inside the container):
 *   pnpm install → build → setup:feishu --new --force-login (one QR scan,
 *   TEST-account console login; reuses /exchange/console-session.json when
 *   present) → browser login (TEST account; reuses web-session.json) →
 *   mock LLM + dsh (profile e2e-dev) → Playwright scenarios → mp4 → manifest.
 *
 * Env: E2E_CHAT, E2E_EXCHANGE, E2E_VIDEO, E2E_SCREENSHOTS, E2E_BASE_URL,
 * E2E_MOCK_PORT, E2E_BOT_NAME, E2E_APP_ID/E2E_APP_SECRET (override).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = '/app'; // container-local copy of the repo
const env = process.env;

const chat = env.E2E_CHAT;
if (!chat) {
  console.error('✗ E2E_CHAT is required (the chat to open), e.g. E2E_CHAT="DSH Agent (e2e)"');
  process.exit(2);
}
const exchange = env.E2E_EXCHANGE ?? '/exchange';
const video = env.E2E_VIDEO ?? 'mp4';
const reportDir = '/exchange/report';
const mockPort = env.E2E_MOCK_PORT ?? '19090';
const dshBin = join(ROOT, 'node_modules', '.bin', 'dsh');
const e2eHome = join(ROOT, '_dev', 'e2e-dsh-home');
const profileDir = join(e2eHome, 'profiles', 'e2e-dev');
const consoleSession = join(exchange, 'console-session.json');
const webSession = join(exchange, 'web-session.json');
const credsFile = join(exchange, 'creds.json');
const setupLog = join(exchange, 'setup.log');

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
  delete process.env[k];
}
// Container-local pnpm store — never write into the copied repo's mounts.
process.env.npm_config_store_dir = '/tmp/pnpm-store';
process.env.npm_config_cache_dir = '/tmp/pnpm-cache';
process.env.CI = 'true';
process.env.XDG_CONFIG_HOME = '/tmp/e2e-xdg';

const children = [];
let playwrightExit = 1;
const SETUP_ATTEMPTS = 4;

function cleanup() {
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

function log(step, msg) {
  console.log(`\n── ${step} ──\n${msg}`);
}

function teeSpawn(command, args, opts, logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: 'a' });
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], ...opts });
    const forward = (chunk) => {
      process.stdout.write(chunk);
      stream.write(chunk);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      stream.write(chunk);
    });
    child.on('close', (code) => {
      stream.end();
      resolve(code ?? 1);
    });
  });
}

async function main() {
  mkdirSync(reportDir, { recursive: true });

  // 1. Install + build (README install-from-source, inside the container).
  if (!existsSync(join(ROOT, 'node_modules', '.bin', 'pnpm'))) {
    log('install', 'installing dependencies (container-local)');
    const res = spawnSync('pnpm', ['install'], { cwd: ROOT, env: process.env, stdio: 'inherit' });
    if (res.status !== 0) process.exit(2);
  }
  if (!existsSync(join(ROOT, 'lib', 'index.js'))) {
    log('build', 'building the plugin (container-local)');
    const res = spawnSync('pnpm', ['run', 'build'], { cwd: ROOT, env: process.env, stdio: 'inherit' });
    if (res.status !== 0) process.exit(2);
  }

  // 2. Profile prep (once).
  if (!existsSync(join(profileDir, 'package.json'))) {
    log('profile', 'installing the plugin into profile e2e-dev');
    const res = spawnSync(dshBin, ['plugin', '--profile', 'e2e-dev', 'add', `link:${ROOT}`], {
      env: { ...process.env, DSH_HOME: e2eHome },
      stdio: 'inherit',
    });
    if (res.status !== 0) process.exit(2);
  }

  // 3. Bot-app setup: --force-login ignores any cached console session, so
  //    the QR is always scanned with the account the user chooses (the
  //    dedicated test account). The console session + app credentials are
  //    exported to the exchange for reuse.
  const envCreds = Boolean(process.env.E2E_APP_ID && process.env.E2E_APP_SECRET);
  const creds = envCreds
    ? { appId: process.env.E2E_APP_ID, appSecret: process.env.E2E_APP_SECRET }
    : existsSync(credsFile)
      ? JSON.parse(readFileSync(credsFile, 'utf8'))
      : undefined;
  if (creds) {
    console.log(`  [setup] using app ${creds.appId} from ${credsFile}`);
  } else {
    // pnpm is installed globally in the image (Dockerfile.e2e), not in the
    // repo's node_modules.
    const pnpmBin = 'pnpm';
    log(
      'setup',
      'creating the bot app (console QR login — scan with the TEST account).\n' +
        `    scan the LATEST QR at ${setupLog} with the Feishu app (auto-refreshes; up to ${SETUP_ATTEMPTS} attempts)`,
    );
    let code = 1;
    for (let attempt = 1; attempt <= SETUP_ATTEMPTS; attempt += 1) {
      writeFileSync(setupLog, '', 'utf8');
      console.log(`  [setup] attempt ${attempt}/${SETUP_ATTEMPTS}`);
      code = await teeSpawn(
        pnpmBin,
        [
          'run', 'setup:feishu', '--',
          '--new', '--force-login', '--profile', 'e2e-dev',
          '--dsh-home', e2eHome,
          '--app-name', env.E2E_BOT_NAME ?? 'DSH Agent (e2e)',
        ],
        { env: { ...process.env, DSH_HOME: e2eHome, DSH_FEISHU_SESSION: consoleSession }, cwd: ROOT },
        setupLog,
      );
      if (code === 0) break;
      console.log(`  [setup] attempt ${attempt} failed (QR expired?) — retrying with a fresh QR`);
    }
    if (code !== 0) {
      console.error(`✗ setup:feishu failed after ${SETUP_ATTEMPTS} attempts`);
      process.exit(2);
    }
    const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
    const id = /appId:\s*(\S+)/.exec(patch);
    const secret = /appSecret:\s*(\S+)/.exec(patch);
    if (id?.[1] && secret?.[1]) {
      writeFileSync(credsFile, `${JSON.stringify({ appId: id[1], appSecret: secret[1] }, null, 2)}\n`);
      console.log(`  [setup] credentials exported to ${credsFile}`);
      process.env.E2E_APP_ID = id[1];
      process.env.E2E_APP_SECRET = secret[1];
    }
  }

  // 4. Browser session (scan with the same account; reused from the
  //    exchange). The console session does NOT authenticate the web app, so
  //    this is a separate one-time QR login.
  if (!existsSync(webSession)) {
    log('session', 'browser login required — scan with the account you choose');
    const res = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'e2e-login.mjs'), '--state', webSession],
      { cwd: ROOT, env: process.env, stdio: 'inherit' },
    );
    if (res.status !== 0) {
      console.error('✗ browser login failed');
      process.exit(2);
    }
  }

  // 4b. Setup mode: after the app + browser session are ready, verify the
  //     chat exists and stop. The user only ever needs to message the bot
  //     once (Feishu does not allow programmatic creation of the first
  //     user↔bot contact); everything else is exported for hands-free runs.
  if (env.E2E_SETUP === '1') {
    log('setup-check', 'verifying the chat exists (browser, list polling)');
    const check = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'e2e-check-chat.mjs')],
      { cwd: ROOT, env: process.env, stdio: 'inherit' },
    );
    if (check.status === 0) {
      console.log('\nE2E_SETUP_READY — environment prepared, later runs are hands-free');
      process.exit(0);
    }
    console.log(
      '\nE2E_SETUP_NEEDS_CHAT — in the Feishu app, search the bot and send it a message ' +
        '(creates the chat), then re-run `pnpm run e2e:setup`.',
    );
    process.exit(3);
  }

  // 5. Mock DeepSeek server.
  log('mock llm', `starting mock DeepSeek server on 127.0.0.1:${mockPort}`);
  const mock = spawn(process.execPath, [join(ROOT, 'scripts', 'e2e-mock-llm.mjs')], {
    env: { ...process.env, E2E_MOCK_PORT: mockPort },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(mock);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock LLM did not report a port')), 15_000);
    mock.stdout.on('data', (chunk) => {
      if (new RegExp(`PORT=${mockPort}`).test(String(chunk))) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  // 6. Boot dsh with the bot app.
  const appId = env.E2E_APP_ID ?? creds?.appId;
  const appSecret = env.E2E_APP_SECRET ?? creds?.appSecret;
  log('dsh', `starting dsh --profile e2e-dev (app ${appId})`);
  const dsh = spawn(dshBin, ['--profile', 'e2e-dev'], {
    env: {
      ...process.env,
      DSH_HOME: e2eHome,
      ...(appId !== undefined ? { FEISHU_APP_ID: appId } : {}),
      ...(appSecret !== undefined ? { FEISHU_APP_SECRET: appSecret } : {}),
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}`,
      FEISHU_DEBUG: process.env.FEISHU_DEBUG ?? '',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(dsh);
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 90_000);
    dsh.stdout.on('data', (chunk) => {
      if (/long connection ready|\[feishu\]/.test(String(chunk))) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  if (!ready) {
    console.error('✗ dsh did not report a ready feishu connection');
    process.exit(2);
  }
  console.log('  dsh feishu connection ready');

  // 7. Playwright scenarios (report + session live in the exchange). The
  //    e2e suite is compiled to .build/ first — Playwright does not resolve
  //    NodeNext `.js`-suffixed imports against `.ts` sources.
  log('playwright', 'compiling the e2e suite (container-local)');
  const tsc = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', 'e2e/tsconfig.build.json'], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (tsc.status !== 0) {
    console.error('✗ e2e tsc build failed');
    process.exit(2);
  }
  log('playwright', `running scenarios (chat "${chat}")`);
  const pw = join(ROOT, 'node_modules', '.bin', 'playwright');
  const res = spawnSync(pw, ['test', '--config', 'e2e/.build/playwright.config.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      E2E_CHAT: chat,
      E2E_VIDEO: video,
      E2E_SCREENSHOTS: env.E2E_SCREENSHOTS ?? 'on',
      E2E_REPORT_DIR: reportDir,
      E2E_SESSION_STATE: webSession,
      E2E_BASE_URL: env.E2E_BASE_URL ?? 'https://www.feishu.cn/',
      E2E_APP_ID: appId ?? '',
      E2E_APP_SECRET: appSecret ?? '',
    },
    stdio: 'inherit',
  });
  playwrightExit = res.status ?? 1;

  // 8. mp4 conversion.
  if (video === 'mp4') {
    const webms = collectFiles(reportDir, '.webm');
    for (const webm of webms) {
      const mp4 = webm.replace(/\.webm$/, '.mp4');
      log('convert', `${webm} -> ${mp4}`);
      const conv = spawnSync(
        'ffmpeg',
        ['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4],
        { stdio: 'inherit' },
      );
      if (conv.status !== 0) console.warn('  (mp4 conversion failed — keeping the webm)');
    }
  }

  // 9. Artifact manifest.
  const artifacts = collectArtifacts(reportDir);
  writeFileSync(
    join(reportDir, 'manifest.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), artifacts }, null, 2)}\n`,
  );
  log('report', `artifacts: ${artifacts.length} in ${reportDir}`);
  console.log(`  html: ${join(reportDir, 'html', 'index.html')}`);
}

const SCREENSHOT_EXT = new Set(['.png', '.jpg', '.jpeg']);
const VIDEO_EXT = new Set(['.webm', '.mp4']);

function collectArtifacts(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === 'html') continue;
        walk(full);
      } else {
        const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
        const kind = SCREENSHOT_EXT.has(ext) ? 'screenshot' : VIDEO_EXT.has(ext) ? 'video' : undefined;
        if (kind !== undefined) out.push({ kind, path: relative(dir, full), size: stat.size });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function collectFiles(dir, ext) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(ext)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

main()
  .catch((err) => {
    console.error(`✗ e2e failed: ${err.message}`);
    playwrightExit = 2;
  })
  .finally(() => {
    cleanup();
    console.log(`\nE2E finished (exit ${playwrightExit})`);
    process.exit(playwrightExit);
  });
