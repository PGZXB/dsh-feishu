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

import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { CardAction, FeishuTransport } from '../feishu/types.js';
import { isImagePath } from '../outbound.js';
import type { SessionMap } from '../session-map.js';
import {
  assistantText,
  buildCard,
  buildRowDetailsCard,
  type CardSnapshot,
  type CardStatus,
  type SteeringRow,
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
 * The `file_path` of a mutation tool call, parsed from its raw arguments JSON.
 * The fs write/edit tools name the target in `file_path` (the schema key the
 * model emits); a read also carries `file_path`, but callers gate on a
 * `meta.diffs` mutation signal, so only write/edit reach this. Returns
 * undefined when the field is absent or the arguments are not JSON.
 */
function filePathFromArguments(args: string | undefined): string | undefined {
  if (args === undefined || args === '') return undefined;
  try {
    const parsed = JSON.parse(args) as { file_path?: unknown };
    return typeof parsed.file_path === 'string' && parsed.file_path !== ''
      ? parsed.file_path
      : undefined;
  } catch {
    return undefined;
  }
}

/** A fresh zeroed session stats accumulator (session-scoped, not per-turn). */
function emptySessionStats(): SessionStatsView {
  return {
    turnCount: 0,
    stepCount: 0,
    toolCount: 0,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    contextWindow: undefined,
  };
}

/** Sum one assistant step's `TokenUsage` (absent fields add nothing) into the
 *  session accumulator. `usage` is the `assistant/message` event's optional
 *  `usage` field, absent when the adapter reported none. */
function accumulateTokenUsage(stats: SessionStatsView, usage: unknown): void {
  if (typeof usage !== 'object' || usage === null) return;
  const u = usage as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadTokens?: unknown;
    cacheWriteTokens?: unknown;
  };
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  stats.tokenUsage.inputTokens += num(u.inputTokens);
  stats.tokenUsage.outputTokens += num(u.outputTokens);
  stats.tokenUsage.cacheReadTokens += num(u.cacheReadTokens);
  stats.tokenUsage.cacheWriteTokens += num(u.cacheWriteTokens);
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
  /** Paths (relative to the pinned cwd) of files the agent produced this
   *  turn via write/edit mutations (from `tool/result` `meta.diffs`).
   *  Reset on turn start; the final card chips render from it. */
  producedPaths: string[];
  /** A friendly, actionable explanation of the last turn failure, or
   *  `undefined` when the last turn didn't fail. Reset on turn start. */
  errorText: string | undefined;
}

/**
 * Map a turn-failure error to a friendly, actionable message the USER can
 * act on (or relay to the bot admin). The generic "see the card for details"
 * card told no one what broke; a MISSING_CREDENTIAL tells the admin exactly
 * what to fix, and an unknown error stays the raw message so a reporter can
 * share it verbatim.
 *
 * Guarantee: this NEVER returns an empty string — a turn failure must always
 * surface SOMETHING concrete. A blank `message` falls back to the error code,
 * and a blank code to an explicit "check the bot log" instruction (still more
 * useful than a dead end).
 * @param error - the turn-failure error (`reason.error` on a `turn/end`
 *   event): `code` is the stable category, `message` the provider text.
 * @returns a non-empty user-facing explanation.
 */
export function friendlyTurnError(error: { code?: string; message: string }): string {
  const code = error.code ?? '';
  const message = error.message.trim();
  if (code === 'MISSING_CREDENTIAL' || /no API key/i.test(message)) {
    return (
      "The model has no API key — the bot can't reach the LLM. " +
      'Ask the bot admin to configure one (e.g. DEEPSEEK_API_KEY).'
    );
  }
  if (code === 'NO_ADAPTER' || /no adapter/i.test(message)) {
    return (
      "The selected model/provider isn't available. " +
      'Ask the bot admin to check the model configuration.'
    );
  }
  if (code === 'AgentPresetConflict') {
    return "The chosen preset was changed mid-session and can't be applied. Start a fresh session and pick the preset again.";
  }
  if (message !== '') return message;
  if (code !== '') {
    return `The turn failed (error ${code}). Ask the bot admin to check the bot log.`;
  }
  return 'The turn failed for an unspecified reason. Ask the bot admin to check the bot log.';
}

/** Session-scoped cumulative usage folded from the event stream (exact
 *  counted fields only — no timing, which the host cannot see). */
