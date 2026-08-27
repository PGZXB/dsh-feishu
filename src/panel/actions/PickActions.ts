/**
 * Picker apply actions: the dropdown selection → apply → result → pop to
 * menu half of the panel principle. One template (the base class) covers
 * repo/model/permission picks; each subclass owns only its business step.
 *
 * @module @dsh-feishu/dsh-feishu/panel/actions/PickActions
 */

import type { CommandResult } from '../../commands.js';
import type { CardAction } from '../../feishu/types.js';
import { permissionPresetLabel, t } from '../../i18n/index.js';
import { applySessionModelSwitch } from '../../model-switch.js';
import { PanelAction } from './ActionRegistry.js';
import type { PanelActionContext } from './PanelAction.js';

/** `repo-pick` — pin the working directory and remint a fresh session. */
export class RepoPickAction extends PanelAction {
  readonly kind = 'repo-pick';
  readonly allowedWhileWorking = false;
  protected override busyTitle(): string {
    return t('card.repo.title');
  }
  protected override work(ctx: PanelActionContext, action: CardAction): CommandResult | undefined {
    const path = action.option ?? action.value.path;
    if (path === undefined || path === '') {
      return { kind: 'error', text: t('panel.action.invalidProjectPick') };
    }
    const resolved = ctx.resolveDirectory(path);
    if (!resolved.ok) return { kind: 'error', text: resolved.error };
    ctx.services.sessionMap.setCwd(action.chatId, resolved.path);
    ctx.services.sessionMap.remint(action.chatId);
    return {
      kind: 'success',
      text: t('command.info.cwdSetRestart', { path: resolved.path }),
    };
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    // A navigation card (has a parent) pops back to the menu; a standalone
    // card seeded by a typed command has no parent — it stays (shows the
    // result posted by runPanelOperation) and redraws its current view so it
    // is not left on the busy placeholder.
    if (ctx.canReturn(action.chatId)) {
      await ctx.popToMenu(action.chatId);
    } else {
      await ctx.replacePanel(action.chatId, ctx.panelViewFor(action.chatId));
    }
  }
}

/** `permission-pick` — switch the permission preset through the service. */
export class PermissionPickAction extends PanelAction {
  readonly kind = 'permission-pick';
  readonly allowedWhileWorking = false;
  protected override busyTitle(): string {
    return t('command.cmd.permission.label');
  }
  protected override work(ctx: PanelActionContext, action: CardAction): CommandResult | undefined {
    const preset = action.option ?? action.value.preset;
    if (preset === undefined || preset === '') return;
    const service = ctx.services.permissionPresets;
    const agent = ctx.liveAgent(action.chatId);
    if (service === undefined || agent === undefined) {
      return {
        kind: 'error',
        text: t('panel.action.permissionPickUnavailable'),
      };
    }
    try {
      service.set(agent.session, preset);
    } catch (error: unknown) {
      ctx.services.logger.warn(`permission pick failed: ${String(error)}`);
      return {
        kind: 'error',
        text: t('panel.action.permissionSwitchFailed', {
          preset,
          detail: String(error),
        }),
      };
    }
    const option = service.optionOf(preset);
    return {
      kind: 'success',
      text: t('command.info.permissionSwitched', {
        preset: permissionPresetLabel(option.name ?? preset),
      }),
    };
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    // A navigation card (has a parent) pops back to the menu; a standalone
    // card seeded by a typed command has no parent — it stays (shows the
    // result posted by runPanelOperation) and redraws its current view so it
    // is not left on the busy placeholder.
    if (ctx.canReturn(action.chatId)) {
      await ctx.popToMenu(action.chatId);
    } else {
      await ctx.replacePanel(action.chatId, ctx.panelViewFor(action.chatId));
    }
  }
}

/** `model-pick` — set the deployment default model. */
export class ModelPickAction extends PanelAction {
  readonly kind = 'model-pick';
  readonly allowedWhileWorking = false;
  protected override busyTitle(): string {
    return t('panel.model.title');
  }
  protected override work(ctx: PanelActionContext, action: CardAction): CommandResult | undefined {
    const selection = action.option ?? action.value.selection;
    if (selection === undefined || selection === '') return;
    const service = ctx.services.agentDefaultModel;
    if (service === undefined) {
      return {
        kind: 'error',
        text: t('panel.action.modelPickUnavailable'),
      };
    }
    const parsed = ctx.parseModelArg(selection);
    if (!parsed.ok) return { kind: 'error', text: parsed.error };
    void service.saveSelection(parsed.selection);
    // (B) switch the current session immediately too (not only the default).
    applySessionModelSwitch(
      ctx.liveAgent(action.chatId)?.ctx,
      parsed.selection,
      ctx.services.logger,
    );
    return {
      kind: 'success',
      text: t('command.info.modelSet', {
        selection: `${parsed.selection.provider} · ${parsed.selection.model}`,
      }),
    };
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    // A navigation card (has a parent) pops back to the menu; a standalone
    // card seeded by a typed command has no parent — it stays (shows the
    // result posted by runPanelOperation) and redraws its current view so it
    // is not left on the busy placeholder.
    if (ctx.canReturn(action.chatId)) {
      await ctx.popToMenu(action.chatId);
    } else {
      await ctx.replacePanel(action.chatId, ctx.panelViewFor(action.chatId));
    }
  }
}

/** All picker apply actions. */
export const PICK_ACTIONS: readonly PanelAction[] = [
  new RepoPickAction(),
  new PermissionPickAction(),
  new ModelPickAction(),
];
