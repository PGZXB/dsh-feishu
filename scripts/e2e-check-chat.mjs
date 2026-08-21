#!/usr/bin/env node
/**
 * Chat-existence check for the E2E setup: loads the exported browser session
 * (storageState), opens the messenger, and polls the chat list for the
 * target chat (E2E_CHAT). Exits 0 when found, 3 when missing — the setup
 * script uses the code to tell the user whether they still need to message
 * the bot once.
 *
 * Env: E2E_CHAT, E2E_SESSION_STATE (default /exchange/web-session.json).
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const env = process.env;

const chat = env.E2E_CHAT;
if (!chat) {
  console.error('✗ E2E_CHAT is required');
  process.exit(2);
}
const sessionState = env.E2E_SESSION_STATE ?? '/exchange/web-session.json';

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
  delete process.env[k];
}

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const { tmpdir } = require('node:os');
const { rmSync } = require('node:fs');

const PROFILE = join(tmpdir(), `e2e-check-chat-${Date.now()}`);
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.route(/\.(woff2?|ttf|eot)(\?.*)?$/, (r) => r.abort()).catch(() => {});

if (existsSync(sessionState)) {
  const s = JSON.parse(readFileSync(sessionState, 'utf8'));
  await context.addCookies(s.cookies);
}

await page
  .goto('https://www.feishu.cn/messenger/', { waitUntil: 'commit', timeout: 45_000 })
  .catch(() => {});
await page.waitForTimeout(10_000);

// The chat list is lazy-loaded; poll for the name (up to 60 s).
const deadline = Date.now() + 60_000;
let found = false;
while (Date.now() < deadline) {
  if ((await page.getByText(chat, { exact: false }).count()) > 0) {
    found = true;
    break;
  }
  await page.waitForTimeout(2_000);
}
await context.close();
console.log(found ? `CHAT_FOUND "${chat}"` : `CHAT_MISSING "${chat}"`);
process.exit(found ? 0 : 3);
