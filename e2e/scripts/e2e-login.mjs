#!/usr/bin/env node

/**
 * One-time feishu.cn web login for the E2E suite: opens the app, and when the
 * session is missing/expired, captures the rotating QR code (canvas element,
 * re-saved every few seconds so the file never goes stale), waits for the
 * scan, then writes the session state (cookies + localStorage) to
 * `E2E_SESSION_STATE` (default `<repo>/_dev/e2e-session/state.json`).
 *
 * The Playwright config injects that state via `storageState`, so a run
 * never re-scans while the session lives.
 *
 * Usage:
 *   node scripts/e2e-login.mjs [--state <path>] [--headed]
 *
 * The QR to scan is written to `<state dir>/qr.png` (refreshed every 5 s).
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// Browser cache: prefer the repo-local pw-browsers when present (host runs).
const LOCAL_BROWSERS = join(ROOT, '_dev', 'pw-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(LOCAL_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS;
}
process.env.XDG_CONFIG_HOME = join(ROOT, '_dev', 'e2e-session', 'config');
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

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test'); // devDep (resolvable top-level)

const argv = process.argv.slice(2);
const stateIdx = argv.indexOf('--state');
const stateFile =
  stateIdx >= 0 ? argv[stateIdx + 1] : join(ROOT, '_dev', 'e2e-session', 'state.json');
const headed = argv.includes('--headed');
const baseUrl = process.env.E2E_BASE_URL ?? 'https://www.feishu.cn/';
const appUrl = new URL('messenger/', baseUrl).href;

// E2E_DEBUG=1 adds fine-grained diagnostics (QR capture cycles, reloads).
const debugEnabled = process.env.E2E_DEBUG === '1';
function debug(...args) {
  if (debugEnabled) console.log('[debug]', ...args);
}
debug('login', `state=${stateFile} headed=${headed} baseUrl=${baseUrl}`);

/** True when the login page reports the QR as expired (so we reload). */
async function isQrExpired(page) {
  try {
    return await page.evaluate(() => {
      const re = /refresh|expired|过期|失效|已过期|刷新二维码/i;
      const text = document.body.innerText;
      // The login page body is short; only treat as expired when the QR area
      // itself shows a renewal prompt (not the whole page chrome).
      const qrBox = document.querySelector('[class*="scan-QR-code"], canvas');
      return qrBox ? re.test(qrBox.textContent ?? '') || re.test(text.slice(0, 200)) : false;
    });
  } catch {
    return false;
  }
}

const isAppUrl = (u) => /\/(messenger|home|space|contact|drive)([/?#]|$)/.test(u);

mkdirSync(dirname(stateFile), { recursive: true });

// The browser profile is ephemeral per-run (the durable artifact is the
// storageState written to --state); a temp profile avoids stale locks and
// permission issues on shared/state directories.
const { tmpdir } = await import('node:os');
const PROFILE = join(tmpdir(), `e2e-login-profile-${Date.now()}`);
for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  rmSync(join(PROFILE, lock), { force: true });
}

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: !headed,
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.route(/\.(woff2?|ttf|eot)(\?.*)?$/, (r) => r.abort()).catch(() => {});

await page.goto(appUrl, { waitUntil: 'commit', timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(8_000);

if (!isAppUrl(page.url())) {
  const qrPath = join(dirname(stateFile), 'qr.png');
  const deadline = Date.now() + 8 * 60 * 1000;
  let loggedIn = false;
  let lastRefresh = 0;
  let capturedOnce = false;
  console.log(`⏳ login required — scan ${qrPath} with the Feishu app`);
  while (Date.now() < deadline) {
    if (Date.now() - lastRefresh > 5_000) {
      lastRefresh = Date.now();
      // The login QR does NOT auto-rotate and is valid for a few minutes, so
      // we must NOT reload every cycle — reloading swaps the QR out from
      // under the user mid-scan, so their scan never confirms (a 5s reload
      // race). Only reload when the page clearly reports the QR as expired
      // (its text changes) or when no QR element can be captured at all.
      const expired = await isQrExpired(page);
      if (expired || !capturedOnce) {
        await page.reload({ waitUntil: 'commit', timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(6_000);
        debug(
          'qr',
          expired ? 'QR expired — reloaded for a fresh one' : 'first capture — loaded login page',
        );
      }
      let captured = false;
      for (const sel of [
        '[class*="scan-QR-code"] canvas',
        'canvas',
        'img[src*="qr"]',
        'img[class*="qrcode"]',
      ]) {
        try {
          const el = page.locator(sel).first();
          if ((await el.count()) > 0) {
            await el.screenshot({ path: qrPath, timeout: 10_000 });
            captured = true;
            break;
          }
        } catch {}
      }
      if (captured) {
        capturedOnce = true;
        console.log(`  [qr] refreshed ${new Date().toISOString()}`);
        debug('qr', `captured ${qrPath}`);
      } else {
        debug('qr', 'no QR element matched on this cycle');
      }
    }
    if (isAppUrl(page.url())) {
      loggedIn = true;
      break;
    }
    await page.waitForTimeout(1_000);
  }
  if (!capturedOnce && !loggedIn) {
    console.error(
      '✗ no QR code could be captured on the login page — is the login page rendering?',
    );
    process.exit(1);
  }
  if (!loggedIn) {
    console.error('✗ login timed out — no QR scan received');
    process.exit(1);
  }
}

await context.storageState({ path: stateFile });
await context.close();
console.log(`✓ session state saved to ${stateFile}`);
