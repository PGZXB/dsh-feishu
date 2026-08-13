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

import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import {
  assistantText,
  buildPanelCard,
  type CardSnapshot,
  type CardStatus,
} from './cards/render.js';
import type { StreamingCardManager } from './cards/streaming.js';
import type { CardAction, FeishuMessage, FeishuTransport } from './feishu/types.js';
import { MessageDeduplicator } from './message-dedup.js';
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
}

/** One turn's card state, owned by the bridge. */
interface TurnState {
  readonly title: string;
  content: string;
  toolLines: string[];
  status: CardStatus;
}

const MAX_TITLE_CHARS = 40;
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

/** Push a tool line, dropping the oldest when over the cap. */
function pushToolLine(turn: TurnState, line: string): void {
  turn.toolLines.push(line);
  if (turn.toolLines.length > MAX_TOOL_LINES) turn.toolLines.shift();
}

/** Flip the most recent tool-call line to a completed mark. */
function markLastToolDone(turn: TurnState): void {
  for (let i = turn.toolLines.length - 1; i >= 0; i -= 1) {
    const line = turn.toolLines[i];
    if (line?.startsWith('🔧')) {
      turn.toolLines[i] = line.replace('🔧', '✅');
      return;
    }
  }
}

/**
 * Wires the Feishu transport to dsh sessions and back. Create one per
 * process; `dispose()` detaches the event subscription.
 */
export class Bridge {
  private readonly dedup = new MessageDeduplicator();
  private readonly turns = new Map<string, TurnState>();
  private readonly lastPrompts = new Map<string, string>();
  private readonly lastOutputs = new Map<string, string>();
  private readonly disposeEvents: () => void;

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
    this.lastPrompts.set(message.chatId, message.text);
    const sessionId = this.options.sessionMap.ensure(message.chatId);
    const agent = await this.resolveAgent(message.chatId, sessionId);
    this.turns.set(message.chatId, {
      title: turnTitle(message.text),
      content: '',
      toolLines: [],
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
  private async resolveAgent(chatId: string, sessionId: string): Promise<Agent> {
    const live = this.options.agentStore.get(sessionId);
    if (live !== undefined) return live;
    try {
      return await this.options.agentStore.resume(sessionId);
    } catch (resumeError: unknown) {
      this.options.logger.warn(`resume of session ${sessionId} failed: ${String(resumeError)}`);
    }
    try {
      return await this.options.agentStore.create(sessionId, this.options.defaultCwd);
    } catch (createError: unknown) {
      this.options.logger.error(
        `session ${sessionId} unusable (${String(createError)}); rebinding a fresh session`,
      );
      const freshId = this.options.sessionMap.remint(chatId);
      return this.options.agentStore.create(freshId, this.options.defaultCwd);
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
        if (event.data.chunk.type === 'text-delta') {
          turn.content += event.data.chunk.text;
          this.patch(chatId, turn);
        }
        break;
      }
      case 'tool/call': {
        pushToolLine(turn, `🔧 ${event.data.name}`);
        this.patch(chatId, turn);
        break;
      }
      case 'tool/result': {
        markLastToolDone(turn);
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
    const kind = action.value['kind'];
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
          const agent = await this.resolveAgent(action.chatId, sessionId);
          this.turns.set(action.chatId, {
            title: turnTitle(prompt),
            content: '',
            toolLines: [],
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

  /** Stage the turn's snapshot on the streaming card. */
  private patch(chatId: string, turn: TurnState): void {
    const snapshot: CardSnapshot = {
      title: turn.title,
      content: turn.content,
      toolLines: turn.toolLines,
      status: turn.status,
    };
    this.options.cards.patch(chatId, snapshot);
  }
}
