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
import { InteractionRegistry } from './cards/interactions.js';
import {
  assistantText,
  buildApprovalCard,
  buildApprovalDecidedCard,
  buildCard,
  buildModelPickerCard,
  buildPanelCard,
  buildPermissionPickerCard,
  buildQuestionAnsweredCard,
  buildQuestionCard,
  buildRepoPickedCard,
  buildRepoPickerCard,
  buildRowDetailsCard,
  buildStatusCard,
  type CardSnapshot,
  type CardStatus,
  type ModelOptionView,
  type PanelCommand,
  type PermissionPresetView,
  type QuestionView,
  type StatusView,
  type ThinkRow,
  type ToolRow,
  type TurnRow,
} from './cards/render.js';
import { buildSessionsCard, type SessionRowView } from './cards/session-list.js';
import type { StreamingCardManager } from './cards/streaming.js';
import { toolRowSummary } from './cards/tool-summary.js';
import { CommandRegistry, type CommandResult, parseSlash } from './commands.js';
import type {
  CardAction,
  CardJson,
  FeishuMessage,
  FeishuTransport,
  SentCard,
} from './feishu/types.js';
import { MessageDeduplicator } from './message-dedup.js';
import { type ProjectInfo, scanMultipleProjects } from './projects.js';
import { buildSessionExport, type SessionExportEvent } from './session-export.js';
import type { SessionMap } from './session-map.js';

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

/** One `/sessions` row as the surface lists it (structural subset of dsh's
 *  session corpus; titles folded by the query engine). */
export interface SessionListRow {
  readonly sessionId: string;
  /** Latest session title, or `undefined` when the log has none. */
  readonly title: string | undefined;
  /** Working directory the session was created in, or `undefined`. */
  readonly cwd: string | undefined;
  /** Unix epoch milliseconds when the session was created. */
  readonly createdAt: number;
  /** Whether the session currently has a live agent. */
  readonly live: boolean;
  /** Whether the session has a persisted log. */
  readonly persisted: boolean;
}

/** Structural subset of `ctx.permissionPresets` (`@deepseek-ai/dsh-permission-presets`,
 *  mounted by dsh-base). Kept local so the plugin compiles without a
 *  dependency on the package. The real service folds a session's events for
 *  `current` and writes the session's durable knobs in `set`. */
export interface PermissionPresetService {
  /** Switchable preset names, declaration order (a property getter). */
  readonly names: readonly string[];
  /** Client presentation for one preset (label falls back to the key). */
  optionOf(name: string): { value: string; name?: string; description?: string };
  /** The preset currently effective for a session's events. */
  current(events: readonly unknown[]): string;
  /** Record a changed preset and apply its sandbox/approval bundle. */
  set(session: unknown, name: string): void;
}

/** Structural subset of `ctx.planMode` (`@deepseek-ai/dsh-plan-mode`). */
export interface PlanModeService {
  /** Logged plan state plus a pending selection awaiting the next pre-step. */
  get(agent: Agent): { active: boolean; pending?: boolean };
  /** Select whether plan mode should be active. */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop';
}

