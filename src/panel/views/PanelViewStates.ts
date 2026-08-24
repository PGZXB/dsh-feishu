/**
 * Panel view states: one renderer per panel view (Strategy objects).
 *
 * Each state declares its `asyncData` flag (whether the controller must post
 * a `⏳ Loading…` placeholder before rendering) and renders its card through
 * the {@link PanelViewContext} seam. The former `panelViewIsAsync` kind list
 * in PanelController is gone — async-ness is a property of the view itself.
 * Each picker subtype is its own state (`picker:repo` / `picker:model` /
 * `picker:permission`), so adding a picker never touches a shared router.
 *
 * @module @dsh-feishu/dsh-feishu/panel/views/PanelViewStates
 */

import {
  buildConfirmCard,
  buildInputCard,
  buildModelPickerCard,
  buildPermissionPickerCard,
  buildRepoPickerCard,
  type PermissionPresetView,
} from '../../cards/render.js';
import { buildSessionDetailCard, buildSessionsCard } from '../../cards/session-list.js';
import type { CardJson } from '../../feishu/types.js';
import { PANEL_CONFIRM_SPEC, PANEL_INPUT_SPEC, type PanelView } from '../types.js';
import type { PanelViewContext } from './PanelViewContext.js';
import type { PanelViewState } from './PanelViewState.js';

/** `menu` — the palette root (sync; built by the Bridge's business side). */
export class MenuViewState implements PanelViewState {
  readonly key = 'menu';
  readonly asyncData = false;
  render(ctx: PanelViewContext, chatId: string, view: PanelView): Promise<CardJson> {
    const page = view.kind === 'menu' ? view.page : 0;
    return Promise.resolve(ctx.buildMenuCard(chatId, page));
  }
}

/** `input` — a text-input sub-view (sync; copy lives in types.ts). */
export class InputViewState implements PanelViewState {
  readonly key = 'input';
  readonly asyncData = false;
  render(_ctx: PanelViewContext, _chatId: string, view: PanelView): Promise<CardJson> {
    if (view.kind !== 'input') return Promise.resolve(this.fallback());
    const spec = PANEL_INPUT_SPEC[view.command];
    return Promise.resolve(
      buildInputCard({
        title: spec.title,
        hint: spec.hint,
        fieldName: spec.fieldName,
        placeholder: spec.placeholder,
        submitLabel: spec.submitLabel,
        command: view.command,
        ...(view.kind === 'input' && view.sessionId !== undefined
          ? { sessionId: view.sessionId }
          : {}),
      }),
    );
  }
  /** Defensive fallback for a malformed view (unreachable in practice). */
  private fallback(): CardJson {
    return buildInputCard({
      title: '✏️ Input',
      hint: 'Enter a value.',
      fieldName: 'value',
      placeholder: 'Value',
      submitLabel: 'Submit',
      command: 'cd',
    });
  }
}

/** `confirm` — a destructive-action confirmation sub-view (sync). */
export class ConfirmViewState implements PanelViewState {
  readonly key = 'confirm';
  readonly asyncData = false;
  render(_ctx: PanelViewContext, _chatId: string, view: PanelView): Promise<CardJson> {
    if (view.kind !== 'confirm') return Promise.resolve(this.fallback());
    const spec = PANEL_CONFIRM_SPEC[view.command];
    return Promise.resolve(
      buildConfirmCard({
        title: spec.title,
        message: spec.message,
        confirmLabel: spec.confirmLabel,
        command: view.command,
      }),
    );
  }
  /** Defensive fallback for a malformed view (unreachable in practice). */
  private fallback(): CardJson {
    return buildConfirmCard({
      title: '⚠️ Confirm',
      message: 'Continue?',
      confirmLabel: 'Confirm',
      command: 'clear',
    });
  }
}

/** `sessions` — the session list (async: loads the session corpus). */
export class SessionsViewState implements PanelViewState {
  readonly key = 'sessions';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, chatId: string, view: PanelView): Promise<CardJson> {
    const archived = view.kind === 'sessions' ? view.archived : false;
    const query = view.kind === 'sessions' ? view.query : undefined;
    const rows = await ctx.loadSessions(chatId, archived);
    return buildSessionsCard(rows ?? [], archived, query);
  }
}

/** `session-detail` — one session's detail sub-view (async: reads the log). */
export class SessionDetailViewState implements PanelViewState {
  readonly key = 'session-detail';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, chatId: string, view: PanelView): Promise<CardJson> {
    const sessionId = view.kind === 'session-detail' ? view.sessionId : '(unknown)';
    const detail = await ctx.sessionDetail(chatId, sessionId);
    if (detail === undefined) return this.unknown(sessionId, ctx);
    return buildSessionDetailCard(detail, ctx.canMutateSessions);
  }
  /** The session is unknown (stale list): render an inert placeholder. */
  private unknown(sessionId: string, ctx: PanelViewContext): CardJson {
    return buildSessionDetailCard(
      {
        sessionId,
        title: '(unknown)',
        cwd: undefined,
        createdAt: 0,
        messageCount: 0,
        lastSummary: undefined,
        live: false,
        current: false,
        archived: false,
      },
      ctx.canMutateSessions,
    );
  }
}

/** `picker:repo` — the project-directory picker (async: scans the roots). */
export class RepoPickerViewState implements PanelViewState {
  readonly key = 'picker:repo';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, _chatId: string, view: PanelView): Promise<CardJson> {
    // A typed `/repo <path>` passes a custom root to scan; bare uses the
    // deployment's default repoRoots. Both open the picker card.
    const roots =
      view.kind === 'picker' && view.picker === 'repo' ? (view.roots ?? ctx.repoRoots) : [];
    const page = view.kind === 'picker' && view.picker === 'repo' ? view.page : 0;
    const projects = await ctx.listProjects(roots);
    return buildRepoPickerCard(projects, roots, page);
  }
}

/** `picker:model` — the model picker (async: loads the provider catalog). */
export class ModelPickerViewState implements PanelViewState {
  readonly key = 'picker:model';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, chatId: string, _view: PanelView): Promise<CardJson> {
    const options = await ctx.loadModelOptions();
    const current = ctx.currentModelSelection(chatId);
    const withCurrent = (options ?? []).map((option) => ({
      ...option,
      current: option.value === current,
    }));
    return buildModelPickerCard(withCurrent, current);
  }
}

/** `picker:permission` — the permission-preset picker (async: resolves the
 *  live agent + preset service). */
export class PermissionPickerViewState implements PanelViewState {
  readonly key = 'picker:permission';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, chatId: string, _view: PanelView): Promise<CardJson> {
    const service = ctx.permissionPresets();
    if (service === undefined) {
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '🔐 Permission' }, template: 'wathet' },
        elements: [
          {
            tag: 'markdown',
            content: 'Permission presets are unavailable on this deployment.',
          },
        ],
      };
    }
    const agent = await ctx.ensureAgent(chatId);
    const currentPreset = service.current(agent.session.events);
    const presets: PermissionPresetView[] = service.names.map((name) => {
      const option = service.optionOf(name);
      return {
        name,
        label: option.name ?? name,
        description: option.description,
        current: name === currentPreset,
      };
    });
    return buildPermissionPickerCard(presets);
  }
}
