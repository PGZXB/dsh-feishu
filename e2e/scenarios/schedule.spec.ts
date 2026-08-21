/**
 * E2E scenario: `/schedule` on a chat with no session yet returns a
 * deterministic local message.
 *
 * The `/schedule` handler returns `no session yet — send a message first.`
 * when no session is bound to the chat — a freshly-created group has none,
 * so the assertion is a local rule-based text check that never round-trips
 * through the LLM (listing reminders needs a real session, which is the
 * integration suite's job).
 *
 * @module e2e/scenarios/schedule
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

test('send /schedule → no-session notice', async ({ page }, testInfo) => {
  const caseId = caseIdFromTitle(testInfo.title);
  const { groupName, chatId } = await openCaseGroup(page, cfg, caseId, cfg.timeoutMs, debug);
  try {
    await sendMessage(page, '/schedule');
    await snapshot(page, cfg, `${caseId}-sent`, caseId);

    // Fresh group → no session bound → the deterministic local notice.
    const reply = await waitForBotReplyContaining(
      page,
      'no session yet — send a message first.',
      cfg.timeoutMs,
    );
    debug('assert', `schedule reply received (${reply.text.length} chars)`);

    await snapshot(page, cfg, `${caseId}-reply`, caseId);

    testInfo.annotations.push({
      type: 'evidence',
      description: `group: ${groupName} | schedule reply (first 200 chars): ${reply.text.slice(0, 200)}`,
    });
  } finally {
    await disbandGroup(cfg, groupName, chatId, debug);
  }
});
