/**
 * Real-composition integration tests for agent-preset-selection: a real dsh
 * process booted from a real profile (Feishu mocked via the file-channel
 * memory transport, LLM via the local mock server).
 *
 * NOTE on scope: the `agentPresets` roster service (`ctx.get('agentPresets')`)
 * is NOT mounted by the bundled dsh CLI (verified against the installed
 * @deepseek-ai types in dsh-agent/dsh-session — the `agentPreset` field is
 * present on sessions, but no roster `list()` service exists yet). So a real
 * dsh process exercises the DEGRADED path: no Mode dropdown and `--preset` is
 * accepted-but-not-applied. The binding and Mode-dropdown behavior against a
 * PRESENT roster is covered by the unit tests (a fake roster service); this
 * suite verifies the real-process degradation and that the working-directory
 * flow is unchanged.
 *
 * It self-skips without a prepared profile + build + dsh CLI; CI runs it with
 * `FEISHU_INT_REQUIRED=1` so a missing prerequisite there is a hard failure.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryOutboxRecord } from '../../src/memory-transport.js';
import { type MockLlmServer, startMockLlmServer } from './mock-llm-server.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Each integration suite gets its OWN dsh home (parallel suites must not share
// `session-map.json`). `FEISHU_INT_AGENT_PRESET_DSH_HOME` overrides.
const DSH_HOME =
  process.env.FEISHU_INT_AGENT_PRESET_DSH_HOME ??
  join(REPO_ROOT, '_dev', 'dsh-home-agent-preset-selection');
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'feishu-dev');
const MEMORY_DIR = join(REPO_ROOT, '_dev', 'int-agent-preset-memory');
const INBOX_DIR = join(MEMORY_DIR, 'inbox');
const OUTBOX_DIR = join(MEMORY_DIR, 'outbox');
const ACTIONS_DIR = join(MEMORY_DIR, 'actions');
/** Scratch working directory pinned via /cd or a repo pick. */
const INT_CWD = join(REPO_ROOT, '_dev', 'int-agent-preset-cwd');
/** A git-marked directory the `/repo <path>` picker scans. */
const INT_REPO = join(REPO_ROOT, '_dev', 'int-agent-preset-repo');

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
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
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
      `(dsh CLI=${dshBin !== undefined} profile=${profileReady} built=${built}); ` +
      'see docs/development.md → "Integration test"',
  );
}

/** Drop one inbound message into the message channel. */
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

/** Write one card action into the actions channel for the spawned process. */
function writeAction(chatId: string, value: Record<string, string>, option: string): void {
  writeFileSync(
    join(ACTIONS_DIR, `act-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    JSON.stringify({
      messageId: `panel-${Date.now()}`,
      chatId,
      operatorOpenId: 'ou_mock',
      value,
      option,
    }),
    'utf8',
  );
}

/** The card records in the outbox (a `card` or a `patch` carries a card). */
function outboxCards(): { readonly chatId?: string; readonly card?: MemoryOutboxRecord['card'] }[] {
  return readOutbox().filter((r) => r.card !== undefined);
}

/** Make a git-marked repo (bare `.git/` dirs are skipped by the scanner). */
function makeGitRepo(dir: string): void {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

describe.skipIf(!integrationReady)('integration > agent-preset-selection', () => {
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
    mkdirSync(INT_CWD, { recursive: true });
    // `/repo <root>` scans the root's CHILDREN for projects, so seed a child
    // git repo (a bare `.git/` on the root itself is not listed).
    mkdirSync(join(INT_REPO, 'demo'), { recursive: true });
    makeGitRepo(join(INT_REPO, 'demo'));
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

  async function boot(): Promise<string> {
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
      return `oc_int_preset_${Date.now()}`;
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
      );
    }
  }

  it('roster absent: the /repo picker renders NO Mode dropdown (flow unchanged)', async () => {
    const chatId = await boot();
    sendMessage(chatId, `/repo ${INT_REPO}`);
    await waitFor(
      'the populated project picker card',
      () =>
        outboxCards().some(
          (r) =>
            r.card?.header?.title.content === '📚 Pick a project' &&
            r.card?.elements.some(
              (el) =>
                el.tag === 'action' &&
                'actions' in el &&
                el.actions.some((a) => a.tag === 'select_static'),
            ),
        ),
      30_000,
    );
    // The async picker posts a ⏳ Loading… card first, then the real card; use
    // the LAST one (the real content).
    const picker = [...outboxCards()]
      .reverse()
      .find((r) => r.card?.header?.title.content === '📚 Pick a project');
    const selects =
      picker?.card?.elements.flatMap((el) =>
        el.tag === 'action' && 'actions' in el
          ? el.actions.filter((a) => a.tag === 'select_static')
          : [],
      ) ?? [];
    // The bundled dsh does not mount the agentPresets roster, so the card
    // carries the project dropdown only — never a Mode/preset-pick dropdown.
    expect(selects.some((s) => s.value.kind === 'preset-pick')).toBe(false);
    expect(selects.some((s) => s.value.kind === 'repo-pick')).toBe(true);
  }, 150_000);

  it('a project pick without touching Mode sets the working directory (no preset) ', async () => {
    const chatId = await boot();
    sendMessage(chatId, `/repo ${INT_REPO}`);
    await waitFor(
      'the project picker card',
      () =>
        outboxCards().some(
          (r) => r.card?.header?.title.content === '📚 Pick a project' && r.chatId === chatId,
        ),
      30_000,
    );
    writeAction(chatId, { kind: 'repo-pick' }, INT_REPO);
    await waitFor(
      'the working-directory result card',
      () =>
        readOutbox().some(
          (r) =>
            r.card?.header?.title.content === '✅ Done' &&
            JSON.stringify(r.card?.elements).includes('Working directory set to') &&
            r.chatId === chatId,
        ),
      30_000,
    );
    // The flow is unchanged without a roster: the confirmation posts, no
    // Mode dropdown was offered, no preset was bound.
    expect(
      readOutbox().some(
        (r) =>
          r.card?.header?.title.content === '✅ Done' &&
          JSON.stringify(r.card?.elements).includes(INT_REPO),
      ),
    ).toBe(true);
  }, 150_000);

  it('a /cd of a real directory works alone (no preset) and accepts --preset harmlessly', async () => {
    const chatId = await boot();
    sendMessage(chatId, `/cd ${INT_CWD}`);
    await waitFor(
      'the /cd confirmation',
      () =>
        readOutbox().some(
          (r) =>
            r.kind === 'text' &&
            r.chatId === chatId &&
            r.text?.includes('Working directory set to'),
        ),
      30_000,
    );
    // With no roster mounted, `--preset <id>` is accepted but not applied: no
    // usage error, the cwd change proceeds, and no preset is bound.
    sendMessage(chatId, `/cd ${INT_CWD} --preset standard`);
    await waitFor(
      'the second /cd confirmation',
      () =>
        readOutbox()
          .filter((r) => r.kind === 'text' && r.chatId === chatId)
          .filter((r) => r.text?.includes('Working directory set to')).length >= 2,
      30_000,
    );
    const texts = readOutbox().filter((r) => r.kind === 'text' && r.chatId === chatId);
    expect(texts.every((r) => r.text?.includes('unknown agent preset') !== true)).toBe(true);
  }, 150_000);
});
