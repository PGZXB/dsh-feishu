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
 * CLI; CI runs it with `FEISHU_INT_REQUIRED=1` so a missing prerequisite
 * there is a hard failure, never a silent skip. See
 * docs/development.md → "Integration test" for prerequisites.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryOutboxRecord } from '../../src/memory-transport.js';
import { type MockLlmServer, startMockLlmServer } from './mock-llm-server.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Repo-local dsh home; override with FEISHU_INT_REAL_DSH_HOME. Deliberately
// NOT `DSH_HOME` — the ambient harness environment exports its own DSH_HOME
// and the test must never touch it. Each integration suite uses its OWN dsh
// home (the suites run in parallel and spawn real dsh processes that share
// `_dev/dsh-home/feishu/session-map.json` — concurrent writes raced and
// silently dropped another suite's chat→session binding, CI-only flakes).
const DSH_HOME = process.env.FEISHU_INT_REAL_DSH_HOME ?? join(REPO_ROOT, '_dev', 'dsh-home-real');
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
/**
 * CI runs this suite with `FEISHU_INT_REQUIRED=1`: a missing prerequisite
 * there is a hard failure, never a silent skip. Local runs keep the graceful
 * self-skip (no dsh CLI, prepared profile, or built lib).
 */
const integrationRequired = process.env.FEISHU_INT_REQUIRED === '1';
const integrationReady = dshBin !== undefined && profileReady && built;
if (integrationRequired && !integrationReady) {
  throw new Error(
    `FEISHU_INT_REQUIRED=1 but integration prerequisites are missing ` +
      `(dsh CLI=${dshBin !== undefined} profile=${profileReady} built=${built}); ` +
      'see docs/development.md → "Integration test"',
  );
}
const ACTIONS_DIR = join(MEMORY_DIR, 'actions');
/** Scratch working directory pinned via /cd in turn-running tests (the
 *  working-directory gate refuses turns until a repo/cwd is chosen). */
const INT_CWD = join(REPO_ROOT, '_dev', 'int-cwd');

