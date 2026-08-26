/**
 * Command-family panel actions: the palette button (`command`), the input
 * form submit (`panel-input-submit`) and the confirm submit
 * (`panel-confirm`). All run the SAME handler as the slash line; the base
 * class template guarantees the busy-placeholder-first patch for operations
 * and the no-busy navigation for sub-view routes.
 *
 * @module @dsh-feishu/dsh-feishu/panel/actions/CommandActions
 */

import type { CommandResult, SurfaceCommand } from '../../commands.js';
import type { CardAction } from '../../feishu/types.js';
import { t } from '../../i18n/index.js';
import {
  isPanelInputCommand,
  PANEL_CONFIRM_SPEC,
  PANEL_INPUT_SPEC,
  type PanelInputCommand,
} from '../types.js';
import { PanelAction } from './ActionRegistry.js';
import type { PanelActionContext } from './PanelAction.js';

/** Run one surface command handler with an invocation (shared by all three
 *  command actions). */
function runCommand(
  chatId: string,
  operatorOpenId: string,
  command: SurfaceCommand,
  rawInput: string,
): CommandResult | Promise<CommandResult> {
  return command.handler({ chatId, senderOpenId: operatorOpenId, rawInput });
}

/** Whether a palette command opens a sub-view (the router). */
function subViewFor(
  name: string | undefined,
):
  | { readonly view: 'input'; readonly command: PanelInputCommand }
  | { readonly view: 'sessions' }
  | { readonly view: 'picker'; readonly picker: 'repo' | 'model' | 'permission' }
  | { readonly view: 'confirm'; readonly command: 'clear' | 'compact' }
  | undefined {
  if (name === 'cd' || name === 'group' || name === 'goal' || name === 'feedback') {
    return { view: 'input', command: name };
  }
  if (name === 'sessions') return { view: 'sessions' };
  if (name === 'repo' || name === 'model' || name === 'permission') {
    return { view: 'picker', picker: name };
  }
  if (name === 'clear' || name === 'compact') return { view: 'confirm', command: name };
  return undefined;
}

/** `command` — a panel palette button. Commands with a sub-view route to
 *  that view (a transition — no busy); everything else runs the same
 *  handler as the slash line and completes (direct-result half of the
 *  principle). */
export class CommandAction extends PanelAction {
  readonly kind = 'command';
  readonly allowedWhileWorking = false;
  protected override isTransition(_ctx: PanelActionContext, action: CardAction): boolean {
    return subViewFor(action.value.name) !== undefined;
  }
  /** The palette's operation-path commands honor the same per-command
   *  allowed-while-working set as the slash line (help/status/schedule/…
   *  stay usable mid-turn; mutations are refused). */
  protected override isAllowedWhileWorking(ctx: PanelActionContext, action: CardAction): boolean {
    const name = action.value.name;
    return name === undefined || ctx.allowedWhileWorking(name);
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const route = subViewFor(action.value.name);
    if (route === undefined) return;
    if (route.view === 'input') {
      await ctx.pushPanel(action.chatId, { kind: 'input', command: route.command });
    } else if (route.view === 'sessions') {
      await ctx.pushPanel(action.chatId, { kind: 'sessions', archived: false });
    } else if (route.view === 'picker') {
      await ctx.pushPanel(action.chatId, { kind: 'picker', picker: route.picker, page: 0 });
    } else {
      await ctx.pushPanel(action.chatId, { kind: 'confirm', command: route.command });
    }
  }
  protected override busyTitle(_ctx: PanelActionContext, action: CardAction): string {
    return action.value.name ?? t('panel.title');
  }
  protected override work(
    ctx: PanelActionContext,
    action: CardAction,
  ): CommandResult | undefined | Promise<CommandResult | undefined> {
    const name = action.value.name;
    const command = name === undefined ? undefined : ctx.findCommand(name);
    if (command === undefined) {
      ctx.services.logger.warn(`command button for unknown command ${name ?? '(missing)'}`);
      return;
    }
    return runCommand(action.chatId, action.operatorOpenId, command, '');
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    if (ctx.canReturn(action.chatId)) {
      await ctx.popToMenu(action.chatId);
    } else {
      await ctx.replacePanel(action.chatId, ctx.panelViewFor(action.chatId));
    }
  }
}

/** `panel-input-submit` — run a text-input command with the entered value.
 *  `find-session` is a transition (re-filter the sessions view); rename and
 *  the generic commands are operations. */
