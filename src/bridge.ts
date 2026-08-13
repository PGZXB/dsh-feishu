/**
 * The surface orchestrator.
 *
 * Inbound Feishu messages are delivered into a per-chat dsh session
 * (`agent.followup`); dsh session events stream back into the chat as one
 * live streaming card per turn, and the final answer is delivered as a fresh
 * message (Feishu card patches are silent — no unread — so the answer itself
 * must notify; botmux rule).
 *
 * Core identity: DSH-native — the agent never does anything to be seen. The
 * bridge subscribes to the session event stream and renders it; there is no
 * capture and no explicit "send" contract.
 *
 * @module @dsh-feishu/dsh-feishu/bridge
 */

import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import {
  assistantText,
  buildPanelCard,
  buildRepoPickedCard,
  buildRepoPickerCard,
  buildToolDetailsCard,
  type CardSnapshot,
  type CardStatus,
  MAX_TOOL_RECORD_CHARS,
  type ToolRecord,
} from './cards/render.js';
import type { StreamingCardManager } from './cards/streaming.js';
import { CommandRegistry, type CommandResult, parseSlash } from './commands.js';
import type { CardAction, FeishuMessage, FeishuTransport } from './feishu/types.js';
import { MessageDeduplicator } from './message-dedup.js';
import { type ProjectInfo, scanMultipleProjects } from './projects.js';
import type { SessionMap } from './session-map.js';

/** Minimal logger surface the bridge needs. */
export interface BridgeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Adapts the dsh agent registry to the surface's needs (injectable for tests). */
export interface AgentStore {
  /** The live agent for a session, or `undefined`. */
  get(sessionId: string): Agent | undefined;
  /**
   * Resume an agent on a persisted session. The session map is durable, so a
   * mapped session may exist on disk without a live agent (daemon restart);
   * resuming it keeps the chat's history instead of colliding on a fresh
   * create. Throws when no persisted log exists for the id.
   */
  resume(sessionId: string): Promise<Agent>;
  /** Create an agent (and its session) for the given id and working directory. */
  create(sessionId: string, cwd: string): Promise<Agent>;
}

/** Options for {@link Bridge}. */
export interface BridgeOptions {
  readonly transport: FeishuTransport;
  readonly sessionMap: SessionMap;
  readonly agentStore: AgentStore;
  /**
   * Subscribe to the session event firehose; the listener receives every
   * event with its owning session id. Returns a disposer.
   */
  readonly onSessionEvent: (
    listener: (sessionId: string, event: SessionEvent) => void,
  ) => () => void;
  readonly cards: StreamingCardManager;
  readonly defaultCwd: string;
  readonly logger: BridgeLogger;
  /**
   * Group mention policy (botmux-compatible): `always` requires an @-mention
   * (relaxed in 1-person-1-bot solo groups); `never` answers every message;
   * `ambient` answers every message unless it redirects to another member;
   * `topic` (threads not implemented yet — currently behaves like `always`).
   * Default `always`.
   */
  readonly groupMentionMode?: 'always' | 'never' | 'ambient' | 'topic';
  /**
   * Chat allowlist: when non-empty, only these chat ids are served (anything
   * else is ignored). Empty means all chats are served.
   */
  readonly allowedChats?: readonly string[];
  /**
   * DSH slash-command passthrough: execute `line` against the chat's live
   * agent through the dsh command registry. Absent, registry commands are
   * not available (every unknown slash line falls to the unknown policy).
   */
  readonly executeCommand?: (agent: Agent, line: string) => Promise<string | undefined>;
  /**
   * Policy for an unknown slash line: `error` replies with an unknown-command
   * notice (default); `passthrough` delivers the line to the model as a
   * normal turn (cc-tui behavior).
   */
  readonly unknownCommand?: 'error' | 'passthrough';
  /**
   * Roots scanned by `/repo` (one level deep) for candidate project
   * directories. Empty means `/repo` lists nothing (use `/cd <path>`).
   */
  readonly repoRoots?: readonly string[];
}

