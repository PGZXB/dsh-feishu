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
              (el) =>
                el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('Done'),
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

  it('markdown tables render as native table elements on the streaming card', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([
        [{ content: '| 路径 | 内容 |\n|---|---|\n| `src/` | 源码 |\n| `docs/` | 文档 |' }],
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

      const chatId = `oc_table_${Date.now()}`;
      sendMessage(chatId, 'show me a table');

      // The final card patch carries a native table element, not raw pipes.
      await waitFor(
        'the table element on the card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'patch')
            .some((r) => {
              const elements = r.card?.elements ?? [];
              return elements.some((el) => el.tag === 'table');
            }),
        90_000,
      );
      const finalCard = readOutbox()
        .filter((r) => r.kind === 'patch')
        .at(-1)?.card;
      const table = finalCard?.elements.find((el) => el.tag === 'table');
      expect(table && 'columns' in table ? table.columns.map((c) => c.display_name) : []).toEqual([
        '路径',
        '内容',
      ]);
      expect(table && 'rows' in table ? table.rows : []).toHaveLength(2);
      // No raw pipe text leaks into markdown elements.
      const markdowns = (finalCard?.elements ?? []).filter(
        (el): el is Extract<typeof el, { tag: 'markdown' }> => el.tag === 'markdown',
      );
      expect(markdowns.every((el) => !el.content.includes('|'))).toBe(true);
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

      // Stop while running → cancel. The card settles to the terminal
      // Stopped state (orange); the intermediate 'Stopping' may flash or be
      // skipped depending on how fast the abort converges (unit-tested).
      // There must be NO standalone '⏹ Stopping…' text bubble (user report).
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'stop' },
      });
      await waitFor(
        'the stopped (orange) card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'patch')
            .some((r) => r.card?.header?.template === 'orange'),
        30_000,
      );
      expect(readOutbox().some((r) => r.kind === 'text' && r.text?.includes('Stopping'))).toBe(
        false,
      );

      // Release the held response. The aborted turn may or may not emit a
      // terminal turn/end under the scripted mock (the aborted loop can stop
      // consuming the released stream), so we assert the reachable part: the
      // agent is no longer running, and a Stop now explains instead of
      // hanging. The aborted → 'Stopped' card mapping is unit-tested.
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

      // Copy/retry on a chat with no completed answer → explanation. Use a
      // fresh chat id: this chat had a message (and possibly a released
      // turn), so its lastOutputs/lastPrompts may be populated.
      const emptyChat = `oc_empty_${Date.now()}`;
      writeAction({
        messageId: 'mem-2',
        chatId: emptyChat,
        operatorOpenId: 'ou_mock',
        value: { kind: 'copy' },
      });
      await waitFor(
        'the empty-copy explanation',
        () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes('Nothing to copy')),
        30_000,
      );
      writeAction({
        messageId: 'mem-3',
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

  /**
   * The session lifecycle chain against the real process: a turn in chat A,
   * /sessions from a fresh chat B, resume via the picker's button (binding
   * moves), a follow-up that continues the resumed session, and /clear
   * starting fresh — with a no-replay check between resume and follow-up.
   */
  it('session lifecycle chain: /sessions, resume by button, continue, /clear', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([[{ content: 'Chain answer one.' }], [{ content: 'Chain answer two.' }]]);
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

      const chatA = `oc_chain_a_${Date.now()}`;
      sendMessage(chatA, 'start the chain in A');
      await waitFor(
        'the green final card patch for A',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
      // Learn A's session id from the persisted session map.
      const map = JSON.parse(
        readFileSync(join(DSH_HOME, 'feishu', 'session-map.json'), 'utf8') as string,
      ) as { entries: Record<string, string> };
      const sessionA = map.entries[chatA];
      expect(sessionA).toBeDefined();
      if (sessionA === undefined) throw new Error('session map missing entry for chat A');

      // A fresh chat B lists sessions; the picker shows A's session.
      const chatB = `oc_chain_b_${Date.now()}`;
      sendMessage(chatB, '/sessions');
      await waitFor(
        'the sessions picker card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => r.card?.header?.title.content === '🗂️ Sessions'),
        30_000,
      );
      expect(
        readOutbox()
          .filter((r) => r.kind === 'card')
          .some((r) => JSON.stringify(r.card?.elements).includes(sessionA)),
      ).toBe(true);

      // Resume A's session from B through the picker's Resume button. The
      // picker's message id comes from its own outbox record (not a computed
      // counter — the process may have sent other cards in between).
      const pickerRecord = [...readOutbox()]
        .reverse()
        .find((r) => r.kind === 'card' && r.card?.header?.title.content === '🗂️ Sessions');
      expect(pickerRecord?.messageId).toBeDefined();
      const pickerId = pickerRecord?.messageId ?? '';
      writeAction({
        messageId: pickerId,
        chatId: chatB,
        operatorOpenId: 'ou_mock',
        value: { kind: 'resume-session', sessionId: sessionA },
      });
      await waitFor(
        'the resume confirmation text',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.text?.includes(`Resumed session ${sessionA}`),
          ),
        30_000,
      );

      // Resume must not replay history into a card: no new card appears
      // until the next user message.
      const cardsAfterResume = readOutbox().filter((r) => r.kind === 'card').length;
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(readOutbox().filter((r) => r.kind === 'card').length).toBe(cardsAfterResume);

      // The follow-up continues the resumed session in B: a fresh card
      // streams the next answer.
      sendMessage(chatB, 'continue in B');
      await waitFor(
        'the continued card in B',
        () => readOutbox().filter((r) => r.kind === 'card').length > cardsAfterResume,
        90_000,
      );
      await waitFor(
        'the green continued card',
        () => {
          const all = readOutbox().filter((r) => r.kind === 'patch');
          const last = all.at(-1)?.card;
          return (
            all.length > 0 &&
            last?.header?.template === 'green' &&
            JSON.stringify(last.elements).includes('Chain answer two.')
          );
        },
        90_000,
      );

      // /clear in B starts fresh; A's session stays listed for /sessions.
      sendMessage(chatB, '/clear');
      await waitFor(
        'the fresh-conversation text',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.text?.includes('New conversation started'),
          ),
        30_000,
      );
      sendMessage(chatB, '/sessions');
      await waitFor(
        'the sessions picker after clear',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => r.card?.header?.title.content === '🗂️ Sessions'),
        30_000,
      );
      expect(
        readOutbox()
          .filter((r) => r.kind === 'card')
          .some((r) => JSON.stringify(r.card?.elements).includes(sessionA)),
      ).toBe(true);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 240_000);

  /** The panel palette button end-to-end: one tap executes the same handler
   *  as the slash line (everything-is-a-card). */
  it('panel palette command button executes the command handler', async () => {
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

      const chatId = `oc_palette_${Date.now()}`;
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
            .some((r) => r.card?.header?.title.content === '⚙️ dsh-feishu panel'),
        30_000,
      );
      // The palette renders command buttons with payloads.
      const panel = readOutbox()
        .filter((r) => r.kind === 'card')
        .at(-1)?.card;
      const commandPayloads =
        panel?.elements.flatMap((el) =>
          el.tag === 'action'
            ? el.actions.filter((a) => a.tag === 'button' && a.value.kind === 'command')
            : [],
        ) ?? [];
      expect(commandPayloads.length).toBeGreaterThan(0);

      // Tap the /status button: the status text arrives (same handler as
      // typing /status).
      writeAction({
        messageId: 'mem-2',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'command', name: 'status' },
      });
      await waitFor(
        'the status command reply',
        () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes(`chat: ${chatId}`)),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);

  /** The web-command wrapper end-to-end: bare /permission opens the preset
   *  picker card (from the real ctx.permissionPresets service), and a pick
   *  applies the preset — a button press actually switches permissions
   *  (user report: the bare harness command only reports). */
  it('web-command wrapper: /permission opens the picker and a pick applies', async () => {
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

      const chatId = `oc_wrapper_${Date.now()}`;
      sendMessage(chatId, '/permission');
      // Bare /permission opens the preset picker card.
      await waitFor(
        'the permission picker card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => r.card?.header?.title.content === '🔐 Permission presets'),
        60_000,
      );
      // The wrapper minted a session + agent for the fresh chat.
      const map = JSON.parse(
        readFileSync(join(DSH_HOME, 'feishu', 'session-map.json'), 'utf8') as string,
      ) as { entries: Record<string, string> };
      expect(map.entries[chatId]).toBeDefined();
      // Pick the read-only preset through the picker's button (message id
      // from the picker's own outbox record).
      const pickerRecord = [...readOutbox()]
        .reverse()
        .find(
          (r) => r.kind === 'card' && r.card?.header?.title.content === '🔐 Permission presets',
        );
      expect(pickerRecord?.messageId).toBeDefined();
      // The picker renders a select_static dropdown with the current preset
      // preselected.
      const pickerCard = pickerRecord?.card;
      const pickerAction = pickerCard?.elements.find((el) => el.tag === 'action');
      const pickerSelect =
        pickerAction && 'actions' in pickerAction
          ? pickerAction.actions.find((a) => a.tag === 'select_static')
          : undefined;
      expect(
        pickerSelect && 'initial_option' in pickerSelect ? pickerSelect.initial_option : undefined,
      ).toBe('workspace-write');
      // Dropdown selection: marker payload + preset in `option`.
      writeAction({
        messageId: pickerRecord?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'permission-pick' },
        option: 'read-only',
      });
      await waitFor(
        'the preset switch text',
        () =>
          readOutbox().some((r) => r.kind === 'text' && r.text?.includes('switched to read-only')),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);

  /** /plan toggles on the real harness controller: a bare /plan enters,
   *  and a second bare /plan leaves — a button press can exit plan mode
   *  (user report: bare /plan only ever entered). */
  it('web-command wrapper: bare /plan toggles plan mode on and off', async () => {
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

      const chatId = `oc_plan_${Date.now()}`;
      sendMessage(chatId, '/plan');
      await waitFor(
        'the plan-mode-on text',
        () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes('Plan mode on')),
        60_000,
      );
      // Second bare /plan leaves plan mode.
      sendMessage(chatId, '/plan');
      await waitFor(
        'the plan-mode-off text',
        () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes('Plan mode off')),
        60_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);

  /** /model reports the real deployment default (ctx.agentDefaultModel is
   *  mounted by dsh-base) — the web client's /model popup has no host
   *  command, so this is a surface-native command. */
  it('web-command wrapper: /model reports the deployment default model', async () => {
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

      const chatId = `oc_model_${Date.now()}`;
      sendMessage(chatId, '/model');
      await waitFor(
        'the model text',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'text' && r.text?.includes('model: deepseek-official · deepseek-v4-flash'),
          ),
        60_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);
});
