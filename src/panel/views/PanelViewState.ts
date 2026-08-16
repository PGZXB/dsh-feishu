/**
 * Panel view state + registry (Strategy): one state per panel view.
 *
 * A view state owns two things the old `renderPanelView` switch spread across
 * the Bridge:
 *   - `asyncData`: whether rendering needs async data (the controller posts a
 *     `⏳ Loading…` placeholder first — the callback-patch guarantee);
 *   - `render`: the card for the view, through the {@link PanelViewContext}
 *     seam.
 *
 * The registry maps a view KEY → state and answers the controller's two
 * questions (`isAsync`, `render`). The key is the view kind, except pickers
 * where it includes the picker subtype (`picker:repo` / `picker:model` /
 * `picker:permission`) so each picker is its own state (Open/Closed: a new
 * picker is one state class + one `register` line — no shared router). The
 * former `panelViewIsAsync` kind list is gone.
 *
 * @module @dsh-feishu/dsh-feishu/panel/views/PanelViewState
 */

import type { CardJson } from '../../feishu/types.js';
import type { PanelView } from '../types.js';
import type { PanelViewContext } from './PanelViewContext.js';

/** The registry key for a panel view (kind, or picker subtype). */
export function panelViewKey(view: PanelView): string {
  if (view.kind === 'picker') return `picker:${view.picker}`;
  return view.kind;
}

/** One panel view's renderer. */
export interface PanelViewState {
  /** The registry key this state renders (see {@link panelViewKey}). */
  readonly key: string;
  /** Whether rendering needs async data (Loading placeholder first). */
  readonly asyncData: boolean;
  /** Render the card for one panel view. */
  render(ctx: PanelViewContext, chatId: string, view: PanelView): Promise<CardJson>;
}

/** Strategy registry: panel view key → view state. */
export class PanelViewRegistry {
  private readonly states = new Map<string, PanelViewState>();

  /** Register a view state; a duplicate key replaces the previous entry. */
  register(state: PanelViewState): void {
    this.states.set(state.key, state);
  }

  /** Whether a view renders from async data (controller posts Loading first). */
  isAsync(view: PanelView): boolean {
    return this.states.get(panelViewKey(view))?.asyncData ?? false;
  }

  /** Render one panel view through its registered state. */
  async render(ctx: PanelViewContext, chatId: string, view: PanelView): Promise<CardJson> {
    const state = this.states.get(panelViewKey(view));
    if (state === undefined) {
      throw new Error(`no panel view state registered for ${panelViewKey(view)}`);
    }
    return state.render(ctx, chatId, view);
  }
}
