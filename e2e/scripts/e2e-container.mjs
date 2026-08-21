#!/usr/bin/env node
/**
 * In-container E2E orchestration. The repo is mounted READ-ONLY at /repo and
 * copied to the container-local /app; every build artifact (node_modules,
 * lib, the pnpm store, the dsh home) stays in the container and vanishes
 * with it. Two small host mounts carry data out and back:
 *
 *   /state  (host e2e/.state)  — the exported one-time setup state:
 *     console-session.json (open-platform login, from setup:feishu)
 *     creds.json            (appId/appSecret of the bot under test)
 *     web-session.json      (feishu web login — the test account)
 *     user.json             (the test user's open_id, extracted from the
 *                            web session for backend group creation)
 *     setup.log, qr.png     (QR scan support files)
 *   /output (host e2e/.output) — one timestamped dir per run with the
 *     standardized report: summary.html/json, cases/<id>/report.html/json,
 *     screenshots, video.mp4; `latest` symlinks to the newest run
 *
 * Modes:
 *   E2E_SETUP=1  one-time environment setup, idempotent: every piece of
 *     state that already exists in /state is SKIPPED (no QR scans when the
 *     logins are already exported). Creates the bot app (open-platform QR
 *     scan), performs the web login (QR scan), extracts the user open_id,
 *     then probes group creation+deletion as an end-to-end check.
 *   otherwise    a test run: imports the setup state (creds, session,
 *     user open_id) into their designated places and runs the scenarios.
 *
 * Flow (test run):
 *   pnpm install → build → mock LLM + dsh (profile e2e-dev, app creds from
 *   /state/creds.json) → Playwright scenarios (each case creates its own
 *   backend group) → mp4 → single-entry report (summary.html).
 *
 * Env: E2E_STATE, E2E_OUTPUT, E2E_VIDEO, E2E_SCREENSHOTS, E2E_BASE_URL,
 * E2E_MOCK_PORT, E2E_BOT_NAME, E2E_APP_ID/E2E_APP_SECRET (override).
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = '/app'; // container-local copy of the repo
const env = process.env;

const state = env.E2E_STATE ?? '/state';
const outputRoot = env.E2E_OUTPUT ?? '/output';
const video = env.E2E_VIDEO ?? 'mp4';
// The run directory: a timestamped dir under the output root; `latest`
// symlinks to it. Every per-case group name embeds this runId, so group
// names are globally unique per run.
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = join(outputRoot, runId);
const mockPort = env.E2E_MOCK_PORT ?? '19090';
const dshBin = join(ROOT, 'node_modules', '.bin', 'dsh');
const e2eHome = join(ROOT, '_dev', 'e2e-dsh-home');
const profileDir = join(e2eHome, 'profiles', 'e2e-dev');
const consoleSession = join(state, 'console-session.json');
const webSession = join(state, 'web-session.json');
const credsFile = join(state, 'creds.json');
const userFile = join(state, 'user.json');
const setupLog = join(state, 'setup.log');

for (const k of [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
]) {
  delete process.env[k];
}
// Container-local pnpm store — never write into the copied repo's mounts.
process.env.npm_config_store_dir = '/tmp/pnpm-store';
process.env.npm_config_cache_dir = '/tmp/pnpm-cache';
process.env.CI = 'true';
process.env.XDG_CONFIG_HOME = '/tmp/e2e-xdg';

const children = [];
let exitCode = 1;
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

function loadJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

/** Read app credentials: env override first, then the exported creds.json. */
function readCreds() {
  const envCreds = Boolean(process.env.E2E_APP_ID && process.env.E2E_APP_SECRET);
  return envCreds
    ? { appId: process.env.E2E_APP_ID, appSecret: process.env.E2E_APP_SECRET }
    : loadJson(credsFile);
}

