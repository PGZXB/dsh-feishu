/**
 * Real-composition integration test: a real dsh process booted from a real
 * profile, running a real agent turn, with only the two external services
 * mocked — Feishu via the file-channel memory transport
 * (`FEISHU_TRANSPORT=memory`) and the LLM API via a local mock server
 * (`DEEPSEEK_BASE_URL`).
 *
 * The test asserts the full private-chat loop end to end: an inbound message
 * creates a session, the agent runs (against the mock LLM), chunks stream
 * into a card (posted + patched), and the final answer is delivered as a
 * fresh message.
 *
 * It self-skips when the environment lacks a prepared profile or the dsh
 * CLI. See docs/development.md → "Integration test" for prerequisites.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryOutboxRecord } from '../../src/memory-transport.js';
import { type MockLlmServer, startMockLlmServer } from './mock-llm-server.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Repo-local dsh home; override with FEISHU_INT_DSH_HOME. Deliberately NOT
// `DSH_HOME` — the ambient harness environment exports its own DSH_HOME and
// the test must never touch it.
const DSH_HOME = process.env.FEISHU_INT_DSH_HOME ?? join(REPO_ROOT, '_dev', 'dsh-home');
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'feishu-dev');
const MEMORY_DIR = join(REPO_ROOT, '_dev', 'int-memory');
const INBOX_DIR = join(MEMORY_DIR, 'inbox');
const OUTBOX_DIR = join(MEMORY_DIR, 'outbox');

/** Resolve the dsh CLI binary: $DSH_BIN, then `dsh` on PATH. */
function resolveDshBin(): string | undefined {
  if (process.env.DSH_BIN !== undefined && process.env.DSH_BIN !== '') return process.env.DSH_BIN;
  const probe = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim() !== '') return probe.stdout.trim();
  return undefined;
}

