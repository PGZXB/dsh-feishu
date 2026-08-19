/**
 * Real-composition integration tests for inbound attachments (F1): a real
 * dsh process booted from the real profile, with only Feishu (memory
 * transport) and the LLM API (mock server) mocked. Asserts that an inbound
 * `image` message reaches the agent as an `image` content block, and an
 * inbound `file` message posts a receipt card + file-name note.
 *
 * Self-skips when the environment lacks a prepared profile or the dsh CLI,
 * like the sibling real-composition suite (see docs/development.md →
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
const DSH_HOME = process.env.FEISHU_INT_DSH_HOME ?? join(REPO_ROOT, '_dev', 'dsh-home');
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'feishu-dev');
const MEMORY_DIR = join(REPO_ROOT, '_dev', 'int-memory-attachments');
const INBOX_DIR = join(MEMORY_DIR, 'inbox');
const OUTBOX_DIR = join(MEMORY_DIR, 'outbox');
const ATTACH_DIR = join(REPO_ROOT, '_dev', 'int-attachments-seed');
const INT_CWD = join(REPO_ROOT, '_dev', 'int-cwd-attachments');

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

/** Drop one inbound message into the message channel. `attachments` is the
 *  normalized attachment list (the shape the bridge consumes). */
function sendMessage(
  chatId: string,
  text: string,
  attachments?: readonly { kind: 'image' | 'file'; key: string; name?: string }[],
): void {
  const messageId = `om-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

/** Seed downloadable bytes for an attachment key (`<key>.bin` +
 *  `<key>.mediaType`), consumed by the memory transport's download methods. */
function seedAttachment(key: string, bytes: Uint8Array, mediaType?: string): void {
  writeFileSync(join(ATTACH_DIR, `${key}.bin`), bytes);
  if (mediaType !== undefined) {
    writeFileSync(join(ATTACH_DIR, `${key}.mediaType`), mediaType, 'utf8');
  }
}

/** Pin the chat's working directory via /cd (the gate refuses turns until
 *  an explicit directory is chosen). */
async function pinWorkingDir(chatId: string): Promise<void> {
  sendMessage(chatId, `/cd ${INT_CWD}`);
  await waitFor(
    'the /cd confirmation',
    () =>
      readOutbox().some(
        (r) =>
          r.kind === 'text' && r.chatId === chatId && r.text?.includes('Working directory set to'),
      ),
    30_000,
  );
}

describe.skipIf(!integrationReady)('integration > inbound-attachments', () => {
  let mock: MockLlmServer | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stdout = '';
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
    mkdirSync(INT_CWD, { recursive: true });
    mkdirSync(INBOX_DIR, { recursive: true });
    mkdirSync(OUTBOX_DIR, { recursive: true });
    mkdirSync(ATTACH_DIR, { recursive: true });
    mock = await startMockLlmServer();
    bridgeReady = false;
    stdout = '';
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
        DEEPSEEK_API_KEY: 'mock_key',
        DEEPSEEK_BASE_URL: server.url,
        // The memory transport serves attachment bytes from
        // FEISHU_MEMORY_ATTACHMENTS (see the transport options).
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('[feishu] bridge ready')) bridgeReady = true;
    });
    child.stderr?.on('data', (_chunk: Buffer) => {});
    await waitFor('the bridge to report ready', () => bridgeReady, 30_000);
    const chatId = `oc_att_${Date.now()}`;
    await pinWorkingDir(chatId);
    return { chatId };
  }

  /** The last request body the mock LLM received (agent's view of the turn). */
  function agentLastBody(): unknown {
    return mock?.lastRequestBody();
  }

  /** The markdown content of a receipt/notice card by header title. */
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

  it('an inbound image message degrades to a file receipt under a text-only model', async () => {
    // The integration profile runs DeepSeek (text-only — the adapter rejects
    // image content with UNSUPPORTED_CONTENT). The image therefore degrades
    // to the file path: receipt card + name note, and the turn completes
    // normally instead of erroring. (Image injection into the agent is
    // covered by unit tests with an image-capable model; see
    // tests/bridge.spec.ts → "inbound attachments".)
    const { chatId } = await boot();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    seedAttachment('img-1', png, 'image/png');
    sendMessage(chatId, '', [{ kind: 'image', key: 'img-1' }]);
    await waitFor(
      'the degraded file receipt card',
      () => cardMarkdowns('📎 File received').length > 0,
      30_000,
    );
    // The turn completes normally (green card) — no UNSUPPORTED_CONTENT error.
    await waitFor(
      'the green final card patch',
      () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
      90_000,
    );
  }, 150_000);

  it('an inbound file message posts a receipt card and names the file to the agent', async () => {
    const { chatId } = await boot();
    seedAttachment('file-1', new Uint8Array([1, 2, 3]));
    sendMessage(chatId, '', [{ kind: 'file', key: 'file-1', name: 'notes.txt' }]);
    await waitFor(
      'the file receipt card',
      () => cardMarkdowns('📎 File received').length > 0,
      30_000,
    );
    // The agent's user message names the file.
    await waitFor(
      'the file name in the agent turn',
      () => {
        const b = agentLastBody() as { messages?: unknown[] } | undefined;
        return JSON.stringify(b?.messages ?? []).includes('notes.txt');
      },
      90_000,
    );
  }, 150_000);

  it('an image whose key is missing still completes the turn (no wedge)', async () => {
    // Under a text-only model the image degrades to a receipt BEFORE any
    // download, so an unknown key never blocks the turn.
    const { chatId } = await boot();
    sendMessage(chatId, '', [{ kind: 'image', key: 'missing' }]);
    // Receipt card appears (degrade path)…
    await waitFor(
      'the degraded file receipt card',
      () => cardMarkdowns('📎 File received').length > 0,
      30_000,
    );
    // …and the turn completes normally.
    await waitFor(
      'the green final card patch',
      () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
      90_000,
    );
  }, 150_000);
});