export interface SessionStatsView {
  /** Number of recorded turns (`turn/start`). */
  turnCount: number;
  /** Number of assistant steps (`assistant/message`). */
  stepCount: number;
  /** Number of tool calls (`tool/call`). */
  toolCount: number;
  /** Accumulated token usage summed across steps (absent usage adds nothing). */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** The chat's current model context window (tokens), or undefined. */
  contextWindow: number | undefined;
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
  /** Best-effort model context window (tokens) for a chat, or undefined when
   *  unknown/unresolvable. Lazily consulted; feeds the context-occupancy
   *  group on the stats line. Absent → the group is always omitted. */
  resolveContextWindow?(
    chatId: string,
    sessionId: string,
    cwd: string,
  ): Promise<number | undefined>;
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
  /** Session-scoped cumulative usage per chat, folded from the event stream.
   *  Deliberately OUTSIDE `cardStates` so it survives `cardStates.set` (a new
   *  turn re-creates the card state but must NOT reset the cumulative usage —
   *  it mirrors the web whole-log `sessionStats`, which is session-scoped). */
  private readonly sessionStatsByChat = new Map<string, SessionStatsView>();
  private readonly lastPrompts = new Map<string, string>();
  private readonly lastOutputs = new Map<string, string>();
  /** Pending two-stage ack reaction per chat (message id + reaction id). */
  private readonly pendingReactions = new Map<
    string,
    { readonly messageId: string; readonly reactionId: string | undefined }
  >();
  /** Steered message ids per chat awaiting the agent's `user/message` event
   *  (message-queue). When the driver consumes a steered message at a step
   *  boundary it emits a `user/message`; the id here lets the trace add a
   *  steering row exactly where it was injected. */
  private readonly pendingSteers = new Map<string, Set<string>>();

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

  /** The chat's session-scoped stats accumulator (get-or-create). */
  private sessionStatsFor(chatId: string): SessionStatsView {
    let stats = this.sessionStatsByChat.get(chatId);
    if (stats === undefined) {
      stats = emptySessionStats();
      this.sessionStatsByChat.set(chatId, stats);
    }
    return stats;
  }

  /** Reset a chat's card state: no live card, no copy/retry targets. Used by
   *  /clear and /resume so the resumed/new conversation starts clean. */
  resetChat(chatId: string): void {
    this.cardStates.delete(chatId);
    this.sessionStatsByChat.delete(chatId);
    this.lastOutputs.delete(chatId);
    this.lastPrompts.delete(chatId);
    // The pending ack reaction belongs to a turn that is being discarded;
    // drop the tracking entry (the stale emoji may remain on the old
    // message — cosmetic only).
    this.pendingReactions.delete(chatId);
    // Any steered message awaiting its consuming `user/message` event is
    // being discarded with the conversation.
    this.pendingSteers.delete(chatId);
  }

  /** Remember the prompt for the retry button. */
  rememberPrompt(chatId: string, text: string): void {
    this.lastPrompts.set(chatId, text);
  }

