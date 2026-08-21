#!/usr/bin/env node
/**
 * Extract the test user's Feishu open_id during `e2e:setup` (one-time).
 *
 * Feishu's web client never exposes the current user's open_id — it only
 * works with the internal user_id. The backend group creation needs the
 * open_id, so the setup resolves it from a real user↔bot exchange:
 *
 *   1. the browser (using the exported web session) opens the global search
 *      (Ctrl+K), types the bot name, and clicks the bot result card — this
 *      opens the p2p chat with the bot;
 *   2. it sends a private message (creating the chat if needed);
 *   3. the app's OWN credentials (im:chat / im:chat.members:read — already
 *      in the manifest, no extra scope) list that chat and read its member
 *      open ids;
 *   4. the member that is not the bot is the test user → written to user.json.
 *
 * This runs exactly once, during `e2e:setup`; test runs never re-send the
 * message (user.json is already exported). All rule-based — DOM/API
 * inspection only, no vision.
 *
 * Usage: node scripts/e2e-user-id.mjs [--state <web-session.json>] [--out <user.json>]
 * Env: E2E_BOT_NAME (default DSH-E2E-TESTBOT), E2E_APP_ID, E2E_APP_SECRET
 *      (fall back to the state dir's creds.json).
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

const botName = process.env.E2E_BOT_NAME ?? 'DSH-E2E-TESTBOT';

// App credentials: env first, then the exported state dir (E2E_STATE, e.g.
// /state in the container — the host e2e/.state mount).
const stateDir = process.env.E2E_STATE ?? join(ROOT, 'e2e', '.state');
const credsFile = join(stateDir, 'creds.json');
const appId = process.env.E2E_APP_ID ?? (existsSync(credsFile) ? JSON.parse(readFileSync(credsFile, 'utf8')).appId : undefined);
const appSecret = process.env.E2E_APP_SECRET ?? (existsSync(credsFile) ? JSON.parse(readFileSync(credsFile, 'utf8')).appSecret : undefined);
if (!appId || !appSecret) {
  console.error('✗ E2E_APP_ID / E2E_APP_SECRET required (or creds.json in the state dir)');
  process.exit(2);
}

const OPEN_BASE = 'https://open.feishu.cn';

/** Fetch a tenant_access_token for the bot app. */
async function tenantToken() {
  const res = await fetch(`${OPEN_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await res.json();
  if (body.code !== 0 || body.tenant_access_token === undefined) {
    throw new Error(`tenant token failed: ${body.code} ${body.msg ?? ''}`);
  }
  return body.tenant_access_token;
}

/** The bot's own open id (`bot/v3/info`), to exclude it from the member list. */
async function botOpenId(token) {
  const res = await fetch(`${OPEN_BASE}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (body.code !== 0) throw new Error(`bot/v3/info failed: ${body.code} ${body.msg ?? ''}`);
  return body.data?.open_id;
}

/** List the bot's chats; return the p2p chat id (or undefined). */
async function findP2pChat(token) {
  const res = await fetch(
    `${OPEN_BASE}/open-apis/im/v1/chats?user_id_type=open_id&page_size=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await res.json();
  if (body.code !== 0) throw new Error(`im/v1/chats failed: ${body.code} ${body.msg ?? ''}`);
  for (const item of body.data?.items ?? []) {
    if (item.chat_type === 'p2p') return item;
  }
  return undefined;
}

/** Member open ids of a chat (`im:chat.members:read`, already granted). */
async function memberOpenIds(token, chatId) {
  const res = await fetch(
    `${OPEN_BASE}/open-apis/im/v1/chats/${chatId}/members?member_id_type=open_id&page_size=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await res.json();
  if (body.code !== 0) throw new Error(`im/v1/chats/:id/members failed: ${body.code} ${body.msg ?? ''}`);
  return (body.data?.items ?? []).map((m) => m.member_id).filter(Boolean);
}

const require = createRequire(import.meta.url);
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

await page.goto('https://www.feishu.cn/messenger/', { waitUntil: 'commit', timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(10_000);

// 1. Global search (Ctrl+K) → type the bot name → click the bot result card.
console.log(`  [user] searching for the bot "${botName}" (Ctrl+K)`);
await page.keyboard.press('Control+k');
await page.waitForTimeout(2_500);
const searchBox = page.locator('.zone-container.editor-kit-container:visible').first();
await searchBox.click();
await searchBox.pressSequentially(botName, { delay: 25 });
await page.waitForTimeout(3_500);

// The bot appears as a `.bot-result-card` (cursor:pointer) in the search
// results; clicking it opens the p2p chat. The bot name is unique per setup
// run (`DSH-E2E-TESTBOT-<stamp>`), so exactly one card carries it.
const botCard = page.locator('.bot-result-card:visible').filter({ hasText: botName }).first();
if ((await botCard.count().catch(() => 0)) === 0) {
  console.error(`✗ no bot result card found for "${botName}" in the search results`);
  process.exit(2);
}
await botCard.click();
await page.waitForTimeout(5_000);

// 2. Send a private message — creates/confirms the p2p chat with the bot.
const composer = page.locator('.innerdocbody:visible, [class*="editor-kit"]:visible').last();
await composer.click();
await composer.fill('e2e setup probe — one-time user resolution');
await composer.press('Enter');
await page.waitForTimeout(4_000);
await context.close();
console.log('  [user] p2p message sent to the bot');

// 3. Resolve the test user's open_id from the resulting chat via the app API.
const token = await tenantToken();
const botOpenIdValue = await botOpenId(token);
// The p2p chat may take a moment to reach the bot's chat list.
let p2p;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  p2p = await findP2pChat(token);
  if (p2p !== undefined) break;
  console.log(`  [user] p2p chat not listed yet (attempt ${attempt}/5) — retrying`);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
let openId;
if (p2p?.chat_id !== undefined) {
  const members = await memberOpenIds(token, p2p.chat_id);
  openId = members.find((m) => m !== botOpenIdValue);
  console.log(
    `  [user] p2p chat ${p2p.chat_id} members: ${members.join(', ')} (bot: ${botOpenIdValue})`,
  );
} else {
  console.error('  [user] no p2p chat found — did the message reach the bot?');
}

if (openId === undefined || !/^ou_/.test(openId)) {
  console.error('✗ could not resolve the test user open_id (no p2p chat / member mismatch).');
  console.error('  Check that the bot app is the one the message was sent to.');
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify({ openId }, null, 2)}\n`);
console.log(`✓ test user open_id: ${openId} -> ${outFile}`);
process.exit(0);
