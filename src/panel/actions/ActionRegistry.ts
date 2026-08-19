/**
 * Panel action base class (Template Method) + action registry (Strategy).
 *
 * Every panel card action is a {@link PanelAction} subclass. The base class
 * owns the lifecycle template — the order that makes every "panel reverts
 * mid-action" bug impossible to reintroduce:
 *
 *   - `gate` (default: refuse when a turn runs and the action mutates);
 *   - TRANSITION actions (isTransition → true): just navigate
 *     (push/replace/pop) — the view's own showPanel handles loading;
 *   - OPERATION actions: `runPanelOperation` — post an `⏳ Operating…`
 *     placeholder FIRST (the callback-patch guarantee), run the business
 *     work, post the result card, run the completion exit (which patches
 *     again).
 *
 * A subclass implements `kind`, `isTransition`, and the hooks the chosen
 * mode needs — the template forces the order, so no action can ever
 * "forget" to patch before awaiting.
 *
 * The registry maps `action.value.kind` → action and dispatches; unknown
 * kinds log and no-op. Registering a new action is one subclass + one
 * `register` line (Open/Closed).
 *
 * @module @dsh-feishu/dsh-feishu/panel/actions/ActionRegistry
 */

import type { CommandResult } from '../../commands.js';
import type { CardAction } from '../../feishu/types.js';
import type { PanelActionContext } from './PanelAction.js';

/** One panel action's marker kind (the `action.value.kind` it handles). */
export type PanelActionKind = string;

/** Base class for ALL panel actions (Template Method). */
export abstract class PanelAction {
  /** The `action.value.kind` this action handles. */
  abstract readonly kind: PanelActionKind;
  /** Whether the action is read-only (allowed while a turn runs). Subclasses
   *  with per-invocation gates (command-family) override {@link
   *  isAllowedWhileWorking} instead. */
  abstract readonly allowedWhileWorking: boolean;
  /**
   * Whether THIS invocation is allowed while a turn runs. Defaults to the
   * static {@link allowedWhileWorking}; command-family actions consult the
   * per-command allowed set (the same ALLOWED_WHILE_WORKING the slash line
   * uses), so e.g. the `help` button stays usable mid-turn while `export`
   * is refused.
   * @param ctx - the action context.
   * @param action - the normalized card callback.
   */
  protected isAllowedWhileWorking(_ctx: PanelActionContext, _action: CardAction): boolean {
    return this.allowedWhileWorking;
  }
  /**
   * Whether this invocation only NAVIGATES (push/replace/pop) — no busy
   * placeholder, no result card, no completion exit. Navigation is the whole
   * action; `showPanel` already posts Loading for async views.
   * @returns true for this invocation (may depend on the action payload).
   */
  protected isTransition(_ctx: PanelActionContext, _action: CardAction): boolean {
    return false;
  }
  /** The transition path (used when isTransition → true). */
  protected transition?(ctx: PanelActionContext, action: CardAction): Promise<void>;
  /** The panel header title shown on the operating placeholder. */
  protected busyTitle(_ctx: PanelActionContext, _action: CardAction): string {
    return '⚙️ dsh-feishu panel';
  }
  /** The business mutation; its outcome becomes the result card. */
  protected work?(
    ctx: PanelActionContext,
    action: CardAction,
  ): CommandResult | undefined | Promise<CommandResult | undefined>;
  /** The completion exit (popToMenu / popToDetail / replacePanel / …). */
  protected finish?(ctx: PanelActionContext, action: CardAction): Promise<void>;

  /**
   * The lifecycle template. Subclasses implement {@link work}/{@link finish}
   * (or {@link transition}); the transition → gate → busy → work → result →
   * exit order is fixed here. Transitions (pure navigation, e.g. opening a
   * sub-view) bypass the working-state gate — matching the original semantics
   * where palette sub-view routes never refused; the gate applies only to
   * mutations.
   * @param ctx - the action context.
   * @param action - the normalized card callback.
   */
  async run(ctx: PanelActionContext, action: CardAction): Promise<void> {
    if (this.isTransition(ctx, action)) {
      ctx.services.logger.debug(
        `panel action ${this.kind}: transition on card ${action.messageId} (chat ${action.chatId})`,
      );
      await this.transition?.(ctx, action);
      return;
    }
    if (ctx.isWorking(action.chatId) && !this.isAllowedWhileWorking(ctx, action)) {
      ctx.services.logger.debug(
        `panel action ${this.kind}: refused while working (chat ${action.chatId})`,
      );
      await ctx.replyText(action.chatId, '⚠️ a turn is running — stop it first.');
      return;
    }
    ctx.services.logger.debug(
      `panel action ${this.kind}: operation on card ${action.messageId} (chat ${action.chatId})`,
    );
    await ctx.runPanelOperation(
      action.chatId,
      this.busyTitle(ctx, action),
      () => this.work?.(ctx, action),
      () => this.finish?.(ctx, action) ?? Promise.resolve(),
    );
  }
}

/** Strategy registry: `action.value.kind` → action handler. */
export class PanelActionRegistry {
  private readonly actions = new Map<PanelActionKind, PanelAction>();

  /** Register an action; a duplicate kind replaces the previous entry. */
  register(action: PanelAction): void {
    this.actions.set(action.kind, action);
  }

  /** All registered kinds (for tests / diagnostics). */
  kinds(): readonly PanelActionKind[] {
    return [...this.actions.keys()];
  }

  /** Dispatch one card action; unknown kinds log and no-op. */
  async handle(ctx: PanelActionContext, action: CardAction): Promise<void> {
    const kind = action.value.kind;
    const handler = kind === undefined ? undefined : this.actions.get(kind);
    if (handler === undefined) {
      ctx.services.logger.warn(`unknown card action kind: ${kind ?? '(missing)'}`);
      return;
    }
    await handler.run(ctx, action);
  }
}