/** One turn's card state, owned by the bridge. */
interface TurnState {
  readonly title: string;
  content: string;
  thinking: string;
  tools: ToolRecord[];
  status: CardStatus;
}

const MAX_TITLE_CHARS = 40;
/** Tool records kept for the live card + details view (newest wins). */
const MAX_TOOL_RECORDS = 30;
/** Tool lines shown on the live card (newest N; details card shows all). */
const MAX_TOOL_LINES = 6;

/** Whether a group is a 1-person-1-bot solo group (mention gate relaxation). */
function isSoloGroup(stats: { userCount: number; botCount: number }): boolean {
  return stats.userCount <= 1 && stats.botCount <= 1;
}

/**
 * Derive the card title for a turn from the user's message.
 * @param text - the inbound user message.
 * @returns a single-line title capped at {@link MAX_TITLE_CHARS}.
 */
export function turnTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= MAX_TITLE_CHARS ? oneLine : `${oneLine.slice(0, MAX_TITLE_CHARS)}…`;
}

/** Push a tool record, dropping the oldest when over the cap. */
function pushToolRecord(turn: TurnState, record: ToolRecord): void {
  turn.tools.push(record);
  if (turn.tools.length > MAX_TOOL_RECORDS) turn.tools.shift();
}

/** Flip the most recent running tool to done/error with its result text. */
function markLastToolDone(turn: TurnState, result: string, status: 'done' | 'error'): void {
  for (let i = turn.tools.length - 1; i >= 0; i -= 1) {
    const tool = turn.tools[i];
    if (tool?.status === 'running') {
      turn.tools[i] = { ...tool, status, result };
      return;
    }
  }
}

/**
 * Wires the Feishu transport to dsh sessions and back. Create one per
 * process; `dispose()` detaches the event subscription.
 */
