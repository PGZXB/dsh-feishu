/**
 * Picker apply actions: the dropdown selection → apply → result → pop to
 * menu half of the panel principle. One template (the base class) covers
 * repo/model/permission picks; each subclass owns only its business step.
 *
 * @module @dsh-feishu/dsh-feishu/panel/actions/PickActions
 */

import type { CommandResult } from '../../commands.js';
import type { CardAction } from '../../feishu/types.js';
import { applySessionModelSwitch } from '../../model-switch.js';
import { PanelAction } from './ActionRegistry.js';
import type { PanelActionContext } from './PanelAction.js';

/** `repo-pick` — pin the working directory and remint a fresh session. */
export class RepoPickAction extends PanelAction {
  readonly kind = 'repo-pick';
  readonly allowedWhileWorking = false;
  protected override busyTitle(): string {
    return '📚 Pick a project';
  }
  protected override async work(
    ctx: PanelActionContext,
    action: CardAction,
  ): Promise<CommandResult | undefined> {
    const path = action.option ?? action.value.path;
    if (path === undefined || path === '') {
      return { kind: 'error', text: 'Invalid project selection.' };
    }
    const resolved = ctx.resolveDirectory(path);
    if (!resolved.ok) return { kind: 'error', text: resolved.error };
    ctx.services.sessionMap.setCwd(action.chatId, resolved.path);
    ctx.services.sessionMap.remint(action.chatId);
    // Bind an explicitly-chosen Mode preset to the fresh session's agent. An
    // untouched Mode (no preset stored) binds nothing — the deployment
    // default applies (and the next message's deliverTurn would too).
    const preset = ctx.selectedAgentPreset(action.chatId);
    if (preset !== undefined) await ctx.ensureAgent(action.chatId, preset);
    return {
      kind: 'success',
      text: `Working directory set to ${resolved.path} (session restarts on your next message).`,
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

/** `preset-pick` — store the chat's chosen agent preset (Mode dropdown on a
 *  working-directory card) and re-render the card so the dropdown reflects
 *  the selection. A transition (no busy placeholder): picking a Mode is a
 *  read-only state choice, allowed even mid-turn. */
export class PresetPickAction extends PanelAction {
  readonly kind = 'preset-pick';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const preset = action.option;
    if (preset === undefined || preset === '') return;
    ctx.setSelectedAgentPreset(action.chatId, preset);
    // Re-render the current card (repo picker or cd input) so the Mode
    // dropdown shows the updated selection and its initial_option.
    await ctx.replacePanel(action.chatId, ctx.panelViewFor(action.chatId));
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
    // (B) switch the current session immediately too (not only the default).
    applySessionModelSwitch(
      ctx.liveAgent(action.chatId)?.ctx,
      parsed.selection,
      ctx.services.logger,
    );
    return {
      kind: 'success',
      text: `Model set to ${parsed.selection.provider} · ${parsed.selection.model} (this session + default).`,
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

/** All picker apply actions (including the Mode `preset-pick` store). */
export const PICK_ACTIONS: readonly PanelAction[] = [
  new RepoPickAction(),
  new PresetPickAction(),
  new PermissionPickAction(),
  new ModelPickAction(),
];
