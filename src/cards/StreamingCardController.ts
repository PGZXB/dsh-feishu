/**
 * StreamingCardController: the streaming-card state machine.
 *
 * One authoritative {@link ChatCardState} per chat, one render path
 * (`syncCard`), and the session-event → card pipeline (`handleEvent`). This
 * is the state machine the UX is built on — the Bridge orchestrates agents
 * and routes messages, but the card itself (state, render, event folding,
 * the streaming card actions stop/copy/retry/row-details/toggle-rows) lives
 * here, behind the {@link StreamingCardHost} seam.
 *
 * @module @dsh-feishu/dsh-feishu/cards/StreamingCardController
 */

import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { CardAction, FeishuTransport } from '../feishu/types.js';
import type { SessionMap } from '../session-map.js';
import {
  assistantText,
  buildCard,
  buildRowDetailsCard,
  type CardSnapshot,
  type CardStatus,
  type ThinkRow,
  type ToolRow,
  type TurnRow,
} from './render.js';
import type { StreamingCardManager } from './streaming.js';
import { toolRowSummary } from './tool-summary.js';

/**
 * Compaction lifecycle events (`compaction/start|summary|end`). The harness
 * compaction seam merges these into the session event union at runtime, but
 * the installed `dsh-session` types do not carry the plugin keys, so they
 * are matched structurally.
 */
type CompactionLifecycleEvent = {
  readonly type: 'compaction/start' | 'compaction/summary' | 'compaction/end';
  readonly data: { readonly summary?: unknown; readonly error?: unknown };
};

/** Narrow a session event to the compaction lifecycle (plugin-merged keys). */
function isCompactionLifecycleEvent(event: SessionEvent): boolean {
  const type = (event as { type?: unknown }).type;
  return type === 'compaction/start' || type === 'compaction/summary' || type === 'compaction/end';
}

/**
 * One chat's streaming-card state — the single authoritative source for the
 * card. The controller renders the card from THIS state and nothing else;
 * card actions mutate it (or not) and then always call {@link
 * StreamingCardController.syncCard}, which re-renders the card from it. No
 * ad-hoc per-action reasserts.
 *
 * Status transitions:
 *   (none)  --message/retry-->  working  --turn/end-->  done | error
 *   working --stop------------>  (unchanged until turn/end aborts it)
 *   done|error --any action--->  done|error (state unchanged; card re-synced)
 */
export interface ChatCardState {
  readonly title: string;
  content: string;
  /** Chronological think/tool rows (all of them — DSH web layout). */
  rows: TurnRow[];
  /** The open think row receiving reasoning deltas, or undefined. */
  openThinkId: string | undefined;
  status: CardStatus;
  /** Collapsed row sequence (per-chat; flips via toggle-rows). */
  collapsed: boolean;
  /** The user pressed Stop; the card shows an in-progress Stopping state
   *  until turn/end(aborted) settles it to `stopped`. */
  stopRequested: boolean;
}

const MAX_TITLE_CHARS = 40;
/** Monotonic counter for think-row ids (stable across the turn). */
let thinkRowSeq = 0;

/**
 * Derive the card title for a turn from the user's message.
 * @param text - the inbound user message.
 * @returns a single-line title capped at {@link MAX_TITLE_CHARS}.
 */
export function turnTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= MAX_TITLE_CHARS ? oneLine : `${oneLine.slice(0, MAX_TITLE_CHARS)}…`;
}

/** Append a row, or update it in place when it already exists (by id). */
function upsertRow(state: ChatCardState, row: TurnRow): void {
  const index = state.rows.findIndex((existing) => existing.id === row.id);
  if (index >= 0) state.rows[index] = row;
  else state.rows.push(row);
}

/** Open a think row if reasoning is streaming and none is open. */
function ensureThinkRow(state: ChatCardState, id: string): void {
  if (state.openThinkId !== undefined) return;
  state.openThinkId = id;
  upsertRow(state, { kind: 'think', id, text: '', settled: false });
}