/** Resolve and validate a user-supplied working-directory path. */
function resolveDirectory(
  input: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const resolvedPath = resolvePath(input.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  if (!existsSync(resolvedPath)) {
    return { ok: false, error: `directory does not exist: ${resolvedPath}` };
  }
  let isDir = false;
  try {
    isDir = statSync(resolvedPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { ok: false, error: `not a directory: ${resolvedPath}` };
  return { ok: true, path: resolvedPath };
}

/**
 * Scan the configured roots for candidate projects. Recursive (botmux
 * semantics: up to depth 3, skipping dot/dependency directories, budgeted),
 * so nested checkouts like `~/src/<repo>` are surfaced.
 */
async function listProjects(roots: readonly string[]): Promise<ProjectInfo[]> {
  return scanMultipleProjects(roots);
}

export class Bridge {
  private readonly dedup = new MessageDeduplicator();
  private readonly turns = new Map<string, TurnState>();
  private readonly lastPrompts = new Map<string, string>();
  private readonly lastOutputs = new Map<string, string>();
  /** Last completed turn's tool records per chat (for the 🔧 Tools button). */
  private readonly lastTools = new Map<string, readonly ToolRecord[]>();
  /** Active repo-picker card message id per chat; a pick consumes it. */
  private readonly pickerMessageIds = new Map<string, string>();
  private readonly disposeEvents: () => void;
  private readonly commands = new CommandRegistry();

  constructor(private readonly options: BridgeOptions) {
    options.transport.onMessage((message) => {
      void this.handleMessage(message).catch((error: unknown) => {
        options.logger.error(`feishu message handling failed: ${String(error)}`);
      });
    });
    options.transport.onCardAction((action) => {
      void this.handleCardAction(action).catch((error: unknown) => {
        options.logger.error(`feishu card action handling failed: ${String(error)}`);
      });
    });
    this.disposeEvents = options.onSessionEvent((sessionId, event) => {
      void this.handleEvent(sessionId, event).catch((error: unknown) => {
        options.logger.error(`session event handling failed: ${String(error)}`);
      });
    });
    this.registerCommands();
  }

  /** All surface commands (the control-panel button source). */
  commandsList(): readonly import('./commands.js').SurfaceCommand[] {
    return this.commands.list();
  }

  /** Detach the session-event subscription. */
  dispose(): void {
    this.disposeEvents();
  }

  /**
   * Deliver an inbound message: dedup, resolve/create the chat's session,
   * open the turn's streaming card, and hand the message to the agent.
   * @param message - the normalized inbound message.
   */
  async handleMessage(message: FeishuMessage): Promise<void> {
    if (!this.dedup.claim(message.messageId)) return;
    if (!(await this.shouldRespond(message))) return;
    this.options.logger.info(
      `inbound message ${message.messageId} in ${message.chatId} (${message.chatType}): ${message.text.slice(0, 80)}`,
    );
    const slash = parseSlash(message.text.trim());
    if (slash !== undefined) {
      await this.handleCommand(message, slash);
      return;
    }
    await this.deliverTurn(message);
  }

  /** Route a slash command: surface command, DSH passthrough, or unknown. */
  private async handleCommand(
    message: FeishuMessage,
    slash: { name: string; rawInput: string },
  ): Promise<void> {
    const command = this.commands.find(slash.name);
    if (command !== undefined) {
      const result = await command.handler({
        chatId: message.chatId,
        senderOpenId: message.senderOpenId,
        rawInput: slash.rawInput,
      });
      await this.replyCommandResult(message.chatId, result);
      return;
    }
    const line = `/${slash.name}${slash.rawInput}`;
    const sessionId = this.options.sessionMap.get(message.chatId);
    const agent = sessionId === undefined ? undefined : this.options.agentStore.get(sessionId);
    if (this.options.executeCommand !== undefined && agent !== undefined) {
      const text = await this.options.executeCommand(agent, line);
      if (text !== undefined) {
        await this.options.transport.sendText(message.chatId, text);
        return;
      }
    }
    if (this.options.unknownCommand === 'passthrough') {
      await this.deliverTurn(message);
      return;
    }
    await this.options.transport.sendText(
      message.chatId,
      `Unknown command ${line} — send /help to list commands.`,
    );
  }

  /** Send a command result as a text message (empty text posts no message). */
  private async replyCommandResult(chatId: string, result: CommandResult): Promise<void> {
    const text = result.kind === 'error' ? `⚠️ ${result.text}` : result.text;
    if (text !== '') await this.options.transport.sendText(chatId, text);
  }

  /** The normal turn flow: session resolution, streaming card, followup. */
  private async deliverTurn(message: FeishuMessage): Promise<void> {
    this.lastPrompts.set(message.chatId, message.text);
    const sessionId = this.options.sessionMap.ensure(message.chatId);
    const cwd = this.options.sessionMap.cwdFor(message.chatId) ?? this.options.defaultCwd;
    const agent = await this.resolveAgent(message.chatId, sessionId, cwd);
    this.turns.set(message.chatId, {
      title: turnTitle(message.text),
      content: '',
      thinking: '',
      tools: [],
      status: 'working',
    });
    // A failed card post must not block the turn: the final answer message
    // is the text fallback (patches simply no-op without an active card).
    try {
      await this.options.cards.open(message.chatId, turnTitle(message.text));
    } catch (error: unknown) {
      this.options.logger.warn(
        `streaming card unavailable, continuing text-only: ${String(error)}`,
      );
    }
    this.options.logger.info(`delivering message ${message.messageId} to agent`);
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'user' },
      }),
    );
  }

  /**
   * The group mention gate (botmux-compatible). p2p messages always pass;
   * group messages follow `groupMentionMode` plus the chat allowlist.
   * @param message - the normalized inbound message.
   * @returns whether the surface should respond to this message.
   */
  private async shouldRespond(message: FeishuMessage): Promise<boolean> {
    const allowed = this.options.allowedChats ?? [];
    if (allowed.length > 0 && !allowed.includes(message.chatId)) {
      this.options.logger.info(`ignoring message from chat ${message.chatId}: not in allowlist`);
      return false;
    }
    if (message.chatType === 'p2p') return true;
    const mode = this.options.groupMentionMode ?? 'always';
    const botOpenId = this.options.transport.getBotOpenId();
    const mentioned = botOpenId !== undefined && message.mentions.includes(botOpenId);
    switch (mode) {
      case 'never':
        return true;
      case 'ambient': {
        // Answer un-@ messages, but yield when the message redirects to
        // another specific member (person/bot) without mentioning us.
        const mentionsOther =
          botOpenId !== undefined && message.mentions.some((id) => id !== botOpenId);
        if (mentionsOther && !mentioned) {
          this.options.logger.info('ignoring group message: redirect to another member (ambient)');
          return false;
        }
        return true;
      }
      case 'topic':
      // Threads are not implemented yet; topic mode currently behaves like
      // always (a non-@ reply inside an owned thread will need the thread
      // concept to relax the gate).
      case 'always': {
        if (mentioned) return true;
        const stats = await this.options.transport.chatStats(message.chatId);
        if (stats !== undefined && isSoloGroup(stats)) {
          this.options.logger.info(
            `group message accepted via solo-group relaxation (${stats.userCount}u/${stats.botCount}b)`,
          );
          return true;
        }
        this.options.logger.info(`ignoring group message: bot not mentioned (mode ${mode})`);
        return false;
      }
      default:
        return false;
    }
  }

  /**
   * Resolve the agent for a chat: live agent first, then resume the mapped
   * persisted session, then create fresh, then — when the mapped id is
   * unusable (id collision with an on-disk log) — rebind a fresh id and
   * create. The ladder keeps the chat usable across restarts.
   * @param chatId - the Feishu chat id.
   * @param sessionId - the mapped session id.
   * @returns the agent to deliver into.
   */
  private async resolveAgent(chatId: string, sessionId: string, cwd: string): Promise<Agent> {
    const live = this.options.agentStore.get(sessionId);
    if (live !== undefined) return live;
    try {
      return await this.options.agentStore.resume(sessionId);
    } catch (resumeError: unknown) {
      this.options.logger.warn(`resume of session ${sessionId} failed: ${String(resumeError)}`);
    }
    try {
      return await this.options.agentStore.create(sessionId, cwd);
    } catch (createError: unknown) {
      this.options.logger.error(
        `session ${sessionId} unusable (${String(createError)}); rebinding a fresh session`,
      );
      const freshId = this.options.sessionMap.remint(chatId);
      return this.options.agentStore.create(freshId, cwd);
    }
  }

  /**
   * Render one session event into the owning chat's streaming card.
   * @param sessionId - the session that produced the event.
   * @param event - the session event.
   */
  async handleEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const chatId = this.options.sessionMap.chatFor(sessionId);
    if (chatId === undefined) return;
    const turn = this.turns.get(chatId);
    if (turn === undefined) return;
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk;
        if (chunk.type === 'text-delta') {
          turn.content += chunk.text;
          this.patch(chatId, turn);
        } else if (chunk.type === 'reasoning-delta') {
          turn.thinking += chunk.text;
          this.patch(chatId, turn);
        }
        break;
      }
      case 'tool/call': {
        pushToolRecord(turn, {
          name: event.data.name,
          status: 'running',
          args: event.data.arguments.slice(0, MAX_TOOL_RECORD_CHARS),
          result: '',
        });
        this.patch(chatId, turn);
        break;
      }
      case 'tool/result': {
        const resultText = assistantText(event.data.message.content[0]?.content ?? []);
        const status = event.data.error !== undefined ? 'error' : 'done';
        markLastToolDone(turn, resultText.slice(0, MAX_TOOL_RECORD_CHARS), status);
        this.patch(chatId, turn);
        break;
      }
      case 'assistant/message': {
        turn.content = assistantText(event.data.message.content);
        this.patch(chatId, turn);
        break;
      }
      case 'turn/end': {
        const status: CardStatus = event.data.reason.kind === 'error' ? 'error' : 'done';
        if (event.data.reason.kind === 'error') {
          const error = event.data.reason.error;
          this.options.logger.error(`turn failed: ${error.code}: ${error.message}`);
          // A corrupt persisted log breaks every turn that resumes it; rebind
          // the chat to a fresh session so the next message starts clean.
          if (error.message.includes('corrupt session log')) {
            this.options.logger.warn(
              `session log for chat ${chatId} is corrupt; rebinding a fresh session`,
            );
            this.options.sessionMap.remint(chatId);
          }
        } else {
          this.options.logger.info(`turn completed for chat ${chatId}`);
        }
        turn.status = status;
        this.patch(chatId, turn);
        await this.options.cards.finalize(chatId, status);
        const finalText = turn.content.trim();
        if (finalText !== '') this.lastOutputs.set(chatId, finalText);
        if (turn.tools.length > 0) this.lastTools.set(chatId, turn.tools);
        this.turns.delete(chatId);
        // The card holds the full answer and finalizes green in place; the
        // initial card send already notified, so a completed turn sends no
        // second bubble. Failures keep a notice — a broken turn must not go
        // unnoticed.
        if (status === 'error') {
          await this.options.transport.sendText(chatId, '⚠️ Turn failed — see the card for details');
        }
        break;
      }
    }
  }

  /**
   * Route one card button callback. Buttons are the surface's command
   * entry point — no slash message needed (everything-is-a-card).
   * @param action - the normalized card callback.
   */
  async handleCardAction(action: CardAction): Promise<void> {
    const kind = action.value.kind;
    this.options.logger.info(
      `card action ${kind ?? '?'} from ${action.operatorOpenId} in ${action.chatId}`,
    );
    switch (kind) {
      case 'stop': {
        const sessionId = this.options.sessionMap.get(action.chatId);
        const agent = sessionId === undefined ? undefined : this.options.agentStore.get(sessionId);
        if (agent !== undefined) {
          agent.cancel({ kind: 'user' }, { keepInbox: true });
          this.options.logger.info(`stop requested for chat ${action.chatId}`);
        }
        break;
      }
      case 'copy': {
        const output = this.lastOutputs.get(action.chatId);
        if (output !== undefined && output !== '') {
          await this.options.transport.sendText(action.chatId, output);
        }
        break;
      }
      case 'retry': {
        const prompt = this.lastPrompts.get(action.chatId);
        if (prompt !== undefined && prompt !== '') {
          const sessionId = this.options.sessionMap.ensure(action.chatId);
          const cwd = this.options.sessionMap.cwdFor(action.chatId) ?? this.options.defaultCwd;
          const agent = await this.resolveAgent(action.chatId, sessionId, cwd);
          this.turns.set(action.chatId, {
            title: turnTitle(prompt),
            content: '',
            thinking: '',
            tools: [],
            status: 'working',
          });
          try {
            await this.options.cards.open(action.chatId, turnTitle(prompt));
          } catch (error: unknown) {
            this.options.logger.warn(
              `retry card unavailable, continuing text-only: ${String(error)}`,
            );
          }
          agent.followup(
            createUserMessage({
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'user' },
            }),
          );
        }
        break;
      }
      case 'repo-pick': {
        // Dropdown selections arrive in `option`; the button fallback stamps
        // the path in `value.path`.
        const path = action.option ?? action.value.path;
        if (path === undefined || path === '') {
          await this.options.transport.sendText(action.chatId, 'Invalid project selection.');
          break;
        }
        // A pick consumes the picker: only the active picker card may select.
        if (action.messageId !== this.pickerMessageIds.get(action.chatId)) {
          this.options.logger.info(`ignoring stale repo pick from card ${action.messageId}`);
          break;
        }
        const resolved = resolveDirectory(path);
        if (!resolved.ok) {
          await this.options.transport.sendText(action.chatId, `⚠️ ${resolved.error}`);
          break;
        }
        this.options.sessionMap.setCwd(action.chatId, resolved.path);
        this.options.sessionMap.remint(action.chatId);
        await this.options.transport.sendText(
          action.chatId,
          `Working directory set to ${resolved.path} (session restarts on your next message).`,
        );
        // Disable the picker card: replace it with a static confirmation so
        // further taps do nothing (feedback: multiple selections felt off).
        this.pickerMessageIds.delete(action.chatId);
        try {
          await this.options.transport.updateCard(
            action.messageId,
            buildRepoPickedCard(resolved.path),
          );
        } catch (error: unknown) {
          this.options.logger.warn(`picker disable update failed: ${String(error)}`);
        }
        break;
      }
      case 'repo-page': {
        if (action.messageId !== this.pickerMessageIds.get(action.chatId)) {
          this.options.logger.info(`ignoring stale repo page from card ${action.messageId}`);
          break;
        }
        const page = Number(action.value.page);
        if (!Number.isInteger(page) || page < 0) break;
        const projects = await listProjects(this.options.repoRoots ?? []);
        try {
          const sent = await this.options.transport.sendCard(
            action.chatId,
            buildRepoPickerCard(projects, page),
          );
          // The page flip posts a fresh picker card — it becomes the active one.
          this.pickerMessageIds.set(action.chatId, sent.messageId);
        } catch (error: unknown) {
          this.options.logger.warn(`repo picker page refresh failed: ${String(error)}`);
        }
        break;
      }
      case 'tool-details': {
        const tools = this.lastTools.get(action.chatId) ?? [];
        const title = turnTitle(this.lastPrompts.get(action.chatId) ?? 'Tool calls');
        await this.options.transport.sendCard(action.chatId, buildToolDetailsCard(title, tools));
        break;
      }
      case 'panel': {
        const output = this.lastOutputs.get(action.chatId);
        const statusLine =
          output === undefined
            ? '**Idle** — send a message to start a turn.'
            : '**Ready** — the last answer is in the card above; copy or retry it.';
        await this.options.transport.sendCard(action.chatId, buildPanelCard(statusLine));
        break;
      }
      default: {
        this.options.logger.warn(`unknown card action kind: ${kind ?? '(missing)'}`);
      }
    }
  }

  /** Register the built-in surface commands. */
  private registerCommands(): void {
    const options = this.options;
    this.commands.register({
      name: 'help',
      description: 'List all surface commands',
      category: 'system',
      buttonLabel: '❓ Help',
      handler: () => {
        const lines = this.commands
          .list()
          .map((command) => `/${command.name} — ${command.description}`)
          .join('\n');
        return {
          kind: 'success',
          text: `dsh-feishu commands:\n${lines}\n\nOther slash lines are forwarded to dsh when they exist in its registry.`,
        };
      },
    });
    this.commands.register({
      name: 'group',
      description: 'Create a group chat with you and the bot',
      category: 'chat',
      buttonLabel: '👥 New group',
      handler: async (invocation) => {
        const name = invocation.rawInput.trim() || 'dsh-feishu';
        try {
          const { chatId } = await options.transport.createGroup(name, [invocation.senderOpenId]);
          return { kind: 'success', text: `Group created: ${name} (${chatId})` };
        } catch (error: unknown) {
          return { kind: 'error', text: `group creation failed: ${String(error)}` };
        }
      },
    });
    this.commands.register({
      name: 'cancel',
      description: 'Stop the current turn',
      category: 'session',
      buttonLabel: '⏹ Stop',
      handler: (invocation) => {
        const sessionId = options.sessionMap.get(invocation.chatId);
        const agent = sessionId === undefined ? undefined : options.agentStore.get(sessionId);
        if (agent !== undefined) {
          agent.cancel({ kind: 'user' }, { keepInbox: true });
          return { kind: 'success', text: 'Stopped.' };
        }
        return { kind: 'error', text: 'no active session to stop.' };
      },
    });
    this.commands.register({
      name: 'cd',
      description: 'Set this chat\u2019s working directory (session restarts in it)',
      category: 'session',
      buttonLabel: '📁 Change dir',
      handler: async (invocation) => {
        const target = invocation.rawInput.trim();
        if (target === '') {
          return { kind: 'error', text: 'usage: /cd <absolute-or-~ path>' };
        }
        const resolved = resolveDirectory(target);
        if (!resolved.ok) return { kind: 'error', text: resolved.error };
        this.options.sessionMap.setCwd(invocation.chatId, resolved.path);
        // A live session keeps its old cwd; rebind so the next message starts
        // a fresh session in the new directory (mirrors botmux /cd).
        this.options.sessionMap.remint(invocation.chatId);
        return {
          kind: 'success',
          text: `Working directory set to ${resolved.path} (session restarts on your next message).`,
        };
      },
    });
    this.commands.register({
      name: 'repo',
      description: 'List candidate project directories (from repoRoots)',
      category: 'session',
      buttonLabel: '📚 Pick project',
      handler: async (invocation) => {
        const roots = this.options.repoRoots ?? [];
        // Direct path selection stays supported: /repo <abs-path>.
        const raw = invocation.rawInput.trim();
        if (raw.startsWith('/') || raw.startsWith('~')) {
          const resolved = resolveDirectory(raw);
          if (!resolved.ok) return { kind: 'error', text: resolved.error };
          this.options.sessionMap.setCwd(invocation.chatId, resolved.path);
          this.options.sessionMap.remint(invocation.chatId);
          return {
            kind: 'success',
            text: `Working directory set to ${resolved.path} (session restarts on your next message).`,
          };
        }
        const projects = await listProjects(roots);
        try {
          const sent = await options.transport.sendCard(
            invocation.chatId,
            buildRepoPickerCard(projects),
          );
          // Record the active picker card so a pick can consume it (and so
          // stale callbacks from an older picker are rejected).
          this.pickerMessageIds.set(invocation.chatId, sent.messageId);
          return { kind: 'success', text: '' };
        } catch (_error: unknown) {
          if (projects.length === 0) {
            return {
              kind: 'error',
              text: 'no candidate projects found under repoRoots — use /cd <path> to set a directory, or configure repoRoots.',
            };
          }
          const lines = projects
            .slice(0, 20)
            .map((project, index) => `${index + 1}. ${project.path}`)
            .join('\n');
          return { kind: 'success', text: `Projects:\n${lines}` };
        }
      },
    });
    this.commands.register({
      name: 'status',
      description: 'Show this chat’s session status',
      category: 'system',
      buttonLabel: '📊 Status',
      handler: (invocation) => {
        const sessionId = options.sessionMap.get(invocation.chatId);
        const agent = sessionId === undefined ? undefined : options.agentStore.get(sessionId);
        const output = this.lastOutputs.get(invocation.chatId);
        const lines = [
          `chat: ${invocation.chatId}`,
          `session: ${sessionId ?? '(none yet)'}`,
          `agent: ${agent !== undefined ? 'live' : 'idle'}`,
          `last output: ${output === undefined ? '(none)' : `${output.length} chars`}`,
          `mention mode: ${options.groupMentionMode ?? 'always'}`,
        ];
        return { kind: 'success', text: lines.join('\n') };
      },
    });
  }

  /** Stage the turn's snapshot on the streaming card. */
  private patch(chatId: string, turn: TurnState): void {
    const snapshot: CardSnapshot = {
      title: turn.title,
      content: turn.content,
      thinking: turn.thinking,
      tools: turn.tools.slice(-MAX_TOOL_LINES),
      status: turn.status,
    };
    this.options.cards.patch(chatId, snapshot);
  }
}
