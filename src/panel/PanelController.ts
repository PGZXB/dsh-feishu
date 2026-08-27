/**
 * The panel controller: ONE authoritative view stack per PANEL CARD and ONE
 * render path (`showPanel`) — the state-machine rule applied to the control
 * panel. Each card owns its stack, so a callback updates the card it was
 * tapped on, never a different one.
 *
 * Responsibilities (all panel mechanics, no business logic):
 * - the per-(chat, card) view stacks (`menu` root at the bottom; push/pop/
 *   replace); unknown cards default to the menu root;
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

import { actionValue, buildPanelBusyCard, buildPanelNoticeCard } from '../cards/render.js';
import type { CommandResult } from '../commands.js';
import type { CardJson, FeishuTransport } from '../feishu/types.js';
import { t } from '../i18n/index.js';
import { isPanelInputCommand, type PanelView, panelConfirmCopy, panelInputCopy } from './types.js';

/** Logger surface the panel needs. */
export interface PanelLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Debug tracing (printed only when FEISHU_DEBUG=1). */
  debug(message: string): void;
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
      return t('panel.title');
    case 'input':
      return panelInputTitle(view.command);
    case 'confirm':
      return panelConfirmCopy(view.command).title;
    case 'sessions':
      return t('sessions.list.title');
    case 'session-detail':
      return t('sessions.detail.title');
    case 'picker':
      return view.picker === 'repo'
        ? t('card.repo.title')
        : view.picker === 'model'
          ? t('panel.model.title')
          : t('command.cmd.permission.label');
  }
}

/** Input-view titles — resolved from the catalog at call time. */
function panelInputTitle(command: string): string {
  if (isPanelInputCommand(command)) return panelInputCopy(command).title;
  return command;
}

/**
 * The panel state machine controller. One instance per bridge; state is
 * per-(chat, card) (each panel card's own view stack, plus the chat's latest
 * panel card id and palette root).
 */
export class PanelController {
  /** The panel view stack per (chat, card): each panel card owns its own
   *  stack, so tapping an old card updates THAT card, never a different one
   *  (user report: "tap this card, another card reacts"). A card that was
   *  never seen in this process (left on screen before a daemon restart)
   *  starts at the menu root when first tapped. */
  private readonly panelViews = new Map<string, Map<string, PanelView[]>>();
  /** The most recently posted panel card per chat (openPanel posts fresh). */
  private readonly panelMessageIds = new Map<string, string>();
  /** The palette menu root per chat (page), used by popToMenu. */
  private readonly panelMessageRoots = new Map<string, PanelView>();

  constructor(private readonly host: PanelHost) {}

  /** The most recently posted panel card of a chat, or `undefined` when
   *  none was opened in this process. Commands (slash lines) that open a
   *  panel view update this card; card callbacks update their OWN card. */
  latestPanelCardId(chatId: string): string | undefined {
    return this.panelMessageIds.get(chatId);
  }

  /** The stack for one (chat, card); unknown cards default to the menu root. */
  private stacksFor(chatId: string): Map<string, PanelView[]> {
    let cards = this.panelViews.get(chatId);
    if (cards === undefined) {
      cards = new Map();
      this.panelViews.set(chatId, cards);
    }
    return cards;
  }

  private stackFor(chatId: string, messageId: string): PanelView[] {
    const stacks = this.stacksFor(chatId);
    let stack = stacks.get(messageId);
    if (stack === undefined) {
      stack = [{ kind: 'menu', page: 0 }];
      stacks.set(messageId, stack);
    }
    return stack;
  }

  /**
   * Open (or page) the control panel: a FRESH card (user request) and a
   * reset stack to the menu root. The new card is independent — earlier
   * panel cards stay on screen and keep working (tap them and they update
   * themselves); the chat therefore never "swaps" one card for another.
   * @param chatId - the chat.
   * @param page - zero-based palette page.
   */
  async openPanel(chatId: string, page = 0): Promise<string> {
    this.host.logger.debug(`panel OPEN (menu page ${page}) in chat ${chatId}`);
    this.panelMessageIds.delete(chatId);
    this.panelMessageRoots.set(chatId, { kind: 'menu', page });
    const sent = await this.showPanel(chatId, undefined, { kind: 'menu', page });
    return sent.messageId;
  }

  /**
   * Open a FRESH panel card seeded directly with a sub-view (slash commands
   * like /sessions or /repo). The card renders that view immediately — no
   * transient menu card — and owns its own stack. The palette menu root is
   * still the menu (popToMenu returns there).
   * @param chatId - the chat.
   * @param view - the view to seed the new card with.
   * @returns the new card's message id.
   */
  async openPanelView(chatId: string, view: PanelView): Promise<string> {
    this.host.logger.debug(`panel OPEN VIEW ${view.kind} in chat ${chatId}`);
    this.panelMessageIds.delete(chatId);
    this.panelMessageRoots.set(chatId, { kind: 'menu', page: 0 });
    const sent = await this.showPanel(chatId, undefined, view);
    return sent.messageId;
  }