/** Settle the open think row (reasoning for this block ended). */
function settleOpenThink(state: ChatCardState): void {
  if (state.openThinkId === undefined) return;
  const id = state.openThinkId;
  state.openThinkId = undefined;
  const index = state.rows.findIndex((row) => row.id === id);
  if (index >= 0 && state.rows[index]?.kind === 'think') {
    state.rows[index] = { ...state.rows[index], settled: true } as ThinkRow;
  }
}

/** Logger surface the streaming controller needs. */
export interface StreamingLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Debug tracing (printed only when FEISHU_DEBUG=1). */
  debug(message: string): void;
}

/**
 * What the streaming card state machine needs from the rest of the surface.
 * The Bridge implements this; the controller never touches Bridge internals
 * directly (structural types avoid a circular import).
 */
export interface StreamingCardHost {
  readonly transport: FeishuTransport;
  readonly cards: StreamingCardManager;
  readonly logger: StreamingLogger;
  readonly sessionMap: SessionMap;
  readonly agentStore: {
    get(sessionId: string): Agent | undefined;
    resume(sessionId: string): Promise<Agent>;
    create(sessionId: string, cwd: string): Promise<Agent>;
  };
  readonly defaultCwd: string;
  /** Reaction emoji config (received/done/error/stopped overrides). */
  readonly reactions:
    | {
        readonly received?: string;
        readonly done?: string;
        readonly error?: string;
        readonly stopped?: string;
      }
    | undefined;
  /** Resolve a live agent for a chat (live → resume → create → remint). */
  resolveAgent(chatId: string, sessionId: string, cwd: string): Promise<Agent>;
  /** Proactive @-mention prefix for a chat in groups (failure notices). */
  textMentionFor(chatId: string): string;
}

/**
 * The streaming-card state machine controller. One instance per bridge;
 * state is per-chat.
 */
export class StreamingCardController {
  /** The authoritative streaming-card state per chat (the state machine). */
  private readonly cardStates = new Map<string, ChatCardState>();
  private readonly lastPrompts = new Map<string, string>();
  private readonly lastOutputs = new Map<string, string>();
  /** Pending two-stage ack reaction per chat (message id + reaction id). */
  private readonly pendingReactions = new Map<
    string,
    { readonly messageId: string; readonly reactionId: string | undefined }
  >();

  constructor(private readonly host: StreamingCardHost) {}

  /** Whether a turn is actively running for the chat (the working gate). */
  isWorking(chatId: string): boolean {
    return this.cardStates.get(chatId)?.status === 'working';
  }

  /** The chat's last completed output, or `undefined`. */
  lastOutput(chatId: string): string | undefined {
    return this.lastOutputs.get(chatId);
  }

  /** The chat's last remembered prompt, or `undefined`. */
  lastPrompt(chatId: string): string | undefined {
    return this.lastPrompts.get(chatId);
  }

  /** The chat's current card state, or `undefined` (no turn yet). */
  state(chatId: string): ChatCardState | undefined {
    return this.cardStates.get(chatId);
  }

  /** Reset a chat's card state: no live card, no copy/retry targets. Used by
   *  /clear and /resume so the resumed/new conversation starts clean. */
  resetChat(chatId: string): void {
    this.cardStates.delete(chatId);
    this.lastOutputs.delete(chatId);
    this.lastPrompts.delete(chatId);
    // The pending ack reaction belongs to a turn that is being discarded;
    // drop the tracking entry (the stale emoji may remain on the old
    // message — cosmetic only).
    this.pendingReactions.delete(chatId);
  }

  /** Remember the prompt for the retry button. */
  rememberPrompt(chatId: string, text: string): void {
    this.lastPrompts.set(chatId, text);
  }

