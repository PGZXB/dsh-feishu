/**
 * Real-composition integration tests for the inbound wait-for-instruction
 * feature: attachment-only messages (file / image / video / rich-text post)
 * register as pending instead of starting a turn; the follow-up text message
 * drains the pending list into ONE turn, in order. A real dsh process boots
 * from the real profile with only Feishu (memory transport) and the LLM API
 * (mock server) mocked.
 *
 * Self-skips when the environment lacks a prepared profile or the dsh CLI,
 * like the sibling real-composition suites (see docs/development.md →
 * "Integration test").
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryOutboxRecord } from '../../src/memory-transport.js';
import { type MockLlmServer, startMockLlmServer } from './mock-llm-server.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Each integration suite uses its OWN dsh home (override per suite, e.g.
// FEISHU_INT_ATTACHMENTS_DSH_HOME): the suites run in parallel (vitest file
// parallelism) and spawn real dsh processes that share
// `_dev/dsh-home/feishu/session-map.json` — concurrent writes raced and
// silently dropped another suite's chat→session binding (CI-only flakes).
const DSH_HOME =
  process.env.FEISHU_INT_WAIT_DSH_HOME ?? join(REPO_ROOT, '_dev', 'dsh-home-wait-instruction');
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'feishu-dev');
const MEMORY_DIR = join(REPO_ROOT, '_dev', 'int-memory-wait-instruction');
const INBOX_DIR = join(MEMORY_DIR, 'inbox');
const OUTBOX_DIR = join(MEMORY_DIR, 'outbox');
const ATTACH_DIR = join(REPO_ROOT, '_dev', 'int-attachments-wait-instruction');
const INT_CWD = join(REPO_ROOT, '_dev', 'int-cwd-wait-instruction');

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
function sendMessage(
  chatId: string,
  text: string,
  attachments?: readonly { kind: 'image' | 'file'; key: string; name?: string }[],
  fixedMessageId?: string,
  chatType: 'p2p' | 'group' = 'p2p',
  mentions: readonly string[] = [],
  unsupportedType?: string,
): void {
  const messageId = fixedMessageId ?? `om-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(
    join(INBOX_DIR, `${messageId}.json`),
    JSON.stringify({
      messageId,
      chatId,
      chatType,
      senderOpenId: 'ou_mock',
      text,
      ...(attachments !== undefined ? { attachments } : {}),
      mentions,
      ...(unsupportedType !== undefined ? { unsupportedType } : {}),
      createdAt: Date.now(),
    }),
    'utf8',
  );
}

/** Seed downloadable bytes for an attachment key. */
function seedAttachment(key: string, bytes: Uint8Array, mediaType?: string): void {
  writeFileSync(join(ATTACH_DIR, `${key}.bin`), bytes);
  if (mediaType !== undefined) {
    writeFileSync(join(ATTACH_DIR, `${key}.mediaType`), mediaType, 'utf8');
  }
}

/** Pin the chat's working directory via /cd. */
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

