/**
 * Navigator panel actions: pure stack navigation (push/replace/pop) with no
 * async business work — the "jump to a new panel view" half of the panel
 * principle (a button that needs more interaction moves the panel). These
 * are TRANSITION actions: no busy placeholder, no result card, no completion
 * exit — the navigation IS the action.
 *
 * @module @dsh-feishu/dsh-feishu/panel/actions/NavigatorActions
 */

import type { CardAction } from '../../feishu/types.js';
import { PanelAction } from './ActionRegistry.js';
import type { PanelActionContext } from './PanelAction.js';

/** `panel` — the streaming card's ⚙️ Panel button: OPEN the control panel as
 *  a FRESH card. (A stale panel card may be scrolled far up the chat;
 *  popToMenu would silently update that off-screen card and the tap would
 *  look dead — user report.) */
export class PanelHomeAction extends PanelAction {
  readonly kind = 'panel';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    await ctx.openPanel(action.chatId);
  }
}

/** `panel-page` — flip the palette page at the menu root only. */
export class PanelPageAction extends PanelAction {
  readonly kind = 'panel-page';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const page = Number(action.value.page);
    if (!Number.isInteger(page) || page < 0) return;
    if (ctx.panelViewFor(action.chatId).kind !== 'menu') return;
    await ctx.replacePanel(action.chatId, { kind: 'menu', page });
  }
}

/** `panel-back` — pop one stack level (the menu root never pops). */
export class PanelBackAction extends PanelAction {
  readonly kind = 'panel-back';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    await ctx.popPanel(action.chatId);
  }
}

/** `session-select` — open a session's detail sub-view. */
export class SessionSelectAction extends PanelAction {
  readonly kind = 'session-select';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const sessionId = action.option ?? action.value.sessionId;
    if (sessionId === undefined || sessionId === '') return;
    await ctx.pushPanel(action.chatId, { kind: 'session-detail', sessionId });
  }
}

/** `sessions-archived-toggle` — flip active ⇄ archived on the sessions view. */
export class SessionsArchivedToggleAction extends PanelAction {
  readonly kind = 'sessions-archived-toggle';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const view = ctx.panelViewFor(action.chatId);
    const archived = view.kind === 'sessions' ? !view.archived : false;
    await ctx.replacePanel(action.chatId, { kind: 'sessions', archived });
  }
}

/** `session-find` — open the find-session input (reach any session). */
export class SessionFindAction extends PanelAction {
  readonly kind = 'session-find';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    await ctx.pushPanel(action.chatId, { kind: 'input', command: 'find-session' });
  }
}

/** `session-rename` — open the rename-session input for one session. */
export class SessionRenameAction extends PanelAction {
  readonly kind = 'session-rename';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const sessionId = action.value.sessionId;
    if (sessionId === undefined || sessionId === '') return;
    await ctx.pushPanel(action.chatId, { kind: 'input', command: 'rename-session', sessionId });
  }
}

/** `repo-page` — flip the repo picker page. */
export class RepoPageAction extends PanelAction {
  readonly kind = 'repo-page';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const page = Number(action.value.page);
    if (!Number.isInteger(page) || page < 0) return;
    await ctx.replacePanel(action.chatId, { kind: 'picker', picker: 'repo', page });
  }
}

/** `model-page` — flip the model picker page. */
export class ModelPageAction extends PanelAction {
  readonly kind = 'model-page';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const page = Number(action.value.page);
    if (!Number.isInteger(page) || page < 0) return;
    await ctx.replacePanel(action.chatId, { kind: 'picker', picker: 'model', page });
  }
}

/** All navigator actions (registered together). */
export const NAVIGATOR_ACTIONS: readonly PanelAction[] = [
  new PanelHomeAction(),
  new PanelPageAction(),
  new PanelBackAction(),
  new SessionSelectAction(),
  new SessionsArchivedToggleAction(),
  new SessionFindAction(),
  new SessionRenameAction(),
  new RepoPageAction(),
  new ModelPageAction(),
];
