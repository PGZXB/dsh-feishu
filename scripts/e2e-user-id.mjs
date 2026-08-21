#!/usr/bin/env node
/**
 * Extract the test user's Feishu open_id during `e2e:setup` (one-time).
 *
 * The plugin's `/group` command gets the requester's open_id from the
 * `im.message.receive_v1` event (`data.sender.sender_id.open_id`). The
 * setup reuses that exact path:
 *
 *   1. a `WSClient` long connection (the same SDK the plugin's transport
 *      uses) listens for message events, registered to
 *      `im.message.receive_v1`;
 *   2. the browser (using the exported web session) opens the bot's p2p
 *      chat via the global search (Ctrl+K) and sends a private message;
 *   3. the event arrives with `sender.sender_id.open_id` = the TEST user's
 *      open id → written to user.json.
 *
 * No extra API scope is needed: the app's existing `im:chat` permissions
 * and the long connection are all `im.message.receive_v1` requires.
 *
 * This runs exactly once, during `e2e:setup`; test runs never re-send the
 * message (user.json is already exported). All rule-based — DOM/API
 * inspection only, no vision.
 *
 * Usage: node scripts/e2e-user-id.mjs [--state <web-session.json>] [--out <user.json>]
 * Env: E2E_BOT_NAME (default DSH-E2E-TESTBOT-<stamp> from the state dir),
 *      E2E_APP_ID, E2E_APP_SECRET (fall back to creds.json in the state dir).
 * Writes `{ "openId": "ou_..." }` to the out file; exits 0 on success.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const argv = process.argv.slice(2);
const stateIdx = argv.indexOf('--state');
const sessionState = stateIdx >= 0 ? argv[stateIdx + 1] : join(ROOT, 'e2e', '.state', 'web-session.json');
const outIdx = argv.indexOf('--out');
const outFile = outIdx >= 0 ? argv[outIdx + 1] : join(ROOT, 'e2e', '.state', 'user.json');

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
  delete process.env[k];
}
process.env.XDG_CONFIG_HOME = join(ROOT, '_dev', 'e2e-session', 'config');

if (!existsSync(sessionState)) {
  console.error(`✗ web session not found at ${sessionState} — run the browser login first`);
  process.exit(2);
}

// The bot app name (unique per setup run, persisted in the state dir).
const stateDir = process.env.E2E_STATE ?? join(ROOT, 'e2e', '.state');
const botNameFile = join(stateDir, 'bot-name');
const botName =
  process.env.E2E_BOT_NAME ??
  (existsSync(botNameFile) ? readFileSync(botNameFile, 'utf8').trim() : 'DSH-E2E-TESTBOT');

// App credentials: env first, then creds.json in the state dir.
const credsFile = join(stateDir, 'creds.json');
const appId = process.env.E2E_APP_ID ?? (existsSync(credsFile) ? JSON.parse(readFileSync(credsFile, 'utf8')).appId : undefined);
const appSecret = process.env.E2E_APP_SECRET ?? (existsSync(credsFile) ? JSON.parse(readFileSync(credsFile, 'utf8')).appSecret : undefined);
if (!appId || !appSecret) {
  console.error('✗ E2E_APP_ID / E2E_APP_SECRET required (or creds.json in the state dir)');
  process.exit(2);
}

// ── 1. WSClient long connection — capture the incoming message event ──────
const require = createRequire(import.meta.url);
const { WSClient, EventDispatcher } = require('@larksuiteoapi/node-sdk');

let resolveOpenId;
let rejectOpenId;
const openIdPromise = new Promise((resolve, reject) => {
  resolveOpenId = resolve;
  rejectOpenId = reject;
});
const eventTimeout = setTimeout(() => {
  rejectOpenId(new Error('no im.message.receive_v1 event within 60 s — did the message reach the bot?'));
}, 60_000);

const dispatcher = new EventDispatcher({}).register({
  'im.message.receive_v1': (data) => {
    const openId = data?.sender?.sender_id?.open_id;
    if (typeof openId === 'string' && openId !== '') {
      clearTimeout(eventTimeout);
      console.log(`  [user] message event received — sender open_id: ${openId}`);
      resolveOpenId(openId);
    }
    return undefined;
  },
});
const ws = new WSClient({
  appId,
  appSecret,
  autoReconnect: true,
  handshakeTimeoutMs: 15_000,
  onReady: () => console.log('  [user] long connection ready — send the message now'),
  onError: (error) => console.log(`  [user] long connection error: ${error.message}`),
});

// ── 2. Browser: open the bot's p2p chat and send the message ──────────────
const { chromium } = require('@playwright/test'); // devDep (resolvable top-level)
const { tmpdir } = require('node:os');

const PROFILE = join(tmpdir(), `e2e-user-id-${Date.now()}`);
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.route(/\.(woff2?|ttf|eot)(\?.*)?$/, (r) => r.abort()).catch(() => {});

const s = JSON.parse(readFileSync(sessionState, 'utf8'));
await context.addCookies(s.cookies ?? []);
for (const origin of s.origins ?? []) {
  await page.goto(`${origin.origin}/`, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {});
  for (const item of origin.localStorage ?? []) {
    await page.evaluate(
      ([k, v]) => window.localStorage.setItem(k, v),
      [item.name, item.value],
    ).catch(() => {});
  }
}

await ws.start({ eventDispatcher: dispatcher });
await page.goto('https://www.feishu.cn/messenger/', { waitUntil: 'commit', timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(10_000);

// Global search (Ctrl+K) → type the bot name → click the bot result card.
console.log(`  [user] searching for the bot "${botName}" (Ctrl+K)`);
await page.keyboard.press('Control+k');
await page.waitForTimeout(2_500);
const searchBox = page.locator('.zone-container.editor-kit-container:visible').first();
await searchBox.click();
await searchBox.pressSequentially(botName, { delay: 25 });
await page.waitForTimeout(3_500);

// The bot appears as a `.bot-result-card` (cursor:pointer) in the search
// results; clicking it opens the p2p chat. The bot name is unique per setup
// run, so exactly one card carries it.
const botCard = page.locator('.bot-result-card:visible').filter({ hasText: botName }).first();
if ((await botCard.count().catch(() => 0)) === 0) {
  console.error(`✗ no bot result card found for "${botName}" in the search results`);
  ws.close();
  process.exit(2);
}
await botCard.click();
await page.waitForTimeout(5_000);

// Send a private message — the incoming event carries the sender open_id.
const composer = page.locator('.innerdocbody:visible, [class*="editor-kit"]:visible').last();
await composer.click();
await composer.fill('e2e setup probe — one-time user resolution');
await composer.press('Enter');
await page.waitForTimeout(2_000);
await context.close();
console.log('  [user] p2p message sent, waiting for the event…');

// ── 3. Resolve the open_id from the event ─────────────────────────────────
let openId;
try {
  openId = await openIdPromise;
} catch (error) {
  console.error(`✗ ${error.message}`);
  ws.close();
  process.exit(1);
}
ws.close();

if (typeof openId !== 'string' || !/^ou_/.test(openId)) {
  console.error(`✗ invalid open_id resolved: ${JSON.stringify(openId)}`);
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify({ openId }, null, 2)}\n`);
console.log(`✓ test user open_id: ${openId} -> ${outFile}`);
process.exit(0);