describe.skipIf(!integrationReady)('integration > inbound-wait-instruction', () => {
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
    rmSync(ATTACH_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(join(INT_CWD, '.dsh_feishu'), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    mkdirSync(INT_CWD, { recursive: true });
    mkdirSync(INBOX_DIR, { recursive: true });
    mkdirSync(OUTBOX_DIR, { recursive: true });
    mkdirSync(ATTACH_DIR, { recursive: true });
    mock = await startMockLlmServer();
    bridgeReady = false;
    stdout = '';
    stderr = '';
  });

  afterEach(async () => {
    await stopChild();
    if (mock !== undefined) await mock.close();
  });

  /** Boot the real dsh process against the memory transport + mock LLM. */
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
        FEISHU_MEMORY_ATTACHMENTS: ATTACH_DIR,
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
    const chatId = `oc_wi_${Date.now()}`;
    await pinWorkingDir(chatId);
    return { chatId };
  }

  /** The last request body the mock LLM received (agent's view of the turn). */
  function agentLastBody(): unknown {
    return mock?.lastRequestBody();
  }

  /** How many LLM completion requests the mock server has served. */
  function llmRequestCount(): number {
    return mock?.completionRequests() ?? 0;
  }

  /** The markdown content of receipt cards by header title. */
  function cardMarkdowns(title: string): string[] {
    return readOutbox()
      .filter(
        (r) => (r.kind === 'card' || r.kind === 'patch') && r.card?.header?.title.content === title,
      )
      .flatMap((r) =>
        (r.card?.elements ?? [])
          .filter((el) => el.tag === 'markdown' && 'content' in el)
          .map((el) => (el as { readonly content: string }).content),
      );
  }

  it('a bare file message lands on disk, posts a receipt card, and does NOT start a turn', async () => {
    const content = 'pending file body\n';
    seedAttachment('pf-1', new TextEncoder().encode(content));
    const { chatId } = await boot();
    sendMessage(chatId, '', [{ kind: 'file', key: 'pf-1', name: 'pending.txt' }], 'om-pf-1');
    try {
      await waitFor('the receipt card', () => cardMarkdowns('📎 File received').length > 0, 30_000);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}`,
      );
    }
    // The file is on disk under the chat bucket.
    const savedFile = join(
      INT_CWD,
      '.dsh_feishu',
      'attachments',
      'cli_mock_app',
      chatId,
      'pending.txt',
    );
    try {
      await waitFor('the saved file on disk', () => existsSync(savedFile), 10_000);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}`,
      );
    }
    expect(readFileSync(savedFile, 'utf8')).toBe(content);
    // Give the bridge a moment: a turn must NOT have started.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(llmRequestCount()).toBe(0);
  }, 150_000);

  it('two bare files register both; one follow-up text drains both into a single turn', async () => {
    const contentA = 'file A body\n';
    const contentB = 'file B body\n';
    seedAttachment('pf-a', new TextEncoder().encode(contentA));
    seedAttachment('pf-b', new TextEncoder().encode(contentB));
    const { chatId } = await boot();
    const dir = join(INT_CWD, '.dsh_feishu', 'attachments', 'cli_mock_app', chatId);
    sendMessage(chatId, '', [{ kind: 'file', key: 'pf-a', name: 'a.txt' }], 'om-pf-a');
    sendMessage(chatId, '', [{ kind: 'file', key: 'pf-b', name: 'b.txt' }], 'om-pf-b');
    try {
      await waitFor(
        'the second receipt card',
        () => cardMarkdowns('📎 File received').length >= 2,
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}`,
      );
    }
    await waitFor(
      'both files on disk',
      () => existsSync(join(dir, 'a.txt')) && existsSync(join(dir, 'b.txt')),
      10_000,
    );
    expect(llmRequestCount()).toBe(0);
    // The follow-up text drains BOTH pending files into one turn.
    sendMessage(chatId, 'analyze these files', undefined, 'om-analyze');
    try {
      await waitFor(
        'the agent turn to carry both saved paths',
        () => {
          const b = agentLastBody() as { messages?: unknown[] } | undefined;
          const body = JSON.stringify(b?.messages ?? []);
          return body.includes(join(dir, 'a.txt')) && body.includes(join(dir, 'b.txt'));
        },
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}\n--- last body ---\n${JSON.stringify(agentLastBody())}`,
      );
    }
    // The turn completed (green final card).
    await waitFor(
      'the green final card patch',
      () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
      90_000,
    );
  }, 150_000);

  it('a bare attachment in a GROUP without a mention still registers, and the follow-up text must @ the bot', async () => {
    const content = 'group pending file\n';
    seedAttachment('pg-1', new TextEncoder().encode(content));
    const { chatId } = await boot();
    // Group bare file, NO mention: registers anyway (attachment messages
    // cannot carry a mention in Feishu — no input box).
    sendMessage(chatId, '', [{ kind: 'file', key: 'pg-1', name: 'group.txt' }], 'om-pg-1', 'group');
    try {
      await waitFor('the receipt card', () => cardMarkdowns('📎 File received').length > 0, 30_000);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}`,
      );
    }
    expect(llmRequestCount()).toBe(0);
    // Un-@ group text does NOT drain (mention gate) — the file stays pending.
    sendMessage(chatId, 'look at this', undefined, 'om-noat', 'group');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(llmRequestCount()).toBe(0);
    // @-mentioned text drains it.
    sendMessage(chatId, 'look at this', undefined, 'om-at', 'group', ['ou_bot']);
    try {
      await waitFor('the turn to start after the @ mention', () => llmRequestCount() > 0, 90_000);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}`,
      );
    }
  }, 150_000);

  it('a folder message gets a loud unsupported-type notice and no turn', async () => {
    const { chatId } = await boot();
    sendMessage(chatId, '', undefined, 'om-folder-1', 'p2p', [], 'folder');
    try {
      await waitFor(
        'the unsupported-type notice',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.chatId === chatId && r.text?.includes("can't process"),
          ),
        30_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}`,
      );
    }
    // No turn, no receipt card, nothing pending.
    expect(llmRequestCount()).toBe(0);
    expect(cardMarkdowns('📎 File received')).toHaveLength(0);
  }, 150_000);
});
