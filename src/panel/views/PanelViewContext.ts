/**
 * Panel view context: the capability surface one panel view state needs to
 * render its card.
 *
 * The Bridge implements this seam (see `bridge.ts` → `panelViewContext()`);
 * view states depend only on the interface, never on Bridge internals. Each
 * business helper hides one data source (session list, project scan, model
 * catalog, …) so a view state stays a pure renderer.
 *
 * @module @dsh-feishu/dsh-feishu/panel/views/PanelViewContext
 */

import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AgentPresetView, PermissionPresetService } from '../../bridge.js';
import type { ModelOptionView } from '../../cards/render.js';
import type { SessionDetailView, SessionRowView } from '../../cards/session-list.js';
import type { CardJson } from '../../feishu/types.js';
import type { ProjectInfo } from '../../projects.js';

/** The seam every panel view state renders against. */
export interface PanelViewContext {
  /** Build the menu card (status line + command palette, per chat). */
  buildMenuCard(chatId: string, page: number): CardJson;
  /** Load the session list (active or archived), or `undefined` when the
   *  listing service is absent. */
  loadSessions(chatId: string, archived?: boolean): Promise<readonly SessionRowView[] | undefined>;
  /** Build one session's detail view, or `undefined` when unknown. */
  sessionDetail(chatId: string, sessionId: string): Promise<SessionDetailView | undefined>;
  /** Scan the configured roots for candidate project directories. */
  listProjects(roots: readonly string[]): Promise<readonly ProjectInfo[]>;
  /** The repo roots scanned by the repo picker (empty = empty picker). */
  readonly repoRoots: readonly string[];
  /** The /model picker catalog, or `undefined` when the llm service is absent. */
  loadModelOptions(): Promise<readonly ModelOptionView[] | undefined>;
  /** The chat's current model as a `provider/model` selection arg. */
  currentModelSelection(chatId: string): string | undefined;
  /** Ensure a live agent exists for the chat (picker views act on one). */
  ensureAgent(chatId: string): Promise<Agent>;
  /** The agent-preset roster for the working-directory Mode dropdown
   *  (empty when the roster service is absent — no Mode is rendered). */
  loadAgentPresets(): Promise<readonly AgentPresetView[]>;
  /** The chat's explicitly-chosen agent preset id (working-directory picks
   *  bind it to the chat's next fresh session), or `undefined`. */
  selectedAgentPreset(chatId: string): string | undefined;
  /** The permission-preset service, or `undefined` when not mounted. */
  permissionPresets(): PermissionPresetService | undefined;
  /** Whether the session detail may show rename/archive (host seam present). */
  canMutateSessions: boolean;
}