/** A provider/model selection (structural subset of dsh's `ModelSelection`). */
export interface ModelSelectionView {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** Structural subset of `ctx.agentDefaultModel` (`@deepseek-ai/dsh-agent-default-model`,
 *  mounted by dsh-base): the default model for new sessions. */
export interface AgentDefaultModelService {
  /** The current default selection. */
  currentSelection(): ModelSelectionView;
  /** Persist a new default for future sessions. */
  saveSelection(next: ModelSelectionView): Promise<void>;
}

/** One model entry the /model picker lists (structural subset of
 *  `LlmModelInfo`). */
export interface LlmModelView {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
}

/** Structural subset of `ctx.llm` (`@deepseek-ai/dsh-llm`, mounted by
 *  dsh-base): provider routes and their advisory model catalogs. */
export interface LlmService {
  listProviders(): readonly { readonly id: string; readonly name: string }[];
  listModels(provider: string): Promise<readonly LlmModelView[]>;
}

/** The approval settlement union (structural subset of `ApprovalOutcome`). */
export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** Structural subset of an `approval/request` (`@deepseek-ai/dsh-user-approval`). */
export interface ApprovalRequestLike {
  readonly agent: Agent;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

/** Structural subset of `AskUserQuestionItem`. */
export interface AskQuestionItemLike {
  readonly id: string;
  readonly question: string;
  readonly detail?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
  readonly intent?: string;
}

/** Structural subset of `AskUserQuestionRequest`. */
export interface AskQuestionsRequestLike {
  readonly questions: readonly AskQuestionItemLike[];
  readonly agent?: Agent;
  readonly signal?: AbortSignal;
}

/** Structural subset of `AskUserQuestionAnswer`. */
export interface AskQuestionsAnswerLike {
  readonly answers: readonly {
    readonly id: string;
    readonly selected: readonly string[];
    readonly custom?: string;
  }[];
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
   * The Feishu app id this surface runs as (shown by `/feishu-status`).
   */
  readonly appId?: string;
  /**
   * Wire mode for the `/feishu-status` diagnostic: 'lark' (long connection)
   * or 'memory' (the file-channel test/demo transport). Absent → 'unknown'.
   */
  readonly transportMode?: 'lark' | 'memory';
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
   * User allowlist: when non-empty, only messages from these sender open ids
   * are served (anything else is ignored — including in an allowed chat).
   * Note `ou_` open ids are app-scoped. Empty means all users are served.
   */
  readonly allowedUsers?: readonly string[];
  /**
   * DSH slash-command passthrough: execute `line` against the chat's live
   * agent through the dsh command registry. Absent, registry commands are
   * not available (every unknown slash line falls to the unknown policy).
   */
  readonly executeCommand?: (agent: Agent, line: string) => Promise<CommandResult | undefined>;
  /**
   * List the session corpus for `/sessions` and `/resume` (newest-first,
   * with folded titles). Absent, the surface degrades to a
   * bound-sessions-only listing.
   */
  readonly listSessions?: () => Promise<readonly SessionListRow[] | undefined>;
  /**
   * Read one complete session log for `/export` (structural subset of
   * `ctx.sessionQuery.readSession`). Absent, `/export` reports the service
   * is not mounted.
   */
  readonly readSession?: (sessionId: string) => Promise<{
    readonly session: { readonly id: string };
    readonly events: readonly SessionExportEvent[];
  }>;
  /**
   * Permission-preset service (`ctx.permissionPresets`, mounted by
   * dsh-base): `/permission` renders a preset picker from it and applies
   * picks through it. Absent, `/permission` degrades to the harness
   * report text.
   */
  readonly permissionPresets?: PermissionPresetService;
  /**
   * Plan-mode controller (`ctx.planMode`, mounted by dsh-base): a bare
   * `/plan` (or its button) toggles plan mode through it instead of only
   * entering. Absent, the bare form falls back to the harness behavior.
   */
  readonly planMode?: PlanModeService;
  /**
   * Default-model service (`ctx.agentDefaultModel`, mounted by dsh-base):
   * `/model` reads the current selection and sets the default for future
   * sessions. Absent, `/model` reports the live agent's own options when
   * available, else fails loud.
   */
  readonly agentDefaultModel?: AgentDefaultModelService;
  /**
   * LLM runtime (`ctx.llm`, mounted by dsh-base): the /model picker card
   * lists models through `listProviders` × `listModels`. Absent, a bare
   * `/model` falls back to the text display.
   */
  readonly llm?: LlmService;
  /**
   * Refuse to start turns until the chat has an EXPLICITLY pinned working
   * directory (/repo pick or /cd). Default true — a fresh chat (or a new
   * group) must choose a repo before DSH works there; the deployment
   * defaultCwd fallback is never an implicit choice (user requirement).
   */
  readonly requireWorkingDir?: boolean;
  /**
   * Two-stage reaction ack emojis: `received` is added to an accepted turn
   * message, then swapped for `done` / `error` / `stopped` when the turn
   * settles. Defaults GoGoGo / DONE / WARN / WARN (botmux codes). Reaction
   * failures only log — they never block the turn.
   */
  readonly reactions?: {
    readonly received?: string;
    readonly done?: string;
    readonly error?: string;
    readonly stopped?: string;
  };
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

/**
 * One chat's streaming-card state — the single authoritative source for the
 * card. The bridge renders the card from THIS state and nothing else; card
 * actions mutate it (or not) and then always call {@link Bridge.syncCard},
 * which re-renders the card from it. This is the state machine the UX is
 * built on: no ad-hoc per-action reasserts.
 *
 * Status transitions:
 *   (none)  --message/retry-->  working  --turn/end-->  done | error
 *   working --stop------------>  (unchanged until turn/end aborts it)
 *   done|error --any action--->  done|error (state unchanged; card re-synced)
 */
interface ChatCardState {
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

/** Surface-wrapped dsh web commands (mounted by dsh-base's command rows):
 *  thin handlers that ensure an agent, then execute the dsh registry command
 *  with the same arguments — the Feishu surface covers the web command set
 *  in-chat, buttons included. `/export` is intentionally absent: it is a
 *  Web-only command whose handler a browser download plugin observes.
 *
 * `/plan` and `/permission` are handled bespoke (state-aware): a bare
 * `/plan` toggles plan mode instead of only entering it, and `/permission`
 * opens a preset picker card instead of only reporting the current preset —
 * a button press must be able to actually choose/switch (user report). */
const HARNESS_COMMANDS: ReadonlyArray<{
  readonly name: string;
  readonly description: string;
  readonly buttonLabel: string;
}> = [
  {
    name: 'goal',
    description: 'Set or view the goal for a long-running task (dsh web)',
    buttonLabel: '🎯 Goal',
  },
  {
    name: 'compact',
    description: 'Compact older conversation history (dsh web)',
    buttonLabel: '🧹 Compact',
  },
  {
    name: 'feedback',
    description: 'Send feedback (dsh web)',
    buttonLabel: '💬 Feedback',
  },
];

/** Mirror the harness /plan command's outcome wording for a toggle. */
function planModeResultText(
  target: boolean,
  outcome: 'committed' | 'queued' | 'cancelled' | 'noop',
): string {
  switch (outcome) {
    case 'committed':
      return target ? 'Plan mode on. Use /plan off to leave.' : 'Plan mode off.';
    case 'queued':
      return target
        ? 'Entering plan mode (applies from the next step). Use /plan off to leave.'
        : 'Leaving plan mode (applies from the next step).';
    case 'cancelled':
      return 'Plan mode entry cancelled.';
    case 'noop':
      return target ? 'Plan mode is already active.' : 'Plan mode is already inactive.';
  }
}

/**
 * Parse a `/model` argument into a selection: `provider/model` or
 * `provider model`. A single bare token is rejected (no provider to route).
 * @param raw - the trimmed argument text.
 * @returns the selection, or a usage error.
 */
function parseModelArg(
  raw: string,
): { ok: true; selection: ModelSelectionView } | { ok: false; error: string } {
  const trimmed = raw.trim();
  const slash = trimmed.split('/');
  const parts = slash.length === 2 ? slash : trimmed.split(/\s+/);
  const provider = parts[0]?.trim();
  const model = parts[1]?.trim();
  if (provider === undefined || provider === '' || model === undefined || model === '') {
    return {
      ok: false,
      error: 'usage: /model <provider>/<model> (e.g. /model deepseek-official/deepseek-v4-flash)',
    };
  }
  return { ok: true, selection: { provider, model } };
}

export class Bridge {
  private readonly dedup = new MessageDeduplicator();
  /** Epoch ms of the last accepted inbound message (any chat), for
   *  `/feishu-status`. */
  private lastInboundAtValue: number | undefined;
  /** The authoritative streaming-card state per chat (the state machine). */
  private readonly cardStates = new Map<string, ChatCardState>();
  private readonly lastPrompts = new Map<string, string>();
  private readonly lastOutputs = new Map<string, string>();
  /** Active repo-picker card message id per chat; a pick consumes it. */
  private readonly pickerMessageIds = new Map<string, string>();
  /** The most recently opened panel card per chat (pagination updates it
   *  in place instead of posting a new card — mobile UX, user report). */
  private readonly panelMessageIds = new Map<string, string>();
  /** Active /sessions picker card message id per chat (stale-callback guard). */
  private readonly sessionPickerMessageIds = new Map<string, string>();
  /** Active /permission picker card message id per chat (stale-callback guard). */
  private readonly permissionPickerMessageIds = new Map<string, string>();
  /** Active /model picker card message id per chat (stale-callback guard). */
  private readonly modelPickerMessageIds = new Map<string, string>();
  /** Pending approval/question card interactions (one resolve path). */
  private readonly interactions = new InteractionRegistry();
  /** Multi-select question state per request id (toggle + submit). */
  private readonly questionState = new Map<
    string,
    {
      readonly chatId: string;
      readonly view: QuestionView;
      selection: string[];
      /** The card the interaction currently targets — retargeted when the
       *  multi-select card is re-posted with checkmarks, so the finalize
       *  update lands on the newest card (user report: answered cards kept
       *  their buttons because the initial message id went stale). */
      messageId: string;
    }
  >();
  /** Chats awaiting a free-text question answer (request id per chat). */
  private readonly awaitingQuestionAnswers = new Map<string, { readonly requestId: string }>();
  /** Monotonic approval request counter (card callback correlation ids). */
  private approvalSeq = 0;
  /** Pending two-stage ack reaction per chat (message id + reaction id). */
  private readonly pendingReactions = new Map<
    string,
    { readonly messageId: string; readonly reactionId: string | undefined }
  >();
  /** Last user whose accepted message started a turn, per chat (proactive
   *  @-mention target for error/approval/question posts in groups). */
  private readonly requesterOpenIds = new Map<string, string>();
  /** Chat type of the last accepted message per chat (`p2p` needs no @). */
  private readonly chatTypes = new Map<string, 'p2p' | 'group'>();

  /**
   * The user to proactively @ for a chat: the last accepted sender, only in
   * groups (a p2p chat is single-user; an @ there is noise). Returns the
   * card-markdown mention prefix, or '' when none applies.
   * @param chatId - the chat.
   * @returns `<at id="…"></at> ` or ''.
   */
  private cardMentionFor(chatId: string): string {
    if (this.chatTypes.get(chatId) !== 'group') return '';
    const requester = this.requesterOpenIds.get(chatId);
    return requester === undefined ? '' : `<at id="${requester}"></at> `;
  }

  /**
   * The text-message mention prefix for proactive notices (same rules as
   * {@link cardMentionFor}, but the text-channel `<at user_id="…">` form).
   * @param chatId - the chat.
   * @returns `<at user_id="…"></at> ` or ''.
   */
  private textMentionFor(chatId: string): string {
    if (this.chatTypes.get(chatId) !== 'group') return '';
    const requester = this.requesterOpenIds.get(chatId);
    return requester === undefined ? '' : `<at user_id="${requester}"></at> `;
  }

  /** Resolved reaction emojis (config overrides, botmux defaults). */
  private reactionEmojis(): { received: string; done: string; error: string; stopped: string } {
    const reactions = this.options.reactions;
    return {
      received: reactions?.received ?? 'GoGoGo',
      done: reactions?.done ?? 'DONE',
      error: reactions?.error ?? 'WARN',
      stopped: reactions?.stopped ?? 'WARN',
    };
  }

  /** The live agent for a chat, or `undefined` (no session or not attached). */
  private liveAgent(chatId: string): Agent | undefined {
    const sessionId = this.options.sessionMap.get(chatId);
    return sessionId === undefined ? undefined : this.options.agentStore.get(sessionId);
  }
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
    this.interactions.dispose();
  }

