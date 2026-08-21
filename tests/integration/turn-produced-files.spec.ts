/**
 * Real-composition integration tests for turn-produced-files: the agent
 * produces a file during a turn (a `write`/`edit` mutation), the streaming
 * card's FINAL state lists it as a `📎 Produced` chip, and tapping the chip
 * sends the file to the Feishu chat (memory transport records the outbound
 * message). Covers the new-file CREATE path (where `tool/result` `meta.diffs`
 * is empty and the path comes from the correlated `tool/call` `file_path`)
 * and the file-vs-image send dispatch.
 *
 * The LLM is mocked (it scripts the agent to call `write`); the Feishu
 * transport is the memory seam, which records `{kind:'file'|'image'}` outbox
 * records instead of hitting the real API — the real upload paths
 * (`im.v1.image.create` / `im.v1.file.create`) are covered by transport unit
 * tests. A real dsh process boots from the real profile.
 *
 * Self-skips when the environment lacks a prepared profile or the dsh CLI.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryOutboxRecord } from '../../src/memory-transport.js';
import { type MockLlmServer, startMockLlmServer } from './mock-llm-server.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DSH_HOME =
  process.env.FEISHU_INT_TURN_PRODUCED_DSH_HOME ??
  join(REPO_ROOT, '_dev', 'dsh-home-turn-produced-files');
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'feishu-dev');
const MEMORY_DIR = join(REPO_ROOT, '_dev', 'int-memory-turn-produced');
const INBOX_DIR = join(MEMORY_DIR, 'inbox');
const OUTBOX_DIR = join(MEMORY_DIR, 'outbox');
const ACTIONS_DIR = join(MEMORY_DIR, 'actions');
const INT_CWD = join(REPO_ROOT, '_dev', 'int-cwd-turn-produced');

function resolveDshBin(): string | undefined {
  if (process.env.DSH_BIN !== undefined && process.env.DSH_BIN !== '') return process.env.DSH_BIN;
  const probe = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim() !== '') return probe.stdout.trim();
  return undefined;
}

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
const integrationRequired = process.env.FEISHU_INT_REQUIRED === '1';
const integrationReady = dshBin !== undefined && profileReady && built;
if (integrationRequired && !integrationReady) {
  throw new Error(
    `FEISHU_INT_REQUIRED=1 but integration prerequisites are missing ` +
      `(dsh CLI=${dshBin !== undefined} profile=${profileReady} built=${built})`,
  );
}

/** Drop one inbound message into the message channel. */
function sendMessage(chatId: string, text: string, fixedMessageId?: string): void {
  const messageId = fixedMessageId ?? `om-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(
    join(INBOX_DIR, `${messageId}.json`),
    JSON.stringify({
      messageId,
      chatId,
      chatType: 'p2p',
      senderOpenId: 'ou_mock',
      text,
      mentions: [],
      createdAt: Date.now(),
    }),
    'utf8',
  );
}

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

describe.skipIf(!integrationReady)('integration > turn-produced-files', () => {
  let mock: MockLlmServer | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stdout = '';
  let stderr = '';
  let bridgeReady = false;

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
    rmSync(INT_CWD, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    mkdirSync(INT_CWD, { recursive: true });
    mkdirSync(INBOX_DIR, { recursive: true });
    mkdirSync(OUTBOX_DIR, { recursive: true });
    mkdirSync(ACTIONS_DIR, { recursive: true });
    mock = await startMockLlmServer();
    bridgeReady = false;
    stdout = '';
    stderr = '';
  });

  afterEach(async () => {
    await stopChild();
    if (mock !== undefined) await mock.close();
  });

  async function boot(): Promise<{ chatId: string }> {
    const bin = dshBin;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    const server = mock;
    if (server === undefined) throw new Error('mock LLM server unavailable');
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
    const chatId = `oc_tp_${Date.now()}`;
    await pinWorkingDir(chatId);
    return { chatId };
  }

  it('a NEW-file write shows a Produced chip and a chip tap sends the file', async () => {
    // Script the agent to CREATE a file with `write`. `before === null`, so the
    // `tool/result` `meta.diffs` is EMPTY — the path comes from the correlated
    // `tool/call` `file_path` (the create parity path).
    mock?.setScripts([
      [
        {
          toolCall: {
            index: 0,
            id: 'call-write-1',
            name: 'write',
            arguments: '{"file_path":"report.txt","content":"the report body\\n"}',
          },
        },
      ],
      [{ content: 'Done — I wrote the report.' }],
    ]);
    const { chatId } = await boot();
    sendMessage(chatId, 'write the report');

    // Turn completes: green final card patch.
    try {
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}\n--- outbox ---\n${JSON.stringify(readOutbox())}`,
      );
    }

    // The final card lists the produced file as a chip — the basename label.
    const finalCard = readOutbox()
      .filter((r) => r.kind === 'patch')
      .at(-1)?.card;
    expect(
      finalCard?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content === '**📎 Produced**',
      ),
    ).toBe(true);
    const chip = finalCard?.elements.some(
      (el) =>
        el.tag === 'action' &&
        'actions' in el &&
        (el.actions as unknown[]).some(
          (a) =>
            Object.hasOwn(a as object, 'text') &&
            (a as { text: { tag: string; content: string } }).text.content === 'report.txt' &&
            (a as { value?: { kind?: string; path?: string } }).value?.kind === 'send-produced' &&
            (a as { value?: { path?: string } }).value?.path === 'report.txt',
        ),
    );
    expect(chip).toBe(true);

    // Tap the chip -> the file is sent to the chat (cwd-relative resolved).
    writeAction({
      messageId: 'mem-1',
      chatId,
      operatorOpenId: 'ou_mock',
      value: { kind: 'send-produced', path: 'report.txt' },
    });
    await waitFor(
      'the outbound file message',
      () => readOutbox().some((r) => r.kind === 'file' && r.chatId === chatId),
      60_000,
    );
  }, 150_000);

  it('a chip tap on an image path sends a native image message', async () => {
    mock?.setScripts([
      [
        {
          toolCall: {
            index: 0,
            id: 'call-write-2',
            name: 'write',
            arguments: '{"file_path":"plot.png","content":"not-a-real-png-body"}',
          },
        },
      ],
      [{ content: 'Done — I made the plot.' }],
    ]);
    const { chatId } = await boot();
    sendMessage(chatId, 'make the plot');
    try {
      await waitFor(
        'the green final card patch',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}\n--- outbox ---\n${JSON.stringify(readOutbox())}`,
      );
    }

    // The final card shows the chip (image filename).
    const finalCard = readOutbox()
      .filter((r) => r.kind === 'patch')
      .at(-1)?.card;
    expect(
      finalCard?.elements.some(
        (el) =>
          el.tag === 'action' &&
          'actions' in el &&
          (el.actions as unknown[]).some(
            (a) =>
              (a as { text?: { content?: string } }).text?.content === 'plot.png' &&
              (a as { value?: { kind?: string } }).value?.kind === 'send-produced',
          ),
      ),
    ).toBe(true);

    // Tap the chip -> the image is sent (isImagePath('plot.png') is true).
    writeAction({
      messageId: 'mem-1',
      chatId,
      operatorOpenId: 'ou_mock',
      value: { kind: 'send-produced', path: 'plot.png' },
    });
    try {
      await waitFor(
        'the outbound image message',
        () => readOutbox().some((r) => r.kind === 'image' && r.chatId === chatId),
        60_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}\n--- outbox ---\n${JSON.stringify(readOutbox())}`,
      );
    }
  }, 150_000);
});
