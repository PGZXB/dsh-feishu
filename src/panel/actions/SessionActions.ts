/**
 * Session-operation panel actions: rename, archive, export, resume — the
 * async mutations inside the session detail/list views. Each goes through
 * the base-class template (busy placeholder → work → result → exit), so the
 * callback-patch guarantee is structural.
 *
 * @module @dsh-feishu/dsh-feishu/panel/actions/SessionActions
 */

import type { CommandResult } from '../../commands.js';
import type { CardAction } from '../../feishu/types.js';
import { t } from '../../i18n/index.js';
import { PanelAction } from './ActionRegistry.js';
import type { PanelActionContext } from './PanelAction.js';

/** `resume-session` — resume a persisted session and rebind the chat. */
export class ResumeSessionAction extends PanelAction {
  readonly kind = 'resume-session';
  readonly allowedWhileWorking = false;
  protected override busyTitle(): string {
    return t('sessions.detail.title');
  }
  protected override work(
    ctx: PanelActionContext,
    action: CardAction,
  ): CommandResult | undefined | Promise<CommandResult | undefined> {
    const sessionId = action.value.sessionId;
    if (sessionId === undefined || sessionId === '') return;
    // Resume comes from the session detail view. The card callback's message
    // id is the OPEN message id (never equal to the stored message id), so
    // the guard checks the panel view instead.
    if (ctx.panelViewFor(action.chatId).kind !== 'session-detail') {
      ctx.services.logger.info(`ignoring session resume outside the detail view`);
      return;
    }
    // The detail row carries the session's cwd so the resumed chat adopts it
    // as its pinned working directory.
    return ctx.resumeSession(action.chatId, sessionId, action.value.cwd);
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    await ctx.popToMenu(action.chatId);
  }
}

/** `session-archive` — archive a session through the host workspace seam. */
export class SessionArchiveAction extends PanelAction {
  readonly kind = 'session-archive';
  readonly allowedWhileWorking = false;
  protected override busyTitle(): string {
    return t('sessions.detail.title');
  }
  protected override async work(
    ctx: PanelActionContext,
    action: CardAction,
  ): Promise<CommandResult | undefined> {
    const sessionId = action.value.sessionId;
    if (sessionId === undefined || sessionId === '') return;
    const workspace = ctx.services.getWorkspaceRegistry?.();
    if (workspace === undefined) {
      return {
        kind: 'error',
        text: t('panel.action.archiveUnavailable'),
      };
    }
    try {
      await workspace.archiveSession(sessionId);
      return { kind: 'success', text: t('panel.action.sessionArchived', { sessionId }) };
    } catch (error: unknown) {
      ctx.services.logger.warn(`session archive failed: ${String(error)}`);
      return {
        kind: 'error',
        text: t('panel.action.archiveFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    await ctx.replacePanel(action.chatId, { kind: 'sessions', archived: false });
  }
}

/** `session-export` — export the session log as a file; stay on the detail. */
export class SessionExportAction extends PanelAction {
  readonly kind = 'session-export';
  readonly allowedWhileWorking = true;
  protected override busyTitle(): string {
    return t('sessions.detail.title');
  }
  protected override work(
    ctx: PanelActionContext,
    action: CardAction,
  ): CommandResult | undefined | Promise<CommandResult | undefined> {
    const sessionId = action.value.sessionId;
    if (sessionId === undefined || sessionId === '') return;
    return ctx.exportSessionLog(action.chatId, sessionId);
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    // Export keeps the user on the detail view (the busy card is replaced by
    // the detail card again).
    await ctx.popToDetail(action.chatId);
  }
}

/** All session-operation actions. */
export const SESSION_ACTIONS: readonly PanelAction[] = [
  new ResumeSessionAction(),
  new SessionArchiveAction(),
  new SessionExportAction(),
];
