/**
 * E2E scenario: `/repo` opens the project-picker panel card.
 *
 * The `/repo` handler (src/commands/surface.ts) pushes a `picker: 'repo'`
 * view onto the panel state machine, which renders a card with a
 * `select_static` dropdown (or numbered buttons when the candidate list is
 * large). This scenario asserts the PICKER CARD renders (its deterministic
 * title text) — whether the mock profile has candidates or not, the picker
 * itself must appear. Choosing a specific project is the integration suite's
 * job (it needs a real repoRoots).
 *
 * @module e2e/scenarios/repo-picker
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

test('send /repo → project picker panel card', async ({ page }, testInfo) => {
  const caseId = caseIdFromTitle(testInfo.title);
  const { groupName, chatId } = await openCaseGroup(page, cfg, caseId, cfg.timeoutMs, debug);
  try {
    await sendMessage(page, '/repo');
    await snapshot(page, cfg, `${caseId}-sent`, caseId);

    // The picker card's deterministic title always renders.
    await waitForCardContaining(page, 'Pick a project', cfg.timeoutMs);
    debug('assert', 'repo picker card received');
    await snapshot(page, cfg, `${caseId}-picker`, caseId);

    testInfo.annotations.push({
      type: 'evidence',
      description: `group: ${groupName} | /repo rendered the project picker card`,
    });
  } finally {
    await disbandGroup(cfg, groupName, chatId, debug);
  }
});
