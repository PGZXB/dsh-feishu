/**
 * Scenario-focused real-composition integration tests (suite 2).
 *
 * Complements `real-composition.spec.ts` (the primary happy-path suite)
 * with edge scenarios that need the real dsh process: restart durability,
 * group mention modes, chat allowlists, the /group and /repo commands,
 * every question-card variant, proactive mentions on
 * approval/question cards, message dedup, unknown-command passthrough,
 * the stopped-turn reaction swap, and solo-group relaxation.
 *
 * The coverage matrix (scenario → test) is documented in
 * `docs/development.md` → "Integration test" → "Scenario coverage".
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryOutboxRecord } from '../../src/memory-transport.js';
import { type MockLlmServer, startMockLlmServer } from './mock-llm-server.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// A SEPARATE dsh home from the primary suite's (_dev/dsh-home): both suites
// boot real dsh processes that persist the session map + logs, and vitest
// runs test FILES in parallel — a shared home would race those writes.
const DSH_HOME =
  process.env.FEISHU_INT_SCENARIOS_DSH_HOME ?? join(REPO_ROOT, '_dev', 'dsh-home-scenarios');
const MEMORY_DIR = join(REPO_ROOT, '_dev', 'int-memory-scenarios');
const INBOX_DIR = join(MEMORY_DIR, 'inbox');
const OUTBOX_DIR = join(MEMORY_DIR, 'outbox');
const ACTIONS_DIR = join(MEMORY_DIR, 'actions');
const INT_CWD = join(REPO_ROOT, '_dev', 'int-cwd');

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
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const dshBin = resolveDshBin();
const profileReady = existsSync(join(DSH_HOME, 'profiles', 'feishu-dev', 'package.json'));
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
async function pinWorkingDir(chatId: string, mention: readonly string[] = []): Promise<void> {
  if (mention.length > 0) {
    sendGroupMessage(chatId, `/cd ${INT_CWD}`, mention);
  } else {
    sendMessage(chatId, `/cd ${INT_CWD}`);
  }
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

describe.skipIf(!integrationReady)('scenario integration (real process)', () => {
  let mock: MockLlmServer | undefined;
  let child: ChildProcess | undefined;
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

  /** Spawn the real dsh process with the memory transport and wait for the
   *  bridge to report ready. Extra env keys override the base set. */
  async function spawnBridge(overrides: Record<string, string> = {}): Promise<void> {
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
        DEEPSEEK_API_KEY: 'mock_key',
        DEEPSEEK_BASE_URL: server.url,
        ...overrides,
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
  }

  /** Wait for the running child to exit (used by the restart test). */
  async function waitForChildExit(process: ChildProcess): Promise<void> {
    if (process.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** The chat's session id from the persisted session map. */
  function sessionIdOf(chatId: string): string {
    const map = JSON.parse(
      readFileSync(join(DSH_HOME, 'feishu', 'session-map.json'), 'utf8') as string,
    ) as { entries: Record<string, string> };
    const sessionId = map.entries[chatId];
    if (sessionId === undefined) throw new Error(`session map missing entry for ${chatId}`);
    return sessionId;
  }

  /** Fail a test with the child's captured logs attached. */
  function failWithLogs(error: unknown): never {
    const tail = readOutbox()
      .slice(-8)
      .map((r) => {
        const card = r.card;
        const title = card?.header?.title?.content ?? '';
        const tpl = card?.header?.template ?? '';
        const text = (r.text ?? '').slice(0, 80);
        const mds = (card?.elements ?? [])
          .filter((el): el is { tag: 'markdown'; content: string } => el.tag === 'markdown')
          .map((el) => el.content.slice(0, 80));
        return `${r.seq} ${r.kind} [${title}|${tpl}] ${text} ${mds.join(' ⏹ ')}`;
      })
      .join('\n');
    throw new Error(
      `${String(error)}\n--- completions: ${mock?.completionRequests() ?? 'n/a'}\n--- outbox tail ---\n${tail}\n--- dsh stderr ---\n${stderr}\n--- dsh stdout ---\n${stdout}`,
    );
  }

  // ----------------------------------------------------------------------
  // Sessions & durability
  // ----------------------------------------------------------------------

  it('restart resumes the same session; /export spans the restart', async () => {
    try {
      mock?.setScripts([[{ content: 'First answer.' }]]);
      await spawnBridge();
      const chatId = `oc_restart_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'first message');
      await waitFor(
        'the first green card',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('First answer.'),
          ),
        90_000,
      );
      const sessionBefore = sessionIdOf(chatId);
      // Kill the daemon and start a fresh process against the same DSH_HOME.
      const first = child;
      if (first === undefined) throw new Error('child not spawned');
      first.kill('SIGTERM');
      await waitForChildExit(first);
      bridgeReady = false;
      child = undefined;

      mock?.setScripts([[{ content: 'Second answer.' }]]);
      await spawnBridge();
      // The same chat continues the SAME session after the restart.
      sendMessage(chatId, 'second message');
      await waitFor(
        'the second green card after restart',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Second answer.'),
          ),
        90_000,
      );
      expect(sessionIdOf(chatId)).toBe(sessionBefore);
      // The persisted session log survives the restart too: /export after
      // the restart ships a transcript containing BOTH turns (proves the
      // resumed session continued the same log, not a fresh one).
      sendMessage(chatId, '/export');
      await waitFor(
        'the file outbox record after restart',
        () => readOutbox().some((r) => r.kind === 'file'),
        60_000,
      );
      const file = [...readOutbox()].reverse().find((r) => r.kind === 'file');
      const transcript = file?.content ?? '';
      expect(transcript).toContain('first message');
      expect(transcript).toContain('First answer.');
      expect(transcript).toContain('second message');
      expect(transcript).toContain('Second answer.');
    } catch (error) {
      failWithLogs(error);
    }
  }, 240_000);

  it('a stop button on a pre-restart card explains there is no live session', async () => {
    try {
      mock?.setScripts([[{ content: 'Pre-restart answer.' }]]);
      await spawnBridge();
      const chatId = `oc_stale_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'before the restart');
      await waitFor(
        'the green card',
        () => readOutbox().some((r) => r.kind === 'patch' && r.card?.header?.template === 'green'),
        90_000,
      );

      // Kill the daemon and start a fresh process (the session map is
      // durable, but no agent is live until a message resumes it).
      const first = child;
      if (first === undefined) throw new Error('child not spawned');
      first.kill('SIGTERM');
      await waitForChildExit(first);
      bridgeReady = false;
      child = undefined;
      await spawnBridge();

      // Tapping Stop on the OLD card must explain the stale state instead
      // of silently ignoring the tap (user-facing staleness, not a no-op).
      writeAction({
        messageId: 'mem-stale-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'stop' },
      });
      await waitFor(
        'the no-live-session stop notice',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.text?.includes('No active session to stop'),
          ),
        30_000,
      );
      // The chat still works after the stale tap: a fresh message resumes
      // the durable session (session durability itself is covered by the
      // restart test above).
      sendMessage(chatId, 'after the restart');
      await waitFor(
        'a new card after the restart',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'card' &&
              r.chatId === chatId &&
              r.card?.header?.title.content === 'after the restart',
          ),
        90_000,
      );
      sendMessage(chatId, '/status');
      await waitFor(
        'the /status reply after restart',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.chatId === chatId && r.text?.includes(`chat: ${chatId}`),
          ),
        30_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 240_000);

  it('/status is read-only and answers while a turn is running', async () => {
    try {
      mock?.holdNextResponse();
      await spawnBridge();
      const chatId = `oc_status_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'start a held turn');
      await waitFor(
        'the working streaming card',
        () => readOutbox().some((r) => r.kind === 'card'),
        30_000,
      );
      sendMessage(chatId, '/status');
      await waitFor(
        'the status text while working',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.text?.includes('session:') && r.text?.includes('chat:'),
          ),
        30_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 120_000);

  it('bare /repo posts the project picker card', async () => {
    try {
      await spawnBridge();
      const chatId = `oc_repo_${Date.now()}`;
      sendMessage(chatId, '/repo');
      await waitFor(
        'the repo picker card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => r.card?.header?.title.content === '📚 Pick a project'),
        30_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 120_000);

  it('/group creates a group chat; an @-mention there runs a turn', async () => {
    try {
      mock?.setScripts([[{ content: 'Group turn answer.' }]]);
      await spawnBridge({ FEISHU_MOCK_BOT_OPEN_ID: 'ou_bot' });
      const chatId = `oc_groupcreate_${Date.now()}`;
      sendMessage(chatId, '/group my new group');
      await waitFor(
        'the group-created text',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.text?.includes('Group created: my new group'),
          ),
        30_000,
      );
      const groupChatId = `oc_group_mynewgroup`;
      await pinWorkingDir(groupChatId, ['ou_bot']);
      sendGroupMessage(groupChatId, 'work in the new group', ['ou_bot']);
      await waitFor(
        'the green group card',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Group turn answer.'),
          ),
        90_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('/feishu-status posts the diagnostic card', async () => {
    try {
      await spawnBridge();
      const chatId = `oc_status_card_${Date.now()}`;
      sendMessage(chatId, '/feishu-status');
      await waitFor(
        'the status diagnostic card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => r.card?.header?.title.content === '📊 dsh-feishu status'),
        30_000,
      );
      const card = [...readOutbox()]
        .reverse()
        .find(
          (r) => r.kind === 'card' && r.card?.header?.title.content === '📊 dsh-feishu status',
        )?.card;
      const markdown = card?.elements.find((el) => el.tag === 'markdown');
      const content = markdown && 'content' in markdown ? markdown.content : '';
      expect(content).toContain('**app:** `cli_mock_app`');
      expect(content).toContain('memory (test transport)');
      expect(content).toContain('**sessions:**');
    } catch (error) {
      failWithLogs(error);
    }
  }, 120_000);

  // ----------------------------------------------------------------------
  // Group mention modes & allowlists (env-config seams)
  // ----------------------------------------------------------------------

  it('groupMentionMode=never answers un-@ group messages', async () => {
    try {
      mock?.setScripts([[{ content: 'Never-mode answer.' }]]);
      await spawnBridge({ FEISHU_GROUP_MENTION_MODE: 'never' });
      const chatId = `oc_never_${Date.now()}`;
      await pinWorkingDir(chatId, []);
      sendGroupMessage(chatId, 'no mention needed', []);
      await waitFor(
        'the green card for the un-@ message',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Never-mode answer.'),
          ),
        90_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('groupMentionMode=ambient yields on redirects, answers plain messages', async () => {
    try {
      mock?.setScripts([[{ content: 'Ambient answer.' }]]);
      await spawnBridge({
        FEISHU_GROUP_MENTION_MODE: 'ambient',
        FEISHU_MOCK_BOT_OPEN_ID: 'ou_bot',
      });
      const chatId = `oc_ambient_${Date.now()}`;
      await pinWorkingDir(chatId, ['ou_bot']);
      // A message redirecting to another member (without @ing the bot) is
      // ignored: no LLM request, no card.
      const completionsBefore = mock?.completionRequests() ?? 0;
      sendGroupMessage(chatId, 'hey @alice what do you think', ['ou_alice']);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(mock?.completionRequests() ?? 0).toBe(completionsBefore);
      // A plain un-@ message is answered.
      sendGroupMessage(chatId, 'plain message please', []);
      await waitFor(
        'the green card for the plain message',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Ambient answer.'),
          ),
        90_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('groupMentionMode=topic behaves like always: un-@ ignored, @ answered', async () => {
    try {
      mock?.setScripts([[{ content: 'Topic answer.' }]]);
      await spawnBridge({ FEISHU_GROUP_MENTION_MODE: 'topic', FEISHU_MOCK_BOT_OPEN_ID: 'ou_bot' });
      const chatId = `oc_topic_${Date.now()}`;
      await pinWorkingDir(chatId, ['ou_bot']);
      const completionsBefore = mock?.completionRequests() ?? 0;
      sendGroupMessage(chatId, 'unmentioned message', []);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(mock?.completionRequests() ?? 0).toBe(completionsBefore);
      sendGroupMessage(chatId, 'mentioned message', ['ou_bot']);
      await waitFor(
        'the green card for the @ message',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Topic answer.'),
          ),
        90_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('allowedChats env: only the listed chat is served', async () => {
    try {
      mock?.setScripts([[{ content: 'Allowed-chat answer.' }]]);
      const allowedChatId = 'oc_int_allowlist';
      await spawnBridge({ FEISHU_ALLOWED_CHATS: allowedChatId });
      // An unlisted (dynamic) chat is ignored entirely.
      const strangerChat = `oc_stranger_${Date.now()}`;
      const completionsBefore = mock?.completionRequests() ?? 0;
      sendMessage(strangerChat, 'should be ignored');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(mock?.completionRequests() ?? 0).toBe(completionsBefore);
      expect(readOutbox().some((r) => r.kind === 'reaction')).toBe(false);
      // The listed chat is served.
      await pinWorkingDir(allowedChatId);
      sendMessage(allowedChatId, 'serve me');
      await waitFor(
        'the green card in the allowed chat',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Allowed-chat answer.'),
          ),
        90_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('solo-group relaxation: un-@ accepted when the group is 1u/1b', async () => {
    try {
      mock?.setScripts([[{ content: 'Solo group answer.' }]]);
      await spawnBridge({
        FEISHU_MOCK_BOT_OPEN_ID: 'ou_bot',
        FEISHU_MOCK_CHAT_STATS: '1u,1b',
      });
      const chatId = `oc_solo_${Date.now()}`;
      await pinWorkingDir(chatId, ['ou_bot']);
      // With one human + the bot, the 'always' gate relaxes: no @ needed.
      sendGroupMessage(chatId, 'we are alone here', []);
      await waitFor(
        'the green card via solo relaxation',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Solo group answer.'),
          ),
        90_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  // ----------------------------------------------------------------------
  // Question-card variants
  // ----------------------------------------------------------------------

  /** Wait for the newest question card and return its message id + card. */
  async function waitForQuestionCard(
    title: string,
  ): Promise<{ messageId: string; card: NonNullable<MemoryOutboxRecord['card']> }> {
    await waitFor(
      'the question card',
      () =>
        readOutbox()
          .filter((r) => r.kind === 'card')
          .some((r) => r.card?.header?.title.content === title),
      60_000,
    );
    const record = [...readOutbox()]
      .reverse()
      .find((r) => r.kind === 'card' && r.card?.header?.title.content === title);
    if (record?.card === undefined || record.messageId === undefined) {
      throw new Error('question card record missing');
    }
    return { messageId: record.messageId, card: record.card };
  }

  it('multi-select question: toggles + Submit settle the answer', async () => {
    try {
      mock?.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-multi-1',
              name: 'ask_user_question',
              arguments:
                '{"questions":[{"id":"m1","question":"Pick any","multi_select":true,"options":[{"label":"A"},{"label":"B"},{"label":"C"}]}]}',
            },
          },
        ],
        [{ content: 'Multi answered.' }],
      ]);
      await spawnBridge();
      const chatId = `oc_multi_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'ask a multi question');
      const { messageId: cardId } = await waitForQuestionCard('❓ Question');
      // Toggle A then B; each tap re-posts the card with checkmarks.
      writeAction({
        messageId: cardId,
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'question-toggle', id: 'm1', option: 'A' },
      });
      await waitFor(
        'the re-posted card with ✅ A',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => JSON.stringify(r.card?.elements).includes('✅ A')),
        30_000,
      );
      writeAction({
        messageId: cardId,
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'question-toggle', id: 'm1', option: 'B' },
      });
      await waitFor(
        'the re-posted card with ✅ B',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => JSON.stringify(r.card?.elements).includes('✅ B')),
        30_000,
      );
      // The toggle re-posts RETARGET the interaction to the newest card —
      // the Submit must use the newest question card's message id (the
      // original card id is stale by now).
      const newestQuestion = [...readOutbox()]
        .reverse()
        .find((r) => r.kind === 'card' && r.card?.header?.title.content === '❓ Question');
      writeAction({
        messageId: newestQuestion?.messageId ?? cardId,
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'question-submit', id: 'm1' },
      });
      await waitFor(
        'the green card after the multi answer',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Multi answered.'),
          ),
        90_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('free-text question: the next chat message is the answer', async () => {
    try {
      mock?.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-free-1',
              name: 'ask_user_question',
              arguments: '{"questions":[{"id":"f1","question":"What color?","options":[]}]}',
            },
          },
        ],
        [{ content: 'Free answered.' }],
      ]);
      await spawnBridge();
      const chatId = `oc_free_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'ask a free-text question');
      await waitForQuestionCard('❓ Question');
      // The reply is captured as the answer (not a new turn).
      sendMessage(chatId, 'blue');
      await waitFor(
        'the green card after the free answer',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Free answered.'),
          ),
        90_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('question Cancel settles empty answers and the turn continues', async () => {
    try {
      mock?.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-cancel-1',
              name: 'ask_user_question',
              arguments:
                '{"questions":[{"id":"c1","question":"Do it?","options":[{"label":"Yes"},{"label":"No"}]}]}',
            },
          },
        ],
        [{ content: 'Cancelled flow answered.' }],
      ]);
      await spawnBridge();
      const chatId = `oc_qcancel_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'ask then cancel');
      const { messageId: cardId } = await waitForQuestionCard('❓ Question');
      writeAction({
        messageId: cardId,
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'question-cancel', id: 'c1' },
      });
      await waitFor(
        'the green card after the cancel',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Cancelled flow answered.'),
          ),
        90_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  // ----------------------------------------------------------------------
  // Proactive mentions on interaction cards
  // ----------------------------------------------------------------------

  it('group approval card @s the requester; p2p approval does not', async () => {
    try {
      mock?.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-ga-1',
              name: 'bash',
              arguments:
                '{"command":"echo group-approval","description":"group approval","sandbox_permissions":"danger-full-access","justification":"group mention check"}',
            },
          },
        ],
        [{ content: 'Group approval done.' }],
      ]);
      await spawnBridge({ FEISHU_MOCK_BOT_OPEN_ID: 'ou_bot' });
      const chatId = `oc_gappr_${Date.now()}`;
      await pinWorkingDir(chatId, ['ou_bot']);
      sendGroupMessage(chatId, 'approve this', ['ou_bot']);
      await waitFor(
        'the group approval card with the @-mention',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => {
              if (r.card?.header?.title.content !== '🔐 Approval needed') return false;
              const markdown = r.card.elements.find((el) => el.tag === 'markdown');
              const content = markdown && 'content' in markdown ? markdown.content : '';
              return content.includes('<at id="ou_mock"></at>');
            }),
        60_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('group question card @s the requester; p2p question does not', async () => {
    try {
      mock?.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-gq-1',
              name: 'ask_user_question',
              arguments:
                '{"questions":[{"id":"g1","question":"Which?","options":[{"label":"Go"}]}]}',
            },
          },
        ],
        [{ content: 'Group question done.' }],
        [
          {
            toolCall: {
              index: 0,
              id: 'call-pq-1',
              name: 'ask_user_question',
              arguments:
                '{"questions":[{"id":"p1","question":"Which p2p?","options":[{"label":"A"}]}]}',
            },
          },
        ],
        [{ content: 'P2P question done.' }],
      ]);
      await spawnBridge({ FEISHU_MOCK_BOT_OPEN_ID: 'ou_bot' });
      const groupChat = `oc_gq_${Date.now()}`;
      await pinWorkingDir(groupChat, ['ou_bot']);
      sendGroupMessage(groupChat, 'ask in group', ['ou_bot']);
      await waitFor(
        'the group question card with the @-mention',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some((r) => {
              if (r.card?.header?.title.content !== '❓ Question') return false;
              const markdown = r.card.elements.find((el) => el.tag === 'markdown');
              const content = markdown && 'content' in markdown ? markdown.content : '';
              return content.includes('<at id="ou_mock"></at>');
            }),
        60_000,
      );

      // A p2p question card carries NO mention — filter by chat id so the
      // group card above never satisfies this wait.
      const p2pChat = `oc_p2pq_${Date.now()}`;
      await pinWorkingDir(p2pChat);
      sendMessage(p2pChat, 'ask in p2p');
      await waitFor(
        'the p2p question card',
        () =>
          readOutbox()
            .filter((r) => r.kind === 'card')
            .some(
              (r) =>
                r.chatId === p2pChat &&
                r.card?.header?.title.content === '❓ Question' &&
                JSON.stringify(r.card.elements).includes('Which p2p?'),
            ),
        60_000,
      );
      const p2pCard = [...readOutbox()]
        .reverse()
        .find(
          (r) =>
            r.kind === 'card' &&
            r.chatId === p2pChat &&
            r.card?.header?.title.content === '❓ Question' &&
            JSON.stringify(r.card.elements).includes('Which p2p?'),
        )?.card;
      expect(JSON.stringify(p2pCard?.elements)).not.toContain('<at id=');
    } catch (error) {
      failWithLogs(error);
    }
  }, 240_000);

  /** dsh-schedule end to end: the agent creates an `every` (turn 1) and an
   *  `after` (turn 2) reminder in chat; the `after` fires ~2s later and its
   *  turn renders as a fresh '⏰ Reminder' card; /schedule lists the
   *  still-active `every`. The first-turn scripts are duplicated because the
   *  per-session title-generation completion consumes one script at an
   *  unpredictable point — the duplicated tool calls guarantee the creates. */
  it('schedule reminders: agent-created, fires to a Reminder card, /schedule lists', async () => {
    try {
      mock?.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-sched-every-1',
              name: 'schedule_create',
              arguments: '{"prompt":"status ping","every_seconds":300}',
            },
          },
        ],
        [
          {
            toolCall: {
              index: 0,
              id: 'call-sched-every-2',
              name: 'schedule_create',
              arguments: '{"prompt":"status ping","every_seconds":300}',
            },
          },
        ],
        [{ content: 'Recurring set.' }],
        [
          {
            toolCall: {
              index: 0,
              id: 'call-sched-after-1',
              name: 'schedule_create',
              arguments: '{"prompt":"quick check","after_seconds":2}',
            },
          },
        ],
        [{ content: 'Quick set.' }],
        [{ content: 'Reminder fired answer.' }],
      ]);
      await spawnBridge();
      const chatId = `oc_sched_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'set up a recurring reminder');
      await waitFor(
        'the recurring-reminder green card',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Recurring set.'),
          ),
        90_000,
      );
      sendMessage(chatId, 'and a quick one');
      await waitFor(
        'the quick-reminder green card',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Quick set.'),
          ),
        90_000,
      );
      // The after reminder fires and the agent's response streams into a
      // fresh '⏰ Reminder' card (agent-initiated turn rendering).
      await waitFor(
        'the Reminder card with the fired answer',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.title.content === '⏰ Reminder' &&
              JSON.stringify(r.card.elements).includes('Reminder fired answer.'),
          ),
        60_000,
      );
      // /schedule lists the still-active recurring reminder.
      sendMessage(chatId, '/schedule');
      await waitFor(
        'the schedule listing text',
        () =>
          readOutbox().some(
            (r) => r.kind === 'text' && r.text?.includes('every 300s · status ping (scheduled)'),
          ),
        30_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 240_000);

  // ----------------------------------------------------------------------
  // Robustness
  // ----------------------------------------------------------------------

  it('message dedup: a redelivered message id runs only once', async () => {
    try {
      mock?.setScripts([[{ content: 'Dedup answer.' }]]);
      await spawnBridge();
      const chatId = `oc_dedup_${Date.now()}`;
      await pinWorkingDir(chatId);
      const messageId = `om-dedup-${Date.now()}`;
      const body = JSON.stringify({
        messageId,
        chatId,
        chatType: 'p2p',
        senderOpenId: 'ou_mock',
        text: 'deliver me twice',
        createdAt: Date.now(),
      });
      writeFileSync(join(INBOX_DIR, `${messageId}.json`), body, 'utf8');
      await waitFor(
        'the received reaction for the message',
        () =>
          readOutbox().some(
            (r) => r.kind === 'reaction' && r.messageId === messageId && r.action === 'add',
          ),
        60_000,
      );
      // Redeliver the SAME message id: the bridge must ignore the duplicate.
      writeFileSync(join(INBOX_DIR, `${messageId}.json`), body, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      // Only the RECEIVED reaction counts as a delivery (the terminal DONE
      // swap also matches action 'add', so filter on the emoji).
      const receivedReactions = readOutbox().filter(
        (r) =>
          r.kind === 'reaction' &&
          r.messageId === messageId &&
          r.action === 'add' &&
          r.emojiType === 'GoGoGo',
      );
      expect(receivedReactions).toHaveLength(1);
      expect(readOutbox().filter((r) => r.kind === 'card')).toHaveLength(1);
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('unknownCommand=passthrough delivers an unknown slash line to the model', async () => {
    try {
      mock?.setScripts([[{ content: 'Passthrough answer.' }]]);
      await spawnBridge({ FEISHU_UNKNOWN_COMMAND: 'passthrough' });
      const chatId = `oc_passthru_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, '/frobnicate the widgets');
      await waitFor(
        'the green card for the passthrough turn',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Passthrough answer.'),
          ),
        90_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('stop mid-turn swaps the received reaction to the stopped emoji', async () => {
    try {
      mock?.holdNextResponse();
      await spawnBridge();
      const chatId = `oc_stopreact_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'start then stop');
      await waitFor(
        'the working streaming card',
        () => readOutbox().some((r) => r.kind === 'card'),
        30_000,
      );
      writeAction({
        messageId: 'mem-1',
        chatId,
        operatorOpenId: 'ou_mock',
        value: { kind: 'stop' },
      });
      // The aborted turn settles the card orange; the pending reaction is
      // swapped (remove + add WARN). The aborted loop may race, so wait for
      // the swap rather than asserting timing.
      await waitFor(
        'the stopped reaction swap',
        () => {
          const records = readOutbox().filter((r) => r.kind === 'reaction');
          return (
            records.some((r) => r.action === 'add' && r.emojiType === 'WARN') &&
            records.some((r) => r.action === 'remove')
          );
        },
        60_000,
      );
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);

  it('/export after a tool-calling turn includes tool rows in the transcript', async () => {
    try {
      mock?.setScripts([
        [
          {
            toolCall: {
              index: 0,
              id: 'call-export-tool-1',
              name: 'bash',
              arguments: '{"command":"echo tool-output","description":"export check"}',
            },
          },
        ],
        [{ content: 'Tool transcript answer.' }],
      ]);
      await spawnBridge();
      const chatId = `oc_exp_tool_${Date.now()}`;
      await pinWorkingDir(chatId);
      sendMessage(chatId, 'run a tool turn');
      await waitFor(
        'the green card after the tool turn',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'patch' &&
              r.card?.header?.template === 'green' &&
              JSON.stringify(r.card.elements).includes('Tool transcript answer.'),
          ),
        90_000,
      );
      sendMessage(chatId, '/export');
      await waitFor(
        'the file outbox record',
        () => readOutbox().some((r) => r.kind === 'file'),
        60_000,
      );
      const file = [...readOutbox()].reverse().find((r) => r.kind === 'file');
      const transcript = file?.content ?? '';
      expect(transcript).toContain('## tool');
      expect(transcript).toContain('echo tool-output');
      expect(transcript).toContain('Tool transcript answer.');
      expect(file?.fileName).toContain('session-');
    } catch (error) {
      failWithLogs(error);
    }
  }, 180_000);
});
