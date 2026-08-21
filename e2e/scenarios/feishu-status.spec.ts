/**
 * E2E scenario: `/feishu-status` renders the surface diagnostic card.
 *
 * This is the ONLY scenario that exercises the real long connection: the
 * card's `connection:` field reflects the live WSClient state (`ready` /
 * `reconnecting` / ...), so a passing run proves the long connection that
 * the integration tests mock. The card header (`📊 dsh-feishu status`) and
 * the `connection:` / `sessions:` body are rule-based assertions on the
 * rendered card text.
 *
 * @module e2e/scenarios/feishu-status
 */

import { test } from '@playwright/test';
import { waitForCardContaining } from '../helpers/assert.js';
import { loadE2eConfig } from '../helpers/config.js';
import { sendMessage, snapshot } from '../helpers/feishu.js';
import { caseIdFromTitle } from '../helpers/report.js';
import { disbandGroup, openCaseGroup, scenarioDebug } from '../helpers/scenario.js';

const cfg = loadE2eConfig();
const debugEnabled = process.env.E2E_DEBUG === '1';
const debug = scenarioDebug(debugEnabled);

test('send /feishu-status → diagnostic card', async ({ page }, testInfo) => {
  const caseId = caseIdFromTitle(testInfo.title);
  const { groupName, chatId } = await openCaseGroup(page, cfg, caseId, cfg.timeoutMs, debug);
  try {
    await sendMessage(page, '/feishu-status');
    await snapshot(page, cfg, `${caseId}-sent`, caseId);

    // The card header + a live connection field. `connection:` should read
    // ready (the real WSClient connected) in a passing run.
    await waitForCardContaining(page, 'dsh-feishu status', cfg.timeoutMs);
    await waitForCardContaining(page, 'connection:', cfg.timeoutMs);

    await snapshot(page, cfg, `${caseId}-card`, caseId);
    debug('assert', 'feishu-status card received');

    testInfo.annotations.push({
      type: 'evidence',
      description: `group: ${groupName} | feishu-status diagnostic card rendered`,
    });
  } finally {
    await disbandGroup(cfg, groupName, chatId, debug);
  }
});
