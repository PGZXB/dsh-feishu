#!/usr/bin/env node
/**
 * Extract the test user's Feishu open_id from the saved web session
 * (storageState written by e2e-login.mjs). The backend group creation
 * (`e2e/lib/group.ts` → `im.v1.chat.create`) needs the test user's open_id
 * to invite them into per-case groups; the plugin gets it from message
 * events in the UI, but the backend has no message event — so we read it
 * from the authenticated web app instead.
 *
 * Strategies, in order (all rule-based — DOM/state inspection, never vision):
 *   1. localStorage deep-scan for an `ou_` open_id value
 *   2. the space web app's own user-info endpoint
 *   3. embedded initial state / DOM attributes
 * On failure the script prints what it DID find (keys, shapes) so the next
 * iteration targets the real structure.
 *
 * Usage: node scripts/e2e-user-id.mjs [--state <web-session.json>] [--out <user.json>]
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

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test'); // devDep (resolvable top-level)
const { tmpdir } = require('node:os');
const { rmSync } = require('node:fs');

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
await page.waitForTimeout(8_000);

const OPEN_ID_RE = /ou_[0-9a-zA-Z_-]{10,}/;

/** Recursively find a string that looks like a Feishu open_id. */
function findOpenIdIn(value, path, out) {
  if (typeof value === 'string' && OPEN_ID_RE.test(value)) {
    out.push({ path, value: value.match(OPEN_ID_RE)[0] });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findOpenIdIn(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'open_id' || k === 'openId' || k === 'openid') {
        if (typeof v === 'string' && OPEN_ID_RE.test(v)) out.push({ path: `${path}.${k}`, value: v });
      }
      findOpenIdIn(v, `${path}.${k}`, out);
    }
  }
}

const diagnostics = { localStorageKeys: [], openIds: [], apiResponses: [] };

// 1. localStorage deep-scan.
const ls = await page
  .evaluate(() => {
    const out = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      out[k] = window.localStorage.getItem(k);
    }
    return out;
  })
  .catch(() => ({}));
diagnostics.localStorageKeys = Object.keys(ls);
for (const [k, v] of Object.entries(ls)) {
  let parsed = v;
  try {
    parsed = JSON.parse(v);
  } catch {}
  findOpenIdIn(parsed, `localStorage.${k}`, diagnostics.openIds);
}

// 2. The space web app's user-info endpoint (same-origin, session cookies).
for (const url of [
  'https://www.feishu.cn/space/api/user/info/',
  'https://www.feishu.cn/messenger/api/user/info/',
]) {
  try {
    const text = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
      return { status: res.status, text: await res.text() };
    }, url);
    diagnostics.apiResponses.push({ url, status: text.status, body: text.text.slice(0, 400) });
    findOpenIdIn(text.text, `api(${url})`, diagnostics.openIds);
  } catch {}
}

// 3. Embedded initial state / DOM attributes.
const domHints = await page
  .evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('script, [data-user], [data-open-id]')) {
      const raw = el.textContent ?? el.getAttribute('data-user') ?? el.getAttribute('data-open-id') ?? '';
      if (raw.includes('ou_')) out.push(raw.slice(0, 200));
      if (out.length >= 5) break;
    }
    return out;
  })
  .catch(() => []);
for (const hint of domHints) {
  const m = hint.match(OPEN_ID_RE);
  if (m) diagnostics.openIds.push({ path: 'dom', value: m[0] });
}

await context.close();

// Prefer an open_id under an explicit key, then any `ou_` match.
const explicit = diagnostics.openIds.find((o) => /open_id|openId/i.test(o.path));
const match = explicit ?? diagnostics.openIds[0];
if (match) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ openId: match.value }, null, 2)}\n`);
  console.log(`✓ test user open_id: ${match.value} (from ${match.path}) -> ${outFile}`);
  process.exit(0);
}

console.error('✗ could not extract the test user open_id from the web session.');
console.error('  localStorage keys:', diagnostics.localStorageKeys.join(', ') || '(none)');
console.error('  api responses:', JSON.stringify(diagnostics.apiResponses, null, 2));
console.error('  open-id candidates:', JSON.stringify(diagnostics.openIds, null, 2));
console.error('  dom hints:', JSON.stringify(domHints, null, 2));
console.error('  Re-run after logging in with the test account; if this persists, the ');
console.error('  session/user-id shape changed and the strategies above need updating.');
process.exit(1);
