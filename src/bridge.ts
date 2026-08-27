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

import { Readable } from 'node:stream';
import type { Agent } from '@deepseek-ai/dsh-agent';
import {
  type ContentBlock,
  createUserMessage,
  MessageId,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import {
  InteractionCardController,
  type InteractionCardHost,
} from './cards/InteractionCardController.js';
import {
  buildInboundFileCard,
  buildPanelCard,
  buildQueueItemCard,
  buildResultCard,
  type ModelOptionView,
  type PanelCommand,
  type QueueItemStatus,
} from './cards/render.js';
import {
  StreamingCardController,
  type StreamingCardHost,
} from './cards/StreamingCardController.js';
import type { SessionDetailView, SessionRowView } from './cards/session-list.js';
import type { StreamingCardManager } from './cards/streaming.js';
import { registerSurfaceCommands, type SurfaceCommandHost } from './commands/surface.js';
import { CommandRegistry, type CommandResult, parseSlash } from './commands.js';
import { resolveDirectory } from './directory.js';
import type {
  CardAction,
  CardJson,
  FeishuMessage,
  FeishuTransport,
  InboundAttachment,
} from './feishu/types.js';
import { readLogFile } from './log-file.js';
import { MessageDeduplicator } from './message-dedup.js';
import { parseModelArg } from './model-args.js';
import { sessionSelection } from './model-switch.js';
import type { PanelActionContext } from './panel/actions/PanelAction.js';
import { buildPanelActionRegistry } from './panel/actions/registry.js';
import { PanelController, type PanelHost } from './panel/PanelController.js';
import type { PanelViewContext } from './panel/views/PanelViewContext.js';
import { buildPanelViewRegistry } from './panel/views/registry.js';
import { type ProjectInfo, scanMultipleProjects } from './projects.js';
import { buildSessionExport, type SessionExportEvent } from './session-export.js';
import type { SessionMap } from './session-map.js';

export type { PanelInputCommand, PanelView } from './panel/types.js';

/** One pending inbound attachment (inbound-wait-instruction): saved to the
 *  workspace, awaiting the user's follow-up instruction. */
export interface PendingInboundFile {
  /** The attachment that was saved. */
  attachment: InboundAttachment;
  /** The display name (user file name or key). */
  name: string;
  /** The real on-disk path, or `undefined` when the save failed. */
  savedPath: string | undefined;
}

import type { PanelView } from './panel/types.js';

export {
  isPanelInputCommand,
  PANEL_CONFIRM_SPEC,
  PANEL_INPUT_SPEC,
  panelConfirmCopy,
  panelInputCopy,
} from './panel/types.js';

import { turnTitle } from './cards/StreamingCardController.js';
import { t } from './i18n/index.js';

export { turnTitle } from './cards/StreamingCardController.js';

/** Sniff a file extension (no dot) from leading bytes, for inbound files —
 *  Feishu file events carry no original name, so the surface derives a
 *  usable extension from the content. Unknown content → `bin`. */
export function sniffExtension(data: Uint8Array): string {
  const head = data.slice(0, 8);
  const startsWith = (bytes: readonly number[]): boolean => bytes.every((b, i) => head[i] === b);
  const text = new TextDecoder().decode(head);
  if (startsWith([0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'jpg';
  if (text.startsWith('GIF8')) return 'gif';
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    String.fromCharCode(data[8] ?? 0, data[9] ?? 0, data[10] ?? 0, data[11] ?? 0) === 'WEBP'
  )
    return 'webp';
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    String.fromCharCode(data[8] ?? 0, data[9] ?? 0, data[10] ?? 0, data[11] ?? 0) === 'AVI '
  )
    return 'avi';
  // MP4/MOV (ISO BMFF): the `ftyp` box starts at offset 4.
  if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return 'mp4';
  // WebM/MKV (EBML): 1A 45 DF A3.
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (text.startsWith('{"') || text.startsWith('[{')) return 'json';
  if (text.startsWith('<?xml')) return 'xml';
  // Plain text (no control bytes in the head) → txt.
  const printable = [...head].every(
    (b) => b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e),
  );
  if (printable) return 'txt';
  return 'bin';
}

/** Minimal logger surface the bridge needs. */
export interface BridgeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Debug tracing (printed only when FEISHU_DEBUG=1). */
  debug(message: string): void;
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
  /**
   * Input modalities the model accepts (`'image'` when it can see images).
   * Used by the inbound-attachment gate: an `image` content block is only
   * injected when the chat's current model advertises image input.
   */
  readonly inputModalities?: readonly string[];
}

/** Structural subset of `ctx.llm` (`@deepseek-ai/dsh-llm`, mounted by
 *  dsh-base): provider routes and their advisory model catalogs. */
