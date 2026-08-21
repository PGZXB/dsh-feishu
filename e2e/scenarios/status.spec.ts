/**
 * E2E scenario: `/status` shows this chat's session status as a text block.
 *
 * The `/status` handler (src/commands/surface.ts) returns a local text list
 * (`chat:` / `session:` / `agent:` / `last output:` / `mention mode:`) that
 * never round-trips through the LLM, so the assertions are deterministic
 * rule-based text checks on the rendered chat.
 *
 * The case runs in its own backend group (see `e2e/helpers/scenario.ts`) and
 * disbands it afterwards.
 *
 * @module e2e/scenarios/status
 */

import { test } from '@playwright/test';
import { waitForBotReplyContaining } from '../helpers/assert.js';
import { loadE2eConfig } from '../helpers/config.js';
import { sendMessage, snapshot } from '../helpers/feishu.js';
import { caseIdFromTitle } from '../helpers/report.js';
import { disbandGroup, openCaseGroup, scenarioDebug } from '../helpers/scenario.js';

const cfg = loadE2eConfig();
const debugEnabled = process.env.E2E_DEBUG === '1';
const debug = scenarioDebug(debugEnabled);

test('send /status → session status text', async ({ page }, testInfo) => {
  const caseId = caseIdFromTitle(testInfo.title);
  const { groupName, chatId } = await openCaseGroup(page, cfg, caseId, cfg.timeoutMs, debug);
  try {
    await sendMessage(page, '/status');
    await snapshot(page, cfg, `${caseId}-sent`, caseId);

    // The status block opens with `chat:` and includes every line. Two
    // independent rule-based assertions.
    await waitForBotReplyContaining(page, 'chat:', cfg.timeoutMs);
    const reply = await waitForBotReplyContaining(page, 'mention mode:', cfg.timeoutMs);
    debug('assert', `status reply received (${reply.text.length} chars)`);

    await snapshot(page, cfg, `${caseId}-reply`, caseId);

    testInfo.annotations.push({
      type: 'evidence',
      description: `group: ${groupName} | status reply (first 300 chars): ${reply.text.slice(0, 300)}`,
    });
  } finally {
    await disbandGroup(cfg, groupName, chatId, debug);
  }
});
