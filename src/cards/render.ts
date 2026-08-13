/**
 * Card rendering: pure functions that turn session events into Feishu card
 * JSON. No I/O here — the streaming manager owns the card pipeline and the
 * transport owns the wire.
 *
 * Layout order (feedback-driven): thinking first (dimmed), then tool calls
 * in chronological order, then the final output at the bottom — the natural
 * "process then result" reading, like a terminal or chat log.
 *
 * @module @dsh-feishu/dsh-feishu/cards/render
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { CardElement, CardJson } from '../feishu/types.js';
import type { ProjectInfo } from '../projects.js';
import { markdownToElements } from './markdown.js';

/** Terminal/working state of one streaming card. */
export type CardStatus = 'working' | 'done' | 'error';

/** One tool invocation shown on the live card. */
export interface ToolRecord {
  readonly name: string;
  readonly status: 'running' | 'done' | 'error';
  /** Raw JSON arguments, truncated for display. */
  readonly args: string;
  /** Result text (or error), truncated for display. */
  readonly result: string;
}

/** Everything the card shows for one turn. */
export interface CardSnapshot {
  readonly title: string;
  /** Accumulated assistant text (rendered as markdown). */
  readonly content: string;
  /** Accumulated reasoning text (dimmed, truncated). */
  readonly thinking: string;
  /** Tool calls, chronological order. */
  readonly tools: readonly ToolRecord[];
  readonly status: CardStatus;
}

/** Header template color per status. */
const STATUS_TEMPLATE: Record<CardStatus, string> = {
  working: 'blue',
  done: 'green',
  error: 'red',
};

/** Longest card body we ever send; the Feishu card cap is ~109KB. */
export const MAX_CARD_CHARS = 60_000;

/** Longest thinking snippet shown on the live card (dimmed, truncated). */
export const MAX_THINKING_CHARS = 500;

/** Longest tool args/result text kept per record. */
export const MAX_TOOL_RECORD_CHARS = 300;

/** Surface action payloads stamped on card buttons. */
export type SurfaceAction =
  | { readonly kind: 'stop' }
  | { readonly kind: 'copy' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'panel' }
  | { readonly kind: 'tool-details' }
  | { readonly kind: 'repo-pick' }
  | { readonly kind: 'repo-page' };

/**
 * Projects per picker card page (the button-based fallback, used only when
 * the project list exceeds the dropdown option cap).
 */
export const REPO_PAGE_SIZE = 8;

/**
 * Hard cap on `select_static` option count for the repo dropdown. Feishu
 * caps select options around this (botmux's `JUMP_PAGE_MAX_OPTIONS`); above
 * it we fall back to the numbered-button list.
 */
export const REPO_SELECT_MAX_OPTIONS = 50;

/**
 * Dropdown label for one project. Names are kept short, but repos sharing a
 * basename get a path disambiguator appended (feedback: many same-named
 * repos at different paths are confusing with bare basenames).
 * @param project - the project to label.
 * @param duplicates - basenames that appear more than once in the scan.
 * @param commonPrefix - longest directory prefix shared by all projects.
 * @returns the option label.
 */
export function repoOptionLabel(
  project: ProjectInfo,
  duplicates: ReadonlySet<string>,
  commonPrefix: string,
): string {
  const base = `${project.name} (${project.branch})${
    project.type === 'worktree' ? ' [worktree]' : ''
  }`;
  if (!duplicates.has(project.name)) return base;
  const rel = project.path.slice(commonPrefix.length).replace(/^[/\\]+/, '');
  return rel === '' ? `${base} — ${project.path}` : `${base} — ${rel}`;
}