  /**
   * Deliver an inbound message: dedup, resolve/create the chat's session,
   * open the turn's streaming card, and hand the message to the agent.
   * @param message - the normalized inbound message.
   */
  async handleMessage(message: FeishuMessage): Promise<void> {
    if (!this.dedup.claim(message.messageId)) return;
    if (!(await this.shouldRespond(message))) return;
    this.lastInboundAtValue = Date.now();
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
      // The state-machine matrix rule: mutating commands are refused while a
      // turn is running (read-only commands — help/status/sessions — and
      // cancel/group stay available).
      if (
        this.refuseWhileWorking(message.chatId) &&
        !Bridge.ALLOWED_WHILE_WORKING.has(slash.name)
      ) {
        await this.replyCommandResult(message.chatId, {
          kind: 'error',
          text: 'a turn is running — stop it first.',
        });
        return;
      }
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
      const result = await this.options.executeCommand(agent, line);
      if (result !== undefined) {
        await this.replyCommandResult(message.chatId, result);
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

  /**
   * The working-state gate (state-machine matrix rule): while a turn is
   * running, only read-only commands may run; mutating commands are refused
   * with an explanation so a mid-turn session rebind/remint can never
   * corrupt the live card.
   * @param chatId - the chat.
   * @returns whether the chat is mid-turn (caller should refuse).
   */
  private refuseWhileWorking(chatId: string): boolean {
    return this.cardStates.get(chatId)?.status === 'working';
  }

  /**
   * Commands allowed while a turn is running (read-only or safe):
   * `help`/`status`/`sessions` read state, `cancel` is the stop itself,
   * `group` creates a separate chat, and `model` reads (or sets the
   * default for future sessions — never touches the running turn).
   */
  private static readonly ALLOWED_WHILE_WORKING = new Set([
    'help',
    'status',
    'feishu-status',
    'schedule',
    'sessions',
    'cancel',
    'group',
    'model',
    'panel',
  ]);

  /** Reset a chat's card state: no live card, no copy/retry targets. Used by
   *  /clear and /resume so the resumed/new conversation starts clean. */
  private resetChatState(chatId: string): void {
    this.cardStates.delete(chatId);
    this.lastOutputs.delete(chatId);
    this.lastPrompts.delete(chatId);
    // The pending ack reaction belongs to a turn that is being discarded;
    // drop the tracking entry (the stale emoji may remain on the old
    // message — cosmetic only).
    this.pendingReactions.delete(chatId);
  }

  /**
   * The shared /resume flow (slash line and /sessions Resume button). The
   * chat must be idle; the target session must not be running elsewhere;
   * then bind the chat to the session (moving the previous binding) and
   * resume a persisted agent when none is live.
   * @param chatId - the chat to rebind.
   * @param sessionId - the session to resume.
   * @returns the surface outcome text.
   */
  /**
   * The shared /resume flow (slash line and /sessions Resume button). The
   * chat must be idle; the target session must not be running elsewhere;
   * then bind the chat to the session (moving the previous binding) and
   * resume a persisted agent when none is live. The resumed session's
   * working directory becomes the chat's pinned cwd (known via the picker
   * action value, or looked up from the session list) — otherwise the
   * working-directory gate would refuse every follow-up turn here.
   * @param chatId - the chat to rebind.
   * @param sessionId - the session to resume.
   * @param cwd - the session's working directory, when already known.
   * @returns the surface outcome text.
   */
  private async resumeSession(
    chatId: string,
    sessionId: string,
    cwd?: string,
  ): Promise<CommandResult> {
    if (this.refuseWhileWorking(chatId)) {
      return { kind: 'error', text: 'a turn is running — stop it first.' };
    }
    if (this.options.sessionMap.get(chatId) === sessionId) {
      return { kind: 'error', text: `session ${sessionId} is already active in this chat.` };
    }
    const agent = this.options.agentStore.get(sessionId);
    if (agent !== undefined && agent.status === 'running') {
      return {
        kind: 'error',
        text: `session ${sessionId} has an active turn — stop it in its chat first.`,
      };
    }
    if (agent === undefined) {
      try {
        await this.options.agentStore.resume(sessionId);
      } catch (error: unknown) {
        this.options.logger.warn(`resume of session ${sessionId} failed: ${String(error)}`);
        return {
          kind: 'error',
          text: `could not resume session ${sessionId}: ${String(error)}`,
        };
      }
    }
    // Adopt the resumed session's working directory as the chat's pin.
    let adopted = cwd;
    if (adopted === undefined && this.options.listSessions !== undefined) {
      try {
        const rows = await this.options.listSessions();
        adopted = rows?.find((row) => row.sessionId === sessionId)?.cwd;
      } catch (error: unknown) {
        this.options.logger.warn(`resume cwd lookup failed: ${String(error)}`);
      }
    }
    if (adopted !== undefined) this.options.sessionMap.setCwd(chatId, adopted);
    // Bind the chat to the session (both directions stay consistent; the
    // previous binding — if any — is detached).
    this.options.sessionMap.set(chatId, sessionId);
    this.resetChatState(chatId);
    const hint =
      this.options.sessionMap.cwdFor(chatId) === undefined
        ? ' This chat has no working directory — pick one with /repo or /cd before sending a message.'
        : '';
    return {
      kind: 'success',
      text: `Resumed session ${sessionId} — send a message to continue it.${hint}`,
    };
  }

  /**
   * Load the session list for /sessions, marking the chat's current session.
   * Degrades to a bound-sessions-only listing when the query service is
   * absent (loud in the log).
   * @param chatId - the requesting chat.
   * @returns session rows, or `undefined` when listing is unavailable.
   */
  private async loadSessions(chatId: string): Promise<readonly SessionRowView[] | undefined> {
    if (this.options.listSessions === undefined) {
      this.options.logger.warn(
        '[feishu] listSessions unavailable; /sessions degraded to bound sessions',
      );
      const current = this.options.sessionMap.get(chatId);
      const seen = new Set<string>();
      const rows: SessionRowView[] = [];
      for (const chat of this.options.sessionMap.chats()) {
        const sessionId = this.options.sessionMap.get(chat);
        if (sessionId === undefined || seen.has(sessionId)) continue;
        seen.add(sessionId);
        rows.push({
          sessionId,
          title: chat === chatId ? 'this chat' : `chat ${chat}`,
          cwd: this.options.sessionMap.cwdFor(chat),
          createdAt: 0,
          live: this.options.agentStore.get(sessionId) !== undefined,
          persisted: false,
          current: sessionId === current,
        });
      }
      return rows;
    }
    const listed = await this.options.listSessions();
    if (listed === undefined) return undefined;
    const current = this.options.sessionMap.get(chatId);
    return listed.map((row) => ({
      ...row,
      current: row.sessionId === current,
    }));
  }

  /** Post the /sessions picker card (the resume-by-button surface). */
  private async openSessionsPicker(chatId: string): Promise<void> {
    const rows = await this.loadSessions(chatId);
    if (rows === undefined) {
      await this.options.transport.sendText(
        chatId,
        'Session list unavailable — the session query service is not mounted.',
      );
      return;
    }
    try {
      const sent = await this.options.transport.sendCard(chatId, buildSessionsCard(rows, 0));
      // Record the active picker card so a resume can consume it (and stale
      // callbacks from an older picker are rejected).
      this.sessionPickerMessageIds.set(chatId, sent.messageId);
    } catch (error: unknown) {
      this.options.logger.warn(`sessions picker send failed: ${String(error)}`);
    }
  }

  /** The panel command palette: every surface command as a button, grouped
   *  by category (session → chat → system) so the palette reads as sections
   *  regardless of registration order. */
  private panelCommands(): PanelCommand[] {
    const categoryOrder = ['session', 'chat', 'system'];
    return [...this.commands.list()]
      .filter((command) => command.hiddenFromPanel !== true)
      .sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category))
      .map((command) => ({
        name: command.name,
        buttonLabel: command.buttonLabel ?? command.name,
        category: command.category,
      }));
  }

  /**
   * Open (or page) the control panel card: the core buttons plus the full
   * command palette, paginated. The panel is stateless — each open/pager
   * posts a fresh card built from the current authoritative state.
   * @param chatId - the chat.
   * @param page - zero-based palette page.
   */
  private async openPanel(chatId: string, page = 0): Promise<void> {
    const sent = await this.options.transport.sendCard(
      chatId,
      this.buildPanelCardFor(chatId, page),
    );
    this.panelMessageIds.set(chatId, sent.messageId);
    this.syncCard(chatId);
  }

  /** Construct the panel card for a chat at the given command page. */
  private buildPanelCardFor(chatId: string, page: number): CardJson {
    const agent = this.liveAgent(chatId);
    const running = agent !== undefined && agent.status === 'running';
    const state = this.cardStates.get(chatId);
    const stopped = state !== undefined && state.status === 'stopped';
    const output = this.lastOutputs.get(chatId);
    const statusLine = running
      ? '**Running** — a turn is in progress.'
      : stopped
        ? '**Stopped** — the last turn was interrupted.'
        : output === undefined
          ? '**Idle** — send a message to start a turn.'
          : '**Ready** — the last answer is in the card above; copy or retry it.';
    // The panel carries the chat's session context so a tap always shows
    // which session the buttons act on. An unpinned chat (no /repo or /cd)
    // surfaces the working-directory requirement instead of a fake cwd.
    const sessionId = this.options.sessionMap.get(chatId);
    const pinned = this.options.sessionMap.cwdFor(chatId);
    const cwd = pinned ?? this.options.defaultCwd;
    const contextLine =
      pinned === undefined && this.options.requireWorkingDir !== false
        ? 'No working directory — pick one with /repo or /cd first'
        : sessionId === undefined
          ? `No session yet · \`${cwd}\``
          : `session \`${sessionId}\` · \`${cwd}\``;
    // Toggle commands show their CURRENT state on the button (plan mode is
    // the one today — the label flips instead of staying static, user report).
    const commands = this.panelCommands().map((command) =>
      command.name === 'plan'
        ? { ...command, buttonLabel: this.planModeButtonLabel(chatId) }
        : command,
    );
    return buildPanelCard(`${statusLine}\n${contextLine}`, running, commands, page);
  }

