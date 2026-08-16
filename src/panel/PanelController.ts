/**
 * The panel controller: ONE authoritative view stack per chat and ONE render
 * path (`showPanel`) — the state-machine rule applied to the control panel.
 *
 * Responsibilities (all panel mechanics, no business logic):
 * - the per-chat view stack (`menu` root at the bottom; push/pop/replace);
 * - the single render path `showPanel` — posts a `⏳ Loading…` placeholder
 *   first for async-data views, then the real card, then re-asserts the
 *   streaming card; a render failure resets the stack to the menu root and
 *   reposts the menu card so page flips and Back never go dead;
 * - `postPanelCard` — post-or-update the ONE panel card, with a
 *   post-on-update-failure fallback (state and the on-screen card never
 *   diverge silently);
 * - `runPanelOperation` — THE single wrapper for async panel operations
 *   (template method: busy placeholder → work → result card → completion
 *   exit). Lark restores the pre-click card whenever a callback carries no
 *   panel patch, so ANY await inside a panel action must be preceded by a
 *   patch; this wrapper makes that guarantee structural.
 *
 * Business logic (rendering a view's content, running a command handler)
 * lives behind {@link PanelHost} — the Bridge implements it; each panel view
 * renders through a registered view state (see `panel/views/`) that declares
 * its own async-ness.
 *
 * @module @dsh-feishu/dsh-feishu/panel/PanelController
 */

import { buildPanelBusyCard, buildPanelNoticeCard } from '../cards/render.js';
import type { CommandResult } from '../commands.js';
import type { CardJson, FeishuTransport } from '../feishu/types.js';
import type { PanelView } from './types.js';

/** Logger surface the panel needs. */
export interface PanelLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * What the panel needs from the rest of the surface. The Bridge implements
 * this; the panel controller never touches Bridge internals directly.
 */
export interface PanelHost {
  readonly transport: FeishuTransport;
  readonly logger: PanelLogger;
  /** Render one panel view to a card (business logic behind the view
   *  registry; the registry's states declare async-ness themselves). */
  renderPanelView(chatId: string, view: PanelView): Promise<CardJson>;
  /** Whether a view renders from async data (post a Loading placeholder
   *  first — the view registry's `asyncData` flag). */
  isAsyncView(view: PanelView): boolean;
  /** Build the menu card (the failure fallback + completion exit). */
  buildMenuCard(chatId: string, page: number): CardJson;
  /** Re-assert the streaming card after a panel render (Lark restores the
   *  pre-click streaming card otherwise — botmux rule). */
  syncCard(chatId: string): void;
  /** Post a panel action's final outcome as a NEW inert result card. */
  resultCard(chatId: string, result: CommandResult): Promise<void>;
  /** Post a bare text message. */
  text(chatId: string, text: string): Promise<void>;
}

/** The view header title for a panel view (busy/loading placeholders reuse
 *  the real view's title so the transition reads as in-place work). */
function panelViewTitle(view: PanelView): string {
  switch (view.kind) {
    case 'menu':
      return '⚙️ dsh-feishu panel';
    case 'input':
      return PANEL_TITLE_BY_INPUT[view.command] ?? '⚙️ dsh-feishu panel';
    case 'confirm':
      return view.command === 'clear' ? '✨ New chat' : '🧹 Compact';
    case 'sessions':
      return '🗂️ Sessions';
    case 'session-detail':
      return '🗂️ Session';
    case 'picker':
      return view.picker === 'repo'
        ? '📚 Pick a project'
        : view.picker === 'model'
          ? '🤖 Model'
          : '🔐 Permission';
  }
}

/** Input-view titles (mirrors PANEL_INPUT_SPEC in types.ts; kept local so
 *  this module stays free of the spec table's field/placeholder copy). */
const PANEL_TITLE_BY_INPUT: Record<string, string> = {
  cd: '📁 Change working directory',
  group: '👥 New group',
  goal: '🎯 Goal',
  feedback: '💬 Feedback',
  'rename-session': '✏️ Rename session',
  'find-session': '🔎 Find session',
};

/**
 * The panel state machine controller. One instance per bridge; state is
 * per-chat (the view stack and the panel card message id).
 */
export class PanelController {
  /** The most recently opened panel card per chat (updates it in place). */
  private readonly panelMessageIds = new Map<string, string>();
  /** The panel view stack per chat (menu root at the bottom). */
  private readonly panelViews = new Map<string, PanelView[]>();

  constructor(private readonly host: PanelHost) {}

  /**
   * Open (or page) the control panel: a FRESH card (user request) and a
   * reset stack to the menu root.
   * @param chatId - the chat.
   * @param page - zero-based palette page.
   */
  async openPanel(chatId: string, page = 0): Promise<void> {
    this.panelViews.set(chatId, [{ kind: 'menu', page }]);
    this.panelMessageIds.delete(chatId);
    await this.showPanel(chatId);
  }

  /**
   * Render the CURRENT panel view (the stack top) IN PLACE on the panel
   * card. Async-data views post a `⏳ Loading…` placeholder FIRST (an
   * immediate patch — Lark otherwise restores the pre-click card while the
   * data loads), then the real card. A render failure resets the stack to
   * the menu root and reposts the menu card so the panel is never left
   * dead.
   * @param chatId - the chat.
   */
  async showPanel(chatId: string): Promise<void> {
    const view = this.panelViewFor(chatId);
    if (this.host.isAsyncView(view)) {
      await this.postPanelCard(chatId, this.loadingPanelCard(view));
    }
    let card: CardJson;
    try {
      card = await this.host.renderPanelView(chatId, view);
    } catch (error: unknown) {
      this.host.logger.error(`panel view render failed: ${String(error)}`);
      // The stack may hold the view that failed to render (e.g. a picker
      // whose data source is broken). Reset to the menu root and repost the
      // menu card so page flips and Back keep working.
      this.panelViews.set(chatId, [this.panelStack(chatId)[0] ?? { kind: 'menu', page: 0 }]);
      try {
        await this.postPanelCard(chatId, this.host.buildMenuCard(chatId, 0));
      } catch (postError: unknown) {
        this.host.logger.warn(
          `panel menu repost after render failure failed: ${String(postError)}`,
        );
      }
      await this.host.text(chatId, '⚠️ The panel view could not be rendered — see the bot log.');
      return;
    }
    await this.postPanelCard(chatId, card);
    this.host.syncCard(chatId);
  }