  /** Register a steered message id (message-queue). Called by the bridge
   *  right before `agent.steer`; when the driver later emits that message's
   *  `user/message` event, the trace adds a steering row where it was
   *  injected. */
  noteSteer(chatId: string, messageId: string): void {
    let set = this.pendingSteers.get(chatId);
    if (set === undefined) {
      set = new Set();
      this.pendingSteers.set(chatId, set);
    }
    set.add(messageId);
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
      producedPaths: [],
      errorText: undefined,
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
      error: reactions?.error ?? 'ERROR',
      stopped: reactions?.stopped ?? 'ERROR',
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
      producedPaths: state.producedPaths,
      sessionStats: this.sessionStatsFor(chatId),
      status: state.status,
      ...(state.errorText !== undefined ? { errorText: state.errorText } : {}),
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
          producedPaths: [],
          errorText: undefined,
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
      case 'user/message': {
        // A user-role message on the model-visible surface. This is only a
        // STEERING injection when it arrives mid-turn AND we were the ones
        // who steered it (message-queue): the bridge registered the id via
        // noteSteer when the user clicked Steer. Add a steering row to the
        // trace so the user sees where their steered message was injected.
        const steered = this.pendingSteers.get(chatId)?.delete(event.data.id) === true;
        if (steered) {
          this.host.logger.debug(
            `streaming steering ${chatId}: message ${event.data.id} injected at step boundary`,
          );
          settleOpenThink(state);
          upsertRow(state, {
            kind: 'steering',
            id: event.data.id,
            text: assistantText(event.data.content),
          } satisfies SteeringRow);
          this.syncCard(chatId);
        }
        break;
      }
      case 'turn/start': {
        // Session-scoped turn accounting mirrors the web whole-log
        // `sessionStats`; it is NOT reset per turn.
        const stats = this.sessionStatsFor(chatId);
        stats.turnCount += 1;
        this.host.logger.debug(`streaming turn/start ${chatId}: turn ${event.data.turn}`);
        // Best-effort: resolve the chat's model context window once per turn
        // to feed the context-occupancy group. Non-blocking — a failure just
        // leaves `contextWindow` undefined (the group is omitted).
        if (this.host.resolveContextWindow !== undefined) {
          const cwd = this.host.sessionMap.cwdFor(chatId) ?? this.host.defaultCwd;
          void this.host
            .resolveContextWindow(chatId, sessionId, cwd)
            .then((window) => {
              if (window !== undefined) {
                stats.contextWindow = window;
                if (state.status === 'working') this.syncCard(chatId);
              }
            })
            .catch((error: unknown) => {
              this.host.logger.warn(
                `streaming context-window ${chatId}: resolve failed (${String(error)})`,
              );
            });
        }
        break;
      }
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
        this.sessionStatsFor(chatId).toolCount += 1;
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
        // Find the correlated tool row (also the create-fallback path source).
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
        const callRow = target >= 0 ? (state.rows[target] as ToolRow | undefined) : undefined;
        // Turn-produced files (path-level parity with the DSH web row). The
        // web derives produced paths from a mutation tool's render intent
        // (diff / generic+edit → `locations[].path`), which is browser-only.
        // The host-visible analogue: the fs write/edit mutation tools persist
        // a `meta.diffs` KEY on `tool/result` — a non-empty array for an
        // update/overwrite, an empty one for a new-file CREATE. Reads carry a
        // window/snippet meta (NO diffs key) and deletes/terminals carry none,
        // so a `meta.diffs` key (even empty) is the mutation signal. For an
        // empty `diffs` (a create) the path is not in meta, so derive it from
        // the correlated `tool/call` arguments' `file_path` — matching the
        // web's `presentCall.locations` exactly.
        const meta = (event.data as { meta?: { diffs?: unknown[] } }).meta;
        if (meta !== undefined && Array.isArray(meta.diffs)) {
          let path: string | undefined;
          if (meta.diffs.length > 0) {
            const first = meta.diffs[0] as { path?: unknown };
            if (typeof first?.path === 'string' && first.path !== '') path = first.path;
          } else {
            // New-file create: no diff basis, so `meta.diffs` is empty. The
            // path rides the tool/call arguments (`file_path`).
            path = filePathFromArguments(callRow?.args);
          }
          if (path !== undefined && path !== '' && !state.producedPaths.includes(path)) {
            state.producedPaths.push(path);
            this.host.logger.debug(
              `streaming produced-file ${chatId}: ${path} (${state.producedPaths.length} total)`,
            );
          }
        }
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
        const stats = this.sessionStatsFor(chatId);
        stats.stepCount += 1;
        accumulateTokenUsage(stats, event.data.usage);
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
          state.errorText = friendlyTurnError(error);
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
          // go unnoticed, and the group must know WHOSE turn failed. The
          // notice always carries the concrete reason (never a dead "see the
          // card"): `state.errorText` is guaranteed non-empty by
          // `friendlyTurnError`.
          await this.host.transport.sendText(
            chatId,
            `${this.host.textMentionFor(chatId)}⚠️ Turn failed: ${state.errorText ?? 'unknown error'}`,
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
            producedPaths: [],
            errorText: undefined,
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
          producedPaths: [],
          errorText: undefined,
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
      case 'send-produced': {
        // A produced-file chip: send the file to the chat via the outbound
        // transport (image extension -> image message, otherwise file). This
        // does NOT mutate card state — the card stays terminal. Best-effort;
        // an unreadable file fails loud to the user. `path` is cwd-relative.
        const path = action.value.path;
        if (typeof path !== 'string' || path === '') {
          this.host.logger.warn(`send-produced ${action.chatId}: missing path`);
          return;
        }
        // The produced path from `meta.diffs[].path` is ABSOLUTE (the fs
        // write/edit tools report the resolved path); accept an absolute path
        // as-is and only join a relative one onto the pinned cwd. Never re-join
        // an absolute path (double-prefix bug, #31).
        const cwd = this.host.sessionMap.cwdFor(action.chatId) ?? this.host.defaultCwd;
        const filePath = isAbsolute(path) ? path : join(cwd, path);
        try {
          const bytes = new Uint8Array(await readFile(filePath));
          const name = basename(filePath);
          if (isImagePath(path)) {
            await this.host.transport.sendImage(action.chatId, name, bytes);
            this.host.logger.debug(`send-produced ${action.chatId}: sent image ${path}`);
          } else {
            await this.host.transport.sendFile(action.chatId, name, bytes);
            this.host.logger.debug(`send-produced ${action.chatId}: sent file ${path}`);
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          this.host.logger.warn(`send-produced ${action.chatId} ${path}: failed (${msg})`);
          await this.host.transport.sendText(
            action.chatId,
            `⚠️ Could not send the produced file \`${path}\` (${msg}).`,
          );
        }
        return;
      }
      default:
        // Not a streaming-card action (panel/approval/question) — ignore.
        return;
    }
  }
}