  /**
   * Begin a turn's card lifecycle: two-stage ack stage 1 (👀 on the accepted
   * message), enter the working state, and open the streaming card. Best
   * effort — a failed reaction or card post never blocks the turn.
   * @param chatId - the chat.
   * @param messageId - the accepted message id (ack target).
   * @param title - the streaming-card title.
   */
  async beginTurn(chatId: string, messageId: string, title: string): Promise<void> {
    this.host.logger.debug(
      `streaming beginTurn ${chatId}: message ${messageId} '${title}' (two-stage ack stage 1)`,
    );
    const reactionId = await this.host.transport
      .addReaction(messageId, this.reactionEmojis().received)
      .catch((error: unknown) => {
        this.host.logger.warn(`received reaction failed: ${String(error)}`);
        return undefined;
      });
    this.pendingReactions.set(chatId, { messageId, reactionId });
    this.cardStates.set(chatId, {
      title,
      content: '',
      rows: [],
      openThinkId: undefined,
      status: 'working',
      collapsed: true,
      stopRequested: false,
    });
    try {
      await this.host.cards.open(chatId, title);
    } catch (error: unknown) {
      this.host.logger.warn(`streaming card unavailable, continuing text-only: ${String(error)}`);
    }
  }

  /** Resolved reaction emojis (config overrides, botmux defaults). */
  private reactionEmojis(): {
    received: string;
    done: string;
    error: string;
    stopped: string;
  } {
    const reactions = this.host.reactions;
    return {
      received: reactions?.received ?? 'GoGoGo',
      done: reactions?.done ?? 'DONE',
      error: reactions?.error ?? 'WARN',
      stopped: reactions?.stopped ?? 'WARN',
    };
  }

  /**
   * The single render path of the card state machine: render the chat's
   * authoritative {@link ChatCardState} into the streaming card. A live
   * (working) card goes through the streaming manager; a finished (done /
   * error) card is re-patched in place. Deferred via a macrotask so the
   * card-callback ACK lands first — Lark can otherwise restore the
   * pre-click card (botmux rule), which is the root of the "card reverts
   * to working after any action" bugs.
   */
  syncCard(chatId: string): void {
    const state = this.cardStates.get(chatId);
    if (state === undefined) return;
    if (state.status === 'working') {
      this.host.cards.patch(chatId, this.snapshot(chatId, state));
      return;
    }
    const messageId = this.host.cards.lastMessageId(chatId);
    if (messageId === undefined) return;
    const card = buildCard(this.snapshot(chatId, state));
    setTimeout(() => {
      void this.host.transport.updateCard(messageId, card).catch((error: unknown) => {
        this.host.logger.warn(`streaming card sync failed: ${String(error)}`);
      });
    }, 0);
  }

  /** Build the render snapshot from the authoritative state. */
  private snapshot(chatId: string, state: ChatCardState): CardSnapshot {
    return {
      title: state.title,
      content: state.content,
      rows: state.rows,
      cwd: this.host.sessionMap.cwdFor(chatId) ?? this.host.defaultCwd,
      collapsed: state.collapsed,
      stopRequested: state.stopRequested,
      status: state.status,
    };
  }

  /**
   * Two-stage ack, stage 2: remove the received reaction and add the
   * terminal one (done / error / stopped). Best-effort; failures log only.
   */
  private async ackTurnEnd(chatId: string, status: CardStatus): Promise<void> {
    const pending = this.pendingReactions.get(chatId);
    if (pending === undefined) return;
    this.pendingReactions.delete(chatId);
    const terminal =
      status === 'done'
        ? this.reactionEmojis().done
        : status === 'stopped'
          ? this.reactionEmojis().stopped
          : this.reactionEmojis().error;
    if (pending.reactionId !== undefined) {
      await this.host.transport
        .removeReaction(pending.messageId, pending.reactionId)
        .catch((error: unknown) => {
          this.host.logger.warn(`ack reaction remove failed: ${String(error)}`);
        });
    }
    await this.host.transport.addReaction(pending.messageId, terminal).catch((error: unknown) => {
      this.host.logger.warn(`ack reaction add failed: ${String(error)}`);
    });
  }

