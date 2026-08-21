/**
 * Rule-based chat assertions: wait until a bot reply matches, reading the
 * rendered DOM only. No vision calls — assertions must stay free and
 * deterministic (see `docs/e2e-testing.md` → "Constraints").
 *
 * @module e2e/helpers/assert
 */

import type { Page } from '@playwright/test';
import { type ChatMessage, chatMessages } from './feishu.js';

/**
 * Wait until a bot (non-self) message in the opened chat contains `text`.
 * Polls the rendered messages and throws with the recent history on timeout —
 * the failure payload is the rule-based evidence (no screenshots required to
 * diagnose).
 * @param page - the browser page.
 * @param text - substring the bot reply must contain.
 * @param timeoutMs - how long to wait.
 * @returns the matching bot message.
 */
export async function waitForBotReplyContaining(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<ChatMessage> {
  const deadline = Date.now() + timeoutMs;
  let recent: ChatMessage[] = [];
  for (;;) {
    recent = await chatMessages(page);
    const match = recent.find((m) => !m.isSelf && m.text.includes(text));
    if (match !== undefined) return match;
    if (Date.now() > deadline) {
      const tail = recent
        .slice(-6)
        .map((m) => `${m.isSelf ? 'self' : 'bot'}: ${m.text.slice(0, 120)}`)
        .join('\n');
      throw new Error(
        `timed out waiting for bot reply containing "${text}"\nlast messages:\n${tail || '(none rendered)'}`,
      );
    }
    await page.waitForTimeout(500);
  }
}

/**
 * Wait until a bot message (a rendered card, which is also a message item)
 * contains `text`. Intended for interactive cards whose body text may spread
 * across elements — the whole message textContent is the assertion target.
 * @param page - the browser page.
 * @param text - substring the card must contain.
 * @param timeoutMs - how long to wait.
 */
export async function waitForCardContaining(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let recent: ChatMessage[] = [];
  for (;;) {
    recent = await chatMessages(page);
    const cardMatch = recent.find((m) => !m.isSelf && m.text.includes(text));
    if (cardMatch !== undefined) return;
    if (Date.now() > deadline) {
      const tail = recent
        .slice(-6)
        .map((m) => `${m.isSelf ? 'self' : 'bot'}: ${m.text.slice(0, 120)}`)
        .join('\n');
      throw new Error(
        `timed out waiting for a card containing "${text}"\nlast messages:\n${tail || '(none rendered)'}`,
      );
    }
    await page.waitForTimeout(500);
  }
}