export interface LlmService {
  listProviders(): readonly { readonly id: string; readonly name: string }[];
  listModels(provider: string): Promise<readonly LlmModelView[]>;
  /** Optional model-context resolution (dsh `resolveModelInfo`), used for the
   *  stats line's context-occupancy group. Absent → the group is omitted. */
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ readonly context?: { readonly contextWindow?: number } }>;
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
  /** The surface data directory (default `$DSH_HOME/feishu`); the operator
   *  log lives at `$dataDir/logs/dsh-feishu.log` (see `log-file.ts`). */
  readonly dataDir: string;
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
   * Session-title seam (`ctx.sessionTitle`, mounted by dsh-base): renames a
   * live session durably (`session/title` event, web-visible). Absent, the
   * detail view hides the Rename button.
   */
  readonly sessionTitle?: {
    rename(session: unknown, title: string): unknown;
  };
  /**
   * Workspace-registry seam (`ctx.workspaceRegistry`, mounted by the
   * storage×3 + workspace bundle rows): archives/restores sessions through
   * the durable storage domain (web-visible). Resolved lazily because the
   * service initializes asynchronously after apply; a startup-time snapshot
   * would be permanently undefined. Absent, the Archive button is hidden.
   */
  readonly getWorkspaceRegistry?: () =>
    | {
        archiveSession(sessionId: string): Promise<unknown>;
        readonly archivedSessionIds: readonly string[];
      }
    | undefined;
  /**
   * Inbound-file seam: persist one downloaded file under the chat's working
   * directory at `<cwd>/.dsh_feishu/attachments/<appId>/<chatId>/<name>.<ext>`
   * so the agent can read it with its workspace tools. Bucketed per app +
   * chat so the WeChat-style name dedupe fires when the same chat re-sends a
   * same-named file (a per-message bucket would never collide). Implemented
   * by the host (index.ts) where fs access lives; the bridge only names the
   * file. Absent, files degrade to a name-only note (the receipt card still
   * posts).
   */
  readonly saveInboundFile?: (input: {
    /** The chat whose working directory holds the file. */
    chatId: string;
    /** The Feishu app id the surface runs as (bucket segment). */
    appId: string;
    /** The normalized attachment (key + optional name). */
    attachment: InboundAttachment;
    /** The downloaded body, streamed (not buffered) so large files pipe to
     *  disk without a memory spike (botmux lesson). The leading bytes have
     *  been read for sniffing and pushed back, so the full body is here. */
    stream: NodeJS.ReadableStream;
    /** A sniffed extension (pdf/zip/txt/json/bin…), no leading dot. */
    extension: string;
  }) => Promise<{ path: string }>;
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
   * settles. Defaults GoGoGo / DONE / ERROR / ERROR — valid Feishu
   * `emoji_type` values (WARN is not in the platform's reaction table).
   * Reaction failures only log — they never block the turn.
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

/** Whether a group is a 1-person-1-bot solo group (mention gate relaxation). */
function isSoloGroup(stats: { userCount: number; botCount: number }): boolean {
  return stats.userCount <= 1 && stats.botCount <= 1;
}

/** Remove inline @-mention tokens from message text (Feishu renders each
 *  mention as `@_user_<n>` or `@<label>` inline, not always the `<at>`
 *  placeholder the transport strips), so "@bot /help" dispatches as
 *  "/help". Untouched when the text carries no mention, so blank or plain
 *  messages pass through byte-for-byte. */
function stripMentions(text: string): string {
  if (!text.includes('@')) return text;
  return text
    .replace(/@[^\s@/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The user-visible text of one queued message (message-queue): the joined
 * `text` blocks of its content, used for the queue-card row preview and the
 * edit default. Empty when a message carries only non-text blocks.
 */
function queueMessageText(message: { readonly content: readonly ContentBlock[] }): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** One queue item's dedicated-card lifecycle entry (message-queue). */
interface QueueCardEntry {
  /** The posted card's message id (`undefined` until the first post lands —
   *  a failed first post falls back to a fresh `sendCard`). */
  cardMessageId: string | undefined;
  /** The item's lifecycle state. */
  status: QueueItemStatus;
  /** The item's text (kept after it leaves the active queue so the retained
   *  marker card can still show the preview). */
  text: string;
  /** The resolved user message for the queued item. The surface owns the queue
   *  (NOT the agent inbox), so this is what the surface later re-delivers as a
   *  normal turn (`deliverQueuedTurn` → `followup`) after the owning turn ends,
   *  or steers into the running turn (`agent.steer`). An edit rewrites the
   *  content but keeps the same identity, so the card actions stay stable. */
  message: UserMessage;
  /** The original inbound message (identity + sender + chat type), kept so the
   *  re-delivered turn can open its streaming card with the real ack id and
   *  restore the proactive @-mention target. */
  feishu: FeishuMessage;
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
  /** Epoch ms of the last accepted inbound message (any chat), for
   *  `/feishu-status`. */
  private lastInboundAtValue: number | undefined;
  /** The streaming-card state machine (per-chat state + single render path). */
  private readonly streaming: StreamingCardController;
  /** The panel state machine (view stack + single render path). */
  private readonly panel: PanelController;
  /** Panel card actions (Strategy registry; Template Method lifecycle). */
  private readonly panelActions = buildPanelActionRegistry();
  /** Panel view states (Strategy registry; async-ness declared per view). */
  private readonly panelViews = buildPanelViewRegistry();
  /** Approval/question card flows (one resolve path per pending interaction). */
  private readonly interactions: InteractionCardController;
  /** Last user whose accepted message started a turn, per chat (proactive
   *  @-mention target for error/approval/question posts in groups). */
  private readonly requesterOpenIds = new Map<string, string>();
  /** Chat type of the last accepted message per chat (`p2p` needs no @). */
  private readonly chatTypes = new Map<string, 'p2p' | 'group'>();
  /**
   * Pending inbound attachments per chat (inbound-wait-instruction): bare
   * attachment messages (file/image/video — no text) register here instead
   * of starting a turn. The next text message in the chat drains the list
   * into its turn, in order. Not persisted across restarts.
   */
  private readonly pendingInbound = new Map<string, PendingInboundFile[]>();
  /**
   * The per-item queue card registry (message-queue). One dedicated card per
   * queued message, one lifecycle state per card — NO shared "N queued" card
   * and NO recall/re-post single-card invariant. `Map<chatId, Map<itemId,
   * entry>>`; the entry carries the owning card's message id (for in-place
   * `updateCard`), the item's lifecycle state, and its text (needed to render
   * the retained marker card after the item leaves the inbox).
   */
  private readonly queueCards = new Map<string, Map<string, QueueCardEntry>>();
  /**
   * The surface-owned, in-memory queue of a chat's pending non-steer messages
   * (message-queue). Unlike `inbox.nextTurn` — which the agent loop auto-claims
   * at its own step boundary and would bypass `deliverTurn` — these items are
   * never handed to the inbox: after the current turn ends the surface delivers
   * them ITSELF via `deliverQueuedTurn`, which opens each streaming card. Not
   * persisted: a restart drops queued messages (accepted trade-off).
   */
  private readonly queued = new Map<string, QueueCardEntry[]>();

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

  /** The live agent for a chat, or `undefined` (no session or not attached). */
  private liveAgent(chatId: string): Agent | undefined {
    const sessionId = this.options.sessionMap.get(chatId);
    return sessionId === undefined ? undefined : this.options.agentStore.get(sessionId);
  }
  private readonly disposeEvents: () => void;
  private readonly commands = new CommandRegistry();

  constructor(private readonly options: BridgeOptions) {
    this.streaming = new StreamingCardController(this.streamingHost());
    this.panel = new PanelController(this.panelHost());
    this.interactions = new InteractionCardController(this.interactionHost());
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
    registerSurfaceCommands(this.commands, this.commandHost());
  }

  /** The InteractionCardHost the interaction controller delegates to. */
  private interactionHost(): InteractionCardHost {
    return {
      transport: this.options.transport,
      logger: this.options.logger,
      sessionMap: this.options.sessionMap,
      cardMentionFor: (chatId) => this.cardMentionFor(chatId),
      syncCard: (chatId) => this.streaming.syncCard(chatId),
    };
  }

  /** The StreamingCardHost the streaming controller delegates to: Bridge
   *  owns agent resolution and proactive mentions; the controller owns the
   *  card state machine. */
  private streamingHost(): StreamingCardHost {
    return {
      transport: this.options.transport,
      cards: this.options.cards,
      logger: this.options.logger,
      sessionMap: this.options.sessionMap,
      agentStore: this.options.agentStore,
      defaultCwd: this.options.defaultCwd,
      reactions: this.options.reactions,
      resolveAgent: (chatId, sessionId, cwd) => this.resolveAgent(chatId, sessionId, cwd),
      resolveContextWindow: (chatId, sessionId, cwd) =>
        this.resolveContextWindow(chatId, sessionId, cwd),
      textMentionFor: (chatId) => this.textMentionFor(chatId),
      sendLogFile: (chatId) => this.sendLogFile(chatId).then(() => {}),
    };
  }

  /** All surface commands (the control-panel button source). */
  commandsList(): readonly import('./commands.js').SurfaceCommand[] {
    return this.commands.list();
  }

  /** The PanelHost the panel controller delegates to: Bridge owns the
   *  business logic (result cards, streaming-card sync); view rendering goes
   *  through the view registry (PanelViewStates). */
  private panelHost(): PanelHost {
    return {
      transport: this.options.transport,
      logger: this.options.logger,
      renderPanelView: (chatId, view) =>
        this.panelViews.render(this.panelViewContext(), chatId, view),
      isAsyncView: (view) => this.panelViews.isAsync(view),
      buildMenuCard: (chatId, page) => this.buildPanelCardFor(chatId, page),
      syncCard: (chatId) => this.streaming.syncCard(chatId),
      resultCard: (chatId, result) => this.replyResultCard(chatId, result),
      text: (chatId, text) => this.options.transport.sendText(chatId, text),
    };
  }

  /** The seam every panel view state renders against: the Bridge's data
   *  sources (session list, project scan, model catalog, permission presets)
   *  plus the menu-card builder. View states depend on this interface, never
   *  on Bridge internals (see `panel/views/PanelViewContext.ts`). */
  private panelViewContext(): PanelViewContext {
    return {
      buildMenuCard: (chatId, page) => this.buildPanelCardFor(chatId, page),
      loadSessions: (chatId, archived) => this.loadSessions(chatId, archived),
      sessionDetail: (chatId, sessionId) => this.sessionDetailView(chatId, sessionId),
      listProjects: (roots) => listProjects(roots),
      repoRoots: this.options.repoRoots ?? [],
      loadModelOptions: () => this.loadModelOptions(),
      currentModelSelection: (chatId) => this.currentModelSelection(chatId),
      ensureAgent: (chatId) => this.ensureAgent(chatId),
      permissionPresets: () => this.options.permissionPresets,
      canMutateSessions:
        this.options.sessionTitle !== undefined || this.options.getWorkspaceRegistry !== undefined,
    };
  }

  /** The seam every panel action runs against: navigation (the panel
   *  controller), the working-state gate, the command registry, and the
   *  Bridge's business helpers. Actions depend on this interface, never on
   *  Bridge internals (see `panel/actions/PanelAction.ts`). The context is
   *  bound to ONE panel card (`messageId`) — every navigation updates that
   *  card, so tapping an old card updates itself, never a different one. */
  private panelContext(messageId: string): PanelActionContext {
    return {
      services: {
        transport: this.options.transport,
        sessionMap: this.options.sessionMap,
        agentStore: this.options.agentStore,
        logger: this.options.logger,
        defaultCwd: this.options.defaultCwd,
        requireWorkingDir: this.options.requireWorkingDir,
        repoRoots: this.options.repoRoots,
        sessionTitle: this.options.sessionTitle,
        getWorkspaceRegistry: this.options.getWorkspaceRegistry,
        permissionPresets: this.options.permissionPresets,
        planMode: this.options.planMode,
        agentDefaultModel: this.options.agentDefaultModel,
        llm: this.options.llm,
        listSessions: this.options.listSessions,
      },
      messageId,
      openPanel: (chatId) => this.openPanel(chatId),
      pushPanel: (chatId, view) => this.pushPanel(chatId, messageId, view),
      replacePanel: (chatId, view) => this.replacePanel(chatId, messageId, view),
      popPanel: (chatId) => this.popPanel(chatId, messageId),
      popToMenu: (chatId) => this.popToMenu(chatId, messageId),
      canReturn: (chatId) => this.panel.canReturn(chatId, messageId),
      popToDetail: (chatId) => this.popToDetail(chatId, messageId),
      panelViewFor: (chatId) => this.panelViewFor(chatId, messageId),
      panelStack: (chatId) => this.panelStack(chatId, messageId),
      runPanelOperation: (chatId, title, work, finish) =>
        this.runPanelOperation(chatId, messageId, title, work, finish),
      replyResultCard: (chatId, result) => this.replyResultCard(chatId, result),
      replyText: (chatId, text) => this.options.transport.sendText(chatId, text),
      isWorking: (chatId) => this.refuseWhileWorking(chatId),
      allowedWhileWorking: (kind) => Bridge.ALLOWED_WHILE_WORKING.has(kind),
      findCommand: (name) => this.commands.find(name),
      ensureAgent: (chatId) => this.ensureAgent(chatId),
      liveAgent: (chatId) => this.liveAgent(chatId),
      resumeSession: (chatId, sessionId, cwd) => this.resumeSession(chatId, sessionId, cwd),
      exportSessionLog: (chatId, sessionId) => this.exportSessionLog(chatId, sessionId),
      loadSessions: (chatId, archived) => this.loadSessions(chatId, archived),
      currentModelSelection: (chatId) => this.currentModelSelection(chatId),
      loadModelOptions: () => this.loadModelOptions(),
      resolveDirectory: (input) => resolveDirectory(input),
      parseModelArg: (raw) => parseModelArg(raw),
    };
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
    // A known-but-unhandled Feishu message type (folder, sticker, …) gets a
    // loud notice instead of vanishing — the user must learn the bot cannot
    // process it (misconfiguration fails loud). No turn, no pending.
    if (message.unsupportedType !== undefined) {
      this.options.logger.info(
        `message ${message.messageId}: unsupported type ${message.unsupportedType} (chat ${message.chatId})`,
      );
      await this.options.transport.sendText(
        message.chatId,
        t('inbound.unsupportedType', { type: message.unsupportedType }) +
          (message.unsupportedType === 'folder' ? t('inbound.folderNote') : ''),
      );
      return;
    }
    this.lastInboundAtValue = Date.now();
    this.options.logger.info(
      `inbound message ${message.messageId} in ${message.chatId} (${message.chatType}): ${message.text.slice(0, 80)}`,
    );
    // Feishu renders inline @-mentions as `@<label>` tokens. Strip them
    // before dispatch so "@bot /help" (or a mention mid-text) parses as the
    // slash command instead of falling into the working-directory gate as a
    // plain message. The agent also sees the cleaned text.
    const text = stripMentions(message.text);
    const slash = parseSlash(text);
    if (slash !== undefined) {
      this.options.logger.debug(
        `message ${message.messageId} -> slash command /${slash.name} (chat ${message.chatId})`,
      );
      await this.handleCommand(message, slash);
      return;
    }
    // Inbound-wait-instruction: a bare attachment message (no text) is
    // registered as pending — every attachment (file OR image, both treated
    // as plain files) lands on disk and a receipt card posts, but NO turn
    // starts. The user's follow-up text message drains the pending list into
    // its turn (the agent then works on the files). Attachment messages
    // cannot carry a mention (Feishu sends them without an input box), so
    // this is also where the mention gate is bypassed for groups — handled
    // in shouldRespond.
    if (text === '' && (message.attachments?.length ?? 0) > 0) {
      this.options.logger.debug(
        `message ${message.messageId} -> pending attachment (chat ${message.chatId})`,
      );
      await this.registerPending(message);
      return;
    }
    this.options.logger.debug(`message ${message.messageId} -> turn (chat ${message.chatId})`);
    await this.deliverTurn(text === message.text ? message : { ...message, text });
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
        this.options.logger.debug(
          `command /${slash.name} refused: a turn is running (chat ${message.chatId})`,
        );
        await this.replyCommandResult(message.chatId, {
          kind: 'error',
          text: t('command.error.turnRunning'),
        });
        return;
      }
      const result = await command.handler({
        chatId: message.chatId,
        senderOpenId: message.senderOpenId,
        rawInput: slash.rawInput,
      });
      this.options.logger.debug(
        `command /${slash.name} (chat ${message.chatId}) -> ${result.kind}`,
      );
      await this.replyCommandResult(message.chatId, result);
      return;
    }
    const line = `/${slash.name}${slash.rawInput}`;
    const sessionId = this.options.sessionMap.get(message.chatId);
    const agent = sessionId === undefined ? undefined : this.options.agentStore.get(sessionId);
    if (this.options.executeCommand !== undefined && agent !== undefined) {
      const result = await this.options.executeCommand(agent, line);
      if (result !== undefined) {
        this.options.logger.debug(
          `command ${line} -> dsh passthrough (chat ${message.chatId}) -> ${result.kind}`,
        );
        await this.replyCommandResult(message.chatId, result);
        return;
      }
    }
    if (this.options.unknownCommand === 'passthrough') {
      this.options.logger.debug(`unknown command ${line}: passthrough as a turn`);
      await this.deliverTurn(message);
      return;
    }
    this.options.logger.debug(`unknown command ${line}: replying with help hint`);
    await this.options.transport.sendText(message.chatId, t('command.unknown', { line }));
  }

  /** Send a command result as a text message (empty text posts no message). */
  private async replyCommandResult(chatId: string, result: CommandResult): Promise<void> {
    const text = result.kind === 'error' ? `⚠️ ${result.text}` : result.text;
    if (text !== '') await this.options.transport.sendText(chatId, text);
  }

  /**
   * Post a panel action's FINAL result as a NEW pure-information card (no
   * buttons/inputs) — the panel principle: intermediate steps live in the
   * panel card, results leave it as an inert card (user requirement).
   * @param chatId - the chat.
   * @param result - the command result to render.
   */
  private async replyResultCard(chatId: string, result: CommandResult): Promise<void> {
    const text = result.kind === 'error' ? `⚠️ ${result.text}` : result.text;
    if (text === '') return;
    const title = result.kind === 'error' ? t('result.failedTitle') : t('card.status.note.done');
    await this.options.transport
      .sendCard(chatId, buildResultCard(title, text, result.kind === 'error'))
      .catch(async (error: unknown) => {
        this.options.logger.warn(`result card send failed: ${String(error)}`);
        await this.options.transport.sendText(chatId, text).catch(() => {});
      });
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
    return this.streaming.isWorking(chatId);
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
    'find-session',
    'cancel',
    'group',
    'model',
    'panel',
  ]);

  /** Reset a chat's card state: no live card, no copy/retry targets. Used by
   *  /clear and /resume so the resumed/new conversation starts clean. */
  private resetChatState(chatId: string): void {
    this.streaming.resetChat(chatId);
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
      return { kind: 'error', text: t('command.error.turnRunning') };
    }
    if (this.options.sessionMap.get(chatId) === sessionId) {
      return { kind: 'error', text: t('resume.error.sessionBusy', { sessionId }) };
    }
    const agent = this.options.agentStore.get(sessionId);
    if (agent !== undefined && agent.status === 'running') {
      return {
        kind: 'error',
        text: t('resume.error.sessionTurnRunning', { sessionId }),
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
    const hint = this.options.sessionMap.cwdFor(chatId) === undefined ? t('resume.noCwdHint') : '';
    return {
      kind: 'success',
      text: t('resume.success', { sessionId }) + hint,
    };
  }

  /**
   * Load the session list for /sessions, marking the chat's current session.
   * Degrades to a bound-sessions-only listing when the query service is
   * absent (loud in the log).
   * @param chatId - the requesting chat.
   * @returns session rows, or `undefined` when listing is unavailable.
   */
  private async loadSessions(
    chatId: string,
    archived = false,
  ): Promise<readonly SessionRowView[] | undefined> {
    let rows: SessionRowView[] | undefined;
    if (this.options.listSessions === undefined) {
      this.options.logger.warn(
        '[feishu] listSessions unavailable; /sessions degraded to bound sessions',
      );
      const current = this.options.sessionMap.get(chatId);
      const seen = new Set<string>();
      const bound: SessionRowView[] = [];
      for (const chat of this.options.sessionMap.chats()) {
        const sessionId = this.options.sessionMap.get(chat);
        if (sessionId === undefined || seen.has(sessionId)) continue;
        seen.add(sessionId);
        bound.push({
          sessionId,
          title: chat === chatId ? 'this chat' : `chat ${chat}`,
          cwd: this.options.sessionMap.cwdFor(chat),
          createdAt: 0,
          live: this.options.agentStore.get(sessionId) !== undefined,
          persisted: false,
          current: sessionId === current,
        });
      }
      rows = bound;
    } else {
      const listed = await this.options.listSessions();
      if (listed === undefined) return undefined;
      const current = this.options.sessionMap.get(chatId);
      rows = listed.map((row) => ({
        ...row,
        current: row.sessionId === current,
      }));
    }
    // Archive filtering needs the host archive set; without the seam every
    // session is active.
    const archivedIds = await this.loadArchivedSessionIds();
    if (archivedIds.size === 0) return rows;
    return archived
      ? rows.filter((row) => archivedIds.has(row.sessionId))
      : rows.filter((row) => !archivedIds.has(row.sessionId));
  }

  /** The host's archived session id set, or empty when the seam is absent. */
  private async loadArchivedSessionIds(): Promise<Set<string>> {
    try {
      const workspace = this.options.getWorkspaceRegistry?.();
      if (workspace === undefined) return new Set();
      return new Set(workspace.archivedSessionIds);
    } catch (error: unknown) {
      this.options.logger.warn(`archived session list failed: ${String(error)}`);
      return new Set();
    }
  }

  /** Build one session's detail view for the panel detail sub-view. */
  private async sessionDetailView(
    chatId: string,
    sessionId: string,
  ): Promise<SessionDetailView | undefined> {
    const rows = await this.loadSessions(chatId);
    const row = rows?.find((entry) => entry.sessionId === sessionId);
    let messageCount = 0;
    let lastSummary: string | undefined;
    if (this.options.readSession !== undefined) {
      try {
        const log = await this.options.readSession(sessionId);
        messageCount = log.events.length;
        for (let index = log.events.length - 1; index >= 0; index -= 1) {
          const event = log.events[index];
          if (event?.type !== 'assistant/message') continue;
          const text = (event.data?.message?.content ?? [])
            .filter((block) => block?.type === 'text')
            .map((block) => block.text ?? '')
            .join('');
          if (text !== '') {
            lastSummary = text;
            break;
          }
        }
      } catch (error: unknown) {
        this.options.logger.warn(`session detail read failed: ${String(error)}`);
      }
    }
    if (row === undefined) return undefined;
    const archivedIds = await this.loadArchivedSessionIds();
    return {
      sessionId,
      title: row.title,
      cwd: row.cwd,
      createdAt: row.createdAt,
      messageCount,
      lastSummary,
      live: row.live,
      current: row.current,
      archived: archivedIds.has(sessionId),
    };
  }

  /** Export ANY session's log as a file message (session detail action). */
  private async exportSessionLog(chatId: string, sessionId: string): Promise<CommandResult> {
    if (this.options.readSession === undefined) {
      return {
        kind: 'error',
        text: t('command.error.exportUnavailable'),
      };
    }
    try {
      const log = await this.options.readSession(sessionId);
      const transcript = buildSessionExport(log.events);
      const fileName = `session-${sessionId}.md`;
      await this.options.transport.sendFile(chatId, fileName, new TextEncoder().encode(transcript));
      return {
        kind: 'success',
        text: t('command.info.exportedEvents', { count: log.events.length, file: fileName }),
      };
    } catch (error: unknown) {
      this.options.logger.warn(`session export failed: ${String(error)}`);
      const detail = String(error);
      const scopeHint = detail.includes('im:resource') ? t('inbound.unavailableUploadScope') : '';
      return { kind: 'error', text: t('command.error.exportFailed', { detail }) + scopeHint };
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

  /** Open (or page) the control panel: a fresh card + reset stack. */
  private async openPanel(chatId: string, page = 0): Promise<string> {
    return this.panel.openPanel(chatId, page);
  }

  /** THE single wrapper for async panel operations (patch-first guarantee). */
  private async runPanelOperation(
    chatId: string,
    messageId: string,
    title: string,
    work: () => CommandResult | undefined | Promise<CommandResult | undefined>,
    finish: () => Promise<void>,
  ): Promise<void> {
    await this.panel.runPanelOperation(chatId, messageId, title, work, finish);
  }

  /** PUSH a sub-view onto the panel stack and render it. */
  private async pushPanel(chatId: string, messageId: string, view: PanelView): Promise<void> {
    await this.panel.pushPanel(chatId, messageId, view);
  }

  /** POP one level (Back); the menu root never pops. */
  private async popPanel(chatId: string, messageId: string): Promise<void> {
    await this.panel.popPanel(chatId, messageId);
  }

  /** Replace the stack top (e.g. a page flip). */
  private async replacePanel(chatId: string, messageId: string, view: PanelView): Promise<void> {
    await this.panel.replacePanel(chatId, messageId, view);
  }

  /** POP back to the menu root (keeping its page). */
  private async popToMenu(chatId: string, messageId: string): Promise<void> {
    await this.panel.popToMenu(chatId, messageId);
  }

  /** POP back to the session detail (after a rename completes), if present. */
  private async popToDetail(chatId: string, messageId: string): Promise<void> {
    await this.panel.popToDetail(chatId, messageId);
  }

  /** The panel view stack for a chat. */
  private panelStack(chatId: string, messageId: string): PanelView[] {
    return this.panel.panelStack(chatId, messageId);
  }

  /** The current panel view (the stack top), defaulting to the menu root. */
  private panelViewFor(chatId: string, messageId: string): PanelView {
    return this.panel.panelViewFor(chatId, messageId);
  }

  /** Construct the panel card for a chat at the given command page. */
  private buildPanelCardFor(chatId: string, page: number): CardJson {
    const agent = this.liveAgent(chatId);
    const running = agent !== undefined && agent.status === 'running';
    const stopped = this.streaming.state(chatId)?.status === 'stopped';
    const output = this.streaming.lastOutput(chatId);
    const statusLine = running
      ? t('panel.cardMenu.running')
      : stopped
        ? t('panel.cardMenu.stopped')
        : output === undefined
          ? t('panel.cardMenu.idle')
          : t('panel.cardMenu.ready');
    // The panel carries the chat's session context so a tap always shows
    // which session the buttons act on. An unpinned chat (no /repo or /cd)
    // surfaces the working-directory requirement instead of a fake cwd.
    const sessionId = this.options.sessionMap.get(chatId);
    const pinned = this.options.sessionMap.cwdFor(chatId);
    const cwd = pinned ?? this.options.defaultCwd;
    const contextLine =
      pinned === undefined && this.options.requireWorkingDir !== false
        ? t('panel.context.noCwd')
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
    if (planMode === undefined) return t('panel.planMode.plan');
    const sessionId = this.options.sessionMap.get(chatId);
    const agent = sessionId === undefined ? undefined : this.options.agentStore.get(sessionId);
    if (agent === undefined) return t('panel.planMode.plan');
    const current = planMode.get(agent);
    const active = current.pending ?? current.active;
    return active ? t('panel.planMode.leave') : t('panel.planMode.plan');
  }

  /**
   * Handle one `approval/request` (the surface's answerer): map the agent to
   * its chat, post an approval card, and wait for the card callback (or
   * timeout/abort → `'cancelled'`). Fail-closed `'unavailable'` when the
   * chat is unknown or the card cannot be posted.
   * @param request - the approval request.
   * @returns the settlement outcome.
   */
  /**
   * Handle one `approval/request` (the surface's answerer): map the agent to
   * its chat, post an approval card, and wait for the card callback (or
   * timeout/abort → `'cancelled'`). Fail-closed `'unavailable'` when the
   * chat is unknown or the card cannot be posted.
   * @param request - the approval request.
   * @returns the settlement outcome.
   */
  async handleApprovalRequest(request: ApprovalRequestLike): Promise<ApprovalOutcomeLike> {
    return this.interactions.handleApprovalRequest(request);
  }

  /**
   * Answer one `AskUserQuestionRequest` as the surface's userQuestions
   * provider: post a question card per item and collect the answers through
   * card callbacks (or the next chat message for free-text questions).
   * @param request - the questions to ask.
   * @returns the structured answers.
   */
  async askQuestions(request: AskQuestionsRequestLike): Promise<AskQuestionsAnswerLike> {
    return this.interactions.askQuestions(request);
  }

  /** The chat's current model as a `provider/model` selection arg. */
  private currentModelSelection(chatId: string): string | undefined {
    const live = this.liveAgent(chatId);
    // A session-switched model (via `/model`, dsh web parity) takes precedence:
    // applySessionModelSwitch writes `selection.current` into the agent's coupled
    // ref, but the agent's static `options` is NOT mutated, so reading it first
    // would show the pre-switch model (the #40 display bug). Fall back to the
    // agent's static options, then the deployment default.
    const switched = sessionSelection(live?.ctx)?.current;
    if (switched !== undefined) {
      return `${switched.provider}/${switched.model}`;
    }
    if (live?.options?.provider !== undefined && live?.options?.model !== undefined) {
      return `${live.options.provider}/${live.options.model}`;
    }
    const selection = this.options.agentDefaultModel?.currentSelection();
    if (selection === undefined) return undefined;
    return `${selection.provider}/${selection.model}`;
  }

  /** Best-effort model context window (tokens) for a chat's current model.
   *  Resolves the agent's `provider/model`, queries the llm service's
   *  optional `resolveModelInfo`, and returns `context.contextWindow`.
   *  Returns `undefined` when the model is unknown, the llm service does not
   *  expose `resolveModelInfo`, or resolution fails — the stats line omits the
   *  context group in every such case. */
  private async resolveContextWindow(
    chatId: string,
    _sessionId: string,
    _cwd: string,
  ): Promise<number | undefined> {
    const llm = this.options.llm;
    const selection = this.currentModelSelection(chatId);
    if (llm === undefined || selection === undefined || llm.resolveModelInfo === undefined) {
      return undefined;
    }
    const slash = selection.indexOf('/');
    if (slash <= 0 || slash === selection.length - 1) return undefined;
    const provider = selection.slice(0, slash);
    const model = selection.slice(slash + 1);
    try {
      const info = await llm.resolveModelInfo(provider, model);
      return info.context?.contextWindow;
    } catch (error: unknown) {
      this.options.logger.warn(
        `context-window ${chatId}: resolveModelInfo ${selection} failed (${String(error)})`,
      );
      return undefined;
    }
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
   * Ensure a session and live agent exist for the chat (used by the dsh web
   * command wrappers, which execute against an agent). Mints a session on a
   * fresh chat — documented wrapper behavior. For a persisted session with no
   * live agent, RESUME before create — a bare create on a session the
   * persisted state already owns throws ("persisted state already owns this
   * identity") and wedges the surface (user report: /permission showed "The
   * panel view could not be rendered" and every later panel button went
   * dead).
   * @param chatId - the chat.
   * @returns a live agent bound to the chat's session.
   */
  private async ensureAgent(chatId: string): Promise<Agent> {
    const sessionId = this.options.sessionMap.ensure(chatId);
    const live = this.options.agentStore.get(sessionId);
    if (live !== undefined) return live;
    const cwd = this.options.sessionMap.cwdFor(chatId) ?? this.options.defaultCwd;
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

  /** The normal turn flow: session resolution, streaming card, followup. */
  private async deliverTurn(message: FeishuMessage): Promise<void> {
    // A free-text question answer is captured here — the reply is the
    // answer, not a turn (bypasses the working-directory gate).
    if (this.interactions.answerFreeText(message.chatId, message.text)) {
      this.options.logger.debug(
        `message ${message.messageId}: captured as free-text question answer`,
      );
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
      this.options.logger.debug(
        `message ${message.messageId}: refused by working-directory gate (no cwd)`,
      );
      await this.options.transport.sendText(message.chatId, t('gate.workingDirRequired'));
      return;
    }
    // The message-queue gate: a message that arrives while a turn is running
    // is NOT delivered as an interrupting turn — it is kept in the surface's
    // OWN queue (never `inbox.nextTurn`, which the agent loop auto-claims at
    // its step boundary and would bypass `deliverTurn`) and surfaced on its OWN
    // queue card. When the owning turn ends the surface delivers it as a normal
    // turn (opening its streaming card). Degrade to a normal turn when no live
    // agent (or no inbox) exists (today's behavior).
    const live = this.liveAgent(message.chatId);
    if (
      live !== undefined &&
      live.inbox !== undefined &&
      this.streaming.isWorking(message.chatId)
    ) {
      const queued = createUserMessage({
        content: await this.inboundContent(message),
        source: { kind: 'user' },
      });
      const entry: QueueCardEntry = {
        cardMessageId: undefined,
        status: 'queued',
        text: queueMessageText(queued),
        message: queued,
        feishu: message,
      };
      this.queueCardEntries(message.chatId).set(queued.id, entry);
      this.queuedFor(message.chatId).push(entry);
      await this.renderQueueItem(message.chatId, queued.id, entry);
      this.options.logger.debug(`message ${message.messageId} -> queued (chat ${message.chatId})`);
      return;
    }
    this.streaming.rememberPrompt(message.chatId, message.text);
    // Remember the accepted sender and chat type: proactive @-mentions in
    // groups (error notices, approval cards, question cards) target the user
    // who started this turn.
    this.requesterOpenIds.set(message.chatId, message.senderOpenId);
    this.chatTypes.set(message.chatId, message.chatType === 'group' ? 'group' : 'p2p');
    // Inbound media (image/file messages): download and inject BEFORE the
    // turn starts — a broken attachment notices loudly but never wedges the
    // chat (the turn continues, text-only when the attachment failed).
    const content = await this.inboundContent(message);
    // Inbound-wait-instruction: prepend any pending attachments (bare file
    // messages that arrived earlier) so this text message's turn works on
    // them too, in arrival order.
    this.drainPending(message.chatId, content);
    // Two-stage ack stage 1 + the working card state + the card open (the
    // streaming controller's beginTurn; a failed reaction or card post must
    // never block the turn).
    await this.streaming.beginTurn(message.chatId, message.messageId, turnTitle(message.text));
    const sessionId = this.options.sessionMap.ensure(message.chatId);
    const cwd = this.options.sessionMap.cwdFor(message.chatId) ?? this.options.defaultCwd;
    const agent = await this.resolveAgent(message.chatId, sessionId, cwd);
    this.options.logger.info(`delivering message ${message.messageId} to agent`);
    agent.followup(
      createUserMessage({
        content,
        source: { kind: 'user' },
      }),
    );
  }

  /**
   * The queue-item card registry for a chat (get-or-create). One dedicated
   * card per queued message, keyed by its message id.
   * @param chatId - the chat.
   * @returns the per-chat item→entry map.
   */
  private queueCardEntries(chatId: string): Map<string, QueueCardEntry> {
    let entries = this.queueCards.get(chatId);
    if (entries === undefined) {
      entries = new Map();
      this.queueCards.set(chatId, entries);
    }
    return entries;
  }

  /**
   * The surface-owned pending queue for a chat (get-or-create), in arrival
   * order (message-queue). The SOURCE OF TRUTH for which non-steer queued
   * messages are still waiting to be delivered; {@link queueCardEntries} is the
   * per-item card registry (which also retains terminal/sent/removed marker
   * cards).
   * @param chatId - the chat.
   * @returns the ordered pending queue.
   */
  private queuedFor(chatId: string): QueueCardEntry[] {
    let queue = this.queued.get(chatId);
    if (queue === undefined) {
      queue = [];
      this.queued.set(chatId, queue);
    }
    return queue;
  }

  /** The still-pending queue item for an item id in a chat, or `undefined`
   *  when the item was already delivered/steered/removed (message-queue).
   *  @param chatId - the chat.
   *  @param itemId - the item's (stable) message id.
   *  @returns the pending entry, or `undefined` when not in the active queue. */
  private queuedItem(chatId: string, itemId: MessageId): QueueCardEntry | undefined {
    return this.queued.get(chatId)?.find((entry) => entry.message.id === itemId);
  }

  /** Take one item out of a chat's pending surface queue (message-queue). The
   *  per-item card registry keeps the entry, so the retained card still renders.
   *  @param chatId - the chat.
   *  @param itemId - the item's (stable) message id. */
  private removeQueued(chatId: string, itemId: MessageId): void {
    const queue = this.queued.get(chatId);
    if (queue === undefined) return;
    const index = queue.findIndex((entry) => entry.message.id === itemId);
    if (index >= 0) queue.splice(index, 1);
  }

  /**
   * Render one queue item's dedicated card (message-queue) from its registry
   * entry. When the card was already posted, it is updated IN PLACE via
   * `updateCard` (never delete+send); a first-post failure falls back to a
   * fresh `sendCard`. Card-render failures log and leave the registry state
   * untouched (the next mutation re-renders).
   * @param chatId - the chat.
   * @param itemId - the item's message id.
   * @param entry - the item's lifecycle entry.
   */
  private async renderQueueItem(
    chatId: string,
    itemId: string,
    entry: QueueCardEntry,
  ): Promise<void> {
    const card = buildQueueItemCard(
      { id: itemId, text: entry.text, status: entry.status },
      this.streaming.isWorking(chatId),
    );
    if (entry.cardMessageId !== undefined) {
      try {
        await this.options.transport.updateCard(entry.cardMessageId, card);
      } catch (error: unknown) {
        this.options.logger.warn(
          `queue item card update failed (chat ${chatId}): ${String(error)}`,
        );
      }
      return;
    }
    try {
      const sent = await this.options.transport.sendCard(chatId, card);
      entry.cardMessageId = sent.messageId;
    } catch (error: unknown) {
      this.options.logger.warn(`queue item card send failed (chat ${chatId}): ${String(error)}`);
    }
  }

  /**
   * One queue-item card button callback (message-queue). Each queued message
   * has its OWN card with its OWN lifecycle state: Steer (only while a turn
   * runs) marks the item `steering` and steers the running turn (via
   * `agent.steer` — the surface queue no longer feeds the agent inbox); Edit
   * opens the inline edit form (`editing`); Edit submit replaces the text and
   * returns to `queued`; Edit cancel returns to `queued` unchanged; Remove
   * marks the item `removed`. The item stays in the surface queue (pending
   * delivery) for every non-terminal state. Terminal state cards (steered/sent/
   * removed) are RETAINED with their marker — never recalled. When the item
   * raced the drain a notice posts.
   * @param action - the normalized card callback.
   */
  private async handleQueueCardAction(action: CardAction): Promise<void> {
    // A live agent is needed only for Steer (`agent.steer`); edit/remove act on
    // the surface queue alone. Degrade loudly when the agent is gone.
    const agent = this.liveAgent(action.chatId);
    if (agent === undefined) {
      this.options.logger.warn(
        `queue card action ${action.value.kind} ignored: no live agent for chat ${action.chatId}`,
      );
      return;
    }
    const kind = action.value.kind;
    const id = action.value.id;
    if (id === undefined) {
      this.options.logger.warn(`queue card action ${kind} ignored: missing item id`);
      return;
    }
    const messageId = MessageId(id);
    const entry = this.queueCardEntries(action.chatId).get(id);
    if (entry === undefined) {
      this.options.logger.warn(
        `queue card action ${kind} ignored: unknown item ${id} (chat ${action.chatId})`,
      );
      return;
    }
    // The item is still waiting in the surface queue (pending delivery). Once
    // it leaves (delivered/steered/removed) the action raced the drain.
    const pending = this.queuedItem(action.chatId, messageId) !== undefined;
    switch (kind) {
      case 'queue-steer': {
        // Steer is available only while a turn runs (mirror the web
        // `steer-unavailable` guard); when idle the card renders a disabled
        // hint and this never fires.
        if (!this.streaming.isWorking(action.chatId)) {
          this.options.logger.info(`queue steer ignored: no turn running (chat ${action.chatId})`);
          await this.renderQueueItem(action.chatId, id, entry);
          break;
        }
        if (pending) {
          // Take the item out of the pending surface queue and steer it into
          // the running turn. `agent.steer` routes to the next-step boundary,
          // NOT the next-turn list — so it never auto-claims a streaming card.
          this.removeQueued(action.chatId, messageId);
          this.streaming.noteSteer(action.chatId, id);
          entry.status = 'steering';
          agent.steer(entry.message);
          this.options.logger.debug(
            `queue steer ${id} -> running turn, card steering (chat ${action.chatId})`,
          );
        } else {
          await this.markItemConsumed(action.chatId, id, entry);
        }
        await this.renderQueueItem(action.chatId, id, entry);
        break;
      }
      case 'queue-edit': {
        // Open the inline edit form on THIS card. The item must still be
        // pending; otherwise it raced the drain.
        if (pending) {
          entry.status = 'editing';
          this.options.logger.debug(`queue edit open ${id} (chat ${action.chatId})`);
          await this.renderQueueItem(action.chatId, id, entry);
        } else {
          await this.markItemConsumed(action.chatId, id, entry);
        }
        break;
      }
      case 'queue-edit-submit': {
        const text = action.value.text ?? action.formValue?.text;
        if (text === undefined || text === '') {
          this.options.logger.warn(
            `queue edit submit ${id} ignored: no replacement text (chat ${action.chatId})`,
          );
          await this.renderQueueItem(action.chatId, id, entry);
          break;
        }
        if (pending) {
          // Rewrite the queued content but keep the SAME identity — the card's
          // action buttons reference that stable id, and the pending queue key
          // stays valid. The re-delivered turn uses the edited content.
          const stableId = entry.message.id;
          const rewritten = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          });
          entry.message = { ...rewritten, id: stableId };
          entry.text = text;
          entry.status = 'queued';
          this.options.logger.debug(`queue edit ${id} -> queued (chat ${action.chatId})`);
          await this.renderQueueItem(action.chatId, id, entry);
        } else {
          await this.markItemConsumed(action.chatId, id, entry);
        }
        break;
      }
      case 'queue-edit-cancel': {
        entry.status = 'queued';
        this.options.logger.debug(`queue edit cancel ${id} -> queued (chat ${action.chatId})`);
        await this.renderQueueItem(action.chatId, id, entry);
        break;
      }
      case 'queue-remove': {
        if (pending) {
          this.removeQueued(action.chatId, messageId);
          entry.status = 'removed';
          this.options.logger.debug(`queue remove ${id} -> removed (chat ${action.chatId})`);
          await this.renderQueueItem(action.chatId, id, entry);
        } else {
          await this.markItemConsumed(action.chatId, id, entry);
        }
        break;
      }
      default: {
        this.options.logger.warn(`unknown queue card action kind: ${kind}`);
      }
    }
  }

  /**
   * An item-steering/editing/removing action raced the surface drain — the
   * item was already delivered (or consumed another way). Mark it `sent` (if
   * still queued/editing) and render its retained marker card.
   * @param chatId - the chat.
   * @param itemId - the item's message id.
   * @param entry - the item's lifecycle entry.
   */
  private async markItemConsumed(
    chatId: string,
    itemId: string,
    entry: QueueCardEntry,
  ): Promise<void> {
    if (entry.status === 'queued' || entry.status === 'editing') {
      entry.status = 'sent';
    }
    await this.options.transport.sendText(chatId, t('queue.alreadyConsumed'));
    await this.renderQueueItem(chatId, itemId, entry);
  }

  /**
   * Deliver one queued item as its own turn (message-queue). Called from
   * {@link drainQueue} on `turn/end` when the surface-owned queue for a chat is
   * non-empty; the item goes out as a normal turn (rememberPrompt → beginTurn →
   * followup) so it opens its OWN streaming card, exactly like a freshly
   * arrived message. The queue gate and working-directory gate are deliberately
   * bypassed — a queued message must go out regardless of cwd (today's
   * behavior) and must never be re-queued. Uses the resolved content already
   * built when it was queued (no re-download of attachments, no duplicate
   * receipt card).
   * @param chatId - the chat.
   * @param item - the queued item to deliver.
   */
  private async deliverQueuedTurn(chatId: string, item: QueueCardEntry): Promise<void> {
    const source = item.feishu;
    // Keep the proactive @-mention target for this chat: the queued message's
    // sender started the turn that now runs.
    this.requesterOpenIds.set(chatId, source.senderOpenId);
    this.chatTypes.set(chatId, source.chatType === 'group' ? 'group' : 'p2p');
    this.streaming.rememberPrompt(chatId, item.text);
    await this.streaming.beginTurn(chatId, source.messageId, turnTitle(item.text));
    const sessionId = this.options.sessionMap.ensure(chatId);
    const cwd = this.options.sessionMap.cwdFor(chatId) ?? this.options.defaultCwd;
    const agent = await this.resolveAgent(chatId, sessionId, cwd);
    this.options.logger.info(`delivering queued message ${item.message.id} to agent`);
    agent.followup(item.message);
    this.options.logger.debug(`queue drain (chat ${chatId}): delivered ${item.message.id} -> sent`);
  }

  /**
   * Release a chat's pending surface queue (message-queue). Called on
   * `turn/end`: the owning turn is over, so any queued non-steer message can
   * now run as its own turn. One item is delivered per turn/end — a delivery
   * (followup) starts a turn, and delivering the next immediately would put it
   * in the agent inbox where the loop auto-claims it without a streaming card.
   * The chain continues on the next turn/end. Each delivered item is marked
   * `sent` (retained marker) and removed from the pending queue.
   * @param chatId - the chat.
   */
  private async drainQueue(chatId: string): Promise<void> {
    const queue = this.queued.get(chatId);
    if (queue === undefined || queue.length === 0) return;
    const item = queue[0];
    if (item === undefined) return;
    if (item.status !== 'queued' && item.status !== 'editing') {
      // A terminal-status item should never sit in the pending queue; drop it.
      queue.shift();
      return;
    }
    try {
      await this.deliverQueuedTurn(chatId, item);
      item.status = 'sent';
    } catch (error: unknown) {
      // Unlikely (resolveAgent rebinds on creation errors, beginTurn is best
      // effort); fail loud and drop the item so it does not wedge the queue.
      this.options.logger.error(`queue drain delivery failed: ${String(error)}`);
      item.status = 'removed';
    }
    queue.shift();
    await this.renderQueueItem(chatId, item.message.id, item);
  }

  /**
   * Reconcile the per-item queue cards after a session event (message-queue).
   * Three transitions the surface observes here: (a) on `turn/end` it drains the
   * surface-owned queue — each queued non-steer message is delivered as its own
   * turn (opening its streaming card) and its card is marked `sent`; (b) on a
   * turn boundary the running state flips, so a pending card's Steer
   * availability re-renders; (c) a steered message's `user/message` event (the
   * trace got its steering row) marks the steered item's card `steered`.
   * Best-effort — fires only when the chat has a queue-card registry.
   * @param chatId - the chat.
   * @param event - the session event just rendered.
   */
  private async syncQueueAfterEvent(chatId: string, event: SessionEvent): Promise<void> {
    const entries = this.queueCards.get(chatId);
    if (entries === undefined || entries.size === 0) return;
    // (a) The owning turn ended: release the surface queue in order — the agent
    // loop no longer auto-claims inbox next-turn, so the surface delivers each
    // queued message itself (opening its streaming card).
    if (event.type === 'turn/end') {
      await this.drainQueue(chatId);
    }
    const turnBoundary = event.type === 'turn/start' || event.type === 'turn/end';
    for (const [itemId, entry] of [...entries]) {
      // (b) On a turn boundary the running state flips; keep the pending card's
      // Steer availability accurate (Steer shows only while a turn runs).
      if (turnBoundary && (entry.status === 'queued' || entry.status === 'editing')) {
        await this.renderQueueItem(chatId, itemId, entry);
      }
    }
    // (c) A steered message was consumed into the running turn.
    if (event.type === 'user/message') {
      const itemId = event.data.id;
      const entry = entries.get(itemId);
      if (entry !== undefined && entry.status === 'steering') {
        this.options.logger.debug(
          `queue steered (chat ${chatId}): message ${itemId} consumed into the turn`,
        );
        entry.status = 'steered';
        await this.renderQueueItem(chatId, itemId, entry);
      }
    }
  }

  /**
   * Build the agent-visible content blocks for one inbound message. Text
   * messages pass through unchanged. Image attachments are downloaded and
   * committed through the attachment seam, then injected as `image` content
   * blocks; file attachments post a receipt card and contribute a
   * file-name note. Failures notice loudly and degrade to text-only — the
   * message is never silently dropped.
   * @param message - the normalized inbound message.
   * @returns the content blocks for the agent's user message.
   */
  private async inboundContent(message: FeishuMessage): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    if (message.text !== '') blocks.push({ type: 'text', text: message.text });
    // `attachments` is always present on normalized messages; the guard
    // covers transport-level JSON without the field (defensive only).
    // Every attachment (image or file) is saved as a plain file under the
    // chat's attachment bucket — a Feishu image is just a file to the agent
    // (it reads it with its workspace tools; there is no image content block
    // / visual-input path, per the unified-attachment decision).
    for (const attachment of message.attachments ?? []) {
      await this.inboundFile(message, attachment, blocks);
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: message.text });
    return blocks;
  }

  /** Download + persist one inbound file under the chat's working directory,
   *  post the receipt card, and append a note with the REAL saved path to
   *  `blocks` (the agent reads the file with its workspace tools). Failures
   *  notice loudly and still let the turn run text-only. */
  private async inboundFile(
    message: FeishuMessage,
    attachment: InboundAttachment,
    blocks: ContentBlock[],
  ): Promise<void> {
    const pending = await this.saveInboundFileAttachment(message, attachment);
    try {
      await this.options.transport.sendCard(
        message.chatId,
        buildInboundFileCard(pending.name, pending.savedPath, 1),
      );
    } catch (error: unknown) {
      this.options.logger.warn(`file receipt card failed: ${String(error)}`);
    }
    blocks.push({
      type: 'text',
      text:
        pending.savedPath === undefined
          ? `[user sent a file: ${pending.name}]`
          : `[user sent a file: ${pending.name} — saved at ${pending.savedPath}. You can read it with your file tools.]`,
    });
  }

  /**
   * Download one inbound attachment and persist it under the chat's working
   * directory. Files stream through the message-resource API; images are
   * downloaded as bytes and re-wrapped as a stream, so BOTH land in the same
   * attachment bucket as plain files (a Feishu image is just a file to the
   * agent — it reads it with its workspace tools; there is no image content
   * block / visual input path). Failures notice loudly and return an entry
   * with no path (the message is never silently dropped, and a broken
   * attachment never wedges the chat).
   * @param message - the owning message.
   * @param attachment - the attachment to download.
   * @returns the pending entry (name + real path when the save succeeded).
   */
  private async saveInboundFileAttachment(
    message: FeishuMessage,
    attachment: InboundAttachment,
  ): Promise<PendingInboundFile> {
    const name = attachment.name ?? attachment.key;
    let savedPath: string | undefined;
    try {
      let stream: NodeJS.ReadableStream;
      let head: Uint8Array;
      if (attachment.kind === 'image') {
        const downloaded = await this.options.transport.downloadImage(
          message.messageId,
          attachment.key,
        );
        const bytes = Buffer.from(downloaded.data);
        head = new Uint8Array(bytes.subarray(0, 16));
        // Re-push the head so the save seam's pipeline sees the full body.
        const body = new Readable({ read() {} });
        body.push(head);
        body.push(bytes.subarray(head.length));
        body.push(null);
        stream = body;
        this.options.logger.debug(
          `inbound image ${attachment.key}: downloaded (${downloaded.data.length} bytes, ${message.chatId})`,
        );
      } else {
        const downloaded = await this.options.transport.downloadFile(
          message.messageId,
          attachment.key,
        );
        stream = downloaded.stream;
        head = downloaded.head;
        this.options.logger.debug(`inbound file ${attachment.key}: downloaded (${message.chatId})`);
      }
      const save = this.options.saveInboundFile;
      if (save !== undefined) {
        const extension = sniffExtension(head);
        const saved = await save({
          chatId: message.chatId,
          appId: this.options.appId ?? 'unknown',
          attachment,
          stream,
          extension,
        });
        savedPath = saved.path;
        this.options.logger.debug(
          `inbound file ${attachment.key}: saved to ${saved.path} (${message.chatId})`,
        );
      } else {
        this.options.logger.warn(
          `inbound file ${attachment.key}: save seam absent, name-only note (${message.chatId})`,
        );
      }
    } catch (error: unknown) {
      this.options.logger.warn(`inbound file ${attachment.key} download failed: ${String(error)}`);
    }
    return { attachment, name, savedPath };
  }

  /**
   * Inbound-wait-instruction: register a bare attachment message (no text)
   * as pending. Each attachment is downloaded and saved to the workspace; a
   * NEW receipt card posts for each (the previous cards are kept — each file
   * is traceable in chat history), showing the running count. NO turn starts;
   * the user's follow-up text message drains the pending list into its turn.
   * @param message - the bare attachment message.
   */
  private async registerPending(message: FeishuMessage): Promise<void> {
    // Append this message's attachments to the chat's pending list
    // SYNCHRONOUSLY, before any await: the message channel delivers a burst
    // without awaiting (drainInbox calls the handler back-to-back), so two
    // concurrent bare-file messages must each see the other's entries — a
    // read-then-set around an await would silently drop one of them.
    const pending = this.pendingInbound.get(message.chatId) ?? [];
    const placeholders: PendingInboundFile[] = (message.attachments ?? []).map((attachment) => ({
      attachment,
      name: attachment.name ?? attachment.key,
      savedPath: undefined,
    }));
    pending.push(...placeholders);
    this.pendingInbound.set(message.chatId, pending);
    for (let i = 0; i < placeholders.length; i += 1) {
      const placeholder = placeholders[i];
      if (placeholder === undefined) continue;
      const saved = await this.saveInboundFileAttachment(message, placeholder.attachment);
      // Mutate the already-registered entry in place (its position in the
      // list is fixed; a re-set here would race concurrent appends).
      placeholder.name = saved.name;
      placeholder.savedPath = saved.savedPath;
      const count = pending.length;
      this.options.logger.debug(
        `inbound pending ${placeholder.attachment.kind} ${placeholder.attachment.key}: ${saved.savedPath ?? 'no path'} (${count} pending, chat ${message.chatId})`,
      );
      try {
        await this.options.transport.sendCard(
          message.chatId,
          buildInboundFileCard(saved.name, saved.savedPath, count),
        );
      } catch (error: unknown) {
        this.options.logger.warn(`pending receipt card failed: ${String(error)}`);
      }
    }
  }

  /**
   * Inbound-wait-instruction: drain the chat's pending attachments into the
   * current turn — the saved-path notes are injected BEFORE the message's own
   * content, in arrival order, and the list is cleared. Called by
   * `deliverTurn` for every text message; no-op when nothing is pending.
   * @param chatId - the chat.
   * @param blocks - the content blocks being built for the turn; pending
   *   notes are prepended in place.
   */
  private drainPending(chatId: string, blocks: ContentBlock[]): void {
    const pending = this.pendingInbound.get(chatId);
    if (pending === undefined || pending.length === 0) return;
    this.pendingInbound.delete(chatId);
    const notes: ContentBlock[] = pending.map((file) => ({
      type: 'text',
      text:
        file.savedPath === undefined
          ? `[user sent a file: ${file.name}]`
          : `[user sent a file: ${file.name} — saved at ${file.savedPath}. You can read it with your file tools.]`,
    }));
    this.options.logger.debug(
      `inbound pending drained: ${pending.length} file(s) into turn (chat ${chatId})`,
    );
    blocks.unshift(...notes);
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
    if (message.chatType === 'p2p') {
      this.options.logger.debug(
        `message ${message.messageId}: p2p chat -> respond (no mention gate)`,
      );
      return true;
    }
    // Inbound-wait-instruction: a bare attachment message (no text) bypasses
    // the group mention gate. Feishu sends attachments without an input box,
    // so an @ is physically impossible — gating it would dead-lock group file
    // usage. Registration is pending-only (no work happens), and the follow-up
    // TEXT instruction still passes the gate below, so the gate's safety
    // purpose (the agent never acts without an accepted instruction) holds.
    if (message.text === '' && (message.attachments?.length ?? 0) > 0) {
      this.options.logger.debug(
        `message ${message.messageId}: bare attachment -> register (mention gate bypassed)`,
      );
      return true;
    }
    const mode = this.options.groupMentionMode ?? 'always';
    const botOpenId = this.options.transport.getBotOpenId();
    const mentioned = botOpenId !== undefined && message.mentions.includes(botOpenId);
    switch (mode) {
      case 'never':
        this.options.logger.debug(`message ${message.messageId}: group mode 'never' -> respond`);
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
        this.options.logger.debug(
          `message ${message.messageId}: group mode 'ambient' -> respond (mentioned=${mentioned})`,
        );
        return true;
      }
      case 'topic':
      // Threads are not implemented yet; topic mode currently behaves like
      // always (a non-@ reply inside an owned thread will need the thread
      // concept to relax the gate).
      case 'always': {
        if (mentioned) {
          this.options.logger.debug(
            `message ${message.messageId}: group mode 'always', bot mentioned -> respond`,
          );
          return true;
        }
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
    if (live !== undefined) {
      this.options.logger.debug(`agent resolve ${chatId}: live agent for session ${sessionId}`);
      return live;
    }
    this.options.logger.debug(
      `agent resolve ${chatId}: session ${sessionId} not live, trying resume`,
    );
    try {
      return await this.options.agentStore.resume(sessionId);
    } catch (resumeError: unknown) {
      this.options.logger.warn(`resume of session ${sessionId} failed: ${String(resumeError)}`);
    }
    this.options.logger.debug(
      `agent resolve ${chatId}: resume failed, creating session ${sessionId}`,
    );
    try {
      return await this.options.agentStore.create(sessionId, cwd);
    } catch (createError: unknown) {
      this.options.logger.error(
        `session ${sessionId} unusable (${String(createError)}); rebinding a fresh session`,
      );
      const freshId = this.options.sessionMap.remint(chatId);
      this.options.logger.debug(`agent resolve ${chatId}: rebinding fresh session ${freshId}`);
      return this.options.agentStore.create(freshId, cwd);
    }
  }

  /**
   * Render one session event into the owning chat's streaming card.
   * @param sessionId - the session that produced the event.
   * @param event - the session event.
   */
  async handleEvent(sessionId: string, event: SessionEvent): Promise<void> {
    this.options.logger.debug(`session event ${event.type} from ${sessionId}`);
    await this.streaming.handleEvent(sessionId, event);
    // message-queue: reconcile the per-item queue cards after the event — on
    // `turn/end` the surface drains its own queue (delivering each queued
    // message as its own turn, marking the items `sent`) and a steered
    // message's `user/message` event marks its item `steered`. Best-effort —
    // fires only when a queue-card registry exists for this chat.
    const chatId = this.options.sessionMap.chatFor(sessionId);
    if (chatId !== undefined && this.queueCards.has(chatId)) {
      await this.syncQueueAfterEvent(chatId, event);
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
    this.options.logger.debug(
      `card action ${kind ?? '?'} on card ${action.messageId} (chat ${action.chatId})`,
    );
    switch (kind) {
      case 'stop':
      case 'copy':
      case 'retry':
      case 'row-details':
      case 'toggle-rows':
      case 'send-produced':
      case 'send-log': {
        // Streaming-card actions are handled by the streaming state
        // machine controller (they mutate the card state).
        await this.streaming.handleStreamingAction(action);
        break;
      }
      case 'repo-pick':
      case 'repo-page':
      case 'panel':
      case 'panel-page':
      case 'panel-back':
      case 'panel-input-submit':
      case 'panel-confirm':
      case 'command':
      case 'resume-session':
      case 'session-select':
      case 'sessions-archived-toggle':
      case 'session-find':
      case 'session-rename':
      case 'session-archive':
      case 'session-export':
      case 'permission-pick':
      case 'model-pick':
      case 'model-page': {
        // Panel actions are Strategy objects dispatched through the
        // registry; the base-class template owns the lifecycle (gate /
        // transition / busy-first operation).
        this.options.logger.debug(
          `panel action ${kind} on card ${action.messageId} (chat ${action.chatId}) -> registry`,
        );
        await this.panelActions.handle(this.panelContext(action.messageId), action);
        break;
      }
      case 'approval':
      case 'question':
      case 'question-toggle':
      case 'question-submit':
      case 'question-cancel': {
        // Approval/question interactions are handled by the interaction
        // controller (they settle pending card interactions).
        await this.interactions.handleCardAction(action);
        break;
      }
      case 'queue-steer':
      case 'queue-edit':
      case 'queue-edit-submit':
      case 'queue-edit-cancel':
      case 'queue-remove': {
        // Queue-card actions drive each queued item's OWN card state machine
        // (message-queue).
        await this.handleQueueCardAction(action);
        break;
      }
      default: {
        this.options.logger.warn(`unknown card action kind: ${kind ?? '(missing)'}`);
      }
    }
  }

  /** Register the built-in surface commands. */
  /** The SurfaceCommandHost the surface command set delegates to: Bridge
   *  owns panel navigation, session/agent resolution, and the streaming
   *  controller; the command module owns the command copy. Option-backed
   *  fields are GETTERS — the original handlers read `this.options.X` at
   *  call time, and tests mutate options after construction. */
  /** Read the dsh-feishu log and ship it to the chat (`/log` + the error-card
   *  "Export log" button). Returns a user-facing result. */
  async sendLogFile(chatId: string): Promise<CommandResult> {
    const file = readLogFile(this.options.dataDir);
    if (!file.ok) return { kind: 'error', text: file.error };
    try {
      await this.options.transport.sendFile(chatId, file.name, file.content);
      this.options.logger.info(
        `log export ${file.name}: ${file.content.length} bytes -> chat ${chatId}`,
      );
      return { kind: 'success', text: t('command.info.logSent', { count: file.content.length }) };
    } catch (error: unknown) {
      this.options.logger.warn(`log export ${chatId} failed: ${String(error)}`);
      return {
        kind: 'error',
        text: t('command.error.logSendFailedDetail', { detail: String(error) }),
      };
    }
  }

  private commandHost(): SurfaceCommandHost {
    const bridge = this;
    return {
      get transport() {
        return bridge.options.transport;
      },
      get sessionMap() {
        return bridge.options.sessionMap;
      },
      get agentStore() {
        return bridge.options.agentStore;
      },
      get logger() {
        return bridge.options.logger;
      },
      get executeCommand() {
        return bridge.options.executeCommand;
      },
      get readSession() {
        return bridge.options.readSession;
      },
      get permissionPresets() {
        return bridge.options.permissionPresets;
      },
      get planMode() {
        return bridge.options.planMode;
      },
      get agentDefaultModel() {
        return bridge.options.agentDefaultModel;
      },
      get llm() {
        return bridge.options.llm;
      },
      get listSessions() {
        return bridge.options.listSessions;
      },
      get groupMentionMode() {
        return bridge.options.groupMentionMode;
      },
      get appId() {
        return bridge.options.appId;
      },
      get transportMode() {
        return bridge.options.transportMode;
      },
      get unknownCommand() {
        return bridge.options.unknownCommand;
      },
      get lastInboundAt() {
        return bridge.lastInboundAtValue;
      },
      openPanel: (chatId) => bridge.openPanel(chatId),
      // Typed slash commands open a FRESH, INDEPENDENT card seeded with the
      // view — never pilot/update the chat's existing panel card. Each typed
      // command is its own state machine; a later command must not touch an
      // earlier card (the `#panel` fix).
      pushPanel: async (chatId, view) => {
        await bridge.panel.openPanelView(chatId, view);
      },
      ensureAgent: (chatId) => bridge.ensureAgent(chatId),
      resumeSession: (chatId, sessionId, cwd) => bridge.resumeSession(chatId, sessionId, cwd),
      isWorking: (chatId) => bridge.refuseWhileWorking(chatId),
      resetChat: (chatId) => bridge.resetChatState(chatId),
      lastOutput: (chatId) => bridge.streaming.lastOutput(chatId),
      liveAgent: (chatId) => bridge.liveAgent(chatId),
      sendLog: (chatId) => bridge.sendLogFile(chatId),
    };
  }
}