export class PanelInputSubmitAction extends PanelAction {
  readonly kind = 'panel-input-submit';
  readonly allowedWhileWorking = false;
  protected override isTransition(_ctx: PanelActionContext, action: CardAction): boolean {
    return action.value.command === 'find-session';
  }
  /** find-session re-filters the list (read-only, allowed mid-turn like the
   *  slash line); the rest honor the per-command allowed set. */
  protected override isAllowedWhileWorking(ctx: PanelActionContext, action: CardAction): boolean {
    const commandName = action.value.command;
    return commandName === undefined || ctx.allowedWhileWorking(commandName);
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const rawInput = this.inputValue(action);
    const view = ctx.panelViewFor(action.chatId);
    const archived = view.kind === 'sessions' ? view.archived : false;
    await ctx.replacePanel(action.chatId, {
      kind: 'sessions',
      archived,
      query: rawInput.trim(),
    });
  }
  protected override busyTitle(_ctx: PanelActionContext, action: CardAction): string {
    const name = action.value.command;
    if (isPanelInputCommand(name)) return PANEL_INPUT_SPEC[name].title;
    return t('panel.title');
  }
  protected override work(
    ctx: PanelActionContext,
    action: CardAction,
  ): CommandResult | undefined | Promise<CommandResult | undefined> {
    const commandName = action.value.command;
    if (!isPanelInputCommand(commandName)) return;
    const rawInput = this.inputValue(action);
    if (commandName === 'rename-session') {
      // Rename through the dsh session-title service (web-visible).
      const sessionId = action.value.sessionId;
      if (sessionId === undefined || sessionId === '') return;
      const sessionTitle = ctx.services.sessionTitle;
      if (sessionTitle === undefined) {
        return {
          kind: 'error',
          text: t('panel.action.renameUnavailable'),
        };
      }
      return (async () => {
        try {
          // The title service needs the live Session object; a session with
          // no live agent (e.g. after a daemon restart) is resumed first —
          // resume loads the persisted agent without replaying history.
          let agent = ctx.services.agentStore.get(sessionId);
          if (agent === undefined) {
            agent = await ctx.services.agentStore.resume(sessionId);
          }
          const session = agent?.session;
          if (session === undefined) {
            return {
              kind: 'error',
              text: t('panel.action.sessionNotLoaded'),
            };
          }
          sessionTitle.rename(session, rawInput);
          return { kind: 'success', text: `Renamed session ${sessionId}.` };
        } catch (error: unknown) {
          ctx.services.logger.warn(`session rename failed: ${String(error)}`);
          return {
            kind: 'error',
            text: `Rename failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      })();
    }
    const command = ctx.findCommand(commandName);
    if (command === undefined) return;
    return runCommand(action.chatId, action.operatorOpenId, command, rawInput);
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const commandName = action.value.command;
    const canReturn = ctx.canReturn(action.chatId);
    if (commandName === 'rename-session') {
      if (canReturn) await ctx.popToDetail(action.chatId);
      else await ctx.replacePanel(action.chatId, ctx.panelViewFor(action.chatId));
      return;
    }
    if (canReturn) await ctx.popToMenu(action.chatId);
    else await ctx.replacePanel(action.chatId, ctx.panelViewFor(action.chatId));
  }

  /** The typed value from the form callback for this command's field. */
  private inputValue(action: CardAction): string {
    const commandName = action.value.command;
    if (!isPanelInputCommand(commandName)) return '';
    const fieldName = PANEL_INPUT_SPEC[commandName].fieldName;
    return action.formValue?.[fieldName] ?? '';
  }
}

/** `panel-confirm` — run a destructive command after confirmation. */
export class PanelConfirmAction extends PanelAction {
  readonly kind = 'panel-confirm';
  readonly allowedWhileWorking = false;
  protected override busyTitle(_ctx: PanelActionContext, action: CardAction): string {
    const name = action.value.command;
    if (name === 'clear' || name === 'compact') return PANEL_CONFIRM_SPEC[name].title;
    return t('panel.title');
  }
  protected override work(
    ctx: PanelActionContext,
    action: CardAction,
  ): CommandResult | undefined | Promise<CommandResult | undefined> {
    const commandName = action.value.command;
    const command =
      commandName === 'clear' || commandName === 'compact'
        ? ctx.findCommand(commandName)
        : undefined;
    if (command === undefined) return;
    return runCommand(action.chatId, action.operatorOpenId, command, '');
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    if (ctx.canReturn(action.chatId)) {
      await ctx.popToMenu(action.chatId);
    } else {
      await ctx.replacePanel(action.chatId, ctx.panelViewFor(action.chatId));
    }
  }
}

/** All command-family actions. */
export const COMMAND_ACTIONS: readonly PanelAction[] = [
  new CommandAction(),
  new PanelInputSubmitAction(),
  new PanelConfirmAction(),
];