  /** The plan-mode toggle button label for a chat's current state. */
  private planModeButtonLabel(chatId: string): string {
    const planMode = this.options.planMode;
    if (planMode === undefined) return '🗺️ Plan mode';
    const sessionId = this.options.sessionMap.get(chatId);
    const agent = sessionId === undefined ? undefined : this.options.agentStore.get(sessionId);
    if (agent === undefined) return '🗺️ Plan mode';
    const current = planMode.get(agent);
    const active = current.pending ?? current.active;
    return active ? '🗺️ Leave plan mode' : '🗺️ Plan mode';
  }

  /**
   * Post the /permission preset picker card: a dropdown of the switchable
   * presets (from the mounted `permissionPresets` service) with the current
   * preset preselected.
   * @param chatId - the chat.
   */
  private async openPermissionPicker(chatId: string): Promise<void> {
    const service = this.options.permissionPresets;
    if (service === undefined) return;
    const agent = await this.ensureAgent(chatId);
    const current = service.current(agent.session.events);
    const presets: PermissionPresetView[] = service.names.map((name) => {
      const option = service.optionOf(name);
      return {
        name,
        label: option.name ?? name,
        description: option.description,
        current: name === current,
      };
    });
    try {
      const sent = await this.options.transport.sendCard(
        chatId,
        buildPermissionPickerCard(presets),
      );
      this.permissionPickerMessageIds.set(chatId, sent.messageId);
    } catch (error: unknown) {
      this.options.logger.warn(`permission picker send failed: ${String(error)}`);
    }
  }

  /**
   * Handle one `approval/request` (the surface's answerer): map the agent to
   * its chat, post an approval card, and wait for the card callback (or
   * timeout/abort → `'cancelled'`). Fail-closed `'unavailable'` when the
   * chat is unknown or the card cannot be posted.
   * @param request - the approval request.
   * @returns the settlement outcome.
   */
  async handleApprovalRequest(request: ApprovalRequestLike): Promise<ApprovalOutcomeLike> {
    const chatId = this.options.sessionMap.chatFor(String(request.agent.session.id));
    if (chatId === undefined) {
      this.options.logger.warn(
        `approval request for session ${String(request.agent.session.id)} has no chat; failing closed`,
      );
      return 'unavailable';
    }
    this.approvalSeq += 1;
    const requestId = `approval-${this.approvalSeq}`;
    let messageId: string;
    try {
      const sent = await this.options.transport.sendCard(
        chatId,
        buildApprovalCard(request.toolName, request.reason, requestId, this.cardMentionFor(chatId)),
      );
      messageId = sent.messageId;
    } catch (error: unknown) {
      this.options.logger.warn(`approval card send failed: ${String(error)}`);
      return 'unavailable';
    }
    return new Promise<ApprovalOutcomeLike>((resolve) => {
      this.interactions.register(requestId, chatId, messageId, (outcome) => {
        // Turn the card into its static decided state, deferred out of the
        // card-callback ACK (botmux rule), then re-assert the streaming card.
        const settled: ApprovalOutcomeLike = outcome as ApprovalOutcomeLike;
        setTimeout(() => {
          void this.options.transport
            .updateCard(messageId, buildApprovalDecidedCard(settled))
            .catch((error: unknown) => {
              this.options.logger.warn(`approval card settle update failed: ${String(error)}`);
            });
        }, 0);
        this.syncCard(chatId);
        resolve(settled);
      });
      if (request.signal !== undefined) {
        request.signal.addEventListener('abort', () => {
          this.interactions.abort(requestId, 'cancelled');
        });
      }
    });
  }

  /**
   * Answer one `AskUserQuestionRequest` as the surface's userQuestions
   * provider: post a question card per item and collect the answers through
   * card callbacks (or the next chat message for free-text questions).
   * @param request - the questions to ask.
   * @returns the structured answers.
   */
  async askQuestions(request: AskQuestionsRequestLike): Promise<AskQuestionsAnswerLike> {
    const agent = request.agent;
    const chatId =
      agent === undefined ? undefined : this.options.sessionMap.chatFor(String(agent.session.id));
    if (chatId === undefined) {
      this.options.logger.warn('user question has no chat to render into; answering cancelled');
      return {
        answers: request.questions.map((question) => ({ id: question.id, selected: [] })),
      };
    }
    const answers = new Map<string, { readonly id: string; selected: string[]; custom?: string }>();
    let resolveAllPromise!: () => void;
    const allDone = new Promise<void>((resolve) => {
      resolveAllPromise = resolve;
    });
    let pendingCount = request.questions.length;
    let settled = false;
    const resolveAll = (): void => {
      if (settled) return;
      settled = true;
      resolveAllPromise();
    };
    const settleOne = (answer: {
      readonly id: string;
      selected: string[];
      custom?: string;
    }): void => {
      if (answers.has(answer.id)) return;
      answers.set(answer.id, answer);
      pendingCount -= 1;
      if (pendingCount <= 0) resolveAll();
    };
    const viewOf = (question: AskQuestionItemLike): QuestionView => ({
      id: question.id,
      question: question.question,
      detail: question.detail,
      options: question.options ?? [],
      multiSelect: question.multiSelect ?? false,
    });
    for (const question of request.questions) {
      const requestId = `question-${question.id}`;
      const view = viewOf(question);
      let sent: SentCard;
      try {
        sent = await this.options.transport.sendCard(
          chatId,
          buildQuestionCard(view, [], this.cardMentionFor(chatId)),
        );
      } catch (error: unknown) {
        this.options.logger.warn(`question card send failed: ${String(error)}`);
        settleOne({ id: question.id, selected: [] });
        continue;
      }
      const messageId = sent.messageId;
      // Once answered, the card becomes a static confirmation (no buttons —
      // further taps do nothing, user report). Deferred out of the card
      // callback ACK. The target is the LATEST card the interaction points
      // at (a multi-select re-post retargets it), not the initial post.
      const finalizeCard = (targetMessageId: string, answerText: string): void => {
        setTimeout(() => {
          void this.options.transport
            .updateCard(targetMessageId, buildQuestionAnsweredCard(question.question, answerText))
            .catch((error: unknown) => {
              this.options.logger.warn(`question card settle update failed: ${String(error)}`);
            });
        }, 0);
      };
      if (view.options.length === 0) {
        // Free-text: await the next message in this chat.
        this.awaitingQuestionAnswers.set(chatId, { requestId });
        this.interactions.register(requestId, chatId, messageId, (outcome) => {
          const pending = this.awaitingQuestionAnswers.get(chatId);
          if (pending?.requestId === requestId) this.awaitingQuestionAnswers.delete(chatId);
          const cancelled = outcome === 'cancelled';
          const text = cancelled ? '' : outcome;
          finalizeCard(messageId, cancelled ? 'cancelled' : outcome);
          settleOne({ id: question.id, selected: [], ...(text === '' ? {} : { custom: text }) });
        });
        continue;
      }
      if (view.multiSelect) {
        this.questionState.set(requestId, { chatId, view, selection: [], messageId });
        this.interactions.register(requestId, chatId, messageId, () => {
          const state = this.questionState.get(requestId);
          this.questionState.delete(requestId);
          const selected = state?.selection ?? [];
          finalizeCard(
            state?.messageId ?? messageId,
            selected.length === 0 ? 'cancelled' : selected.join(', '),
          );
          settleOne({ id: question.id, selected });
        });
        continue;
      }
      // Single-select: the chosen option label is the outcome.
      this.interactions.register(requestId, chatId, messageId, (outcome) => {
        finalizeCard(messageId, outcome);
        settleOne({ id: question.id, selected: [outcome] });
      });
    }
    if (request.signal !== undefined) {
      request.signal.addEventListener('abort', () => {
        for (const question of request.questions) {
          const requestId = `question-${question.id}`;
          this.awaitingQuestionAnswers.delete(chatId);
          if (!answers.has(question.id)) settleOne({ id: question.id, selected: [] });
          this.interactions.abort(requestId, 'cancelled');
        }
        resolveAll();
      });
    }
    await allDone;
    return {
      answers: request.questions.map(
        (question) => answers.get(question.id) ?? { id: question.id, selected: [] },
      ),
    };
  }

