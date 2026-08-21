/**
 * Shared scenario scaffolding: the group-chat lifecycle every scenario uses.
 * Each test case creates its OWN backend group (name `<caseId>-<runId>`,
 * unique per run — the same `im.v1.chat.create` the plugin's `/group` wraps),
 * opens it in the browser, and disbands it in `finally` so runs never
 * accumulate chats. The bot stays the group owner (no `owner_id`), so the
 * app's `im.v1.chat.delete` is permitted.
 *
 * @module e2e/helpers/scenario
 */

import type { Page } from '@playwright/test';
import type { E2eConfig } from './config.js';
import { openApp, openChat, snapshot } from './feishu.js';
import { createGroup, deleteGroup, groupNameFor } from './group.js';

/** E2E_DEBUG=1 diagnostic logger (no-op when off). */
export function scenarioDebug(enabled: boolean): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    if (enabled) console.log('[debug]', ...args);
  };
}

/** Assert the E2E state the scenarios need; throws a clear message otherwise. */
export function requireUserOpenId(cfg: E2eConfig): string {
  if (cfg.userOpenId === undefined) {
    throw new Error('E2E_USER_OPEN_ID is required (run `pnpm run e2e:setup` first)');
  }
  return cfg.userOpenId;
}

/**
 * Create a per-case group and open its chat, returning the disbands handle.
 * The caller must `await cleanup.chatId`-knowing cleanup in `finally`.
 * @param page - the browser page.
 * @param cfg - resolved E2E config (runId + userOpenId).
 * @param caseTitledId - the caseId (caseIdFromTitle output).
 * @param timeoutMs - chat-open timeout.
 * @param debug - diagnostic logger.
 * @returns the group name and chat id.
 */
export async function openCaseGroup(
  page: Page,
  cfg: E2eConfig,
  caseId: string,
  timeoutMs: number,
  debug: (...args: unknown[]) => void,
): Promise<{ groupName: string; chatId: string }> {
  const groupName = groupNameFor(caseId, cfg.runId);
  debug('case', `caseId=${caseId} group=${groupName} runId=${cfg.runId}`);
  const userOpenId = requireUserOpenId(cfg);
  const { chatId } = await createGroup(cfg, groupName, [userOpenId], fetch, debug);
  await openApp(page, cfg);
  await openChat(page, groupName, timeoutMs);
  await snapshot(page, cfg, `${caseId}-chat-open`, caseId);
  return { groupName, chatId };
}

/** Disband the group (best effort — log and move on). */
export async function disbandGroup(
  cfg: E2eConfig,
  groupName: string,
  chatId: string,
  debug: (...args: unknown[]) => void,
): Promise<void> {
  try {
    await deleteGroup(cfg, chatId, fetch, debug);
    console.log(`  [cleanup] disbanded group ${groupName} (${chatId})`);
  } catch (error) {
    console.warn(
      `  [cleanup] could not disband ${groupName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
