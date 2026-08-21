/**
 * Anchor E2E scenario: send `/help` in the bot chat and verify the bot
 * replies with the slash-command descriptions.
 *
 * The `/help` handler (src/commands/surface.ts) answers with a block that
 * starts `dsh-feishu commands:` and lists every registered command as
 * `/name — description` — so the assertions are rule-based text checks on
 * the rendered chat, with zero dependency on the LLM (the command resolves
 * locally in the plugin).
 *
 * The chat is opened through the messenger UI (search fallback creates the
 * p2p chat on first contact).
 *
 * @module e2e/scenarios/help
 */

import { test } from '@playwright/test';
import { waitForBotReplyContaining } from '../lib/assert.js';
import { loadE2eConfig } from '../lib/config.js';
import { openApp, openChat, sendMessage, snapshot } from '../lib/feishu.js';

const cfg = loadE2eConfig();

test('send /help → slash command descriptions', async ({ page }, testInfo) => {
  await openApp(page, cfg);
  await openChat(page, cfg.chatName, cfg.timeoutMs);
  // Key evidence point 1: the chat is open, composer visible.
  await snapshot(page, cfg, 'help-chat-open');

  await sendMessage(page, '/help');
  // Key evidence point 2: the /help message is in the chat.
  await snapshot(page, cfg, 'help-sent');

  // The help block opens with the header and includes at least the /help
  // command's own line — two independent rule-based assertions.
  await waitForBotReplyContaining(page, 'dsh-feishu commands:', cfg.timeoutMs);
  const reply = await waitForBotReplyContaining(
    page,
    '/help — List all surface commands',
    cfg.timeoutMs,
  );

  // Key evidence point 3: the final bot reply with the command list.
  await snapshot(page, cfg, 'help-reply');

  testInfo.annotations.push({
    type: 'evidence',
    description: `bot reply (first 300 chars): ${reply.text.slice(0, 300)}`,
  });
});