/** Read every outbox record, oldest first. */
function readOutbox(): MemoryOutboxRecord[] {
  let files: string[];
  try {
    files = readdirSync(OUTBOX_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((file) => {
      try {
        return JSON.parse(readFileSync(join(OUTBOX_DIR, file), 'utf8')) as MemoryOutboxRecord;
      } catch {
        return undefined;
      }
    })
    .filter((record): record is MemoryOutboxRecord => record !== undefined)
    .sort((a, b) => a.seq - b.seq);
}

/** Wait until `predicate` holds or the deadline passes. */
async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const dshBin = resolveDshBin();
const profileReady = existsSync(join(PROFILE_DIR, 'package.json'));
const built = existsSync(join(REPO_ROOT, 'lib', 'index.js'));
const ACTIONS_DIR = join(MEMORY_DIR, 'actions');

/** Write one card action into the actions channel for the spawned process. */
function writeAction(action: unknown): void {
  writeFileSync(
    join(ACTIONS_DIR, `act-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    JSON.stringify(action),
    'utf8',
  );
}

describe.skipIf(!dshBin || !profileReady || !built)('real-composition integration', () => {
  let mock: MockLlmServer | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stdout = '';
  let stderr = '';
  let bridgeReady = false;

  beforeEach(async () => {
    if (mock !== undefined) await mock.close();
    if (child !== undefined && child.exitCode === null) child.kill('SIGTERM');
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    mkdirSync(INBOX_DIR, { recursive: true });
    mkdirSync(ACTIONS_DIR, { recursive: true });
    mkdirSync(OUTBOX_DIR, { recursive: true });
    mock = await startMockLlmServer();
    child = undefined;
    bridgeReady = false;
    stdout = '';
    stderr = '';
  });

  afterEach(async () => {
    if (child !== undefined && child.exitCode === null) child.kill('SIGTERM');
    if (mock !== undefined) await mock.close();
  });

  it('runs one full private-chat turn: card posted, patched, final answer delivered', async () => {
    const bin = dshBin;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    const server = mock;
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      child = spawn(bin, ['--profile', 'feishu-dev'], {
        env: {
          ...process.env,
          DSH_HOME,
          FEISHU_APP_ID: 'cli_mock_app',
          FEISHU_APP_SECRET: 'mock_secret',
          FEISHU_TRANSPORT: 'memory',
          FEISHU_MEMORY_DIR: MEMORY_DIR,
          DEEPSEEK_API_KEY: 'mock_key',
          DEEPSEEK_BASE_URL: server.url,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('[feishu] bridge ready')) bridgeReady = true;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      await waitFor('the bridge to report ready', () => bridgeReady, 30_000);

      // Inject an inbound message through the memory transport's file channel.
      // A unique chat id per run avoids colliding with a previous run's
      // persisted session mapping.
      const chatId = `oc_int_${Date.now()}`;
      writeFileSync(
        join(INBOX_DIR, `om-int-1.json`),
        JSON.stringify({
          messageId: `om-int-${Date.now()}`,
          chatId,
          chatType: 'p2p',
          senderOpenId: 'ou_mock',
          text: 'run a quick integration check',
          createdAt: Date.now(),
        }),
        'utf8',
      );

      // A completed turn finalizes the card green in place (no second
      // bubble); the streamed answer is captured in the final patch.
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );

      const records = readOutbox();
      expect(records.some((r) => r.kind === 'card')).toBe(true);
      expect(records.some((r) => r.kind === 'patch')).toBe(true);
      expect(records.some((r) => r.kind === 'text')).toBe(false);
      const patches = records.filter((r) => r.kind === 'patch');
      const lastCard = patches.at(-1)?.card;
      expect(JSON.stringify(lastCard?.elements)).toContain('Hello from mock LLM');
      expect(server.completionRequests()).toBeGreaterThanOrEqual(1);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 150_000);

  it('automated UX state machine: tool rows, collapse toggle, details, reassert', async () => {
    const bin = dshBin;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    const server = mock;
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      // Scripted tool-calling turn: reasoning delta opens a think row, a bash
      // tool call opens a tool row, then the post-tool request answers.
      server.setScripts([
        [
          { reasoning: 'Let me check the files.' },
          {
            toolCall: { index: 0, id: 'call-ux-1', name: 'bash', arguments: '{"command":"ls"}' },
          },
        ],
        [{ content: 'Final UX answer.' }],
      ]);
      child = spawn(bin, ['--profile', 'feishu-dev'], {
        env: {
          ...process.env,
          DSH_HOME,
          FEISHU_APP_ID: 'cli_mock_app',
          FEISHU_APP_SECRET: 'mock_secret',
          FEISHU_TRANSPORT: 'memory',
          FEISHU_MEMORY_DIR: MEMORY_DIR,
          DEEPSEEK_API_KEY: 'mock_key',
          DEEPSEEK_BASE_URL: server.url,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('[feishu] bridge ready')) bridgeReady = true;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      await waitFor('the bridge to report ready', () => bridgeReady, 30_000);

      const chatId = `oc_ux_${Date.now()}`;
      writeFileSync(
        join(INBOX_DIR, `om-ux-1.json`),
        JSON.stringify({
          messageId: `om-ux-${Date.now()}`,
          chatId,
          chatType: 'p2p',
          senderOpenId: 'ou_mock',
          text: 'run the UX automation check',
          createdAt: Date.now(),
        }),
        'utf8',
      );

      // Turn completes: final card patch is green.
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );

      // The streaming card is the first card sent (message id mem-1).
      // Collapsed by default → the sequence line 'think -> bash'.
      const patches = readOutbox().filter((r) => r.kind === 'patch');
      const finalCard = patches.at(-1)?.card;
      expect(
        finalCard?.elements.some(
          (el) => el.tag === 'markdown' && 'content' in el && el.content === 'think -> bash',
        ),
      ).toBe(true);

      // Expand → full rows visible (column_set row elements).
      const patchCountBeforeExpand = readOutbox().filter((r) => r.kind === 'patch').length;
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'toggle-rows' },
      });
      await waitFor(
        'the expanded card patch',
        () => {
          const all = readOutbox().filter((r) => r.kind === 'patch');
          const last = all.at(-1)?.card;
          return (
            all.length > patchCountBeforeExpand &&
            last?.elements.some((el) => el.tag === 'column_set') === true
          );
        },
        30_000,
      );

      // Open row details → details card sent (a separate sendCard) and the
      // streaming card is re-asserted (still expanded — not collapsed).
      const cardsBeforeDetails = readOutbox().filter((r) => r.kind === 'card').length;
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'row-details', id: 'call-ux-1' },
      });
      await waitFor(
        'the details card',
        () => readOutbox().filter((r) => r.kind === 'card').length > cardsBeforeDetails,
        30_000,
      );
      // The reassert patch keeps the card expanded (column_set present).
      await waitFor(
        'the reasserted expanded card',
        () => {
          const all = readOutbox().filter((r) => r.kind === 'patch');
          const last = all.at(-1)?.card;
          return last?.elements.some((el) => el.tag === 'column_set') === true;
        },
        30_000,
      );
      const detailCard = readOutbox()
        .filter((r) => r.kind === 'card')
        .at(-1)?.card;
      expect(JSON.stringify(detailCard?.elements)).toContain('IN');
      expect(JSON.stringify(detailCard?.elements)).toContain('OUT');

      // Collapse again → back to the sequence line.
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'toggle-rows' },
      });
      await waitFor(
        'the collapsed card patch',
        () => {
          const all = readOutbox().filter((r) => r.kind === 'patch');
          const last = all.at(-1)?.card;
          return (
            last?.elements.some(
              (el) => el.tag === 'markdown' && 'content' in el && el.content === 'think -> bash',
            ) === true
          );
        },
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);
});
