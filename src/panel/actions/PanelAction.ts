/**
 * Panel action context: the capability surface a panel action may use.
 *
 * The Bridge implements this seam (see `bridge.ts` → `panelContext()`);
 * actions depend only on the interface, never on Bridge internals, so each
 * action is unit-testable with a fake context and the dispatch stays
 * decoupled from the surface implementation.
 *
 * @module @dsh-feishu/dsh-feishu/panel/actions/PanelAction
 */

import type { Agent } from '@deepseek-ai/dsh-agent';
import type {
  AgentDefaultModelService,
  LlmService,
  ModelSelectionView,
  PermissionPresetService,
  PlanModeService,
  SessionListRow,
} from '../../bridge.js';
import type { ModelOptionView } from '../../cards/render.js';
import type { CommandResult, SurfaceCommand } from '../../commands.js';
import type { FeishuTransport } from '../../feishu/types.js';
import type { SessionMap } from '../../session-map.js';
import type { PanelView } from '../types.js';

/** Services the panel actions reach (the injectable subset of BridgeOptions). */
export interface PanelServices {
  readonly transport: FeishuTransport;
  readonly sessionMap: SessionMap;
  readonly agentStore: {
    get(sessionId: string): Agent | undefined;
    resume(sessionId: string): Promise<Agent>;
    create(sessionId: string, cwd: string): Promise<Agent>;
  };
  readonly logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  readonly defaultCwd: string;
  readonly requireWorkingDir: boolean | undefined;
  readonly repoRoots: readonly string[] | undefined;
  readonly apiProxy:
    | {
        readonly sessions: {
          rename(request: { readonly sessionId: string; readonly title: string }): Promise<unknown>;
        };
        readonly workspace: {
          list(): Promise<{ readonly archivedSessionIds?: readonly string[] }>;
          archiveSession(request: { readonly sessionId: string }): Promise<unknown>;
        };
      }
    | undefined;
  readonly permissionPresets: PermissionPresetService | undefined;
  readonly planMode: PlanModeService | undefined;
  readonly agentDefaultModel: AgentDefaultModelService | undefined;
  readonly llm: LlmService | undefined;
  readonly listSessions: (() => Promise<readonly SessionListRow[] | undefined>) | undefined;
}

/** The seam every panel action runs against. */
export interface PanelActionContext {
  readonly services: PanelServices;
  /** Panel navigation (stack semantics; every call re-renders in place). */
  openPanel(chatId: string): Promise<void>;
  pushPanel(chatId: string, view: PanelView): Promise<void>;
  replacePanel(chatId: string, view: PanelView): Promise<void>;
  popPanel(chatId: string): Promise<void>;
  popToMenu(chatId: string): Promise<void>;
  popToDetail(chatId: string): Promise<void>;
  panelViewFor(chatId: string): PanelView;
  panelStack(chatId: string): PanelView[];
  /** THE single async-operation wrapper (patch-first guarantee). */
  runPanelOperation(
    chatId: string,
    title: string,
    work: () => CommandResult | undefined | Promise<CommandResult | undefined>,
    finish: () => Promise<void>,
  ): Promise<void>;
  /** Post a final outcome as an inert result card. */
  replyResultCard(chatId: string, result: CommandResult): Promise<void>;
  /** Post a bare text message. */
  replyText(chatId: string, text: string): Promise<void>;
  /** Whether a turn is running (the working-state gate). */
  isWorking(chatId: string): boolean;
  /** Whether a command kind is allowed while a turn is running. */
  allowedWhileWorking(kind: string): boolean;
  /** The surface command registry (button handlers == slash handlers). */
  findCommand(name: string): SurfaceCommand | undefined;
  /** Business helpers the actions delegate to (Bridge implements). */
  ensureAgent(chatId: string): Promise<Agent>;
  liveAgent(chatId: string): Agent | undefined;
  resumeSession(chatId: string, sessionId: string, cwd?: string): Promise<CommandResult>;
  exportSessionLog(chatId: string, sessionId: string): Promise<CommandResult>;
  loadSessions(chatId: string, archived?: boolean): Promise<readonly SessionListRow[] | undefined>;
  currentModelSelection(chatId: string): string | undefined;
  /** The view options for the /model picker (rendered by the picker view). */
  loadModelOptions(): Promise<readonly ModelOptionView[] | undefined>;
  /** Resolve and validate a working-directory path. */
  resolveDirectory(input: string): { ok: true; path: string } | { ok: false; error: string };
  /** Parse a `/model` argument into a selection. */
  parseModelArg(
    raw: string,
  ): { ok: true; selection: ModelSelectionView } | { ok: false; error: string };
}
