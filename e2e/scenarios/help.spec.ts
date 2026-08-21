/**
 * Anchor E2E scenario: send `/help` in the bot's group chat and verify the
 * bot replies with the slash-command descriptions.
 *
 * Each case runs in its OWN group chat (name `<caseId>-<runId>`, unique per
 * run), created through the backend — the same `im.v1.chat.create` call the
 * plugin's `/group` command wraps — so cases never share a chat page. The
 * browser only opens the already-created group.
 *
 * The `/help` handler (src/commands/surface.ts) answers with a block that
 * starts `dsh-feishu commands:` and lists every registered command as
 * `/name — description` — so the assertions are rule-based text checks on
 * the rendered chat, with zero dependency on the LLM (the command resolves
 * locally in the plugin).
 *
 * @module e2e/scenarios/help
 */

import { test } from '@playwright/test';
import { waitForBotReplyContaining } from '../helpers/assert.js';
import { loadE2eConfig } from '../helpers/config.js';
import { openApp, openChat, sendMessage, snapshot } from '../helpers/feishu.js';
import { createGroup, deleteGroup, groupNameFor } from '../helpers/group.js';
import { caseIdFromTitle } from '../helpers/report.js';

const cfg = loadE2eConfig();

// E2E_DEBUG=1 adds fine-grained diagnostics (group create/delete, DOM steps)
// on top of the scenario's normal progress logs.
const debugEnabled = process.env.E2E_DEBUG === '1';
const debug = (...args: unknown[]) => {
  if (debugEnabled) console.log('[debug]', ...args);
};

test('send /help → slash command descriptions', async ({ page }, testInfo) => {
  // Backend group creation (the same call /group wraps): each case owns a
  // uniquely-named group, so parallel runs never share a chat page. The
  // group is disbanded in `finally` — every run cleans up after itself.
  const caseId = caseIdFromTitle(testInfo.title);
  const groupName = groupNameFor(caseId, cfg.runId);
  debug('case', `caseId=${caseId} group=${groupName} runId=${cfg.runId}`);
  if (cfg.userOpenId === undefined) {
    throw new Error('E2E_USER_OPEN_ID is required (run `pnpm run e2e:setup` first)');
  }
  const { chatId } = await createGroup(cfg, groupName, [cfg.userOpenId], fetch, debug);
  try {
    await openApp(page, cfg);
    await openChat(page, groupName, cfg.timeoutMs);
    // Key evidence point 1: the group chat is open, composer visible.
    await snapshot(page, cfg, 'help-chat-open', caseId);

    await sendMessage(page, '/help');
    // Key evidence point 2: the /help message is in the chat.
    await snapshot(page, cfg, 'help-sent', caseId);

    // The help block opens with the header and includes at least the /help
    // command's own line — two independent rule-based assertions.
    debug('assert', 'waiting for "dsh-feishu commands:"');
    await waitForBotReplyContaining(page, 'dsh-feishu commands:', cfg.timeoutMs);
    const reply = await waitForBotReplyContaining(
      page,
      '/help — List all surface commands',
      cfg.timeoutMs,
    );
    debug('assert', `reply received (${reply.text.length} chars)`);

    // Key evidence point 3: the final bot reply with the command list.
    await snapshot(page, cfg, 'help-reply', caseId);

    testInfo.annotations.push({
      type: 'evidence',
      description: `group: ${groupName} | bot reply (first 300 chars): ${reply.text.slice(0, 300)}`,
    });
  } finally {
    // Disband the group so test runs do not accumulate chats. createGroup
    // keeps the BOT as the group owner (unlike /group, which makes the
    // requester the owner), so the app can delete it. Best effort: log and
    // move on if the cleanup itself fails.
    try {
      await deleteGroup(cfg, chatId, fetch, debug);
      console.log(`  [cleanup] disbanded group ${groupName} (${chatId})`);
    } catch (error) {
      console.warn(
        `  [cleanup] could not disband ${groupName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
});