/** Compile the e2e suite to e2e/.build/ (Playwright needs .js imports). */
function compileE2e() {
  log('playwright', 'compiling the e2e suite (container-local)');
  const tsc = spawnSync(
    join(ROOT, 'node_modules', '.bin', 'tsc'),
    ['-p', 'e2e/tsconfig.build.json'],
    {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    },
  );
  if (tsc.status !== 0) {
    console.error('✗ e2e tsc build failed');
    process.exit(2);
  }
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
    const res = spawnSync('pnpm', ['run', 'build'], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    if (res.status !== 0) process.exit(2);
  }

  // 2. Profile prep (once per container; the dsh home is container-local).
  if (!existsSync(join(profileDir, 'package.json'))) {
    log('profile', 'installing the plugin into profile e2e-dev');
    const res = spawnSync(dshBin, ['plugin', '--profile', 'e2e-dev', 'add', `link:${ROOT}`], {
      env: { ...process.env, DSH_HOME: e2eHome },
      stdio: 'inherit',
    });
    if (res.status !== 0) process.exit(2);
  }

  // 3. Bot-app setup (idempotent): creds already exported -> skip entirely.
  //    Otherwise create the app via setup:feishu; a cached open-platform
  //    session skips the QR scan (--force-login only on a fresh session).
  let creds = readCreds();
  if (creds) {
    console.log(`  [setup] using app ${creds.appId} from ${credsFile}`);
  } else {
    const needsLogin = !existsSync(consoleSession);
    log(
      'setup',
      'creating the bot app (open-platform QR login — scan with the TEST account).\n' +
        `    scan the LATEST QR at ${setupLog} with the Feishu app (auto-refreshes; up to ${SETUP_ATTEMPTS} attempts)`,
    );
    let code = 1;
    for (let attempt = 1; attempt <= SETUP_ATTEMPTS; attempt += 1) {
      writeFileSync(setupLog, '', 'utf8');
      console.log(`  [setup] attempt ${attempt}/${SETUP_ATTEMPTS}`);
      code = await teeSpawn(
        'pnpm',
        [
          'run',
          'setup:feishu',
          '--',
          '--new',
          '--profile',
          'e2e-dev',
          '--dsh-home',
          e2eHome,
          '--app-name',
          env.E2E_BOT_NAME ?? 'DSH-E2E-TESTBOT',
          ...(needsLogin ? ['--force-login'] : []),
        ],
        {
          env: { ...process.env, DSH_HOME: e2eHome, DSH_FEISHU_SESSION: consoleSession },
          cwd: ROOT,
        },
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
      writeFileSync(
        credsFile,
        `${JSON.stringify({ appId: id[1], appSecret: secret[1] }, null, 2)}\n`,
      );
      console.log(`  [setup] credentials exported to ${credsFile}`);
      process.env.E2E_APP_ID = id[1];
      process.env.E2E_APP_SECRET = secret[1];
      creds = { appId: id[1], appSecret: secret[1] };
    } else {
      console.error('✗ setup:feishu succeeded but wrote no appId/appSecret to the profile');
      process.exit(2);
    }
  }

  // 4. Browser session (idempotent): reuse the exported web login; only scan
  //    when it is missing. The console session does NOT authenticate the web
  //    app, so this is a separate one-time QR login.
  if (!existsSync(webSession)) {
    log('session', 'browser login required — scan with the TEST account');
    const res = spawnSync(
      process.execPath,
      [join(ROOT, 'e2e', 'scripts', 'e2e-login.mjs'), '--state', webSession],
      { cwd: ROOT, env: process.env, stdio: 'inherit' },
    );
    if (res.status !== 0) {
      console.error('✗ browser login failed');
      process.exit(2);
    }
  } else {
    console.log('  [setup] reusing the exported web session');
  }

  // 5. Test-user open_id (idempotent, one-time): the browser sends the bot a
  //    p2p message (creates the chat), then the app's own credentials
  //    (im:chat / im:chat.members:read — already in the manifest) resolve
  //    the test user's open_id from that chat's members.
  if (!existsSync(userFile)) {
    log('user', 'sending a one-time p2p message to the bot and resolving the test user open_id');
    const res = spawnSync(
      process.execPath,
      [join(ROOT, 'e2e', 'scripts', 'e2e-user-id.mjs'), '--state', webSession, '--out', userFile],
      { cwd: ROOT, env: process.env, stdio: 'inherit' },
    );
    if (res.status !== 0) {
      console.error('✗ could not extract the test user open_id');
      process.exit(2);
    }
  } else {
    console.log('  [setup] reusing the exported test user open_id');
  }
  const user = loadJson(userFile);
  const userOpenId = user?.openId;

  // 6. Setup mode: verify group creation+deletion end-to-end, then stop.
  if (env.E2E_SETUP === '1') {
    compileE2e();
    log('setup-check', 'probing backend group creation (create + delete)');
    const probe = spawnSync(
      process.execPath,
      [join(ROOT, 'e2e', 'scripts', 'e2e-check-group.mjs'), '--run-id', runId],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          E2E_APP_ID: creds?.appId ?? '',
          E2E_APP_SECRET: creds?.appSecret ?? '',
          E2E_USER_OPEN_ID: userOpenId ?? '',
        },
        stdio: 'inherit',
      },
    );
    if (probe.status !== 0) {
      console.error('✗ group probe failed — the app cannot create groups yet');
      process.exit(2);
    }
    console.log('\nE2E_SETUP_READY — environment prepared, later runs are hands-free');
    exitCode = 0;
    return;
  }

  // 7. Test run: every piece of state must already exist (run e2e:setup).
  if (!creds || !userOpenId) {
    console.error('✗ setup state missing (creds or user open_id) — run `pnpm run e2e:setup` first');
    process.exit(2);
  }
  if (!existsSync(webSession)) {
    console.error('✗ web session missing — run `pnpm run e2e:setup` first');
    process.exit(2);
  }

  // 8. Mock DeepSeek server.
  log('mock llm', `starting mock DeepSeek server on 127.0.0.1:${mockPort}`);
  const mock = spawn(process.execPath, [join(ROOT, 'e2e', 'scripts', 'e2e-mock-llm.mjs')], {
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

  // 9. Boot dsh with the bot app.
  log('dsh', `starting dsh --profile e2e-dev (app ${creds.appId})`);
  const dsh = spawn(dshBin, ['--profile', 'e2e-dev'], {
    env: {
      ...process.env,
      DSH_HOME: e2eHome,
      FEISHU_APP_ID: creds.appId,
      FEISHU_APP_SECRET: creds.appSecret,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}`,
      FEISHU_DEBUG: process.env.FEISHU_DEBUG ?? '',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(dsh);
  // The readiness marker is the plugin's `[feishu] bridge ready` line
  // (src/index.ts) — `[feishu] starting surface` prints at boot before the
  // long connection is up, so matching it would start scenarios too early.
  // Accumulate stdout: a single `data` chunk may hold a partial line.
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 90_000);
    let buffer = '';
    dsh.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.includes('[feishu] bridge ready')) {
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

  // 10. Playwright scenarios: each case creates its own backend group named
  //     `<caseId>-<runId>` and opens it — no shared chat, no UI creation.
  compileE2e();
  log('playwright', `running scenarios (run ${runId})`);
  const pw = join(ROOT, 'node_modules', '.bin', 'playwright');
  const res = spawnSync(pw, ['test', '--config', 'e2e/.build/playwright.config.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      E2E_RUN_ID: runId,
      E2E_VIDEO: video,
      E2E_SCREENSHOTS: env.E2E_SCREENSHOTS ?? 'on',
      E2E_REPORT_DIR: reportDir,
      E2E_SESSION_STATE: webSession,
      E2E_BASE_URL: env.E2E_BASE_URL ?? 'https://www.feishu.cn/',
      E2E_APP_ID: creds.appId,
      E2E_APP_SECRET: creds.appSecret,
      E2E_USER_OPEN_ID: userOpenId,
    },
    stdio: 'inherit',
  });
  exitCode = res.status ?? 1;

  // 11. mp4 conversion.
  if (video === 'mp4') {
    const webms = collectFiles(reportDir, '.webm');
    for (const webm of webms) {
      const mp4 = webm.replace(/\.webm$/, '.mp4');
      log('convert', `${webm} -> ${mp4}`);
      const conv = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-i',
          webm,
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          mp4,
        ],
        { stdio: 'inherit' },
      );
      if (conv.status !== 0) console.warn('  (mp4 conversion failed — keeping the webm)');
    }
  }

  // 12. Single-entry run report: summary.html (Playwright-style) linking
  //     into cases/<id>/report.html, plus the JSON artifacts.
  log('report', `generating the run report in ${reportDir}`);
  const envForReport = {
    ...process.env,
    E2E_RUN_DIR: reportDir,
    E2E_APP_ID: creds?.appId ?? '',
    E2E_PLUGIN_VERSION: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
  };
  const gen = spawnSync(
    process.execPath,
    [join(ROOT, 'e2e', 'scripts', 'e2e-report.mjs'), reportDir],
    { cwd: ROOT, env: envForReport, stdio: 'inherit' },
  );
  if (gen.status !== 0) {
    // A run with no report is a failed run, not a warning.
    console.error('✗ report generation failed — raw Playwright output is still in reportDir');
    exitCode = 2;
  }
  // `latest` symlink → this run (remove-then-create; rm -f of a dir symlink is fine).
  spawnSync('sh', ['-c', `rm -f ${outputRoot}/latest && ln -s ${runId} ${outputRoot}/latest`], {
    stdio: 'ignore',
  });
  log('report', `run report: ${join(reportDir, 'summary.html')} (latest -> ${runId})`);
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
    exitCode = 2;
  })
  .finally(() => {
    cleanup();
    console.log(`\nE2E finished (exit ${exitCode})`);
    process.exit(exitCode);
  });
