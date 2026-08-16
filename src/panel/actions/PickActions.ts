/**
 * Picker apply actions: the dropdown selection → apply → result → pop to
 * menu half of the panel principle. One template (the base class) covers
 * repo/model/permission picks; each subclass owns only its business step.
 *
 * @module @dsh-feishu/dsh-feishu/panel/actions/PickActions
 */

import type { CommandResult } from '../../commands.js';
import type { CardAction } from '../../feishu/types.js';
import { PanelAction } from './ActionRegistry.js';
import type { PanelActionContext } from './PanelAction.js';

/** `repo-pick` — pin the working directory and remint a fresh session. */
export class RepoPickAction extends PanelAction {
  readonly kind = 'repo-pick';
  readonly allowedWhileWorking = false;
  protected override busyTitle(): string {
    return '📚 Pick a project';
  }
  protected override work(ctx: PanelActionContext, action: CardAction): CommandResult | undefined {
    const path = action.option ?? action.value.path;
    if (path === undefined || path === '') {
      return { kind: 'error', text: 'Invalid project selection.' };
    }
    const resolved = ctx.resolveDirectory(path);
    if (!resolved.ok) return { kind: 'error', text: resolved.error };
    ctx.services.sessionMap.setCwd(action.chatId, resolved.path);
    ctx.services.sessionMap.remint(action.chatId);
    return {
      kind: 'success',
      text: `Working directory set to ${resolved.path} (session restarts on your next message).`,
    };
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    await ctx.popToMenu(action.chatId);
  }
}

/** `permission-pick` — switch the permission preset through the service. */
export class PermissionPickAction extends PanelAction {
  readonly kind = 'permission-pick';
  readonly allowedWhileWorking = false;
  protected override busyTitle(): string {
    return '🔐 Permission';
  }
  protected override work(ctx: PanelActionContext, action: CardAction): CommandResult | undefined {
    const preset = action.option ?? action.value.preset;
    if (preset === undefined || preset === '') return;
    const service = ctx.services.permissionPresets;
    const agent = ctx.liveAgent(action.chatId);
    if (service === undefined || agent === undefined) {
      return {
        kind: 'error',
        text: 'Permission pick unavailable — the bot may have restarted. Send /permission again.',
      };
    }
    try {
      service.set(agent.session, preset);
    } catch (error: unknown) {
      ctx.services.logger.warn(`permission pick failed: ${String(error)}`);
      return { kind: 'error', text: `could not switch to preset ${preset}: ${String(error)}` };
    }
    const option = service.optionOf(preset);
    return {
      kind: 'success',
      text: `Permission preset switched to ${option.name ?? preset}.`,
    };
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    await ctx.popToMenu(action.chatId);
  }
}

/** `model-pick` — set the deployment default model. */
export class ModelPickAction extends PanelAction {
  readonly kind = 'model-pick';
  readonly allowedWhileWorking = false;
  protected override busyTitle(): string {
    return '🤖 Model';
  }
  protected override work(ctx: PanelActionContext, action: CardAction): CommandResult | undefined {
    const selection = action.option ?? action.value.selection;
    if (selection === undefined || selection === '') return;
    const service = ctx.services.agentDefaultModel;
    if (service === undefined) {
      return {
        kind: 'error',
        text: 'Model pick unavailable — the agentDefaultModel service is not mounted.',
      };
    }
    const parsed = ctx.parseModelArg(selection);
    if (!parsed.ok) return { kind: 'error', text: parsed.error };
    void service.saveSelection(parsed.selection);
    return {
      kind: 'success',
      text: `Default model set to ${parsed.selection.provider} · ${parsed.selection.model} (applies to new sessions).`,
    };
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    await ctx.popToMenu(action.chatId);
  }
}

/** All picker apply actions. */
export const PICK_ACTIONS: readonly PanelAction[] = [
  new RepoPickAction(),
  new PermissionPickAction(),
  new ModelPickAction(),
];
