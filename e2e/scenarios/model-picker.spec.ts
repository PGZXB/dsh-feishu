/**
 * E2E scenario: bare `/model` opens the model-picker panel card.
 *
 * The `/model` handler opens a `picker: 'model'` view when the `llm`
 * service is mounted (which the e2e profile does), rendering a card with a
 * model dropdown (`Choose a model`). This scenario asserts the PICKER CARD
 * renders. Selecting a specific model is the integration suite's job (it
 * needs the real catalog and must restore the prior selection).
 *
 * @module e2e/scenarios/model-picker
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

test('send /model → model picker panel card', async ({ page }, testInfo) => {
  const caseId = caseIdFromTitle(testInfo.title);
  const { groupName, chatId } = await openCaseGroup(page, cfg, caseId, cfg.timeoutMs, debug);
  try {
    await sendMessage(page, '/model');
    await snapshot(page, cfg, `${caseId}-sent`, caseId);

    // The model-picker card's deterministic title always renders when the
    // llm service is mounted (the e2e profile's config).
    await waitForCardContaining(page, 'Choose a model', cfg.timeoutMs);
    debug('assert', 'model picker card received');
    await snapshot(page, cfg, `${caseId}-picker`, caseId);

    testInfo.annotations.push({
      type: 'evidence',
      description: `group: ${groupName} | /model rendered the model picker card`,
    });
  } finally {
    await disbandGroup(cfg, groupName, chatId, debug);
  }
});
