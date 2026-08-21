#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = '/app';
for (const k of ['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','all_proxy','ALL_PROXY']) delete process.env[k];
process.env.XDG_CONFIG_HOME = join(ROOT, '_dev', 'e2e-session', 'config');
const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const { tmpdir } = require('node:os');
const PROFILE = join(tmpdir(), `debug-search-${Date.now()}`);
const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1440, height: 900 } });
const page = context.pages()[0] ?? (await context.newPage());
await page.route(/\.(woff2?|ttf|eot)(\?.*)?$/, (r) => r.abort()).catch(() => {});
const s = JSON.parse(readFileSync('/state/web-session.json', 'utf8'));
await context.addCookies(s.cookies ?? []);
for (const origin of s.origins ?? []) {
  await page.goto(`${origin.origin}/`, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {});
  for (const item of origin.localStorage ?? []) {
    await page.evaluate(([k, v]) => window.localStorage.setItem(k, v), [item.name, item.value]).catch(() => {});
  }
}
await page.goto('https://www.feishu.cn/messenger/', { waitUntil: 'commit', timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(10000);
const listRow = page.getByText('DSH-E2E-TESTBOT', { exact: false }).first();
if ((await listRow.count().catch(() => 0)) > 0) {
  const row = listRow.locator('xpath=ancestor::*[contains(@class,"chat")][1]');
  if ((await row.count().catch(() => 0)) > 0) await row.click();
  else await listRow.click();
  await page.waitForTimeout(8000);
}
// Dump the innerHTML of the chat pane (bounded) and search for any id-ish tokens
const html = await page.evaluate(() => {
  const comp = document.querySelector('.innerdocbody:visible');
  if (!comp) return '';
  let el = comp;
  for (let i = 0; i < 6 && el; i++) el = el.parentElement;
  return (el ? el.innerHTML : '').slice(0, 12000);
}).catch(() => '');
writeFileSync('/state/dbg-chatpane.html', html);
const tokens = [...new Set(html.match(/[a-z][a-z0-9_-]{2,40}/g) ?? [])].filter(t => /^oc_/.test(t) || /chat|conversation/i.test(t));
console.log('tokens with chat/conversation/oc_:', JSON.stringify(tokens.slice(0, 30)));
console.log('html len:', html.length);
await context.close();