/** Write one card action into the actions channel for the spawned process. */
function writeAction(action: unknown): void {
  writeFileSync(
    join(ACTIONS_DIR, `act-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    JSON.stringify(action),
    'utf8',
  );
}

/** Pin the chat's working directory via /cd (the gate refuses turns until
 *  an explicit directory is chosen). */
async function pinWorkingDir(chatId: string): Promise<void> {
  // /cd is idempotent (setCwd + remint), so retry it if the confirmation
  // does not arrive — the first /cd can be delayed by dsh cold-start on a
  // slow CI runner (the bridge reports ready before every service settles).
  // Outbox records carry the chatId; matching any chat's text would pass
  // immediately on a prior chat's pin and let a later message race ahead.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    sendMessage(chatId, `/cd ${INT_CWD}`);
    try {
      await waitFor(
        'the /cd confirmation',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'text' &&
              r.chatId === chatId &&
              r.text?.includes('Working directory set to'),
          ),
        20_000,
      );
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

/** The markdown body of every RESULT card posted (header ✅/⚠️) — panel
 *  action outcomes now leave the panel as an inert card (user principle:
 *  intermediate steps live in the panel, results notify as a new card). */
function resultCardTexts(): string[] {
  return readOutbox()
    .filter((r) => {
      const title = r.card?.header?.title.content;
      return title === '✅ Done' || title === '⚠️ Action failed';
    })
    .flatMap((r) =>
      (r.card?.elements ?? [])
        .filter((el) => el.tag === 'markdown' && 'content' in el)
        .map((el) => (el as { readonly content: string }).content),
    );
}

/** Drop one inbound message into the message channel. */
/** Drop a GROUP message with the given mention open ids (mention-gate
 *  tests). An un-@ group message is ignored under the default `always`
 *  mode. */
function sendGroupMessage(chatId: string, text: string, mentions: readonly string[]): void {
  const messageId = `om-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(
    join(INBOX_DIR, `${messageId}.json`),
    JSON.stringify({
      messageId,
      chatId,
      chatType: 'group',
      senderOpenId: 'ou_mock',
      text,
      mentions,
      createdAt: Date.now(),
    }),
    'utf8',
  );
}

function sendMessage(chatId: string, text: string): void {
  const messageId = `om-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(
    join(INBOX_DIR, `${messageId}.json`),
    JSON.stringify({
      messageId,
      chatId,
      chatType: 'p2p',
      senderOpenId: 'ou_mock',
      text,
      createdAt: Date.now(),
    }),
    'utf8',
  );
}

describe.skipIf(!integrationReady)('real-composition integration', () => {
  let mock: MockLlmServer | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stdout = '';
  let stderr = '';
  let bridgeReady = false;

  /** Kill the spawned dsh process and WAIT for it to exit (SIGTERM, then
   *  SIGKILL after a 5 s grace) so its file writes cannot race the next
   *  test's MEMORY_DIR reset (CI ENOTEMPTY under Node 22). */
  async function stopChild(): Promise<void> {
    const proc = child;
    child = undefined;
    if (proc === undefined || proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
        resolve();
      }, 5_000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  beforeEach(async () => {
    if (mock !== undefined) await mock.close();
    await stopChild();
    rmSync(MEMORY_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    mkdirSync(INT_CWD, { recursive: true });
    mkdirSync(INBOX_DIR, { recursive: true });
    mkdirSync(ACTIONS_DIR, { recursive: true });
    mkdirSync(OUTBOX_DIR, { recursive: true });
    mock = await startMockLlmServer();
    bridgeReady = false;
    stdout = '';
    stderr = '';
  });

  afterEach(async () => {
    await stopChild();
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
      await pinWorkingDir(chatId);
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
      // The only text is the /cd pin confirmation — no second answer bubble.
      const texts = records.filter((r) => r.kind === 'text');
      expect(texts.length).toBeGreaterThanOrEqual(1);
      expect(texts.every((r) => r.text?.includes('Working directory set to') === true)).toBe(true);
      const patches = records.filter((r) => r.kind === 'patch');
      const lastCard = patches.at(-1)?.card;
      expect(JSON.stringify(lastCard?.elements)).toContain('Hello from mock LLM');
      // The terminal card also carries the session-stats line (exact counted
      // fields): at least one turn + one step, rendered as a markdown row.
      expect(
        lastCard?.elements.some(
          (el) => el.tag === 'markdown' && 'content' in el && String(el.content).includes('turns'),
        ),
      ).toBe(true);
      expect(
        lastCard?.elements.some(
          (el) => el.tag === 'markdown' && 'content' in el && String(el.content).includes('steps'),
        ),
      ).toBe(true);
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
      await pinWorkingDir(chatId);
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
      // Collapsed by default → the sequence line 'think → bash'.
      const patches = readOutbox().filter((r) => r.kind === 'patch');
      const finalCard = patches.at(-1)?.card;
      expect(
        finalCard?.elements.some(
          (el) => el.tag === 'markdown' && 'content' in el && el.content === 'think → bash',
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
              (el) => el.tag === 'markdown' && 'content' in el && el.content === 'think → bash',
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
      await pinWorkingDir(chatId);
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
      await pinWorkingDir(chatId);
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
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'run the matrix check');

      // Wait for the running turn's card to appear (the agent is held
      // running by the mock).
      await waitFor(
        'the working streaming card',
        () => readOutbox().some((r) => r.kind === 'card'),
        30_000,
      );
      // Ensure the agent's request is actually in flight (held) before
      // driving the panel/stop actions — see the copy-after-stop test.
      await server.waitForHold();

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
            action.actions.some((a) => 'text' in a && a.text.content === '⏹ Stop current turn')
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
      await pinWorkingDir(chatA);
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
          readOutbox().some(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🗂️ Sessions' &&
              (r.card.elements ?? []).some(
                (el) =>
                  el.tag === 'action' &&
                  'actions' in el &&
                  el.actions.some((a) => a.tag === 'select_static'),
              ),
          ),
        30_000,
      );
      expect(
        readOutbox()
          .filter((r) => r.kind === 'card' || r.kind === 'patch')
          .some((r) => JSON.stringify(r.card?.elements).includes(sessionA)),
      ).toBe(true);

      // Resume A's session from B: Details → the detail card → Resume. The
      // message ids come from the outbox records (not computed counters).
      // The loading placeholder carries the same title, so target the record
      // that actually renders the dropdown.
      const pickerRecord = [...readOutbox()]
        .reverse()
        .find(
          (r) =>
            r.card?.header?.title.content === '🗂️ Sessions' &&
            (r.card.elements ?? []).some(
              (el) =>
                el.tag === 'action' &&
                'actions' in el &&
                el.actions.some((a) => a.tag === 'select_static'),
            ),
        );
      expect(pickerRecord?.messageId).toBeDefined();
      const pickerId = pickerRecord?.messageId ?? '';
      writeAction({
        messageId: pickerId,
        chatId: chatB,
        operatorOpenId: 'ou_mock',
        value: { kind: 'session-select', sessionId: sessionA },
      });
      await waitFor(
        'the session detail card',
        () =>
          readOutbox().some(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🗂️ Session',
          ),
        30_000,
      );
      const detailRecord = [...readOutbox()]
        .reverse()
        .find((r) => r.card?.header?.title.content === '🗂️ Session');
      writeAction({
        messageId: detailRecord?.messageId ?? '',
        chatId: chatB,
        operatorOpenId: 'ou_mock',
        value: { kind: 'resume-session', sessionId: sessionA },
      });
      await waitFor(
        'the resume confirmation card',
        () => resultCardTexts().some((t) => t.includes(`Resumed session ${sessionA}`)),
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
          readOutbox().some(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🗂️ Sessions',
          ),
        30_000,
      );
      expect(
        readOutbox()
          .filter((r) => r.kind === 'card' || r.kind === 'patch')
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

      // Tap the /status button: the outcome arrives as a result card (the
      // state-machine completion exit posts an inert card and pops to menu).
      writeAction({
        messageId: 'mem-2',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'command', name: 'status' },
      });
      await waitFor(
        'the status command result card',
        () => resultCardTexts().some((t) => t.includes(`chat: ${chatId}`)),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);

  /** The user-reported compact regression: tapping 🧹 Compact must open a
   *  compaction card immediately (button feedback), finalize it when the
   *  transaction ends, and leave the chat servable again — previously the
   *  chat stayed "working" forever and every later command was refused with
   *  "a turn is running — stop it first." */
  it('compact button finalizes the compaction card and unlocks the chat (regression)', async () => {
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

      const chatId = `oc_compact_${Date.now()}`;
      await pinWorkingDir(chatId);
      // A first turn gives the session history to compact.
      sendMessage(chatId, 'hello from the compact regression test');
      await waitFor(
        'the first turn to finalize',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );

      // Open the panel and tap the 🧹 Compact palette button.
      writeAction({
        messageId: 'mem-compact-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'panel' },
      });
      await waitFor(
        'the panel card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card' && r.chatId === chatId)
            .some((r) => r.card?.header?.title.content === '⚙️ dsh-feishu panel'),
        30_000,
      );
      writeAction({
        messageId: 'mem-compact-2',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'command', name: 'compact' },
      });
      // The compact button first shows the confirm sub-view (state machine);
      // the panel card is updated IN PLACE (patch record, no chatId).
      await waitFor(
        'the compact confirm card',
        () =>
          readOutbox().some(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🧹 Compact',
          ),
        30_000,
      );
      const confirmCard = [...readOutbox()]
        .reverse()
        .find((r) => r.card?.header?.title.content === '🧹 Compact');
      writeAction({
        messageId: confirmCard?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'panel-confirm', command: 'compact' },
      });

      // Immediate feedback: a Compacting card opens (not a silent wait).
      await waitFor(
        'the Compacting card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card' && r.chatId === chatId)
            .some((r) => r.card?.header?.title.content === '🧹 Compacting…'),
        30_000,
      );

      // The transaction settles: either a "Compacted …" result card or the
      // failure notice — never a permanently working card.
      await waitFor(
        'the compaction outcome',
        () =>
          resultCardTexts().some(
            (t) =>
              t.includes('Compacted') ||
              t.includes('No compactable history') ||
              t.includes('Compaction failed') ||
              t.includes('unavailable on this deployment'),
          ),
        90_000,
      );

      // THE REGRESSION: the chat is servable again — a later command must
      // NOT be refused with "a turn is running — stop it first."
      sendMessage(chatId, '/status');
      await waitFor(
        'the /status reply after compaction',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.chatId === chatId && r.text?.includes(`chat: ${chatId}`),
          ),
        30_000,
      );
      const after = readOutbox();
      expect(
        after.some(
          (r) => r.chatId === chatId && r.text?.includes('a turn is running — stop it first.'),
        ),
      ).toBe(false);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** The state-machine matrix rule end-to-end: while a turn is running,
   *  mutating commands — including the 🧹 Compact button and a typed
   *  `/repo` — are refused with "a turn is running — stop it first."
   *  (the surface must not start a second turn over a live one). */
  it('mutating commands and the compact button are refused while a turn is running', async () => {
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

      const chatId = `oc_refuse_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'hold this turn open');
      await waitFor(
        'the working streaming card',
        () => readOutbox().some((r) => r.kind === 'card' && r.chatId === chatId),
        30_000,
      );
      // The turn must actually be running (request in flight, held) before
      // the mutating-command refusal is tested — see the copy-after-stop
      // test for the race this guards against.
      await server.waitForHold();

      // Compact button (palette command) while running → the confirm view
      // opens, and CONFIRMING is refused.
      writeAction({
        messageId: 'mem-refuse-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'command', name: 'compact' },
      });
      await waitFor(
        'the compact confirm card',
        () =>
          readOutbox().some(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🧹 Compact',
          ),
        30_000,
      );
      const confirmCard = [...readOutbox()]
        .reverse()
        .find((r) => r.card?.header?.title.content === '🧹 Compact');
      writeAction({
        messageId: confirmCard?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'panel-confirm', command: 'compact' },
      });
      await waitFor(
        'the compact refusal',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'text' &&
              r.chatId === chatId &&
              r.text?.includes('a turn is running — stop it first.'),
          ),
        30_000,
      );

      // Typed /repo while running → refused the same way.
      sendMessage(chatId, '/repo');
      await waitFor(
        'the /repo refusal',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'text' && r.chatId === chatId)
            .filter((r) => r.text?.includes('a turn is running — stop it first.')).length >= 2,
        30_000,
      );

      // Release the held response: the turn completes and the chat is
      // servable again.
      server.release();
      await waitFor(
        'the turn to finalize after release',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        60_000,
      );
      sendMessage(chatId, '/status');
      await waitFor(
        'the /status reply after the held turn',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.chatId === chatId && r.text?.includes(`chat: ${chatId}`),
          ),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Hostile/unexpected input must never break the surface: markdown-heavy
   *  text, a blank message, and a very long message all produce a completed
   *  green turn (lark_md has no reliable escaping — the surface must not
   *  crash or wedge on attacker-shaped text). */
  it('hostile markdown, blank, and very long messages all complete safely', async () => {
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

      const chatId = `oc_hostile_${Date.now()}`;
      await pinWorkingDir(chatId);
      const greens = () =>
        readOutbox().filter((r) => r.kind === 'patch' && r.card?.header?.template === 'green')
          .length;

      // 1. Markdown/HTML/mention-shaped hostile text.
      sendMessage(
        chatId,
        'hello **bold** `inline code` [link](https://example.com) <at id="ou_x"></at> 🚀 `**nested**`',
      );
      await waitFor('the hostile turn to finalize', () => greens() >= 1, 90_000);
      // The card title derives from the user's message and must carry the
      // hostile text verbatim (the surface never crashes on it).
      const titles = readOutbox()
        .filter((r) => r.kind === 'patch' && r.card?.header?.template === 'green')
        .map((r) => r.card?.header?.title.content ?? '');
      expect(titles.some((t) => t.includes('bold'))).toBe(true);

      // 2. A blank message (whitespace only) still completes.
      sendMessage(chatId, '   ');
      await waitFor('the blank turn to finalize', () => greens() >= 2, 90_000);

      // 3. A very long message: the card title is capped, the turn completes.
      sendMessage(chatId, `${'x'.repeat(500)} tail`);
      await waitFor('the long turn to finalize', () => greens() >= 3, 90_000);
      const longCard = readOutbox()
        .filter((r) => r.kind === 'patch' && r.card?.header?.template === 'green')
        .at(-1)?.card;
      const title = longCard?.header?.title.content ?? '';
      expect(title.length).toBeLessThanOrEqual(41);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Consecutive messages to one chat: each must be answered — the surface
   *  must never drop or wedge a follow-up message behind the previous turn.
   *  (Burst messages arriving within one step are merged by the agent's
   *  inbox `next-step` claim — that is harness semantics, not a loss.) */
  it('consecutive messages to one chat are each answered', async () => {
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

      const chatId = `oc_seq_${Date.now()}`;
      await pinWorkingDir(chatId);
      const greens = () =>
        readOutbox().filter((r) => r.kind === 'patch' && r.card?.header?.template === 'green')
          .length;

      // Message A: wait for its turn to complete before sending B.
      sendMessage(chatId, 'first message');
      await waitFor('the first turn to finalize', () => greens() >= 1, 90_000);
      // Message B: its own turn completes too — nothing is dropped.
      sendMessage(chatId, 'second message');
      await waitFor('the second turn to finalize', () => greens() >= 2, 90_000);

      // Burst (same step): the agent merges them into one turn — still at
      // least one completed turn, never a wedged chat.
      sendMessage(chatId, 'burst one');
      sendMessage(chatId, 'burst two');
      await waitFor('the burst turn to finalize', () => greens() >= 3, 120_000);
      // The chat is servable after the burst.
      sendMessage(chatId, '/status');
      await waitFor(
        'the /status reply after the burst',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.chatId === chatId && r.text?.includes(`chat: ${chatId}`),
          ),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

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
      // Bare /permission opens the preset picker card (loading placeholder
      // posts first, the real picker arrives as a patch).
      await waitFor(
        'the permission picker card',
        () =>
          readOutbox().some(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🔐 Permission presets',
          ),
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
          (r) =>
            (r.kind === 'card' || r.kind === 'patch') &&
            r.card?.header?.title.content === '🔐 Permission presets',
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
        'the preset switch result card',
        () => resultCardTexts().some((t) => t.includes('switched to read-only')),
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
      // Bare /model opens the picker card with the real deepseek catalog
      // (loading placeholder posts first, the real picker is a patch). The
      // picker's `select_static` options are populated asynchronously from the
      // model catalog, so wait for a card whose options are NON-EMPTY: a
      // title-only match can read the placeholder or an unfilled picker and
      // flake on an empty options list.
      const pickerSelectOptions = (record: MemoryOutboxRecord): string[] => {
        const action = record.card?.elements.find((el) => el.tag === 'action');
        const select =
          action && 'actions' in action
            ? action.actions.find((a) => a.tag === 'select_static')
            : undefined;
        return select && 'options' in select ? select.options.map((o) => o.value) : [];
      };
      const findModelPicker = (): MemoryOutboxRecord | undefined =>
        [...readOutbox()]
          .reverse()
          .find(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🤖 Model' &&
              pickerSelectOptions(r).length > 0,
          );
      await waitFor(
        'the model picker card with a filled catalog',
        () => findModelPicker() !== undefined,
        60_000,
      );
      const pickerRecord = findModelPicker();
      const pickerAction = pickerRecord?.card?.elements.find((el) => el.tag === 'action');
      const pickerSelect =
        pickerAction && 'actions' in pickerAction
          ? pickerAction.actions.find((a) => a.tag === 'select_static')
          : undefined;
      expect(
        pickerSelect && 'options' in pickerSelect ? pickerSelect.options.map((o) => o.value) : [],
      ).toContain('deepseek-official/deepseek-v4-flash');
      // The preselected current is whatever the persisted default is — it
      // must be a catalog member (the picker never preselects an unknown).
      const initialOption =
        pickerSelect && 'initial_option' in pickerSelect ? pickerSelect.initial_option : undefined;
      const optionValues =
        pickerSelect && 'options' in pickerSelect ? pickerSelect.options.map((o) => o.value) : [];
      expect(optionValues).toContain('deepseek-official/deepseek-v4-flash');
      expect(optionValues).toContain(initialOption ?? 'no-initial');

      // Pick another model through the dropdown option → default saved.
      writeAction({
        messageId: pickerRecord?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'model-pick' },
        option: 'deepseek-official/deepseek-v4-pro',
      });
      await waitFor(
        'the model-switch result card',
        () =>
          resultCardTexts().some((t) =>
            t.includes('Model set to deepseek-official · deepseek-v4-pro (this session + default)'),
          ),
        30_000,
      );

      // Restore the deployment default (the test writes the shared profile's
      // settings; leave it at the dsh-base default so later runs and the
      // real bot are unaffected).
      writeAction({
        messageId: pickerRecord?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'model-pick' },
        option: 'deepseek-official/deepseek-v4-flash',
      });
      await waitFor(
        'the model-restore result card',
        () =>
          resultCardTexts().some((t) =>
            t.includes(
              'Model set to deepseek-official · deepseek-v4-flash (this session + default)',
            ),
          ),
        30_000,
      );

      // /panel opens the control panel card from this (fresh) chat — the
      // same single panel card, updated in place (patch after the first
      // post).
      sendMessage(chatId, '/panel');
      await waitFor(
        'the panel card via /panel',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card' || r.kind === 'patch')
            .some((r) => r.card?.header?.title.content === '⚙️ dsh-feishu panel'),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);

  /** The working-directory gate on the real process: a fresh chat refuses
   *  turns with guidance until /cd pins a directory (user requirement: DSH
   *  is unavailable until a repo is explicitly chosen). */
  it('refuses work until a working directory is chosen, then works after /cd', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([[{ content: 'Gated work answer.' }]]);
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

      const chatId = `oc_gate_${Date.now()}`;
      // A plain message without a pinned directory → refused with guidance.
      sendMessage(chatId, 'do some work');
      await waitFor(
        'the working-directory refusal',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.text?.includes('No working directory chosen'),
          ),
        30_000,
      );
      // No card was opened and no model request happened.
      expect(readOutbox().filter((r) => r.kind === 'card')).toHaveLength(0);
      expect(server.completionRequests()).toBe(0);

      // After /cd pins a directory, the same chat works normally.
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'now work');
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
      expect(server.completionRequests()).toBeGreaterThanOrEqual(1);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Error turn → red card + ⚠️ notice (the failure must never go
   *  unnoticed), then retry recovers to a done card. */
  it('error turn notifies and retry recovers', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      // Three failing scripts cover the initial request plus the default
      // retry budget; the scripts are RESET to a success before the retry
      // action below, so the recovery is deterministic either way.
      server.setScripts([
        [{ error: 'mock boom' }],
        [{ error: 'mock boom' }],
        [{ error: 'mock boom' }],
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

      const chatId = `oc_error_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'cause an error');
      // The card finalizes red and a ⚠️ notice arrives.
      await waitFor(
        'the red final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'red'),
        90_000,
      );
      await waitFor(
        'the failure notice text',
        () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes('Turn failed')),
        30_000,
      );
      // Retry the same prompt → green + recovered answer.
      server.setScripts([[{ content: 'Recovered answer.' }]]);
      const streamingId = readOutbox()
        .filter((r) => r.kind === 'card')
        .at(-1)?.messageId;
      writeAction({
        messageId: streamingId ?? 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'retry' },
      });
      await waitFor(
        'the recovered green card',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Recovered answer.'),
          ),
        90_000,
      );
      expect(server.completionRequests()).toBeGreaterThanOrEqual(2);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Copy resends the last output as text; retry runs a fresh turn. */
  it('copy resends the answer and retry starts a fresh turn', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([[{ content: 'Copy me.' }], [{ content: 'Retried answer.' }]]);
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

      const chatId = `oc_copy_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'give me a copy');
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
      const streamingId = readOutbox()
        .filter((r) => r.kind === 'card')
        .at(-1)?.messageId;
      // Copy → the last output arrives as a text message.
      writeAction({
        messageId: streamingId ?? 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'copy' },
      });
      await waitFor(
        'the copied text',
        () => readOutbox().some((r) => r.kind === 'text' && r.text === 'Copy me.'),
        30_000,
      );
      // Retry → a fresh working card streams the second answer.
      const cardsBeforeRetry = readOutbox().filter((r) => r.kind === 'card').length;
      writeAction({
        messageId: streamingId ?? 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'retry' },
      });
      await waitFor(
        'the retried card',
        () => readOutbox().filter((r) => r.kind === 'card').length > cardsBeforeRetry,
        90_000,
      );
      await waitFor(
        'the retried green card with the new answer',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Retried answer.'),
          ),
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** The group mention gate on the real process: an un-@ message is
   *  ignored, an @-mention runs the turn. */
  it('group mention gate: un-@ ignored, @-mention answered', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([[{ content: 'Group answer.' }]]);
      child = spawn(bin, ['--profile', 'feishu-dev'], {
        env: {
          ...process.env,
          DSH_HOME,
          FEISHU_APP_ID: 'cli_mock_app',
          FEISHU_APP_SECRET: 'mock_secret',
          FEISHU_TRANSPORT: 'memory',
          FEISHU_MEMORY_DIR: MEMORY_DIR,
          FEISHU_MOCK_BOT_OPEN_ID: 'ou_bot',
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

      const chatId = `oc_group_${Date.now()}`;
      // Pin the working directory through an @-mentioned /cd first.
      sendGroupMessage(chatId, `/cd ${INT_CWD}`, ['ou_bot']);
      await waitFor(
        'the /cd confirmation in the group',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.text?.includes('Working directory set to'),
          ),
        30_000,
      );
      // An un-@ message is ignored entirely: no card, no LLM request.
      const completionsBefore = server.completionRequests();
      sendGroupMessage(chatId, 'hey bot', []);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // The un-@ message must not start a turn: no LLM request, no card.
      expect(server.completionRequests()).toBe(completionsBefore);
      expect(readOutbox().filter((r) => r.kind === 'card')).toHaveLength(0);
      // An @-mentioned message runs the turn (at least one completion).
      sendGroupMessage(chatId, 'hey @bot do work', ['ou_bot']);
      await waitFor(
        'the green final card patch for the group',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
      expect(server.completionRequests()).toBeGreaterThanOrEqual(completionsBefore + 1);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Two chats run turns concurrently; both complete independently. */
  it('two chats run turns concurrently without interference', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([[{ content: 'Answer A.' }], [{ content: 'Answer B.' }]]);
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

      const chatA = `oc_multi_a_${Date.now()}`;
      const chatB = `oc_multi_b_${Date.now()}`;
      await pinWorkingDir(chatA);
      await pinWorkingDir(chatB);
      sendMessage(chatA, 'work A');
      sendMessage(chatB, 'work B');
      try {
        await waitFor(
          'both green cards',
          () =>
            readOutbox().filter((r) => r.kind === 'patch' && r.card?.header?.template === 'green')
              .length >= 2,
          45_000,
        );
      } catch (waitError) {
        const rec = readOutbox();
        let inboxFiles: string[] = [];
        try {
          inboxFiles = readdirSync(INBOX_DIR);
        } catch {
          inboxFiles = [];
        }
        throw new Error(
          `${String(waitError)}\nDBG cards=${rec.filter((r) => r.kind === 'card').length} patches=${rec.filter((r) => r.kind === 'patch').length} texts=${JSON.stringify(rec.filter((r) => r.kind === 'text').map((r) => r.text))} completions=${server.completionRequests()} inbox=${JSON.stringify(inboxFiles)}`,
        );
      }
      // Each chat's answer appears on a card (cross-chat isolation). Each
      // new session also fires a title-generation completion, so only the
      // card contents are asserted precisely.
      const patches = readOutbox().filter((r) => r.kind === 'patch');
      const joined = JSON.stringify(patches.map((r) => r.card?.elements));
      expect(joined).toContain('Answer A.');
      expect(joined).toContain('Answer B.');
      expect(server.completionRequests()).toBeGreaterThanOrEqual(2);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Regression for ErrCode 11310: an answer with more than 5 GFM tables
   *  must render at most 5 native table elements, overflow becomes fenced
   *  code, and the turn still completes green (no card-cap crash). */
  it('caps native tables at 5 and fences the overflow', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      const tables = Array.from(
        { length: 7 },
        (_, i) => `| h1 | h2 |\n|---|---|\n| a${i} | b${i} |`,
      );
      server.setScripts([[{ content: tables.join('\n\n') }]]);
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

      const chatId = `oc_tables_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'give me many tables');
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
      const finalCard = readOutbox()
        .filter((r) => r.kind === 'patch')
        .at(-1)?.card;
      const tableCount = (finalCard?.elements ?? []).filter((el) => el.tag === 'table').length;
      expect(tableCount).toBeLessThanOrEqual(5);
      // The overflow renders as fenced code (no raw pipe text leaks).
      const markdowns = (finalCard?.elements ?? []).filter(
        (el): el is Extract<typeof el, { tag: 'markdown' }> => el.tag === 'markdown',
      );
      expect(markdowns.some((el) => el.content.includes('```'))).toBe(true);
      // Raw pipe text may only live INSIDE a code fence (the overflow is
      // fenced) — it must never leak as bare markdown.
      const unfencedLeak = markdowns.some(
        (el) => !el.content.includes('```') && el.content.includes('| a'),
      );
      expect(unfencedLeak).toBe(false);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Very long output: the card keeps the newest tail with a truncation
   *  marker (content integrity — never silently dropped). */
  it('truncates very long output to the newest tail with a marker', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      const long = 'x'.repeat(70_000);
      server.setScripts([[{ content: long }]]);
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

      const chatId = `oc_long_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'long output please');
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
      const finalCard = readOutbox()
        .filter((r) => r.kind === 'patch')
        .at(-1)?.card;
      const markdowns = (finalCard?.elements ?? []).filter(
        (el): el is Extract<typeof el, { tag: 'markdown' }> => el.tag === 'markdown',
      );
      // Exclude the session-stats line (it follows the output on the terminal
      // card); the tail assertion is about the streamed output, not the stats.
      const joined = markdowns
        .map((el) => el.content)
        .filter((content) => !content.includes('turns'))
        .join('\n');
      expect(joined).toContain('truncated');
      // The newest tail survives (the marker prepends; the tail stays last).
      expect(joined.endsWith('xxx')).toBe(true);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Slash-command surface batch: help, status, unknown-command fallback,
   *  typed /model, and the real harness /goal. */
  it('command surface: /help, /status, unknown fallback, typed /model, /goal', async () => {
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

      const chatId = `oc_cmds_${Date.now()}`;
      const expectText = (needle: string, label: string): Promise<void> =>
        waitFor(
          label,
          () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes(needle)),
          60_000,
        );

      sendMessage(chatId, '/help');
      await expectText('dsh-feishu commands', 'the /help text');
      sendMessage(chatId, '/status');
      await expectText(`chat: ${chatId}`, 'the /status text');
      sendMessage(chatId, '/nope');
      await expectText('Unknown command /nope', 'the unknown-command text');
      // Typed /model sets the default directly (no picker needed).
      sendMessage(chatId, '/model deepseek-official/deepseek-v4-flash');
      await expectText(
        'Model set to deepseek-official · deepseek-v4-flash (this session + default)',
        'the /model text',
      );
      // The real harness /goal: create then view.
      sendMessage(chatId, '/goal fix the build');
      await expectText('Goal created', 'the /goal create text');
      sendMessage(chatId, '/goal');
      await expectText('fix the build', 'the /goal view text');
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Panel page navigation: the palette paginates and the nav action flips
   *  to page 2 (system group). */
  it('panel palette paginates via the nav buttons', async () => {
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

      const chatId = `oc_paginate_${Date.now()}`;
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
      const page1 = readOutbox()
        .filter((r) => r.kind === 'card')
        .at(-1)?.card;
      expect(
        page1?.elements.some(
          (el) =>
            el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page 1/2'),
        ),
      ).toBe(true);
      writeAction({
        messageId: 'mem-2',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'panel-page', page: '1' },
      });
      await waitFor(
        'the page-2 panel card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card' || r.kind === 'patch')
            .some(
              (r) =>
                r.card?.elements.some(
                  (el) =>
                    el.tag === 'note' &&
                    'elements' in el &&
                    el.elements[0]?.content.includes('page 2/2'),
                ) === true,
            ),
        30_000,
      );
      const page2 = readOutbox()
        .filter((r) => r.kind === 'card' || r.kind === 'patch')
        .at(-1)?.card;
      const labels =
        page2?.elements.flatMap((el) =>
          el.tag === 'action'
            ? el.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
            : [],
        ) ?? [];
      expect(labels).toContain('🗺️ Plan mode');
      expect(labels).toContain('🤖 Model');
      expect(labels).toContain('📤 Export');
      expect(labels).toContain('🔐 Permission');
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);

  /** The real approval flow end to end: a scripted sandbox-escalation tool
   *  call raises an approval/request, the approval card posts, and pressing
   *  Allow grants the escalation so the tool runs and the turn completes. */
  it('approval card: Allow grants the escalation and the turn completes', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-approval-1',
              name: 'bash',
              arguments:
                '{"command":"rm -rf /tmp/dsh-feishu-approval-test","description":"integration approval","sandbox_permissions":"danger-full-access","justification":"integration test approval flow"}',
            },
          },
        ],
        [{ content: 'Approval flow done.' }],
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

      const chatId = `oc_appr_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'run the approval flow');
      // The approval card appears with Allow/Reject buttons.
      await waitFor(
        'the approval card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => r.card?.header?.title.content === '🔐 Approval needed'),
        60_000,
      );
      const approvalRecord = [...readOutbox()]
        .reverse()
        .find((r) => r.kind === 'card' && r.card?.header?.title.content === '🔐 Approval needed');
      const approvalCard = approvalRecord?.card;
      const action = approvalCard?.elements.find((el) => el.tag === 'action');
      const allowButton =
        action && 'actions' in action
          ? action.actions.find(
              (a) => a.tag === 'button' && 'value' in a && a.value.decision === 'allow',
            )
          : undefined;
      const requestId = allowButton && 'value' in allowButton ? allowButton.value.id : undefined;
      expect(requestId).toBeDefined();

      // Press Allow through the card callback channel.
      writeAction({
        messageId: approvalRecord?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'approval', decision: 'allow', id: requestId ?? '' },
      });
      // The tool runs, the card becomes a static "Allowed once" card, and
      // the turn completes green with the model's answer.
      await waitFor(
        'the approved static card',
        () =>
          readOutbox().some(
            (r) => r.kind === 'patch' && JSON.stringify(r.card?.elements).includes('Allowed once'),
          ),
        30_000,
      );
      await waitFor(
        'the green final card patch',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Approval flow done.'),
          ),
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Rejecting the approval fails the escalation: the tool errors, the card
   *  becomes "Rejected", and the turn still completes (the model answers
   *  after the tool error). */
  it('approval card: Reject fails the escalation and the turn completes', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-approval-2',
              name: 'bash',
              arguments:
                '{"command":"rm -rf /tmp/dsh-feishu-approval-test-2","description":"integration approval","sandbox_permissions":"danger-full-access","justification":"integration test approval flow"}',
            },
          },
        ],
        [{ content: 'Rejected flow done.' }],
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

      const chatId = `oc_appr_reject_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'run the approval reject flow');
      await waitFor(
        'the approval card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => r.card?.header?.title.content === '🔐 Approval needed'),
        60_000,
      );
      const approvalRecord = [...readOutbox()]
        .reverse()
        .find((r) => r.kind === 'card' && r.card?.header?.title.content === '🔐 Approval needed');
      const action = approvalRecord?.card?.elements.find((el) => el.tag === 'action');
      const rejectButton =
        action && 'actions' in action
          ? action.actions.find(
              (a) => a.tag === 'button' && 'value' in a && a.value.decision === 'reject',
            )
          : undefined;
      const requestId = rejectButton && 'value' in rejectButton ? rejectButton.value.id : undefined;
      expect(requestId).toBeDefined();

      writeAction({
        messageId: approvalRecord?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'approval', decision: 'reject', id: requestId ?? '' },
      });
      await waitFor(
        'the rejected static card',
        () =>
          readOutbox().some(
            (r) => r.kind === 'patch' && JSON.stringify(r.card?.elements).includes('Rejected'),
          ),
        30_000,
      );
      await waitFor(
        'the green final card patch after rejection',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Rejected flow done.'),
          ),
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** /export delivers the session log as a file message (the Feishu
   *  equivalent of the web's browser-download /export). */
  it('/export sends the session log as a file message', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([[{ content: 'Exportable answer.' }]]);
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

      const chatId = `oc_export_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'produce exportable content');
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
      sendMessage(chatId, '/export');
      await waitFor(
        'the file record in the outbox',
        () => readOutbox().some((r) => r.kind === 'file'),
        30_000,
      );
      const file = readOutbox().find((r) => r.kind === 'file');
      expect(file?.fileName).toMatch(/^session-.*\.md$/);
      // The transcript carries the user turn and the assistant answer. The
      // outbox file `content` is a byte array now (binary-safe seam).
      const transcript = Buffer.from(file?.content ?? []).toString('utf8');
      expect(transcript).toContain('## user');
      expect(transcript).toContain('produce exportable content');
      expect(transcript).toContain('Exportable answer.');
      await waitFor(
        'the export confirmation text',
        () => readOutbox().some((r) => r.kind === 'text' && r.text?.includes('Exported')),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** The model can ask the user a question (ask_user_question, mounted in
   *  the profile): the question card posts and an option tap feeds the
   *  answer back into the turn. */
  it('ask_user_question posts a question card and the option answer continues the turn', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-question-1',
              name: 'ask_user_question',
              arguments:
                '{"questions":[{"id":"q1","question":"Which stack?","options":[{"label":"Go"},{"label":"Rust"}]}]}',
            },
          },
        ],
        [{ content: 'Question answered.' }],
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

      const chatId = `oc_question_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'ask me something');
      // The question card posts with the option buttons.
      await waitFor(
        'the question card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => r.card?.header?.title.content === '❓ Question'),
        60_000,
      );
      const questionRecord = [...readOutbox()]
        .reverse()
        .find((r) => r.kind === 'card' && r.card?.header?.title.content === '❓ Question');
      const questionCard = questionRecord?.card;
      expect(JSON.stringify(questionCard?.elements)).toContain('Which stack?');
      const action = questionCard?.elements.find((el) => el.tag === 'action');
      const optionButton =
        action && 'actions' in action
          ? action.actions.find(
              (a) => a.tag === 'button' && 'value' in a && a.value.answer === 'Rust',
            )
          : undefined;
      expect(optionButton && 'value' in optionButton ? optionButton.value.id : undefined).toBe(
        'q1',
      );
      // Answer via the card callback channel.
      writeAction({
        messageId: questionRecord?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'question', id: 'q1', answer: 'Rust' },
      });
      // The tool result feeds back and the turn completes green.
      await waitFor(
        'the green final card patch after the question',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Question answered.'),
          ),
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Two-stage reaction ack on a completed turn: the received emoji lands
   *  on the inbound message, then swaps to DONE via remove+add at turn end. */
  it('two-stage reaction ack: received emoji, then DONE swap on completion', async () => {
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

      const chatId = `oc_reaction_${Date.now()}`;
      const messageId = `om-rx-${Date.now()}`;
      await pinWorkingDir(chatId);
      // Reaction records carry no chatId — the correlation key is the
      // inbound messageId, written explicitly here.
      writeFileSync(
        join(INBOX_DIR, `${messageId}.json`),
        JSON.stringify({
          messageId,
          chatId,
          chatType: 'p2p',
          senderOpenId: 'ou_mock',
          text: 'run a reaction check',
          createdAt: Date.now(),
        }),
        'utf8',
      );
      // Stage 1: the received emoji lands on the inbound message.
      await waitFor(
        'the received reaction add',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'reaction' &&
              r.messageId === messageId &&
              r.action === 'add' &&
              r.emojiType === 'GoGoGo',
          ),
        60_000,
      );
      // Stage 2: turn completion swaps it to DONE (remove then add).
      await waitFor(
        'the DONE reaction swap',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'reaction' &&
              r.messageId === messageId &&
              r.action === 'add' &&
              r.emojiType === 'DONE',
          ),
        90_000,
      );
      const records = readOutbox().filter(
        (r) => r.kind === 'reaction' && r.messageId === messageId,
      );
      expect(records[0]).toMatchObject({ action: 'add', emojiType: 'GoGoGo' });
      expect(records[1]).toMatchObject({ action: 'remove', reactionId: records[0]?.reactionId });
      expect(records[2]).toMatchObject({ action: 'add', emojiType: 'DONE' });
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Two-stage reaction ack on a failing turn: the received emoji swaps to
   *  the configured error emoji (WARN) instead of DONE. */
  it('two-stage reaction ack: error turn swaps to the error emoji', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([
        [{ error: 'mock boom' }],
        [{ error: 'mock boom' }],
        [{ error: 'mock boom' }],
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

      const chatId = `oc_reaction_err_${Date.now()}`;
      const messageId = `om-rx-err-${Date.now()}`;
      await pinWorkingDir(chatId);
      writeFileSync(
        join(INBOX_DIR, `${messageId}.json`),
        JSON.stringify({
          messageId,
          chatId,
          chatType: 'p2p',
          senderOpenId: 'ou_mock',
          text: 'cause a reaction ack error',
          createdAt: Date.now(),
        }),
        'utf8',
      );
      await waitFor(
        'the red final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'red'),
        90_000,
      );
      await waitFor(
        'the ERROR reaction swap',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'reaction' &&
              r.messageId === messageId &&
              r.action === 'add' &&
              r.emojiType === 'ERROR',
          ),
        30_000,
      );
      const records = readOutbox().filter(
        (r) => r.kind === 'reaction' && r.messageId === messageId,
      );
      expect(records[0]).toMatchObject({ action: 'add', emojiType: 'GoGoGo' });
      expect(records[1]).toMatchObject({ action: 'remove', reactionId: records[0]?.reactionId });
      expect(records[2]).toMatchObject({ action: 'add', emojiType: 'ERROR' });
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** The user allowlist (env seam FEISHU_ALLOWED_USERS): a listed sender is
   *  served, a stranger in the same chat is ignored entirely — no reaction,
   *  no card, no LLM request. */
  it('allowedUsers: listed sender served, stranger ignored', async () => {
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
          FEISHU_ALLOWED_USERS: 'ou_mock',
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

      const chatId = `oc_allowed_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'served turn');
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
      // A stranger (same chat, different sender) is ignored: no reaction on
      // their message, no new LLM request, no card.
      const completionsBefore = server.completionRequests();
      const strangerId = `om-stranger-${Date.now()}`;
      writeFileSync(
        join(INBOX_DIR, `${strangerId}.json`),
        JSON.stringify({
          messageId: strangerId,
          chatId,
          chatType: 'p2p',
          senderOpenId: 'ou_stranger',
          text: 'intrude',
          createdAt: Date.now(),
        }),
        'utf8',
      );
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(readOutbox().some((r) => r.kind === 'reaction' && r.messageId === strangerId)).toBe(
        false,
      );
      expect(server.completionRequests()).toBe(completionsBefore);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Proactive @-mention: a failing turn in a GROUP posts the error notice
   *  with a text-channel mention of the user who started the turn. */
  it('proactive mention: group error notice @s the requester', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([
        [{ error: 'mock boom' }],
        [{ error: 'mock boom' }],
        [{ error: 'mock boom' }],
      ]);
      child = spawn(bin, ['--profile', 'feishu-dev'], {
        env: {
          ...process.env,
          DSH_HOME,
          FEISHU_APP_ID: 'cli_mock_app',
          FEISHU_APP_SECRET: 'mock_secret',
          FEISHU_TRANSPORT: 'memory',
          FEISHU_MEMORY_DIR: MEMORY_DIR,
          FEISHU_MOCK_BOT_OPEN_ID: 'ou_bot',
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

      const chatId = `oc_mention_${Date.now()}`;
      sendGroupMessage(chatId, `/cd ${INT_CWD}`, ['ou_bot']);
      await waitFor(
        'the /cd confirmation in the group',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.text?.includes('Working directory set to'),
          ),
        30_000,
      );
      sendGroupMessage(chatId, 'break something', ['ou_bot']);
      await waitFor(
        'the red final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'red'),
        90_000,
      );
      await waitFor(
        'the mention-carrying failure notice',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'text' &&
              r.text?.includes('<at user_id="ou_mock"></at>') &&
              r.text?.includes('Turn failed'),
          ),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);

  /** Compact on a chat with no compactable history: the reply is
   *  informational and the chat stays servable (nothing is wedged). */
  it('compact with no history replies and leaves the chat servable', async () => {
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

      const chatId = `oc_nohist_${Date.now()}`;
      await pinWorkingDir(chatId);
      // A brand-new chat: nothing to compact.
      writeAction({
        messageId: 'mem-nohist-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'command', name: 'compact' },
      });
      // The panel button first shows the confirm sub-view; confirming runs
      // the command (a brand-new chat has nothing to compact).
      await waitFor(
        'the compact confirm card',
        () =>
          readOutbox().some(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🧹 Compact',
          ),
        30_000,
      );
      const confirmCard = [...readOutbox()]
        .reverse()
        .find((r) => r.card?.header?.title.content === '🧹 Compact');
      writeAction({
        messageId: confirmCard?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'panel-confirm', command: 'compact' },
      });
      await waitFor(
        'the no-compactable-history result card',
        () => resultCardTexts().some((t) => t.includes('No compactable history')),
        60_000,
      );
      // The chat was not wedged: a command still works.
      sendMessage(chatId, '/status');
      await waitFor(
        'the /status reply after compact',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.chatId === chatId && r.text?.includes(`chat: ${chatId}`),
          ),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);

  /** Out-of-range panel navigation must clamp, never crash: a huge page
   *  number still shows a panel; garbage pages are ignored. */
  it('panel navigation clamps out-of-range pages and ignores garbage', async () => {
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

      const chatId = `oc_panelclamp_${Date.now()}`;
      writeAction({
        messageId: 'mem-pc-1',
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
      const before = readOutbox().filter((r) => r.kind === 'card').length;
      // A huge page clamps to the last page — the SAME panel card is updated
      // in place (a patch, not a new card).
      writeAction({
        messageId: 'mem-pc-2',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'panel-page', page: '99' },
      });
      await waitFor(
        'the clamped panel card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card' || r.kind === 'patch')
            .some((r) => r.card?.header?.title.content === '⚙️ dsh-feishu panel'),
        30_000,
      );
      expect(readOutbox().filter((r) => r.kind === 'card').length).toBe(before);
      // Garbage pages are ignored — the chat still answers commands.
      writeAction({
        messageId: 'mem-pc-3',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'panel-page', page: 'abc' },
      });
      writeAction({
        messageId: 'mem-pc-4',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'panel-page', page: '-1' },
      });
      sendMessage(chatId, '/status');
      await waitFor(
        'the /status reply after garbage pages',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.chatId === chatId && r.text?.includes(`chat: ${chatId}`),
          ),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);

  /** Copy after a stopped turn resends the partial output the card held
   *  (the stop did not erase it). */
  it('copy after a stopped turn resends the held output', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
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

      const chatId = `oc_stopcopy_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'start then stop me');
      await waitFor(
        'the working streaming card',
        () => readOutbox().some((r) => r.kind === 'card' && r.chatId === chatId),
        30_000,
      );
      // The working card appears as soon as the turn starts, but the agent's
      // LLM request is established asynchronously — a stop issued before it
      // reaches the server cancels nothing and the turn completes normally
      // (no stopped card → timeout on slow CI runners). Await the hold so
      // the abort deterministically lands.
      await server.waitForHold();
      writeAction({
        messageId: 'mem-sc-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'stop' },
      });
      await waitFor(
        'the stopped card',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'orange'),
        60_000,
      );
      // Copy resends the partial output that was streamed before the stop.
      writeAction({
        messageId: 'mem-sc-2',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'copy' },
      });
      await waitFor(
        'the copied partial output',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.chatId === chatId && r.text?.includes('starting…'),
          ),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);

  /** A question card submitted with nothing selected settles an EMPTY
   *  answer and the turn continues (the model gets the empty selection). */
  it('question card submitted empty settles an empty answer and the turn continues', async () => {
    const bin = dshBin;
    const server = mock;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    if (server === undefined) throw new Error('mock LLM server unavailable');
    try {
      server.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-qempty-1',
              name: 'ask_user_question',
              arguments:
                '{"questions":[{"id":"q1","question":"Pick any","multiSelect":true,"options":[{"label":"A"},{"label":"B"}]}]}',
            },
          },
        ],
        [{ content: 'Empty selection accepted.' }],
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

      const chatId = `oc_qempty_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'ask me something');
      await waitFor(
        'the question card',
        () =>
          readOutbox().some(
            (r) => r.kind === 'card' && r.card?.header?.title.content === '❓ Question',
          ),
        60_000,
      );
      // Submit with nothing toggled (the callback must carry the question
      // card's real message id or the stale-card guard rejects it).
      const questionRecord = [...readOutbox()]
        .reverse()
        .find((r) => r.kind === 'card' && r.card?.header?.title.content === '❓ Question');
      writeAction({
        messageId: questionRecord?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'question-submit', id: 'q1' },
      });
      // The turn continues and completes with the model's reply.
      await waitFor(
        'the turn completing after the empty submit',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Empty selection accepted.'),
          ),
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 120_000);

  /** Session detail flow end to end: list → detail → rename/archive via the
   *  host apiProxy seam (B verification: the seam must be present in the
   *  real dsh process, or the detail view degrades). */
  it('session detail lists, renames and archives through the host seam', async () => {
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

      const chatId = `oc_detail_${Date.now()}`;
      await pinWorkingDir(chatId);
      // One turn creates a real session with a log.
      sendMessage(chatId, 'hello session detail');
      await waitFor(
        'the first turn to finalize',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
      // Open the Sessions flow (panel button).
      writeAction({
        messageId: 'mem-detail-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'command', name: 'sessions' },
      });
      await waitFor(
        'the sessions list',
        () =>
          readOutbox().some(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🗂️ Sessions' &&
              (r.card.elements ?? []).some(
                (el) =>
                  el.tag === 'action' &&
                  'actions' in el &&
                  el.actions.some((a) => a.tag === 'select_static'),
              ),
          ),
        30_000,
      );
      // Open the first row's detail (any session). The sessions view is a
      // dropdown: the marker stamps the kind, the chosen id arrives in the
      // callback `option`. The loading placeholder carries the same title,
      // so target the record that actually renders the dropdown.
      const listCard = [...readOutbox()].reverse().find((r) => {
        if (r.card?.header?.title.content !== '🗂️ Sessions') return false;
        return (r.card.elements ?? []).some(
          (el) =>
            el.tag === 'action' &&
            'actions' in el &&
            el.actions.some((a) => a.tag === 'select_static'),
        );
      });
      const list = listCard?.card;
      const dropdown = list?.elements
        .flatMap((el) => (el.tag === 'action' ? el.actions : []))
        .find((a) => a.tag === 'select_static');
      expect(dropdown && 'value' in dropdown ? dropdown.value.kind : undefined).toBe(
        'session-select',
      );
      const firstOption =
        dropdown && 'options' in dropdown ? dropdown.options[0]?.value : undefined;
      expect(firstOption).toBeDefined();
      writeAction({
        messageId: listCard?.messageId ?? '',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'session-select' },
        option: firstOption ?? '',
      });
      await waitFor(
        'the session detail card with actions',
        () =>
          readOutbox().some(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🗂️ Session' &&
              JSON.stringify(r.card?.elements ?? []).includes('✏️ Rename'),
          ),
        30_000,
      );
      const detailCard = [...readOutbox()]
        .reverse()
        .find(
          (r) =>
            (r.kind === 'card' || r.kind === 'patch') &&
            r.card?.header?.title.content === '🗂️ Session' &&
            JSON.stringify(r.card?.elements ?? []).includes('✏️ Rename'),
        );
      const detailJson = JSON.stringify(detailCard?.card?.elements ?? []);
      // The bundle mounts the storage×3 + workspace rows, so the session
      // detail MUST show Rename + Archive in the real dsh process — this is
      // the regression this feature fixes (previously the apiProxy seam was
      // absent in practice and these buttons never rendered).
      expect(detailJson).toContain('✏️ Rename');
      expect(detailJson).toContain('🗄️ Archive');
      {
        // Rename via the input form.
        const renameButton = detailCard?.card?.elements
          .flatMap((el) => (el.tag === 'action' ? el.actions : []))
          .find((a) => 'text' in a && a.text.content.includes('Rename'));
        const renameValue =
          renameButton && 'value' in renameButton ? renameButton.value : undefined;
        writeAction({
          messageId: detailCard?.messageId ?? '',
          chatId,
          operatorOpenId: 'ou_mock',
          value: { kind: 'session-rename', sessionId: renameValue?.sessionId ?? '' },
        });
        await waitFor(
          'the rename input card',
          () =>
            readOutbox().some(
              (r) =>
                (r.kind === 'card' || r.kind === 'patch') &&
                r.card?.header?.title.content === '✏️ Rename session',
            ),
          30_000,
        );
        // Read the submit button's value FROM the rendered card — a real
        // click submits exactly that value. The session id must be carried
        // through the input-card render (regression: it used to be dropped,
        // so a real submit silently did nothing; tests previously
        // constructed the action directly and bypassed the render).
        const renameInputCard = [...readOutbox()]
          .reverse()
          .find(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '✏️ Rename session',
          );
        const renameSubmitButton = renameInputCard?.card?.elements
          .flatMap((el) => (el.tag === 'form' ? el.elements : []))
          .find((a) => 'name' in a && a.name === 'panel-input-submit');
        const renameSubmitValue =
          renameSubmitButton && 'value' in renameSubmitButton
            ? renameSubmitButton.value
            : undefined;
        expect(renameSubmitValue?.sessionId).toBeTruthy();
        writeAction({
          messageId: 'mem-detail-rename-submit',
          chatId,
          operatorOpenId: 'ou_mock',
          value: {
            kind: 'panel-input-submit',
            command: 'rename-session',
            sessionId: renameSubmitValue?.sessionId ?? '',
          },
          formValue: { title: 'Renamed by integration test' },
        });
        await waitFor(
          'the rename confirmation',
          () => resultCardTexts().some((t) => t.includes('Renamed session')),
          30_000,
        );
        // Back to detail → Archive.
        await waitFor(
          'the detail card after rename',
          () =>
            readOutbox().some(
              (r) =>
                (r.kind === 'card' || r.kind === 'patch') &&
                r.card?.header?.title.content === '🗂️ Session' &&
                JSON.stringify(r.card?.elements ?? []).includes('🗄️ Archive'),
            ),
          30_000,
        );
        const detailAfter = [...readOutbox()]
          .reverse()
          .find(
            (r) =>
              (r.kind === 'card' || r.kind === 'patch') &&
              r.card?.header?.title.content === '🗂️ Session' &&
              JSON.stringify(r.card?.elements ?? []).includes('🗄️ Archive'),
          );
        const archiveButton = detailAfter?.card?.elements
          .flatMap((el) => (el.tag === 'action' ? el.actions : []))
          .find((a) => 'text' in a && a.text.content.includes('Archive'));
        const archiveValue =
          archiveButton && 'value' in archiveButton ? archiveButton.value : undefined;
        writeAction({
          messageId: detailAfter?.messageId ?? '',
          chatId,
          operatorOpenId: 'ou_mock',
          value: { kind: 'session-archive', sessionId: archiveValue?.sessionId ?? '' },
        });
        await waitFor(
          'the archive confirmation',
          () => resultCardTexts().some((t) => t.includes('Archived session')),
          30_000,
        );
      }
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }, 180_000);
});
