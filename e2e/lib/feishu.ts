/**
 * Feishu web client helpers: the selectors and interaction sequences the E2E
 * scenarios drive. Rule-based throughout — every assertion reads the rendered
 * DOM, never a vision call.
 *
 * Selectors were captured from a real feishu.cn web session (see
 * `docs/e2e-testing.md` → "Selectors"): the chat input is a
 * `DIV[contenteditable="true"]` (`.zone-container.editor-kit-container`),
 * message items carry `.js-message-item` (`.message-self` /
 * `.message-not-self`), and card buttons are real `<button>` elements.
 *
 * @module e2e/lib/feishu
 */

import type { Locator, Page } from '@playwright/test';
import type { E2eConfig } from './config.js';

/** One chat message as rendered in the web client. */
export interface ChatMessage {
  readonly text: string;
  /** Whether the message was sent by the logged-in user (self). */
  readonly isSelf: boolean;
}

/** True when the URL is inside the feishu app shell (any tenant subdomain). */
export function isAppUrl(url: string): boolean {
  return /\/(messenger|home|space|contact|drive)([/?#]|$)/.test(url);
}

/**
 * Open the feishu web app (messenger) and wait until the app shell appears.
 * Session state is injected by the Playwright config, so a valid session
 * lands directly in the app; an expired one bounces to the login page and
 * this throws with a pointer to `pnpm run e2e:login`.
 * @param page - the browser page.
 * @param cfg - resolved E2E configuration.
 */
export async function openApp(page: Page, cfg: E2eConfig): Promise<void> {
  await page
    .goto(new URL('messenger/', cfg.baseUrl).href, { waitUntil: 'commit', timeout: 45_000 })
    .catch(() => {});
  const deadline = Date.now() + cfg.timeoutMs;
  for (;;) {
    if (isAppUrl(page.url())) return;
    if (Date.now() > deadline) {
      throw new Error(
        `feishu app did not open (url=${page.url()}) — the session may be expired; run \`pnpm run e2e:login\``,
      );
    }
    await page.waitForTimeout(1_000);
  }
}

/**
 * Open a chat by the name shown in the chat list. The list preview and the
 * opened chat both show the name; clicking the first visible match opens the
 * conversation (waits until message items render). When no list match exists
 * (a brand-new bot has no chat yet), fall back to the search box
 * (Ctrl+K / the search modal): typing the name and picking the first result
 * CREATES the p2p chat as a side effect.
 * @param page - the browser page.
 * @param name - the chat name to open.
 * @param timeoutMs - how long to wait for the chat to render.
 */
export async function openChat(page: Page, name: string, timeoutMs: number): Promise<void> {
  // The chat list is lazy-loaded — the freshly-created bot chat can take a
  // while to appear. Poll for the list item (up to timeoutMs) before
  // clicking, so the search fallback only runs when the chat truly does not
  // exist.
  const deadline = Date.now() + Math.min(timeoutMs, 45_000);
  let listMatch: Locator | undefined;
  for (;;) {
    const candidate = page.getByText(name, { exact: false }).first();
    if ((await candidate.count()) > 0) {
      listMatch = candidate;
      break;
    }
    if (Date.now() > deadline) break;
    await page.waitForTimeout(1_000);
  }
  if (listMatch === undefined) {
    await openChatViaSearch(page, name);
  } else {
    // Click the clickable ROW that carries the name, not the text node.
    const row = listMatch.locator('xpath=ancestor::*[contains(@class,"chat")][1]');
    if ((await row.count()) > 0) {
      await row.click();
    } else {
      await listMatch.click();
    }
  }
  // The chat pane is open when its messages render (the fresh chat carries
  // the user's first message). A message item is unambiguous — the search
  // modal never renders one.
  await page.locator('.js-message-item').first().waitFor({ state: 'visible', timeout: timeoutMs });
}

/** Search for `name` via the messenger search and click the first result. */
async function openChatViaSearch(page: Page, name: string): Promise<void> {
  // Open the search: the sidebar "Search" entry renders as two paragraphs
  // inside a clickable container — click the PARENT of the text, not the
  // text node (SPA handlers sit on the container).
  const searchText = page.getByText('Search', { exact: true }).first();
  let clickable: import('@playwright/test').Locator;
  if ((await searchText.count()) > 0) {
    clickable = searchText.locator('..');
  } else {
    clickable = page.getByText('(Ctrl+K)', { exact: true }).first().locator('..');
  }
  await clickable.click();
  await page.waitForTimeout(2_000);
  const input = page
    .locator('[class*="search"] input, input:visible, [contenteditable="true"]:visible')
    .last();
  await input.fill(name);
  await page.waitForTimeout(2_500);
  const result = page
    .locator(
      '[class*="search"] [class*="result"], [class*="SearchResult"] [class*="item"], [class*="contact"] [class*="item"], [class*="menu"] [class*="item"]',
    )
    .first();
  await result.click();
}

/**
 * Read every message currently rendered in the opened chat, top to bottom.
 * @param page - the browser page.
 * @returns the chat messages.
 */
export async function chatMessages(page: Page): Promise<ChatMessage[]> {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('.js-message-item')];
    return items.map((el) => ({
      text: (el.textContent ?? '').trim(),
      isSelf: el.classList.contains('message-self'),
    }));
  });
}

/**
 * Send a text message into the opened chat (the input is a contenteditable
 * div — filling it then pressing Enter submits).
 * @param page - the browser page.
 * @param text - the message text (a slash line like `/help` works).
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  // The CHAT composer specifically (the search modal has its own
  // contenteditable — typing there sends the message nowhere).
  const input = page.locator('.innerdocbody:visible, [class*="editor-kit"]:visible').last();
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

/**
 * Click a button whose accessible name or text contains `label`.
 * @param page - the browser page.
 * @param label - substring of the button label (e.g. `生成工作复盘`).
 */
export async function clickButton(page: Page, label: string): Promise<void> {
  await page
    .getByRole('button', { name: new RegExp(label) })
    .first()
    .click();
}

/**
 * Click a card action by the text inside the card element that carries it
 * (fallback when the element is not a `<button>` role).
 * @param page - the browser page.
 * @param label - substring of the card text to click.
 */
export async function clickCardText(page: Page, label: string): Promise<void> {
  await page.getByText(label, { exact: false }).first().click();
}