  /** The chat's current model as a `provider/model` selection arg. */
  private currentModelSelection(chatId: string): string | undefined {
    const live = this.liveAgent(chatId);
    if (live?.options?.provider !== undefined && live?.options?.model !== undefined) {
      return `${live.options.provider}/${live.options.model}`;
    }
    const selection = this.options.agentDefaultModel?.currentSelection();
    if (selection === undefined) return undefined;
    return `${selection.provider}/${selection.model}`;
  }

  /**
   * Load the model catalog for the /model picker: every registered provider
   * × its advisory model list (a failing provider catalog is skipped, loud
   * in the log). `undefined` when the llm service is absent.
   */
  private async loadModelOptions(): Promise<readonly ModelOptionView[] | undefined> {
    const llm = this.options.llm;
    if (llm === undefined) return undefined;
    const options: ModelOptionView[] = [];
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.id);
        for (const model of models) {
          options.push({
            value: `${provider.id}/${model.id}`,
            label: `${provider.id} · ${model.name}`,
            current: false,
          });
        }
      } catch (error: unknown) {
        this.options.logger.warn(`model catalog for ${provider.id} failed: ${String(error)}`);
      }
    }
    return options;
  }

  /**
   * Post the /model picker card: a dropdown of the available models with the
   * current one preselected.
   * @param chatId - the chat.
   */
  private async openModelPicker(chatId: string): Promise<void> {
    const options = await this.loadModelOptions();
    if (options === undefined) return;
    const current = this.currentModelSelection(chatId);
    const withCurrent = options.map((option) => ({
      ...option,
      current: option.value === current,
    }));
    try {
      const sent = await this.options.transport.sendCard(
        chatId,
        buildModelPickerCard(withCurrent, current),
      );
      this.modelPickerMessageIds.set(chatId, sent.messageId);
    } catch (error: unknown) {
      this.options.logger.warn(`model picker send failed: ${String(error)}`);
    }
  }

  /**
   * Ensure a session and live agent exist for the chat (used by the dsh web
   * command wrappers, which execute against an agent). Mints a session on a
   * fresh chat — documented wrapper behavior.
   * @param chatId - the chat.
   * @returns a live agent bound to the chat's session.
   */
  private async ensureAgent(chatId: string): Promise<Agent> {
    const sessionId = this.options.sessionMap.ensure(chatId);
    const live = this.options.agentStore.get(sessionId);
    if (live !== undefined) return live;
    const cwd = this.options.sessionMap.cwdFor(chatId) ?? this.options.defaultCwd;
    return this.options.agentStore.create(sessionId, cwd);
  }

