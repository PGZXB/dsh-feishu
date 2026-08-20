/**
 * Real-composition integration tests for inbound rich-text (`post`) and
 * `video` messages: a `post` with text starts a turn immediately carrying
 * the serialized rich text + ordered attachments; a text-less `post` and a
 * bare `video` register as pending (the inbound-wait-instruction path). A
 * real dsh process boots from the real profile with only Feishu (memory
 * transport) and the LLM API (mock server) mocked.
 *
 * The memory transport passes inbox JSON straight to the bridge (no
 * normalizeMessageEvent re-parse), so these tests feed already-normalized
 * messages (text + ordered attachments) — the transport-layer post
 * serialization is covered by unit tests (tests/transport.spec.ts,
 * tests/rich-text.spec.ts).
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
// Each integration suite uses its OWN dsh home (override per suite, e.g.
// FEISHU_INT_ATTACHMENTS_DSH_HOME): the suites run in parallel (vitest file
// parallelism) and spawn real dsh processes that share
// `_dev/dsh-home/feishu/session-map.json` — concurrent writes raced and
// silently dropped another suite's chat→session binding (CI-only flakes).
const DSH_HOME =
  process.env.FEISHU_INT_RICHTEXT_DSH_HOME ?? join(REPO_ROOT, '_dev', 'dsh-home-rich-text');
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'feishu-dev');
const MEMORY_DIR = join(REPO_ROOT, '_dev', 'int-memory-rich-text');
const INBOX_DIR = join(MEMORY_DIR, 'inbox');
const OUTBOX_DIR = join(MEMORY_DIR, 'outbox');
const ATTACH_DIR = join(REPO_ROOT, '_dev', 'int-attachments-rich-text');
const INT_CWD = join(REPO_ROOT, '_dev', 'int-cwd-rich-text');

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

/** Drop one normalized inbound message into the message channel. */
function sendMessage(
  chatId: string,
  text: string,
  attachments?: readonly { kind: 'image' | 'file'; key: string; name?: string }[],
  fixedMessageId?: string,
): void {
  const messageId = fixedMessageId ?? `om-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(
    join(INBOX_DIR, `${messageId}.json`),
    JSON.stringify({
      messageId,
      chatId,
      chatType: 'p2p',
      senderOpenId: 'ou_mock',
      text,
      ...(attachments !== undefined ? { attachments } : {}),
      mentions: [],
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

describe.skipIf(!integrationReady)('integration > inbound-rich-text', () => {
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
    const chatId = `oc_rt_${Date.now()}`;
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

  it('a rich-text post with text and ordered attachments starts a turn carrying both', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    seedAttachment('rt-img', png, 'image/png');
    seedAttachment('rt-file', new TextEncoder().encode('rich text file body\n'));
    const { chatId } = await boot();
    const dir = join(INT_CWD, '.dsh_feishu', 'attachments', 'cli_mock_app', chatId);
    // Normalized post: serialized text (order preserved) + ordered
    // attachments (image then file).
    sendMessage(
      chatId,
      '**Bold intro**\n<image 1>\n<file 2>',
      [
        { kind: 'image', key: 'rt-img' },
        { kind: 'file', key: 'rt-file', name: 'notes.txt' },
      ],
      'om-post-1',
    );
    try {
      await waitFor(
        'the agent turn to carry the serialized text and BOTH saved paths',
        () => {
          const b = agentLastBody() as { messages?: unknown[] } | undefined;
          const body = JSON.stringify(b?.messages ?? []);
          return (
            body.includes('**Bold intro**') &&
            body.includes(join(dir, 'rt-img.png')) &&
            body.includes(join(dir, 'notes.txt'))
          );
        },
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}\n--- last body ---\n${JSON.stringify(agentLastBody())}`,
      );
    }
  }, 150_000);

  it('a text-less post (attachments only) registers as pending, drained by follow-up text', async () => {
    seedAttachment('rt-a', new TextEncoder().encode('post only file\n'));
    const { chatId } = await boot();
    const dir = join(INT_CWD, '.dsh_feishu', 'attachments', 'cli_mock_app', chatId);
    sendMessage(chatId, '', [{ kind: 'file', key: 'rt-a', name: 'only.txt' }], 'om-post-2');
    // No turn yet — the file lands on disk.
    try {
      await waitFor('the pending file on disk', () => existsSync(join(dir, 'only.txt')), 30_000);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}`,
      );
    }
    expect(llmRequestCount()).toBe(0);
    // The follow-up text drains it.
    sendMessage(chatId, 'analyze it', undefined, 'om-post-2-followup');
    try {
      await waitFor(
        'the saved path in the agent turn',
        () => {
          const b = agentLastBody() as { messages?: unknown[] } | undefined;
          return JSON.stringify(b?.messages ?? []).includes(join(dir, 'only.txt'));
        },
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}\n--- last body ---\n${JSON.stringify(agentLastBody())}`,
      );
    }
  }, 150_000);

  it('a bare video message registers as pending and drains like a file', async () => {
    seedAttachment('vid-1', new TextEncoder().encode('fake video bytes\n'));
    const { chatId } = await boot();
    const dir = join(INT_CWD, '.dsh_feishu', 'attachments', 'cli_mock_app', chatId);
    sendMessage(chatId, '', [{ kind: 'file', key: 'vid-1', name: 'clip.mp4' }], 'om-vid-1');
    try {
      await waitFor('the pending video on disk', () => existsSync(join(dir, 'clip.mp4')), 30_000);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}`,
      );
    }
    expect(llmRequestCount()).toBe(0);
    sendMessage(chatId, 'summarize this video', undefined, 'om-vid-1-followup');
    try {
      await waitFor(
        'the video path in the agent turn',
        () => {
          const b = agentLastBody() as { messages?: unknown[] } | undefined;
          return JSON.stringify(b?.messages ?? []).includes(join(dir, 'clip.mp4'));
        },
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}\n--- last body ---\n${JSON.stringify(agentLastBody())}`,
      );
    }
  }, 150_000);
});
