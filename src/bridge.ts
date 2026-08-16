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
  InteractionCardController,
  type InteractionCardHost,
} from './cards/InteractionCardController.js';
import {
  buildPanelCard,
  buildResultCard,
  type ModelOptionView,
  type PanelCommand,
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
import type { CardAction, CardJson, FeishuMessage, FeishuTransport } from './feishu/types.js';
import { MessageDeduplicator } from './message-dedup.js';
import { parseModelArg } from './model-args.js';
import type { PanelActionContext } from './panel/actions/PanelAction.js';
import { buildPanelActionRegistry } from './panel/actions/registry.js';
import { PanelController, type PanelHost } from './panel/PanelController.js';
import type { PanelViewContext } from './panel/views/PanelViewContext.js';
import { buildPanelViewRegistry } from './panel/views/registry.js';
import { type ProjectInfo, scanMultipleProjects } from './projects.js';
import { buildSessionExport, type SessionExportEvent } from './session-export.js';
import type { SessionMap } from './session-map.js';

export type { PanelInputCommand, PanelView } from './panel/types.js';

import type { PanelView } from './panel/types.js';

export { isPanelInputCommand, PANEL_CONFIRM_SPEC, PANEL_INPUT_SPEC } from './panel/types.js';

import { turnTitle } from './cards/StreamingCardController.js';

export { turnTitle } from './cards/StreamingCardController.js';

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
   * Host session-management seam (`ctx.apiProxy`, structural subset): lets
   * the session detail view rename and archive sessions (dsh web parity).
   * Absent, the detail view hides those buttons.
   */
  readonly apiProxy?: {
    readonly sessions: {
      rename(request: { readonly sessionId: string; readonly title: string }): Promise<unknown>;
    };
    readonly workspace: {
      list(): Promise<{ readonly archivedSessionIds?: readonly string[] }>;
      archiveSession(request: { readonly sessionId: string }): Promise<unknown>;
    };
  };
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

/** Whether a group is a 1-person-1-bot solo group (mention gate relaxation). */
function isSoloGroup(stats: { userCount: number; botCount: number }): boolean {
  return stats.userCount <= 1 && stats.botCount <= 1;
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
      textMentionFor: (chatId) => this.textMentionFor(chatId),
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
      canMutateSessions: this.options.apiProxy !== undefined,
    };
  }

  /** The seam every panel action runs against: navigation (the panel
   *  controller), the working-state gate, the command registry, and the
   *  Bridge's business helpers. Actions depend on this interface, never on
   *  Bridge internals (see `panel/actions/PanelAction.ts`). */
  private panelContext(): PanelActionContext {
    return {
      services: {
        transport: this.options.transport,
        sessionMap: this.options.sessionMap,
        agentStore: this.options.agentStore,
        logger: this.options.logger,
        defaultCwd: this.options.defaultCwd,
        requireWorkingDir: this.options.requireWorkingDir,
        repoRoots: this.options.repoRoots,
        apiProxy: this.options.apiProxy,
        permissionPresets: this.options.permissionPresets,
        planMode: this.options.planMode,
        agentDefaultModel: this.options.agentDefaultModel,
        llm: this.options.llm,
        listSessions: this.options.listSessions,
      },
      pushPanel: (chatId, view) => this.pushPanel(chatId, view),
      replacePanel: (chatId, view) => this.replacePanel(chatId, view),
      popPanel: (chatId) => this.popPanel(chatId),
      popToMenu: (chatId) => this.popToMenu(chatId),
      popToDetail: (chatId) => this.popToDetail(chatId),
      panelViewFor: (chatId) => this.panelViewFor(chatId),
      panelStack: (chatId) => this.panelStack(chatId),
      runPanelOperation: (chatId, title, work, finish) =>
        this.runPanelOperation(chatId, title, work, finish),
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
   * Post a panel action's FINAL result as a NEW pure-information card (no
   * buttons/inputs) — the panel principle: intermediate steps live in the
   * panel card, results leave it as an inert card (user requirement).
   * @param chatId - the chat.
   * @param result - the command result to render.
   */
  private async replyResultCard(chatId: string, result: CommandResult): Promise<void> {
    const text = result.kind === 'error' ? `⚠️ ${result.text}` : result.text;
    if (text === '') return;
    const title = result.kind === 'error' ? '⚠️ Action failed' : '✅ Done';
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
      const workspace = this.options.apiProxy?.workspace;
      if (workspace === undefined) return new Set();
      const view = await workspace.list();
      return new Set(view.archivedSessionIds ?? []);
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
        text: 'session export unavailable — the session query service is not mounted.',
      };
    }
    try {
      const log = await this.options.readSession(sessionId);
      const transcript = buildSessionExport(log.events);
      const fileName = `session-${sessionId}.md`;
      await this.options.transport.sendFile(chatId, fileName, transcript);
      return { kind: 'success', text: `Exported ${log.events.length} events to ${fileName}.` };
    } catch (error: unknown) {
      this.options.logger.warn(`session export failed: ${String(error)}`);
      const detail = String(error);
      const scopeHint = detail.includes('im:resource')
        ? ' — the Feishu app needs the im:resource:upload permission scope (developer console → Permissions).'
        : '';
      return { kind: 'error', text: `session export failed: ${detail}${scopeHint}` };
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
  private async openPanel(chatId: string, page = 0): Promise<void> {
    await this.panel.openPanel(chatId, page);
  }

  /** Render the current panel view in place (single render path). */
  private async showPanel(chatId: string): Promise<void> {
    await this.panel.showPanel(chatId);
  }

  /** THE single wrapper for async panel operations (patch-first guarantee). */
  private async runPanelOperation(
    chatId: string,
    title: string,
    work: () => CommandResult | undefined | Promise<CommandResult | undefined>,
    finish: () => Promise<void>,
  ): Promise<void> {
    await this.panel.runPanelOperation(chatId, title, work, finish);
  }

  /** Post (or update) the panel card. */
  private async postPanelCard(chatId: string, card: CardJson): Promise<void> {
    await this.panel.postPanelCard(chatId, card);
  }

  /** PUSH a sub-view onto the panel stack and render it. */
  private async pushPanel(chatId: string, view: PanelView): Promise<void> {
    await this.panel.pushPanel(chatId, view);
  }

  /** POP one level (Back); the menu root never pops. */
  private async popPanel(chatId: string): Promise<void> {
    await this.panel.popPanel(chatId);
  }

  /** Replace the stack top (e.g. a page flip). */
  private async replacePanel(chatId: string, view: PanelView): Promise<void> {
    await this.panel.replacePanel(chatId, view);
  }

  /** POP back to the menu root (keeping its page). */
  private async popToMenu(chatId: string): Promise<void> {
    await this.panel.popToMenu(chatId);
  }

  /** POP back to the session detail (after a rename completes), if present. */
  private async popToDetail(chatId: string): Promise<void> {
    await this.panel.popToDetail(chatId);
  }

  /** The panel view stack for a chat. */
  private panelStack(chatId: string): PanelView[] {
    return this.panel.panelStack(chatId);
  }

  /** The current panel view (the stack top), defaulting to the menu root. */
  private panelViewFor(chatId: string): PanelView {
    return this.panel.panelViewFor(chatId);
  }

  /** Construct the panel card for a chat at the given command page. */
  private buildPanelCardFor(chatId: string, page: number): CardJson {
    const agent = this.liveAgent(chatId);
    const running = agent !== undefined && agent.status === 'running';
    const stopped = this.streaming.state(chatId)?.status === 'stopped';
    const output = this.streaming.lastOutput(chatId);
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
    if (this.interactions.answerFreeText(message.chatId, message.text)) return;
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
    this.streaming.rememberPrompt(message.chatId, message.text);
    // Remember the accepted sender and chat type: proactive @-mentions in
    // groups (error notices, approval cards, question cards) target the user
    // who started this turn.
    this.requesterOpenIds.set(message.chatId, message.senderOpenId);
    this.chatTypes.set(message.chatId, message.chatType === 'group' ? 'group' : 'p2p');
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
    await this.streaming.handleEvent(sessionId, event);
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
      case 'stop':
      case 'copy':
      case 'retry':
      case 'row-details':
      case 'toggle-rows': {
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
        await this.panelActions.handle(this.panelContext(), action);
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
      pushPanel: (chatId, view) => bridge.pushPanel(chatId, view),
      ensureAgent: (chatId) => bridge.ensureAgent(chatId),
      resumeSession: (chatId, sessionId, cwd) => bridge.resumeSession(chatId, sessionId, cwd),
      isWorking: (chatId) => bridge.refuseWhileWorking(chatId),
      resetChat: (chatId) => bridge.resetChatState(chatId),
      lastOutput: (chatId) => bridge.streaming.lastOutput(chatId),
      liveAgent: (chatId) => bridge.liveAgent(chatId),
    };
  }
}