/**
 * Build the interactive repo-picker card. With up to
 * {@link REPO_SELECT_MAX_OPTIONS} projects, selection is a `select_static`
 * dropdown placed DIRECTLY inside an `action` container (botmux pattern:
 * Feishu silently drops form/select/input controls inside a `form` in this
 * card layout, but a select inside an `action` renders and fires a card
 * callback whose `option` field carries the chosen value; the select's own
 * `value` carries the `{kind:'repo-pick'}` marker). Beyond the cap, the card
 * falls back to numbered project buttons with pagination.
 * @param projects - candidate projects (recursively scanned).
 * @param page - zero-based page index (button fallback only).
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildRepoPickerCard(projects: readonly ProjectInfo[], page = 0): CardJson {
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content:
        '**Pick a project directory** — choose one from the dropdown, or use `/cd <path>` for a custom directory.',
    },
    { tag: 'hr' },
  ];
  if (projects.length > 0 && projects.length <= REPO_SELECT_MAX_OPTIONS) {
    const counts = new Map<string, number>();
    for (const project of projects) {
      counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
    }
    const duplicates = new Set(
      [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
    );
    const commonPrefix = longestCommonPathPrefix(projects.map((p) => p.path));
    // Dropdown primary (botmux `repo_switch` pattern): the select lives
    // inside an `action` container, not a `form`.
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: 'Choose a project…' },
          options: projects.map((project, index) => ({
            text: {
              tag: 'plain_text',
              content: `${index + 1}. ${repoOptionLabel(project, duplicates, commonPrefix)}`,
            },
            value: project.path,
          })),
          value: { kind: 'repo-pick' },
        },
      ],
    });
  } else if (projects.length > REPO_SELECT_MAX_OPTIONS) {
    const start = page * REPO_PAGE_SIZE;
    const pageProjects = projects.slice(start, start + REPO_PAGE_SIZE);
    const buttons = pageProjects.map((project, index) => ({
      tag: 'button' as const,
      text: { tag: 'plain_text' as const, content: `${start + index + 1}. ${project.path}` },
      value: { kind: 'repo-pick', path: project.path },
    }));
    if (buttons.length > 0) {
      elements.push({ tag: 'action', actions: buttons });
    }
    const hasPrev = page > 0;
    const hasNext = start + pageProjects.length < projects.length;
    if (hasPrev || hasNext) {
      const nav: Array<{
        tag: 'button';
        text: { tag: 'plain_text'; content: string };
        type?: 'default';
        value: Record<string, string>;
      }> = [];
      if (hasPrev)
        nav.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '‹ Prev' },
          value: { kind: 'repo-page', page: String(page - 1) },
        });
      if (hasNext)
        nav.push({
          tag: 'button',
          text: { tag: 'plain_text', content: 'Next ›' },
          value: { kind: 'repo-page', page: String(page + 1) },
        });
      elements.push({ tag: 'action', actions: nav });
    }
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📚 Pick a project' }, template: 'wathet' },
    elements,
  };
}

/** The static card a picker becomes once a project is chosen (no actions, so
 *  further taps do nothing — the picker is consumed). */
export function buildRepoPickedCard(path: string): CardJson {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📚 Project picked' }, template: 'green' },
    elements: [
      { tag: 'markdown', content: `✅ Working directory set to\n\n\`${path}\`` },
      { tag: 'note', elements: [{ tag: 'plain_text', content: 'Run /repo again to change it.' }] },
    ],
  };
}

/** Longest directory prefix shared by all paths (empty when none). */
function longestCommonPathPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  let prefix = paths[0] ?? '';
  for (const path of paths.slice(1)) {
    while (!path.startsWith(prefix)) {
      const cut = prefix.lastIndexOf('/');
      if (cut <= 0) return '';
      prefix = prefix.slice(0, cut);
    }
  }
  return prefix;
}

/** Encode a surface action as a button value payload. */
export function actionValue(action: SurfaceAction): Record<string, string> {
  return { kind: action.kind };
}

/** The button row appended by status: working → stop; done → copy/retry/panel;
 *  error → retry/panel. A tools button appears when the turn invoked tools. */
function statusButtons(status: CardStatus, hasTools: boolean): CardElement {
  const actions: Array<{
    readonly tag: 'button';
    readonly text: { readonly tag: 'plain_text'; readonly content: string };
    readonly type?: 'primary' | 'danger' | 'default';
    readonly value: Record<string, string>;
  }> = [];
  if (status === 'working') {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⏹ Stop' },
      type: 'danger',
      value: actionValue({ kind: 'stop' }),
    });
  } else {
    if (status === 'done') {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '📋 Copy' },
        value: actionValue({ kind: 'copy' }),
      });
    }
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔁 Retry' },
      value: actionValue({ kind: 'retry' }),
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⚙️ Panel' },
      value: actionValue({ kind: 'panel' }),
    });
    if (hasTools) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '🔧 Tools' },
        value: actionValue({ kind: 'tool-details' }),
      });
    }
  }
  return { tag: 'action', actions };
}

/**
 * Truncate text to `maxChars`, keeping the newest tail (botmux behavior:
 * long output should preserve the latest lines, which is what the user is
 * waiting on). The marker is prepended so the newest content stays at the
 * end of the rendered card.
 * @param text - full text.
 * @param maxChars - maximum returned length.
 * @returns the tail of `text`, or the full text when short enough.
 */
