#!/usr/bin/env node
/**
 * Setup probe: verify the bot app can create and delete group chats through
 * the backend (`im.v1.chat.create` / `im.v1.chat.delete` — the exact calls
 * the plugin's `/group` wraps and the scenarios use per case). Runs inside
 * the container during `e2e:setup` with the compiled e2e suite.
 *
 * Exits 0 when create+delete succeed (the probe group is removed again), 1
 * otherwise. The probe group name embeds the run id so it is unique.
 *
 * Env: E2E_APP_ID, E2E_APP_SECRET, E2E_USER_OPEN_ID, E2E_RUN_ID.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const runId = process.env.E2E_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const appId = process.env.E2E_APP_ID;
const appSecret = process.env.E2E_APP_SECRET;
const userOpenId = process.env.E2E_USER_OPEN_ID;
if (!appId || !appSecret || !userOpenId) {
  console.error('✗ E2E_APP_ID / E2E_APP_SECRET / E2E_USER_OPEN_ID are required for the group probe');
  process.exit(2);
}

const { createGroup, deleteGroup, groupNameFor } = await import(
  join(ROOT, 'e2e', '.build', 'lib', 'group.js')
);
const cfg = { appId, appSecret };

const name = groupNameFor('e2e-setup-probe', runId);
try {
  const { chatId } = await createGroup(cfg, name, [userOpenId]);
  console.log(`  [probe] created group "${name}" (${chatId})`);
  await deleteGroup(cfg, chatId);
  console.log(`  [probe] deleted group ${chatId} — backend group management works`);
  process.exit(0);
} catch (error) {
  console.error(`✗ group probe failed: ${error.message}`);
  process.exit(1);
}