  /**
   * Render one panel card's current view (the stack top) IN PLACE on THAT
   * card. `messageId` selects the card; `undefined` (a fresh open) posts a
   * new card and records it. Async-data views post a `⏳ Loading…`
   * placeholder FIRST (an immediate patch — Lark otherwise restores the
   * pre-click card while the data loads), then the real card. A render
   * failure resets that card's stack to the menu root and reposts the menu
   * card so the panel is never left dead.
   * @param chatId - the chat.
   * @param messageId - the card to update, or `undefined` to post a fresh one.
   * @param seed - optional initial stack when `messageId` is `undefined`.
   */
  async showPanel(
    chatId: string,
    messageId: string | undefined,
    seed?: PanelView,
  ): Promise<{ messageId: string }> {
    if (messageId === undefined) {
      const view = seed ?? { kind: 'menu', page: 0 };
      const isMenu = view.kind === 'menu';
      // Post ONE initial card: the menu (root), a ⏳ Loading placeholder for
      // async seeds, or — for a sync non-menu seed (input/confirm) — the
      // rendered view immediately. A menu fallback would flash the control
      // panel before the sync view settles (the `/cd` flash bug).
      let initial: CardJson | undefined;
      if (isMenu) {
        initial = this.host.buildMenuCard(chatId, 0);
      } else if (this.host.isAsyncView(view)) {
        initial = this.loadingPanelCard(view);
      } else {
        initial = await this.host.renderPanelView(chatId, view);
      }
      const sent = await this.postPanelCard(
        chatId,
        undefined,
        initial ?? this.host.buildMenuCard(chatId, 0),
      );
      const stack = this.stackFor(chatId, sent.messageId);
      stack[0] = view;
      // Async seeds (sessions/pickers) update the Loading placeholder with the
      // real view; sync seeds were already rendered as the initial card.
      if (!isMenu && this.host.isAsyncView(view)) {
        let card: CardJson;
        try {
          card = await this.host.renderPanelView(chatId, view);
        } catch (error: unknown) {
          this.host.logger.error(`panel seed render failed: ${String(error)}`);
          card = this.host.buildMenuCard(chatId, 0);
        }
        await this.postPanelCard(chatId, sent.messageId, card);
      }
      this.host.syncCard(chatId);
      return sent;
    }
    const stack = this.stackFor(chatId, messageId);
    const view = stack[stack.length - 1] ?? { kind: 'menu', page: 0 };
    if (this.host.isAsyncView(view)) {
      await this.postPanelCard(chatId, messageId, this.loadingPanelCard(view));
    }
    let card: CardJson;
    try {
      card = await this.host.renderPanelView(chatId, view);
    } catch (error: unknown) {
      this.host.logger.error(`panel view render failed: ${String(error)}`);
      stack[0] = { kind: 'menu', page: 0 };
      stack.length = 1;
      try {
        await this.postPanelCard(chatId, messageId, this.host.buildMenuCard(chatId, 0));
      } catch (postError: unknown) {
        this.host.logger.warn(
          `panel menu repost after render failure failed: ${String(postError)}`,
        );
      }
      await this.host.text(chatId, t('panel.renderFailedView'));
      return { messageId };
    }
    // A card with a parent (its stack is deeper than one) can return to it:
    // append the ⬅ Back row. A standalone card seeded directly by a typed
    // command (depth one) has no parent and renders no Back.
    if (stack.length > 1) {
      card = {
        ...card,
        elements: [
          ...card.elements,
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: t('panel.back') },
                value: actionValue({ kind: 'panel-back' }),
              },
            ],
          },
        ],
      };
    }
    await this.postPanelCard(chatId, messageId, card);
    this.host.syncCard(chatId);
    return { messageId };
  }

  /** The loading placeholder for an async panel view (Back only). */
  private loadingPanelCard(view: PanelView): CardJson {
    return buildPanelNoticeCard({ title: panelViewTitle(view), hint: t('panel.loading') });
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
   * @param messageId - the card the operation runs on.
   * @param title - the panel header title to show while operating.
   * @param work - the async mutation; its outcome is posted as a result card.
   * @param finish - the completion exit (e.g. popToMenu / popToDetail).
   */
  async runPanelOperation(
    chatId: string,
    messageId: string,
    title: string,
    work: () => CommandResult | undefined | Promise<CommandResult | undefined>,
    finish: () => Promise<void>,
  ): Promise<void> {
    this.host.logger.debug(`panel OPERATION '${title}' on card ${messageId} (chat ${chatId})`);
    await this.postPanelCard(chatId, messageId, buildPanelBusyCard(title));
    try {
      const result = await work();
      if (result !== undefined) {
        this.host.logger.debug(
          `panel operation '${title}' result: ${result.kind} (${result.text.slice(0, 60)})`,
        );
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
   * Post (or in-place update) ONE panel card. With `messageId`, updates that
   * card (it must be a known panel card — unknown ids post fresh and are
   * recorded); without it (a fresh open), posts a new card. A failed update
   * falls back to posting a fresh card; a failed render/post surfaces as a
   * text notice — state and the on-screen card never diverge silently.
   * @param chatId - the chat.
   * @param messageId - the card to update, or `undefined` to post a fresh one.
   * @param card - the panel card to display.
   * @returns the message id of the card shown.
   */
  async postPanelCard(
    chatId: string,
    messageId: string | undefined,
    card: CardJson,
  ): Promise<{ messageId: string }> {
    if (messageId !== undefined) {
      this.host.logger.debug(
        `panel update card ${messageId} in chat ${chatId}: ${card.header?.title?.content ?? '(no title)'}`,
      );
      try {
        await this.host.transport.updateCard(messageId, card);
        return { messageId };
      } catch (error: unknown) {
        this.host.logger.warn(`panel render failed, reposting: ${String(error)}`);
      }
    }
    try {
      const sent = await this.host.transport.sendCard(chatId, card);
      this.panelMessageIds.set(chatId, sent.messageId);
      this.host.logger.debug(
        `panel SENT new card ${sent.messageId} in chat ${chatId} (was updating ${messageId ?? '(none)'}): ${card.header?.title?.content ?? '(no title)'}`,
      );
      return sent;
    } catch (fallbackError: unknown) {
      this.host.logger.error(`panel card could not be posted: ${String(fallbackError)}`);
      await this.host.text(chatId, t('panel.renderFailedCard'));
      return { messageId: '' };
    }
  }

  /** PUSH a sub-view onto a card's stack and render it (a button entering a
   *  new interface; Back pops back to the parent — stack semantics). */
  async pushPanel(chatId: string, messageId: string, view: PanelView): Promise<void> {
    this.host.logger.debug(`panel PUSH ${view.kind} on card ${messageId} (chat ${chatId})`);
    const stack = this.stackFor(chatId, messageId);
    stack.push(view);
    await this.showPanel(chatId, messageId);
  }

  /** POP one level on a card (Back); the menu root never pops. */
  async popPanel(chatId: string, messageId: string): Promise<void> {
    this.host.logger.debug(`panel POP on card ${messageId} (chat ${chatId})`);
    const stack = this.stackFor(chatId, messageId);
    if (stack.length > 1) stack.pop();
    await this.showPanel(chatId, messageId);
  }

  /** Replace a card's stack top (e.g. a page flip inside the current view). */
  async replacePanel(chatId: string, messageId: string, view: PanelView): Promise<void> {
    this.host.logger.debug(`panel REPLACE -> ${view.kind} on card ${messageId} (chat ${chatId})`);
    const stack = this.stackFor(chatId, messageId);
    if (stack.length > 0) stack[stack.length - 1] = view;
    await this.showPanel(chatId, messageId);
  }

  /** POP a card back to the menu root (keeping its page). */
  async popToMenu(chatId: string, messageId: string): Promise<void> {
    this.host.logger.debug(`panel popToMenu on card ${messageId} (chat ${chatId})`);
    const stack = this.stackFor(chatId, messageId);
    // The menu root: the LAST menu view on this card's stack when present
    // (page flips keep the page), else the chat's palette root (a card
    // seeded with a sub-view by a slash command still returns to the menu).
    const lastMenu = [...stack].reverse().find((view) => view.kind === 'menu');
    const root = lastMenu ?? this.panelMessageRoots.get(chatId) ?? { kind: 'menu', page: 0 };
    stack.length = 0;
    stack.push(root);
    await this.showPanel(chatId, messageId);
  }

  /** POP a card back to the session detail (after a rename completes), if present. */
  async popToDetail(chatId: string, messageId: string): Promise<void> {
    this.host.logger.debug(`panel popToDetail on card ${messageId} (chat ${chatId})`);
    const stack = this.stackFor(chatId, messageId);
    const detailIndex = stack.findLastIndex((view) => view.kind === 'session-detail');
    if (detailIndex >= 0) {
      stack.length = detailIndex + 1;
    } else {
      const root = stack[0] ?? { kind: 'menu', page: 0 };
      stack.length = 0;
      stack.push(root);
    }
    await this.showPanel(chatId, messageId);
  }

  /** The panel view stack for one (chat, card) — unknown cards default to menu. */
  panelStack(chatId: string, messageId: string): PanelView[] {
    return this.stackFor(chatId, messageId);
  }

  /** The current view of one (chat, card), defaulting to the menu root. */
  panelViewFor(chatId: string, messageId: string): PanelView {
    const stack = this.stackFor(chatId, messageId);
    return stack[stack.length - 1] ?? { kind: 'menu', page: 0 };
  }

  /** Whether one (chat, card) has a parent to return to (its view stack is
   *  deeper than one). A standalone card seeded directly by a typed slash
   *  command is at depth one → cannot pop. */
  canReturn(chatId: string, messageId: string): boolean {
    return this.stackFor(chatId, messageId).length > 1;
  }
}