  /** The normal turn flow: session resolution, streaming card, followup. */
  private async deliverTurn(message: FeishuMessage): Promise<void> {
    // A free-text question answer is captured here — the reply is the
    // answer, not a turn (bypasses the working-directory gate).
    const awaiting = this.awaitingQuestionAnswers.get(message.chatId);
    if (awaiting !== undefined) {
      this.awaitingQuestionAnswers.delete(message.chatId);
      this.interactions.resolveDirect(awaiting.requestId, message.chatId, message.text);
      return;
    }
    // The working-directory gate: without an explicit /repo pick or /cd the
    // chat is "unavailable" — DSH refuses to work there (user requirement:
    // a new group must choose a repo before any turn runs). The refused
    // message is not remembered as a retry target.
    if (
      this.options.requireWorkingDir !== false &&
      this.options.sessionMap.cwdFor(message.chatId) === undefined
    ) {
      await this.options.transport.sendText(
        message.chatId,
        '⚠️ No working directory chosen yet — DSH won’t start work here until you pick one. ' +
          'Send /repo to choose a project, or /cd <path> to set a directory.',
      );
      return;
    }
    this.lastPrompts.set(message.chatId, message.text);
    // Remember the accepted sender and chat type: proactive @-mentions in
    // groups (error notices, approval cards, question cards) target the user
    // who started this turn.
    this.requesterOpenIds.set(message.chatId, message.senderOpenId);
    this.chatTypes.set(message.chatId, message.chatType === 'group' ? 'group' : 'p2p');
    // Two-stage ack, stage 1: 👀 on the accepted message. Best-effort — a
    // failed reaction must never block the turn.
    const reactionId = await this.options.transport
      .addReaction(message.messageId, this.reactionEmojis().received)
      .catch((error: unknown) => {
        this.options.logger.warn(`received reaction failed: ${String(error)}`);
        return undefined;
      });
    this.pendingReactions.set(message.chatId, { messageId: message.messageId, reactionId });
    const sessionId = this.options.sessionMap.ensure(message.chatId);
    const cwd = this.options.sessionMap.cwdFor(message.chatId) ?? this.options.defaultCwd;
    const agent = await this.resolveAgent(message.chatId, sessionId, cwd);
    // Enter the working state: a fresh card, collapsed by default.
    this.cardStates.set(message.chatId, {
      title: turnTitle(message.text),
      content: '',
      rows: [],
      openThinkId: undefined,
      status: 'working',
      collapsed: true,
      stopRequested: false,
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
   * group messages follow `groupMentionMode`; both must pass the chat and
   * user allowlists.
   * @param message - the normalized inbound message.
   * @returns whether the surface should respond to this message.
   */
  private async shouldRespond(message: FeishuMessage): Promise<boolean> {
    const allowed = this.options.allowedChats ?? [];
    if (allowed.length > 0 && !allowed.includes(message.chatId)) {
      this.options.logger.info(`ignoring message from chat ${message.chatId}: not in allowlist`);
      return false;
    }
    const allowedUsers = this.options.allowedUsers ?? [];
    if (allowedUsers.length > 0 && !allowedUsers.includes(message.senderOpenId)) {
      this.options.logger.info(
        `ignoring message from user ${message.senderOpenId}: not in user allowlist`,
      );
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
      // turns always carry a working card state already (set by deliverTurn
      // before any event), so a card-less chat receiving a plugin-sourced
      // user message is the surface's cue to open a fresh card — otherwise
      // the reminder's response would render nowhere.
      if (
        event.type === 'user/message' &&
        event.data.source?.kind === 'plugin' &&
        typeof event.data.source.plugin === 'string'
      ) {
        const plugin = event.data.source.plugin;
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
          await this.options.cards.open(chatId, title);
        } catch (error: unknown) {
          this.options.logger.warn(`agent-initiated card unavailable: ${String(error)}`);
        }
        state = this.cardStates.get(chatId);
      }
      if (state === undefined || state.status !== 'working') return;
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
        const cwd = this.options.sessionMap.cwdFor(chatId) ?? this.options.defaultCwd;
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
        this.options.cards.patch(chatId, this.snapshot(chatId, state));
        await this.options.cards.finalize(chatId, status);
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
          await this.options.transport.sendText(
            chatId,
            `${this.textMentionFor(chatId)}⚠️ Turn failed — see the card for details`,
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
            await this.options.cards.open(chatId, '🧹 Compacting…');
          } catch (error: unknown) {
            this.options.logger.warn(`compaction card unavailable: ${String(error)}`);
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
          this.options.cards.patch(chatId, this.snapshot(chatId, state));
          await this.options.cards.finalize(chatId, status);
          await this.ackTurnEnd(chatId, status);
          const finalText = state.content.trim();
          if (finalText !== '') this.lastOutputs.set(chatId, finalText);
          if (status === 'error') {
            // A failed compaction must not go unnoticed (same rule as a
            // failed turn).
            await this.options.transport.sendText(
              chatId,
              `${this.textMentionFor(chatId)}⚠️ Compaction failed — see the card for details`,
            );
          }
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
    // The user allowlist gates card buttons too (a button IS a command —
    // everything-is-a-card); an unlisted operator must not stop turns or
    // answer approvals from an allowed chat.
    const allowedUsers = this.options.allowedUsers ?? [];
    if (allowedUsers.length > 0 && !allowedUsers.includes(action.operatorOpenId)) {
      this.options.logger.info(
        `ignoring card action from user ${action.operatorOpenId}: not in user allowlist`,
      );
      return;
    }
    const kind = action.value.kind;
    this.options.logger.info(
      `card action ${kind ?? '?'} from ${action.operatorOpenId} in ${action.chatId}`,
    );
    switch (kind) {
      case 'stop': {
        const agent = this.liveAgent(action.chatId);
        if (agent === undefined) {
          // No session mapping or no attached agent (e.g. the plugin
          // restarted and the card is stale): surface that instead of
          // silently ignoring the tap.
          this.options.logger.info(
            `stop for chat ${action.chatId}: no live agent (stale card or restarted)`,
          );
          await this.options.transport.sendText(
            action.chatId,
            'No active session to stop — the bot may have restarted. Send a message to start fresh.',
          );
          break;
        }
        if (agent.status !== 'running') {
          // The DSH web Stop cancels a running turn; an idle agent has
          // nothing to cancel (agent.cancel is a no-op then — sending
          // "Stopping…" with no follow-up read as a hang, user report).
          this.options.logger.info(`stop for chat ${action.chatId}: agent idle, nothing to stop`);
          await this.options.transport.sendText(
            action.chatId,
            'No active turn to stop — the last turn already finished.',
          );
          break;
        }
        // The same cancel the DSH web Stop button issues (session.cancel →
        // agent.cancel({kind:'user'}, {keepInbox:true})): abort the active
        // turn/driver. keepInbox preserves queued work for the next turn.
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        this.options.logger.info(`stop requested for chat ${action.chatId}`);
        // The card carries the acknowledgment: mark it Stopping and
        // re-render — no separate text bubble (user report: the standalone
        // '⏹ Stopping…' message was unnecessary).
        const state = this.cardStates.get(action.chatId);
        if (state !== undefined && state.status === 'working') {
          state.stopRequested = true;
          this.syncCard(action.chatId);
        }
        break;
      }
      case 'copy': {
        const output = this.lastOutputs.get(action.chatId);
        if (output !== undefined && output !== '') {
          await this.options.transport.sendText(action.chatId, output);
        } else {
          // A silent no-op reads as broken (user report pattern).
          await this.options.transport.sendText(
            action.chatId,
            'Nothing to copy — no completed answer yet.',
          );
        }
        break;
      }
      case 'retry': {
        const prompt = this.lastPrompts.get(action.chatId);
        if (prompt === undefined || prompt === '') {
          await this.options.transport.sendText(
            action.chatId,
            'Nothing to retry — send a message first.',
          );
          break;
        }
        // No working-directory gate here: an unpinned chat can never have a
        // remembered prompt (turns are refused before lastPrompts is set), so
        // the "Nothing to retry" branch above is the only reachable path.
        const sessionId = this.options.sessionMap.ensure(action.chatId);
        const cwd = this.options.sessionMap.cwdFor(action.chatId) ?? this.options.defaultCwd;
        const agent = await this.resolveAgent(action.chatId, sessionId, cwd);
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
          await this.options.transport.updateCard(
            action.messageId,
            buildRepoPickerCard(projects, this.options.repoRoots ?? [], page),
          );
        } catch (error: unknown) {
          this.options.logger.warn(`repo picker page refresh failed: ${String(error)}`);
        }
        break;
      }
      case 'row-details': {
        const state = this.cardStates.get(action.chatId);
        const id = action.value.id;
        const row = (state?.rows ?? []).find((r) => r.id === id);
        if (row === undefined) {
          this.options.logger.warn(`row details for unknown id ${id}`);
          break;
        }
        await this.options.transport.sendCard(action.chatId, buildRowDetailsCard(row));
        // The state machine's single render path re-asserts the streaming
        // card after the callback (botmux rule: Lark can restore the
        // pre-click card, dropping the expanded view).
        this.syncCard(action.chatId);
        break;
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
        break;
      }
      case 'panel': {
        await this.openPanel(action.chatId);
        break;
      }
      case 'panel-page': {
        const page = Number(action.value.page);
        if (!Number.isInteger(page) || page < 0) break;
        // Update the panel card IN PLACE — a page flip must not stack a new
        // card (mobile UX, user report).
        const existing = this.panelMessageIds.get(action.chatId);
        if (existing === undefined || existing !== action.messageId) {
          await this.openPanel(action.chatId, page);
          break;
        }
        try {
          await this.options.transport.updateCard(
            existing,
            this.buildPanelCardFor(action.chatId, page),
          );
        } catch (error: unknown) {
          this.options.logger.warn(`panel page refresh failed: ${String(error)}`);
        }
        this.syncCard(action.chatId);
        break;
      }
      case 'command': {
        // A panel palette button: same handler as the slash line, with the
        // same working-state gate for mutating commands (matrix rule).
        const name = action.value.name;
        const command = name === undefined ? undefined : this.commands.find(name);
        if (command === undefined) {
          this.options.logger.warn(`command button for unknown command ${name ?? '(missing)'}`);
          break;
        }
        if (
          name !== undefined &&
          this.refuseWhileWorking(action.chatId) &&
          !Bridge.ALLOWED_WHILE_WORKING.has(name)
        ) {
          await this.replyCommandResult(action.chatId, {
            kind: 'error',
            text: 'a turn is running — stop it first.',
          });
          break;
        }
        const result = await command.handler({
          chatId: action.chatId,
          senderOpenId: action.operatorOpenId,
          rawInput: '',
        });
        await this.replyCommandResult(action.chatId, result);
        break;
      }
      case 'resume-session': {
        const sessionId = action.value.sessionId;
        if (sessionId === undefined || sessionId === '') break;
        // Only the active /sessions card may resume (stale-card guard).
        if (action.messageId !== this.sessionPickerMessageIds.get(action.chatId)) {
          this.options.logger.info(`ignoring stale session resume from card ${action.messageId}`);
          break;
        }
        // The picker row carries the session's cwd so the resumed chat
        // adopts it as its pinned working directory.
        const result = await this.resumeSession(action.chatId, sessionId, action.value.cwd);
        await this.replyCommandResult(action.chatId, result);
        break;
      }
      case 'sessions-page': {
        if (action.messageId !== this.sessionPickerMessageIds.get(action.chatId)) {
          this.options.logger.info(`ignoring stale sessions page from card ${action.messageId}`);
          break;
        }
        const page = Number(action.value.page);
        if (!Number.isInteger(page) || page < 0) break;
        const rows = await this.loadSessions(action.chatId);
        if (rows === undefined) {
          await this.options.transport.sendText(
            action.chatId,
            'Session list unavailable — the session query service is not mounted.',
          );
          break;
        }
        try {
          await this.options.transport.updateCard(action.messageId, buildSessionsCard(rows, page));
        } catch (error: unknown) {
          this.options.logger.warn(`sessions picker page refresh failed: ${String(error)}`);
        }
        break;
      }
      case 'permission-pick': {
        // Dropdown selections arrive in `option`; the (legacy) button
        // fallback stamps the preset in `value.preset`.
        const preset = action.option ?? action.value.preset;
        if (preset === undefined || preset === '') break;
        // Only the active permission picker may select (stale-card guard).
        if (action.messageId !== this.permissionPickerMessageIds.get(action.chatId)) {
          this.options.logger.info(`ignoring stale permission pick from card ${action.messageId}`);
          break;
        }
        if (this.refuseWhileWorking(action.chatId)) {
          await this.replyCommandResult(action.chatId, {
            kind: 'error',
            text: 'a turn is running — stop it first.',
          });
          break;
        }
        const service = this.options.permissionPresets;
        const agent = this.liveAgent(action.chatId);
        if (service === undefined || agent === undefined) {
          await this.options.transport.sendText(
            action.chatId,
            'Permission pick unavailable — the bot may have restarted. Send /permission again.',
          );
          break;
        }
        try {
          service.set(agent.session, preset);
        } catch (error: unknown) {
          this.options.logger.warn(`permission pick failed: ${String(error)}`);
          await this.replyCommandResult(action.chatId, {
            kind: 'error',
            text: `could not switch to preset ${preset}: ${String(error)}`,
          });
          break;
        }
        const option = service.optionOf(preset);
        await this.options.transport.sendText(
          action.chatId,
          `Permission preset switched to ${option.name ?? preset}.`,
        );
        break;
      }
      case 'model-pick': {
        // Dropdown selections arrive in `option` (`provider/model`); the
        // button fallback stamps it in `value.selection`.
        const selection = action.option ?? action.value.selection;
        if (selection === undefined || selection === '') break;
        // Only the active model picker may select (stale-card guard).
        if (action.messageId !== this.modelPickerMessageIds.get(action.chatId)) {
          this.options.logger.info(`ignoring stale model pick from card ${action.messageId}`);
          break;
        }
        if (this.refuseWhileWorking(action.chatId)) {
          await this.replyCommandResult(action.chatId, {
            kind: 'error',
            text: 'a turn is running — stop it first.',
          });
          break;
        }
        const service = this.options.agentDefaultModel;
        if (service === undefined) {
          await this.options.transport.sendText(
            action.chatId,
            'Model pick unavailable — the agentDefaultModel service is not mounted.',
          );
          break;
        }
        const parsed = parseModelArg(selection);
        if (!parsed.ok) {
          await this.options.transport.sendText(action.chatId, `⚠️ ${parsed.error}`);
          break;
        }
        await service.saveSelection(parsed.selection);
        await this.options.transport.sendText(
          action.chatId,
          `Default model set to ${parsed.selection.provider} · ${parsed.selection.model} (applies to new sessions).`,
        );
        break;
      }
      case 'model-page': {
        if (action.messageId !== this.modelPickerMessageIds.get(action.chatId)) {
          this.options.logger.info(`ignoring stale model page from card ${action.messageId}`);
          break;
        }
        const page = Number(action.value.page);
        if (!Number.isInteger(page) || page < 0) break;
        const options = await this.loadModelOptions();
        if (options === undefined) break;
        const current = this.currentModelSelection(action.chatId);
        try {
          const sent = await this.options.transport.sendCard(
            action.chatId,
            buildModelPickerCard(options, current, page),
          );
          this.modelPickerMessageIds.set(action.chatId, sent.messageId);
        } catch (error: unknown) {
          this.options.logger.warn(`model picker page refresh failed: ${String(error)}`);
        }
        break;
      }
      case 'approval': {
        const id = action.value.id;
        const decision = action.value.decision;
        if (id === undefined || (decision !== 'allow' && decision !== 'reject')) break;
        this.interactions.resolveOnce(
          id,
          action.chatId,
          action.messageId,
          decision === 'allow' ? 'allowed-once' : 'rejected',
        );
        break;
      }
      case 'question': {
        // Single-select: the chosen option label is the answer.
        const id = action.value.id;
        const answer = action.value.answer;
        if (id === undefined || answer === undefined) break;
        this.interactions.resolveOnce(`question-${id}`, action.chatId, action.messageId, answer);
        break;
      }
      case 'question-toggle': {
        // Multi-select: flip one option and re-post the card with
        // checkmarks; the newest card becomes the interaction target.
        const id = `question-${action.value.id ?? ''}`;
        const option = action.value.option;
        const state = this.questionState.get(id);
        if (state === undefined || option === undefined) break;
        state.selection = state.selection.includes(option)
          ? state.selection.filter((entry) => entry !== option)
          : [...state.selection, option];
        try {
          const sent = await this.options.transport.sendCard(
            state.chatId,
            buildQuestionCard(state.view, state.selection),
          );
          this.interactions.retarget(id, sent.messageId);
          state.messageId = sent.messageId;
        } catch (error: unknown) {
          this.options.logger.warn(`question toggle re-post failed: ${String(error)}`);
        }
        break;
      }
      case 'question-submit': {
        const id = `question-${action.value.id ?? ''}`;
        this.interactions.resolveOnce(id, action.chatId, action.messageId, 'submit');
        break;
      }
      case 'question-cancel': {
        const id = `question-${action.value.id ?? ''}`;
        this.awaitingQuestionAnswers.delete(action.chatId);
        this.interactions.resolveOnce(id, action.chatId, action.messageId, 'cancelled');
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
      name: 'panel',
      description: 'Open the control panel card (all commands as buttons)',
      category: 'system',
      hiddenFromPanel: true,
      handler: async (invocation) => {
        await this.openPanel(invocation.chatId);
        return { kind: 'success', text: '' };
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
      buttonLabel: '⏹ Stop turn',
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
            buildRepoPickerCard(projects, roots),
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
    this.commands.register({
      name: 'feishu-status',
      description: 'Show the surface diagnostic card (connection, sessions, activity)',
      category: 'system',
      buttonLabel: '📡 Surface status',
      handler: async (invocation) => {
        const raw = this.options.transport.connectionState?.();
        const connection: StatusView['connection'] =
          this.options.transportMode === 'memory' ? 'memory' : (raw ?? 'unknown');
        await options.transport.sendCard(
          invocation.chatId,
          buildStatusCard({
            appId: options.appId ?? '(not configured)',
            connection,
            sessionCount: options.sessionMap.size,
            lastInboundAt: this.lastInboundAtValue,
          }),
        );
        return { kind: 'success', text: '' };
      },
    });
    // /schedule: list this chat's active reminders. The dsh-schedule package
    // is optional at runtime — dynamic import + loud degradation (the agent
    // itself can list reminders through its schedule tools when the surface
    // cannot).
    this.commands.register({
      name: 'schedule',
      description: 'List active reminders for this chat',
      category: 'system',
      buttonLabel: '⏰ Reminders',
      handler: async (invocation) => {
        const sessionId = options.sessionMap.get(invocation.chatId);
        if (sessionId === undefined) {
          return { kind: 'error', text: 'no session yet — send a message first.' };
        }
        if (options.readSession === undefined) {
          return {
            kind: 'error',
            text: 'schedule listing unavailable — the session query service is not mounted.',
          };
        }
        try {
          const { foldScheduleEvents, scheduleView } = await import('@deepseek-ai/dsh-schedule');
          const log = await options.readSession(sessionId);
          const folded = foldScheduleEvents(log.events as never);
          if (folded.active.length === 0) {
            return {
              kind: 'success',
              text: 'No active reminders — ask the agent to create one (e.g. “remind me in 5 minutes”).',
            };
          }
          const now = Date.now();
          const lines = folded.active.map((record) => {
            const view = scheduleView(record, now);
            const prompt = record.prompt === '' ? '(no prompt)' : record.prompt;
            const rule =
              record.kind === 'after'
                ? `after ${record.afterSeconds}s`
                : record.kind === 'at'
                  ? `at ${record.scheduledAt}`
                  : `every ${record.everySeconds}s`;
            return `${rule} · ${prompt} (${view.state})`;
          });
          return { kind: 'success', text: `Active reminders:\n${lines.join('\n')}` };
        } catch (error: unknown) {
          this.options.logger.warn(`schedule listing unavailable: ${String(error)}`);
          return {
            kind: 'error',
            text: 'schedule listing unavailable — ask the agent to list reminders instead.',
          };
        }
      },
    });
    this.commands.register({
      name: 'model',
      description:
        'Choose a model (opens the picker); or /model <provider>/<model> to set the default',
      category: 'system',
      buttonLabel: '🤖 Model',
      handler: async (invocation) => {
        const raw = invocation.rawInput.trim();
        if (raw === '') {
          if (this.options.llm !== undefined) {
            // A bare /model (or the panel button) opens the picker so the
            // user can actually CHOOSE a model — the button must not just
            // pass through (user report).
            await this.openModelPicker(invocation.chatId);
            return { kind: 'success', text: '' };
          }
          // No catalog: fall back to the text display.
          // The live agent's own options win (what this session actually
          // runs); otherwise the deployment default.
          const live = this.liveAgent(invocation.chatId);
          const liveSelection =
            live !== undefined &&
            live.options?.provider !== undefined &&
            live.options?.model !== undefined
              ? { provider: live.options.provider, model: live.options.model }
              : undefined;
          const selection: ModelSelectionView | undefined =
            liveSelection ?? this.options.agentDefaultModel?.currentSelection();
          if (selection === undefined) {
            return {
              kind: 'error',
              text: 'no model selection available — the agentDefaultModel service is not mounted.',
            };
          }
          const effort =
            selection.reasoningEffort === undefined ? '' : ` · effort ${selection.reasoningEffort}`;
          return {
            kind: 'success',
            text: `model: ${selection.provider} · ${selection.model}${effort}`,
          };
        }
        const parsed = parseModelArg(raw);
        if (!parsed.ok) return { kind: 'error', text: parsed.error };
        const service = this.options.agentDefaultModel;
        if (service === undefined) {
          return {
            kind: 'error',
            text: 'model switching unavailable — the agentDefaultModel service is not mounted.',
          };
        }
        await service.saveSelection(parsed.selection);
        return {
          kind: 'success',
          text: `Default model set to ${parsed.selection.provider} · ${parsed.selection.model} (applies to new sessions).`,
        };
      },
    });
    this.commands.register({
      name: 'export',
      description: 'Export this chat’s session log as a file',
      category: 'system',
      buttonLabel: '📤 Export',
      handler: async (invocation) => {
        const sessionId = options.sessionMap.get(invocation.chatId);
        if (sessionId === undefined) {
          return { kind: 'error', text: 'no session to export yet — send a message first.' };
        }
        if (options.readSession === undefined) {
          return {
            kind: 'error',
            text: 'session export unavailable — the session query service is not mounted.',
          };
        }
        try {
          const log = await options.readSession(sessionId);
          const transcript = buildSessionExport(log.events);
          const fileName = `session-${sessionId}.md`;
          await options.transport.sendFile(invocation.chatId, fileName, transcript);
          return {
            kind: 'success',
            text: `Exported ${log.events.length} events to ${fileName}.`,
          };
        } catch (error: unknown) {
          this.options.logger.warn(`session export failed: ${String(error)}`);
          const detail = String(error);
          const scopeHint = detail.includes('im:resource')
            ? ' — the Feishu app needs the im:resource:upload permission scope (developer console → Permissions).'
            : '';
          return { kind: 'error', text: `session export failed: ${detail}${scopeHint}` };
        }
      },
    });
    this.commands.register({
      name: 'sessions',
      description: 'List saved sessions and resume one in this chat',
      category: 'session',
      buttonLabel: '🗂️ Sessions',
      handler: async (invocation) => {
        await this.openSessionsPicker(invocation.chatId);
        return { kind: 'success', text: '' };
      },
    });
    this.commands.register({
      name: 'resume',
      description: 'Resume a saved session (no id opens the session list)',
      category: 'session',
      buttonLabel: '↩️ Resume session',
      handler: async (invocation) => {
        const target = invocation.rawInput.trim();
        if (target === '') {
          await this.openSessionsPicker(invocation.chatId);
          return { kind: 'success', text: '' };
        }
        const result = await this.resumeSession(invocation.chatId, target);
        return result;
      },
    });
    // /clear and /new share one handler: start a fresh conversation. The old
    // session is NOT deleted — it stays saved and resumable (/sessions) — so
    // the reset never destroys user data (content-integrity rule).
    const startFresh = async (invocation: {
      readonly chatId: string;
      readonly senderOpenId: string;
      readonly rawInput: string;
    }): Promise<CommandResult> => {
      if (this.refuseWhileWorking(invocation.chatId)) {
        return { kind: 'error', text: 'a turn is running — stop it first.' };
      }
      if (options.sessionMap.get(invocation.chatId) === undefined) {
        return { kind: 'error', text: 'nothing to clear — this chat has no session yet.' };
      }
      options.sessionMap.remint(invocation.chatId);
      this.resetChatState(invocation.chatId);
      return {
        kind: 'success',
        text: 'New conversation started — the previous session stays saved; /sessions can resume it.',
      };
    };
    this.commands.register({
      name: 'clear',
      description: 'Start a fresh conversation (previous session stays saved)',
      category: 'session',
      buttonLabel: '✨ Fresh start',
      // /new IS the panel button; /clear stays a slash-only alias (the two
      // commands are the same action — duplicate buttons confuse (user report)).
      hiddenFromPanel: true,
      handler: startFresh,
    });
    this.commands.register({
      name: 'new',
      description: 'Start a new conversation (alias of /clear)',
      category: 'session',
      buttonLabel: '➕ New chat',
      handler: startFresh,
    });
    for (const spec of HARNESS_COMMANDS) {
      this.commands.register({
        name: spec.name,
        description: spec.description,
        category: 'system',
        buttonLabel: spec.buttonLabel,
        handler: async (invocation) => {
          if (this.refuseWhileWorking(invocation.chatId)) {
            return { kind: 'error', text: 'a turn is running — stop it first.' };
          }
          if (options.executeCommand === undefined) {
            return {
              kind: 'error',
              text: `/${spec.name} is unavailable — the dsh command registry is not mounted.`,
            };
          }
          const agent = await this.ensureAgent(invocation.chatId);
          const result = await options.executeCommand(agent, `/${spec.name}${invocation.rawInput}`);
          if (result !== undefined) return result;
          return {
            kind: 'error',
            text: `/${spec.name} is unavailable on this deployment.`,
          };
        },
      });
    }
    // /permission: typed presets pass through to the harness command; a bare
    // /permission (or the panel button) opens the preset picker card so the
    // user can actually choose — the bare harness command only reports.
    this.commands.register({
      name: 'permission',
      description: 'Switch the permission preset — sandbox mode + approval policy (dsh web)',
      category: 'system',
      buttonLabel: '🔐 Permission',
      handler: async (invocation) => {
        const raw = invocation.rawInput.trim();
        if (raw !== '') return this.runHarnessCommand(invocation, 'permission');
        if (this.refuseWhileWorking(invocation.chatId)) {
          return { kind: 'error', text: 'a turn is running — stop it first.' };
        }
        if (this.options.permissionPresets === undefined) {
          // Degraded: no picker data source — fall back to the harness report.
          this.options.logger.warn(
            '[feishu] permissionPresets service unavailable; /permission degraded to report',
          );
          return this.runHarnessCommand(invocation, 'permission');
        }
        await this.openPermissionPicker(invocation.chatId);
        return { kind: 'success', text: '' };
      },
    });
    // /plan: `off` and message forms pass through; a bare /plan (or the
    // panel button) TOGGLES plan mode through ctx.planMode — pressing it
    // again leaves plan mode (user report: bare /plan only ever entered).
    this.commands.register({
      name: 'plan',
      description: 'Enter or leave plan mode (dsh web)',
      category: 'system',
      buttonLabel: '🗺️ Plan mode',
      handler: async (invocation) => {
        const raw = invocation.rawInput.trim();
        if (raw !== '') return this.runHarnessCommand(invocation, 'plan');
        if (this.refuseWhileWorking(invocation.chatId)) {
          return { kind: 'error', text: 'a turn is running — stop it first.' };
        }
        const planMode = this.options.planMode;
        if (planMode === undefined) {
          // Degraded: no controller — fall back to the harness behavior.
          this.options.logger.warn(
            '[feishu] planMode service unavailable; bare /plan degraded to harness behavior',
          );
          return this.runHarnessCommand(invocation, 'plan');
        }
        const agent = await this.ensureAgent(invocation.chatId);
        const state = planMode.get(agent);
        const target = !(state.pending ?? state.active);
        const outcome = planMode.set(agent, target);
        return { kind: 'success', text: planModeResultText(target, outcome) };
      },
    });
  }

  /** Execute one harness command through the dsh registry (shared by the
   *  web-command wrappers): ensure an agent, run the line, map the result. */
  private async runHarnessCommand(
    invocation: { readonly chatId: string; readonly rawInput: string },
    name: string,
  ): Promise<CommandResult> {
    const options = this.options;
    if (options.executeCommand === undefined) {
      return {
        kind: 'error',
        text: `/${name} is unavailable — the dsh command registry is not mounted.`,
      };
    }
    const agent = await this.ensureAgent(invocation.chatId);
    const result = await options.executeCommand(agent, `/${name}${invocation.rawInput}`);
    if (result !== undefined) return result;
    return { kind: 'error', text: `/${name} is unavailable on this deployment.` };
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
  private syncCard(chatId: string): void {
    const state = this.cardStates.get(chatId);
    if (state === undefined) return;
    if (state.status === 'working') {
      this.options.cards.patch(chatId, this.snapshot(chatId, state));
      return;
    }
    const messageId = this.options.cards.lastMessageId(chatId);
    if (messageId === undefined) return;
    const card = buildCard(this.snapshot(chatId, state));
    setTimeout(() => {
      void this.options.transport.updateCard(messageId, card).catch((error: unknown) => {
        this.options.logger.warn(`streaming card sync failed: ${String(error)}`);
      });
    }, 0);
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
      await this.options.transport
        .removeReaction(pending.messageId, pending.reactionId)
        .catch((error: unknown) => {
          this.options.logger.warn(`ack reaction remove failed: ${String(error)}`);
        });
    }
    await this.options.transport
      .addReaction(pending.messageId, terminal)
      .catch((error: unknown) => {
        this.options.logger.warn(`ack reaction add failed: ${String(error)}`);
      });
  }

  /** Build the render snapshot from the authoritative state. */
  private snapshot(chatId: string, state: ChatCardState): CardSnapshot {
    return {
      title: state.title,
      content: state.content,
      rows: state.rows,
      cwd: this.options.sessionMap.cwdFor(chatId) ?? this.options.defaultCwd,
      collapsed: state.collapsed,
      stopRequested: state.stopRequested,
      status: state.status,
    };
  }
}