  /** The loading placeholder for an async panel view (Back only). */
  private loadingPanelCard(view: PanelView): CardJson {
    return buildPanelNoticeCard({ title: panelViewTitle(view), hint: '⏳ Loading…' });
  }

  /**
   * THE single wrapper for async panel operations (rename, archive, export,
   * resume, picks, command/confirm/input handlers). Every async panel action
   * MUST go through here: it posts an operating placeholder FIRST (an
   * immediate panel patch, so the callback always carries one — Lark
   * otherwise restores the pre-click card while the work awaits, the root of
   * every "panel reverts mid-action" bug), then runs the work, then posts
   * the outcome as a result card, then runs `finish` (a panel transition,
   * which patches again). No per-case patch bookkeeping — one structure.
   * @param chatId - the chat.
   * @param title - the panel header title to show while operating.
   * @param work - the async mutation; its outcome is posted as a result card.
   * @param finish - the completion exit (e.g. popToMenu / popToDetail).
   */
  async runPanelOperation(
    chatId: string,
    title: string,
    work: () => CommandResult | undefined | Promise<CommandResult | undefined>,
    finish: () => Promise<void>,
  ): Promise<void> {
    await this.postPanelCard(chatId, buildPanelBusyCard(title));
    try {
      const result = await work();
      if (result !== undefined) {
        await this.host.resultCard(chatId, result);
      }
    } catch (error: unknown) {
      this.host.logger.error(`panel operation failed: ${String(error)}`);
      await this.host.resultCard(chatId, {
        kind: 'error',
        text: `operation failed: ${String(error)}`,
      });
    }
    await finish();
  }

  /**
   * Post (or in-place update) the panel card. A NEW card is posted on first
   * render; every later transition updates the SAME card. A failed update
   * falls back to posting a fresh card; a failed render/post surfaces as a
   * text notice — state and the on-screen card never diverge silently.
   * @param chatId - the chat.
   * @param card - the panel card to display.
   */
  async postPanelCard(chatId: string, card: CardJson): Promise<void> {
    const existing = this.panelMessageIds.get(chatId);
    try {
      if (existing !== undefined) {
        await this.host.transport.updateCard(existing, card);
      } else {
        const sent = await this.host.transport.sendCard(chatId, card);
        this.panelMessageIds.set(chatId, sent.messageId);
      }
    } catch (error: unknown) {
      this.host.logger.warn(`panel render failed, reposting: ${String(error)}`);
      try {
        const sent = await this.host.transport.sendCard(chatId, card);
        this.panelMessageIds.set(chatId, sent.messageId);
      } catch (fallbackError: unknown) {
        this.host.logger.error(`panel card could not be posted: ${String(fallbackError)}`);
        await this.host.text(chatId, '⚠️ The panel card could not be displayed — see the bot log.');
      }
    }
  }

  /** PUSH a sub-view onto the panel stack and render it (a button entering a
   *  new interface; Back pops back to the parent — stack semantics). */
  async pushPanel(chatId: string, view: PanelView): Promise<void> {
    this.panelViews.set(chatId, [...this.panelStack(chatId), view]);
    await this.showPanel(chatId);
  }

  /** POP one level (Back); the menu root never pops. */
  async popPanel(chatId: string): Promise<void> {
    const stack = this.panelStack(chatId);
    const next = stack.length > 1 ? stack.slice(0, -1) : stack;
    this.panelViews.set(chatId, next);
    await this.showPanel(chatId);
  }

  /** Replace the stack top (e.g. a page flip inside the current view). */
  async replacePanel(chatId: string, view: PanelView): Promise<void> {
    const stack = this.panelStack(chatId);
    this.panelViews.set(chatId, [...stack.slice(0, -1), view]);
    await this.showPanel(chatId);
  }

  /** POP back to the menu root (keeping its page). */
  async popToMenu(chatId: string): Promise<void> {
    const root = this.panelStack(chatId)[0] ?? { kind: 'menu', page: 0 };
    this.panelViews.set(chatId, [root]);
    await this.showPanel(chatId);
  }

  /** POP back to the session detail (after a rename completes), if present. */
  async popToDetail(chatId: string): Promise<void> {
    const stack = this.panelStack(chatId);
    const detailIndex = stack.findLastIndex((view) => view.kind === 'session-detail');
    const next =
      detailIndex >= 0 ? stack.slice(0, detailIndex + 1) : [stack[0] ?? { kind: 'menu', page: 0 }];
    this.panelViews.set(chatId, next);
    await this.showPanel(chatId);
  }

  /** The panel view stack for a chat (the menu root is the stack bottom). */
  panelStack(chatId: string): PanelView[] {
    return this.panelViews.get(chatId) ?? [{ kind: 'menu', page: 0 }];
  }

  /** The current panel view (the stack top), defaulting to the menu root. */
  panelViewFor(chatId: string): PanelView {
    const stack = this.panelStack(chatId);
    return stack[stack.length - 1] ?? { kind: 'menu', page: 0 };
  }
}