  /**
   * Render one session event into the owning chat's streaming card.
   * @param sessionId - the session that produced the event.
   * @param event - the session event.
   */
  async handleEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const chatId = this.host.sessionMap.chatFor(sessionId);
    if (chatId === undefined) {
      this.host.logger.debug(
        `streaming event ${event.type} from session ${sessionId}: no chat mapped, ignored`,
      );
      return;
    }
    this.host.logger.debug(
      `streaming event ${event.type} from session ${sessionId} -> chat ${chatId}`,
    );
    // Compaction lifecycle (a /compact transaction, not a turn) is handled
    // BEFORE the working-state gate because it owns its card lifecycle: the
    // card opens at compaction/start (immediate feedback for the button tap)
    // and finalizes at compaction/end. Without this, the checkpoint
    // `user/message` (plugin source 'compact') opened a card that nothing
    // ever closed — the chat stayed "working" forever and every later
    // command was refused with "a turn is running — stop it first."
    // (user report).
    if (isCompactionLifecycleEvent(event)) {
      await this.handleCompactionEvent(chatId, event as unknown as CompactionLifecycleEvent);
      return;
    }
    let state = this.cardStates.get(chatId);
    if (state === undefined || state.status !== 'working') {
      // Agent-initiated turn (e.g. a fired schedule reminder): the agent
      // injected a user message whose source is a plugin. User-initiated
      // turns always carry a working card state already (set by beginTurn
      // before any event), so a card-less chat receiving a plugin-sourced
      // user message is the surface's cue to open a fresh card — otherwise
      // the reminder's response would render nowhere.
      if (
        event.type === 'user/message' &&
        event.data.source?.kind === 'plugin' &&
        typeof event.data.source.plugin === 'string'
      ) {
        const plugin = event.data.source.plugin;
        this.host.logger.debug(
          `streaming agent-initiated card for chat ${chatId}: plugin '${plugin}'`,
        );
        const title =
          plugin === 'schedule'
            ? '⏰ Reminder'
            : plugin === 'compact'
              ? '🧹 Compacting…'
              : `⏰ ${plugin} notification`;
        this.cardStates.set(chatId, {
          title,
          content: '',
          rows: [],
          openThinkId: undefined,
          status: 'working',
          collapsed: true,
          stopRequested: false,
        });
        try {
          await this.host.cards.open(chatId, title);
        } catch (error: unknown) {
          this.host.logger.warn(`agent-initiated card unavailable: ${String(error)}`);
        }
        state = this.cardStates.get(chatId);
      }
      if (state === undefined || state.status !== 'working') {
        this.host.logger.debug(
          `streaming event ${event.type} for chat ${chatId}: ${state === undefined ? 'no card state' : `state is '${state.status}'`}`,
        );
        return;
      }
    }
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk;
        if (chunk.type === 'text-delta') {
          state.content += chunk.text;
          this.syncCard(chatId);
        } else if (chunk.type === 'reasoning-delta') {
          // One think row per reasoning block; deltas append to the open row.
          if (state.openThinkId === undefined) {
            thinkRowSeq += 1;
            ensureThinkRow(state, `think-${thinkRowSeq}`);
          }
          const id = state.openThinkId;
          const index = state.rows.findIndex((row) => row.id === id);
          if (index >= 0 && state.rows[index]?.kind === 'think') {
            const row = state.rows[index] as ThinkRow;
            state.rows[index] = { ...row, text: row.text + chunk.text };
          }
          this.syncCard(chatId);
        }
        break;
      }
      case 'tool/call': {
        settleOpenThink(state);
        this.host.logger.debug(
          `streaming tool/call ${chatId}: ${event.data.name} (${event.data.callId})`,
        );
        const cwd = this.host.sessionMap.cwdFor(chatId) ?? this.host.defaultCwd;
        upsertRow(state, {
          kind: 'tool',
          id: event.data.callId,
          name: event.data.name,
          status: 'running',
          // The summary derives from the FULL arguments before truncation —
          // a long command must never render as its raw JSON envelope.
          summary: toolRowSummary(event.data.name, event.data.arguments, cwd),
          args: event.data.arguments,
          result: '',
        } satisfies ToolRow);
        this.syncCard(chatId);
        break;
      }
      case 'tool/result': {
        const resultText = assistantText(event.data.message.content[0]?.content ?? []);
        const status = event.data.error !== undefined ? 'error' : 'done';
        this.host.logger.debug(
          `streaming tool/result ${chatId}: call ${event.data.message.content[0]?.toolCallId ?? '(unknown)'} -> ${status}`,
        );
        const index = state.rows.findIndex(
          (row): row is ToolRow =>
            row.kind === 'tool' && row.id === event.data.message.content[0]?.toolCallId,
        );
        const target =
          index >= 0
            ? index
            : (() => {
                // Fall back to the last running tool row when the result does
                // not carry a correlating call id.
                for (let i = state.rows.length - 1; i >= 0; i -= 1) {
                  const row = state.rows[i];
                  if (row?.kind === 'tool' && row.status === 'running') return i;
                }
                return -1;
              })();
        if (target >= 0 && state.rows[target]?.kind === 'tool') {
          const row = state.rows[target] as ToolRow;
          state.rows[target] = {
            ...row,
            status,
            result: resultText,
          };
        }
        this.syncCard(chatId);
        break;
      }
      case 'assistant/message': {
        settleOpenThink(state);
        state.content = assistantText(event.data.message.content);
        this.syncCard(chatId);
        break;
      }
      case 'turn/end': {
        const status: CardStatus =
          event.data.reason.kind === 'error'
            ? 'error'
            : event.data.reason.kind === 'aborted'
              ? 'stopped'
              : 'done';
        if (event.data.reason.kind === 'error') {
          const error = event.data.reason.error;
          this.host.logger.error(`turn failed: ${error.code}: ${error.message}`);
          // A corrupt persisted log breaks every turn that resumes it; rebind
          // the chat to a fresh session so the next message starts clean.
          if (error.message.includes('corrupt session log')) {
            this.host.logger.warn(
              `session log for chat ${chatId} is corrupt; rebinding a fresh session`,
            );
            this.host.sessionMap.remint(chatId);
          }
        } else {
          this.host.logger.info(`turn completed for chat ${chatId}`);
        }
        settleOpenThink(state);
        // working → done|stopped|error: the state stays in the map (the
        // card keeps its rows/content for the ⋯ buttons and re-sync); only
        // status moves.
        state.status = status;
        state.stopRequested = false;
        // Stage the terminal snapshot from the authoritative state, then
        // finalize flushes it. (finalize alone only renders when a pending
        // snapshot exists — after the last working patch was flushed there
        // is none, and the card would keep the stale working render.)
        this.host.cards.patch(chatId, this.snapshot(chatId, state));
        await this.host.cards.finalize(chatId, status);
        // Two-stage ack, stage 2: swap 👀 for the terminal emoji.
        await this.ackTurnEnd(chatId, status);
        const finalText = state.content.trim();
        if (finalText !== '') this.lastOutputs.set(chatId, finalText);
        // The card holds the full answer and finalizes in place; the initial
        // card send already notified, so a completed or stopped turn sends no
        // second bubble. Failures keep a notice — a broken turn must not go
        // unnoticed. A stopped turn's '⏹ Stopping…' was already sent by the
        // stop action; the card's '⏹ Stopped' is the terminal state.
        if (status === 'error') {
          // Proactive @ of the requester in groups: a broken turn must not
          // go unnoticed, and the group must know WHOSE turn failed.
          await this.host.transport.sendText(
            chatId,
            `${this.host.textMentionFor(chatId)}⚠️ Turn failed — see the card for details`,
          );
        }
        break;
      }
    }
  }

  /**
   * Render one compaction-lifecycle event into the chat's card. `/compact`
   * runs a durable transaction (compaction/start → compaction/summary →
   * compaction/end) that is NOT a turn — no turn/end follows it, so the
   * surface must open its own card at start and finalize it at end;
   * otherwise the chat is left permanently "working" (user report).
   * @param chatId - the owning chat.
   * @param event - the compaction lifecycle event.
   */
  private async handleCompactionEvent(
    chatId: string,
    event: CompactionLifecycleEvent,
  ): Promise<void> {
    this.host.logger.debug(`streaming compaction ${event.type} for chat ${chatId}`);
    switch (event.type) {
      case 'compaction/start': {
        let state = this.cardStates.get(chatId);
        if (state === undefined || state.status !== 'working') {
          state = {
            title: '🧹 Compacting…',
            content: '',
            rows: [],
            openThinkId: undefined,
            status: 'working',
            collapsed: true,
            stopRequested: false,
          };
          this.cardStates.set(chatId, state);
          try {
            await this.host.cards.open(chatId, '🧹 Compacting…');
          } catch (error: unknown) {
            this.host.logger.warn(`compaction card unavailable: ${String(error)}`);
          }
        }
        break;
      }
      case 'compaction/summary': {
        const state = this.cardStates.get(chatId);
        if (state !== undefined && state.status === 'working') {
          state.content = typeof event.data.summary === 'string' ? event.data.summary : '';
          this.syncCard(chatId);
        }
        break;
      }
      case 'compaction/end': {
        const state = this.cardStates.get(chatId);
        if (state !== undefined && state.status === 'working') {
          // The seam appends compaction/end on success AND failure (a failed
          // close carries `error`) — either way the surface must finalize:
          // a compaction transaction is not a turn, so no turn/end follows.
          const failed = event.data.error !== null && typeof event.data.error === 'object';
          const status: CardStatus = failed ? 'error' : 'done';
          if (failed) {
            const message =
              (event.data.error as { message?: unknown } | null | undefined)?.message ?? undefined;
            if (state.content.trim() === '') {
              state.content =
                message !== undefined && typeof message === 'string'
                  ? `⚠️ ${message}`
                  : '⚠️ Compaction failed.';
            }
          }
          state.status = status;
          state.stopRequested = false;
          this.host.cards.patch(chatId, this.snapshot(chatId, state));
          await this.host.cards.finalize(chatId, status);
          await this.ackTurnEnd(chatId, status);
          const finalText = state.content.trim();
          if (finalText !== '') this.lastOutputs.set(chatId, finalText);
          if (status === 'error') {
            // A failed compaction must not go unnoticed (same rule as a
            // failed turn).
            await this.host.transport.sendText(
              chatId,
              `${this.host.textMentionFor(chatId)}⚠️ Compaction failed — see the card for details`,
            );
          }
        }
        break;
      }
    }
  }

  /**
   * Handle one streaming-card action (stop/copy/retry/row-details/
   * toggle-rows). These mutate the card state machine; the panel actions and
   * approval/question interactions stay in the Bridge.
   * @param action - the normalized card callback.
   */
  async handleStreamingAction(action: CardAction): Promise<void> {
    this.host.logger.debug(
      `streaming action ${action.value.kind} on card ${action.messageId} (chat ${action.chatId})`,
    );
    switch (action.value.kind) {
      case 'stop': {
        const sessionId = this.host.sessionMap.get(action.chatId);
        const agent = sessionId === undefined ? undefined : this.host.agentStore.get(sessionId);
        if (agent === undefined) {
          // No session mapping or no attached agent (e.g. the plugin
          // restarted and the card is stale): surface that instead of
          // silently ignoring the tap.
          this.host.logger.info(
            `stop for chat ${action.chatId}: no live agent (stale card or restarted)`,
          );
          await this.host.transport.sendText(
            action.chatId,
            'No active session to stop — the bot may have restarted. Send a message to start fresh.',
          );
          return;
        }
        if (agent.status !== 'running') {
          // The DSH web Stop cancels a running turn; an idle agent has
          // nothing to cancel (agent.cancel is a no-op then — sending
          // "Stopping…" with no follow-up read as a hang, user report).
          this.host.logger.info(`stop for chat ${action.chatId}: agent idle, nothing to stop`);
          await this.host.transport.sendText(
            action.chatId,
            'No active turn to stop — the last turn already finished.',
          );
          return;
        }
        // The same cancel the DSH web Stop button issues (session.cancel →
        // agent.cancel({kind:'user'}, {keepInbox:true})): abort the active
        // turn/driver. keepInbox preserves queued work for the next turn.
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        this.host.logger.info(`stop requested for chat ${action.chatId}`);
        // The card carries the acknowledgment: mark it Stopping and
        // re-render — no separate text bubble (user report: the standalone
        // '⏹ Stopping…' message was unnecessary).
        const state = this.cardStates.get(action.chatId);
        if (state !== undefined && state.status === 'working') {
          state.stopRequested = true;
          this.syncCard(action.chatId);
        }
        return;
      }
      case 'copy': {
        const output = this.lastOutputs.get(action.chatId);
        if (output !== undefined && output !== '') {
          await this.host.transport.sendText(action.chatId, output);
        } else {
          // A silent no-op reads as broken (user report pattern).
          await this.host.transport.sendText(
            action.chatId,
            'Nothing to copy — no completed answer yet.',
          );
        }
        return;
      }
      case 'retry': {
        const prompt = this.lastPrompts.get(action.chatId);
        if (prompt === undefined || prompt === '') {
          await this.host.transport.sendText(
            action.chatId,
            'Nothing to retry — send a message first.',
          );
          return;
        }
        // No working-directory gate here: an unpinned chat can never have a
        // remembered prompt (turns are refused before lastPrompts is set), so
        // the "Nothing to retry" branch above is the only reachable path.
        const sessionId = this.host.sessionMap.ensure(action.chatId);
        const cwd = this.host.sessionMap.cwdFor(action.chatId) ?? this.host.defaultCwd;
        const agent = await this.host.resolveAgent(action.chatId, sessionId, cwd);
        this.cardStates.set(action.chatId, {
          title: turnTitle(prompt),
          content: '',
          rows: [],
          openThinkId: undefined,
          status: 'working',
          collapsed: true,
          stopRequested: false,
        });
        try {
          await this.host.cards.open(action.chatId, turnTitle(prompt));
        } catch (error: unknown) {
          this.host.logger.warn(`retry card unavailable, continuing text-only: ${String(error)}`);
        }
        agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'user' },
          }),
        );
        return;
      }
      case 'row-details': {
        const state = this.cardStates.get(action.chatId);
        const id = action.value.id;
        const row = (state?.rows ?? []).find((r) => r.id === id);
        if (row === undefined) {
          this.host.logger.warn(`row details for unknown id ${id}`);
          return;
        }
        await this.host.transport.sendCard(action.chatId, buildRowDetailsCard(row));
        // The state machine's single render path re-asserts the streaming
        // card after the callback (botmux rule: Lark can restore the
        // pre-click card, dropping the expanded view).
        this.syncCard(action.chatId);
        return;
      }
      case 'toggle-rows': {
        // Flip the collapsed bit on the authoritative state, then re-render
        // through the single path. Whether the turn is live or finished is
        // syncCard's concern — no per-case patching.
        const state = this.cardStates.get(action.chatId);
        if (state !== undefined) {
          state.collapsed = !state.collapsed;
          this.syncCard(action.chatId);
        }
        return;
      }
      default:
        // Not a streaming-card action (panel/approval/question) — ignore.
        return;
    }
  }
}