export function truncateTail(text: string, maxChars = MAX_CARD_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = `… (truncated ${text.length - maxChars} chars)\n`;
  const keep = maxChars - marker.length;
  if (keep < 1) return `…${text.slice(0, Math.max(1, maxChars - 1))}`;
  return `${marker}${text.slice(-keep)}`;
}

/** Truncate text to `maxChars`, keeping the head (for thinking/args). */
export function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/** Strip angle brackets from text interpolated into inline `<font>` spans so
 *  untrusted model output cannot inject card markup. */
export function stripAngleBrackets(text: string): string {
  return text.replaceAll('<', '').replaceAll('>', '');
}

/** Extract the plain text of an assembled assistant message. */
export function assistantText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** One compact tool line for the live card. */
function toolLine(tool: ToolRecord): string {
  const icon = tool.status === 'running' ? '🔧' : tool.status === 'done' ? '✅' : '❌';
  return `${icon} ${tool.name}`;
}

/**
 * Build the card JSON for one snapshot. Element order: thinking (dimmed,
 * truncated) → tool lines (chronological) → final output at the bottom
 * (markdown-rendered) → status → buttons.
 * @param snapshot - title, content, thinking, tools, and status.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildCard(snapshot: CardSnapshot): CardJson {
  const elements: CardElement[] = [];
  if (snapshot.thinking.trim() !== '') {
    const thinking = truncateHead(snapshot.thinking.trim(), MAX_THINKING_CHARS);
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>💭 ${stripAngleBrackets(thinking)}</font>`,
    });
  }
  for (const tool of snapshot.tools) {
    elements.push({ tag: 'markdown', content: toolLine(tool) });
  }
  if (elements.length > 0 && snapshot.content.trim() !== '') {
    elements.push({ tag: 'hr' });
  }
  const body = truncateTail(snapshot.content).trim();
  if (body !== '') {
    elements.push(...markdownToElements(body));
  }
  if (snapshot.status !== 'working' || elements.length === 0) {
    elements.push({ tag: 'hr' });
    const statusLine =
      snapshot.status === 'error'
        ? '**⚠️ Turn ended with an error**'
        : snapshot.status === 'done'
          ? '**✅ Done**'
          : '**… working**';
    elements.push({ tag: 'markdown', content: statusLine });
  }
  elements.push(statusButtons(snapshot.status, snapshot.tools.length > 0));
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: snapshot.title },
      template: STATUS_TEMPLATE[snapshot.status],
    },
    // v1 layout (root elements, no schema field): the only layout that
    // supports the interactive action buttons (schema 2.0 rejects `action`).
    elements,
  };
}

/**
 * Build the tool-details card: one entry per tool call with its arguments
 * and result, opened from the 🔧 Tools button.
 * @param title - the owning turn's title (card header).
 * @param tools - the turn's tool records (chronological).
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildToolDetailsCard(title: string, tools: readonly ToolRecord[]): CardJson {
  const elements: CardElement[] = [];
  if (tools.length === 0) {
    elements.push({ tag: 'markdown', content: 'No tool calls in this turn.' });
  }
  tools.forEach((tool, index) => {
    const statusIcon = tool.status === 'done' ? '✅' : tool.status === 'error' ? '❌' : '🔧';
    elements.push({
      tag: 'markdown',
      content: `${statusIcon} **${index + 1}. ${tool.name}** — ${tool.status}`,
    });
    if (tool.args !== '') {
      elements.push({
        tag: 'markdown',
        content: `<font color='grey'>args: \`${stripAngleBrackets(truncateHead(tool.args, 400))}\`</font>`,
      });
    }
    if (tool.result !== '') {
      elements.push({
        tag: 'markdown',
        content: `<font color='grey'>result: ${stripAngleBrackets(truncateHead(tool.result, 400))}</font>`,
      });
    }
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔧 ${title}` },
      template: 'wathet',
    },
    elements,
  };
}

/**
 * Build the control-panel card: a standing operation surface the user can
 * click without typing a slash command (stop / retry / copy / panel).
 * @param statusLine - a short current-state line for the panel body.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildPanelCard(statusLine: string): CardJson {
  const elements: CardElement[] = [
    { tag: 'markdown', content: statusLine },
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '⏹ Stop current' },
          type: 'danger',
          value: actionValue({ kind: 'stop' }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🔁 Retry last' },
          value: actionValue({ kind: 'retry' }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '📋 Copy last' },
          value: actionValue({ kind: 'copy' }),
        },
      ],
    },
  ];
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚙️ dsh-feishu panel' },
      template: 'wathet',
    },
    elements,
  };
}
