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

/** Drop one inbound message into the message channel. */
function sendMessage(chatId: string, text: string): void {
  writeFileSync(
    join(INBOX_DIR, `om-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    JSON.stringify({
      messageId: `om-${Date.now()}`,
      chatId,
      chatType: 'p2p',
      senderOpenId: 'ou_mock',
      text,
      createdAt: Date.now(),
    }),
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

      // Stop after the turn finished: the agent is idle → explanatory text,
      // not a hanging "Stopping…" (the user-reported bug).
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'stop' },
      });
      await waitFor(
        'the idle-stop explanation text',
        () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes('No active turn')),
        30_000,
      );
      expect(readOutbox().some((r) => r.kind === 'text' && r.text?.includes('Stopping'))).toBe(
        false,
      );

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

  /**
   * The card-action interaction matrix against the REAL agent loop. Each
   * case boots a fresh dsh child with a scripted (or held) mock LLM and
   * drives card actions through the memory transport, asserting the exact
   * outbox reaction — the abnormal-operation coverage the user asked for.
   */
  it('panel after done keeps the streaming card done (state machine)', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
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

      const chatId = `oc_paneldone_${Date.now()}`;
      sendMessage(chatId, 'check panel after done');

      // Wait for the green final card (turn completed).
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );

      // Open the panel. The streaming card must be re-synced to the SAME
      // done state — not reverted to working (the reported bug).
      const patchesBefore = readOutbox().filter((r) => r.kind === 'patch').length;
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'panel' },
      });
      await waitFor(
        'the panel card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((c) => c.card?.header?.title.content === '⚙️ dsh-feishu panel'),
        30_000,
      );
      await waitFor(
        'the done streaming card re-sync',
        () => {
          const all = readOutbox().filter((r) => r.kind === 'patch');
          const last = all.at(-1)?.card;
          return (
            all.length > patchesBefore &&
            last?.header?.template === 'green' &&
            last?.elements.some(
              (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('Done'),
            ) === true
          );
        },
        30_000,
      );
      // The re-synced card must NOT carry a Stop button (done state).
      const lastPatch = readOutbox()
        .filter((r) => r.kind === 'patch')
        .at(-1)?.card;
      const action = lastPatch?.elements.find((el) => el.tag === 'action');
      const labels =
        action && 'actions' in action
          ? action.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [];
      expect(labels).not.toContain('⏹ Stop');
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  it('stop while running cancels; stop after finish explains; panel reflects state', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      // Hold the LLM response so the agent stays running while we act.
      server.holdNextResponse();
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

      const chatId = `oc_matrix_${Date.now()}`;
      sendMessage(chatId, 'run the matrix check');

      // Wait for the running turn's card to appear (the agent is held
      // running by the mock).
      await waitFor(
        'the working streaming card',
        () => readOutbox().some((r) => r.kind === 'card'),
        30_000,
      );

      // Panel while running carries ⏹ Stop current.
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'panel' },
      });
      await waitFor(
        'the running panel with Stop',
        () => {
          const panel = readOutbox()
            .filter((r) => r.kind === 'card')
            .at(-1)?.card;
          const action = panel?.elements.find((el) => el.tag === 'action');
          return (
            action !== undefined &&
            'actions' in action &&
            action.actions.some((a) => 'text' in a && a.text.content === '⏹ Stop current')
          );
        },
        30_000,
      );

      // Stop while running → cancel + '⏹ Stopping…' text.
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'stop' },
      });
      await waitFor(
        'the Stopping acknowledgement',
        () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes('Stopping')),
        30_000,
      );

      // Release the held response so the aborted turn settles; then wait for
      // the agent to go idle (a new message would be needed to see it, so
      // just give the loop a beat), and a Stop must explain — not hang.
      server.release();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const textsBeforeIdleStop = readOutbox().filter((r) => r.kind === 'text').length;
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'stop' },
      });
      await waitFor(
        'the idle-stop explanation',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'text')
            .slice(textsBeforeIdleStop)
            .some((r) => r.text?.includes('No active turn')),
        30_000,
      );
      // The idle stop must NOT emit a second 'Stopping…' — only the
      // explanation, and nothing after it.
      expect(
        readOutbox()
          .filter((r) => r.kind === 'text')
          .slice(textsBeforeIdleStop)
          .some((r) => r.text?.includes('Stopping')),
      ).toBe(false);

      // Copy/retry on a chat with no completed answer → explanation.
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'copy' },
      });
      await waitFor(
        'the empty-copy explanation',
        () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes('Nothing to copy')),
        30_000,
      );
      // Retry on a chat with no prior prompt → explanation. This chat HAS a
      // prior message, so use a fresh chat id (no session, no last prompt).
      const emptyChat = `oc_empty_${Date.now()}`;
      writeAction({
        messageId: 'mem-2',
        chatId: emptyChat,
        operatorOpenId: 'ou_mock',
        value: { kind: 'retry' },
      });
      await waitFor(
        'the empty-retry explanation',
        () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes('Nothing to retry')),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);
});
