/**
 * Card rendering: pure functions that turn session events into Feishu card
 * JSON. No I/O here — the streaming manager owns the card pipeline and the
 * transport owns the wire.
 *
 * Layout mirrors DSH web (feedback-driven): a chronological sequence of
 * one-line rows — think rows and tool rows — each with an expand button,
 * then the complete output at the bottom, then the execution status and the
 * button area. Every row carries a stable id so a button tap can open that
 * exact row's details card.
 *
 * @module @dsh-feishu/dsh-feishu/cards/render
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { CardElement, CardJson, ColumnContainer } from '../feishu/types.js';
import type { ProjectInfo } from '../projects.js';
import { markdownToElements } from './markdown.js';
import { toolRowTitle } from './tool-summary.js';

/** Terminal/working state of one streaming card. `stopped` is the terminal
 *  state of a turn aborted by the user (Stop) — distinct from `done` so the
 *  card reads "Stopped", not "Done" (DSH web: message.stopped). */
export type CardStatus = 'working' | 'done' | 'error' | 'stopped';

/** One think row: a reasoning block, line = `☁️ Think · Thinking`.
 *  The line always reads "Thinking" (a live latest-line would flicker
 *  through throttled card patches); the full text lives in the expand card.
 */
export interface ThinkRow {
  readonly kind: 'think';
  readonly id: string;
  /** Accumulated reasoning text (full, for the expand card). */
  readonly text: string;
  /** Whether the block settled (row lifecycle; display never changes). */
  readonly settled: boolean;
}

/** One tool row: line = `Title · summary`, expand shows args + result. */
export interface ToolRow {
  readonly kind: 'tool';
  /** Tool call id (stable, pairs call ↔ result). */
  readonly id: string;
  readonly name: string;
  readonly status: 'running' | 'done' | 'error';
  /** One-line summary derived from the FULL arguments at capture time —
   *  truncating the stored args must never degrade the visible summary. */
  readonly summary: string;
  /** Raw JSON arguments (may be truncated for card size). */
  readonly args: string;
  /** Result text (may be truncated). */
  readonly result: string;
}

/** Any chronological row on the live card. */
export type TurnRow = ThinkRow | ToolRow;

/** Everything the card shows for one turn. */
export interface CardSnapshot {
  readonly title: string;
  /** Accumulated assistant text (rendered as markdown, bottom of the card). */
  readonly content: string;
  /** Chronological think/tool rows (all of them — no truncation). */
  readonly rows: readonly TurnRow[];
  /** Session cwd, used to relativize workspace-rooted path summaries. */
  readonly cwd?: string;
  /** Collapse the row sequence to one `think -> tool -> …` line. */
  readonly collapsed?: boolean;
  /** The user pressed Stop; show an in-progress Stopping state. */
  readonly stopRequested?: boolean;
  readonly status: CardStatus;
}

/** Header template color per status. `stopped` uses amber — the DSH web
 *  warning semantic for interrupted work (StateDot warning). */
const STATUS_TEMPLATE: Record<CardStatus, string> = {
  working: 'blue',
  done: 'green',
  error: 'red',
  stopped: 'orange',
};

/** Longest card body we ever send; the Feishu card cap is ~109KB. */
export const MAX_CARD_CHARS = 60_000;

/** Longest reasoning text kept per think row (the live line is one-liner). */
export const MAX_THINK_CHARS = 2000;

/** Surface action payloads stamped on card buttons. */
export type SurfaceAction =
  | { readonly kind: 'stop' }
  | { readonly kind: 'copy' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'panel' }
  | { readonly kind: 'row-details'; readonly id: string }
  | { readonly kind: 'toggle-rows' }
  | { readonly kind: 'repo-pick' }
  | { readonly kind: 'repo-page' }
  | { readonly kind: 'command'; readonly name: string }
  | { readonly kind: 'resume-session'; readonly sessionId: string }
  | { readonly kind: 'panel-page'; readonly page: string }
  | { readonly kind: 'sessions-page'; readonly page: string }
  | { readonly kind: 'permission-pick'; readonly preset: string };

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
 * The path of a project relative to the repoRoot it lives under, or the
 * full path when no root contains it. Repos named generically (`source`,
 * `backend`) are only meaningful through their parent path — the picker
 * shows relative paths always (feedback).
 */
export function repoRelativePath(project: ProjectInfo, roots: readonly string[]): string {
  let best: string | undefined;
  for (const root of roots) {
    const normalized = root.replace(/[/\\]+$/, '');
    if (project.path === normalized || project.path.startsWith(`${normalized}/`)) {
      if (best === undefined || normalized.length > best.length) {
        best = normalized;
      }
    }
  }
  if (best === undefined) return project.path;
  const rel = project.path.slice(best.length).replace(/^[/\\]+/, '');
  return rel === '' ? project.path : rel;
}

/**
 * Dropdown label for one project: `<relative path> (branch)` — always the
 * repoRoot-relative path, not the bare basename (feedback).
 */
export function repoOptionLabel(project: ProjectInfo, roots: readonly string[]): string {
  const rel = repoRelativePath(project, roots);
  return `${rel} (${project.branch})${project.type === 'worktree' ? ' [worktree]' : ''}`;
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
 * @param roots - repoRoots, used to show relative paths in labels.
 * @param page - zero-based page index (button fallback only).
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildRepoPickerCard(
  projects: readonly ProjectInfo[],
  roots: readonly string[],
  page = 0,
): CardJson {
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content:
        '**Pick a project directory** — choose one from the dropdown, or use `/cd <path>` for a custom directory.',
    },
    { tag: 'hr' },
  ];
  if (projects.length > 0 && projects.length <= REPO_SELECT_MAX_OPTIONS) {
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
              content: `${index + 1}. ${repoOptionLabel(project, roots)}`,
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
      text: {
        tag: 'plain_text' as const,
        content: `${start + index + 1}. ${repoOptionLabel(project, roots)}`,
      },
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

/** Encode a surface action as a button value payload (kind + extra fields). */
export function actionValue(action: SurfaceAction): Record<string, string> {
  const value: Record<string, string> = {};
  for (const [key, entry] of Object.entries(action)) {
    if (entry !== undefined) value[key] = String(entry);
  }
  return value;
}

/** The button row appended by status: working → stop; done → copy/retry/panel;
 *  error → retry/panel. When the turn has rows, a persistent toggle button
 *  expands/collapses the think-tool sequence (always visible, like Stop). */
function statusButtons(status: CardStatus, hasRows: boolean, collapsed: boolean): CardElement {
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
  }
  if (hasRows) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: collapsed ? '▸ Expand' : '▾ Collapse' },
      type: 'default',
      value: actionValue({ kind: 'toggle-rows' }),
    });
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

/** The one-line display text of a row, DSH web style. */
export function rowLine(row: TurnRow): string {
  if (row.kind === 'think') {
    // Always "Thinking" — a live latest-line would flicker through
    // throttled card patches; the full text lives in the expand card.
    return '☁️ Think · Thinking';
  }
  const icon = row.status === 'running' ? '🔧' : row.status === 'done' ? '✅' : '❌';
  return `${icon} ${toolRowTitle(row.name)} · ${row.summary}`;
}

/**
 * The minimal collapsed sequence for a turn: row names joined with
 * ` -> ` (`think -> bash -> read`). Think rows read "think", tool rows read
 * their tool name. The full sequence is shown — no truncation.
 */
export function collapseSequence(rows: readonly TurnRow[]): string {
  const names = rows.map((row) => stripAngleBrackets(row.kind === 'think' ? 'think' : row.name));
  return names.join(' -> ');
}

/** One card row: the line text plus its expand button (opens row details). */
function rowElement(row: TurnRow): CardElement {
  const line = stripAngleBrackets(rowLine(row));
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'default',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: line } }],
      },
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⋯' },
            type: 'default',
            value: actionValue({ kind: 'row-details', id: row.id }),
          },
        ],
      },
    ],
  };
}

/**
 * Build the card JSON for one snapshot. Element order: think/tool rows
 * (chronological, all of them) → complete output at the bottom (markdown
 * rendered) → status → buttons. Mirrors DSH web's message flow.
 * @param snapshot - title, content, rows, and status.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildCard(snapshot: CardSnapshot): CardJson {
  const elements: CardElement[] = [];
  const collapsed = snapshot.collapsed ?? false;
  if (collapsed && snapshot.rows.length > 0) {
    // The minimal sequence, one line: `think -> bash -> read -> …`.
    elements.push({ tag: 'markdown', content: collapseSequence(snapshot.rows) });
  } else {
    for (const row of snapshot.rows) {
      elements.push(rowElement(row));
    }
  }
  if (elements.length > 0 && snapshot.content.trim() !== '') {
    elements.push({ tag: 'hr' });
  }
  const body = truncateTail(snapshot.content).trim();
  if (body !== '') {
    elements.push(...markdownToElements(body));
  }
  const stopping = snapshot.stopRequested === true && snapshot.status === 'working';
  if (snapshot.status !== 'working' || stopping || elements.length === 0) {
    elements.push({ tag: 'hr' });
    const statusLine =
      snapshot.status === 'error'
        ? '**⚠️ Turn ended with an error**'
        : snapshot.status === 'stopped'
          ? '**⏹ Stopped**'
          : snapshot.status === 'done'
            ? '**✅ Done**'
            : stopping
              ? '**⏹ Stopping…**'
              : '**… working**';
    elements.push({ tag: 'markdown', content: statusLine });
  }
  elements.push(statusButtons(snapshot.status, snapshot.rows.length > 0, collapsed));
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
 * Wrap text in a fenced code block for a Feishu markdown element. If the
 * content itself contains a longer backtick run, the fence lengthens so the
 * block cannot close early.
 * @param text - code text.
 * @param lang - fence language tag (e.g. `json`), or empty for none.
 * @returns fenced markdown.
 */
function fencedCode(text: string, lang = ''): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}${lang}\n${text.replace(/\n+$/, '')}\n${fence}`;
}

/** Pretty-print JSON args for the IN block; raw text when unparseable. */
function formatArgs(args: string): string {
  try {
    const parsed = JSON.parse(args) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return args;
  }
}

/**
 * Build the details card for one row, opened by its ⋯ button: a think row
 * shows the full reasoning in a code block; a tool row shows the formatted
 * JSON input in a `json` code block and the result in a code block.
 * @param row - the row to expand.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildRowDetailsCard(row: TurnRow): CardJson {
  const elements: CardElement[] = [];
  if (row.kind === 'think') {
    const text = row.text.trim();
    elements.push({
      tag: 'markdown',
      content:
        text === '' ? '_(no reasoning text)_' : fencedCode(truncateHead(text, MAX_CARD_CHARS)),
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: `${row.status === 'error' ? '❌' : '✅'} **${toolRowTitle(row.name)}** — ${row.name}`,
    });
    if (row.args !== '') {
      elements.push({
        tag: 'markdown',
        content: `IN\n${fencedCode(formatArgs(row.args), 'json')}`,
      });
    }
    if (row.result !== '') {
      elements.push({
        tag: 'markdown',
        content: `OUT\n${fencedCode(row.result)}`,
      });
    }
    if (row.args === '' && row.result === '') {
      elements.push({ tag: 'markdown', content: '_(no recorded args or result)_' });
    }
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: row.kind === 'think' ? '☁️ Think' : `🔧 ${toolRowTitle(row.name)}`,
      },
      template: 'wathet',
    },
    elements,
  };
}

/** One command button shown on the control panel. */
export interface PanelCommand {
  readonly name: string;
  /** Button label (defaults to the command name when absent). */
  readonly buttonLabel: string;
  /** Panel grouping category ('session' | 'chat' | 'system'). */
  readonly category: string;
}

/** Command buttons per panel page (Feishu wraps the row; the repo-picker
 *  button fallback uses the same 8-per-page pattern). */
export const PANEL_PAGE_SIZE = 8;

/** A panel page entry: a category header or one command button. */
export type PanelPageEntry =
  | { readonly type: 'header'; readonly label: string }
  | { readonly type: 'button'; readonly name: string; readonly label: string };

/**
 * Paginate the panel command palette. Commands are grouped by category in
 * input order; a category header precedes its first button (and rides to the
 * next page when the break lands between the header and that button, so a
 * page never shows an unlabeled command group).
 * @param commands - panel commands (already grouped by category).
 * @param pageSize - buttons per page.
 * @returns pages of entries (headers + buttons).
 */
export function panelPages(
  commands: readonly PanelCommand[],
  pageSize = PANEL_PAGE_SIZE,
): readonly (readonly PanelPageEntry[])[] {
  const entries: PanelPageEntry[] = [];
  let lastCategory: string | undefined;
  for (const command of commands) {
    if (command.category !== lastCategory) {
      entries.push({ type: 'header', label: command.category });
      lastCategory = command.category;
    }
    entries.push({ type: 'button', name: command.name, label: command.buttonLabel });
  }
  const pages: PanelPageEntry[][] = [];
  let current: PanelPageEntry[] = [];
  let buttons = 0;
  for (const entry of entries) {
    if (entry.type === 'button' && buttons >= pageSize && current.length > 0) {
      // A header stranded on the previous page (its first button starts the
      // next page) rides along so the new page labels its commands.
      const last = current[current.length - 1];
      const stranded = last?.type === 'header' ? current.pop() : undefined;
      pages.push(current);
      current = [];
      buttons = 0;
      if (stranded !== undefined) current.push(stranded);
    }
    if (entry.type === 'button') buttons += 1;
    current.push(entry);
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

/** Capitalize a category id for display ('session' → 'Session'). */
function categoryLabel(category: string): string {
  return category === '' ? category : `${category.charAt(0).toUpperCase()}${category.slice(1)}`;
}

/**
 * Build the control-panel card: a standing operation surface the user can
 * click without typing a slash command. The first action row carries the
 * core buttons (Stop while running / Retry / Copy); below it the full
 * command palette — every registered surface command as a button, grouped by
 * category and paginated (everything-is-a-card: the button executes the same
 * handler as the slash line).
 * @param statusLine - a short current-state line for the panel body.
 * @param running - whether a turn is actively running (show Stop).
 * @param commands - the full command palette (registration order).
 * @param page - zero-based palette page.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildPanelCard(
  statusLine: string,
  running: boolean,
  commands: readonly PanelCommand[] = [],
  page = 0,
): CardJson {
  const core: Array<{
    readonly tag: 'button';
    readonly text: { readonly tag: 'plain_text'; readonly content: string };
    readonly type?: 'primary' | 'danger' | 'default';
    readonly value: Record<string, string>;
  }> = [];
  if (running) {
    core.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⏹ Stop current' },
      type: 'danger',
      value: actionValue({ kind: 'stop' }),
    });
  }
  core.push(
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
  );
  const elements: CardElement[] = [
    { tag: 'markdown', content: statusLine },
    { tag: 'hr' },
    { tag: 'action', actions: core },
  ];
  if (commands.length > 0) {
    const pages = panelPages(commands);
    const total = pages.length;
    const index = Math.min(Math.max(page, 0), total - 1);
    const entries = pages[index] ?? [];
    elements.push({ tag: 'markdown', content: `**Commands** — page ${index + 1}/${total}` });
    const pageButtons: Array<{
      readonly tag: 'button';
      readonly text: { readonly tag: 'plain_text'; readonly content: string };
      readonly value: Record<string, string>;
    }> = [];
    for (const entry of entries) {
      if (entry.type === 'header') {
        elements.push({ tag: 'markdown', content: `**${categoryLabel(entry.label)}**` });
      } else {
        pageButtons.push({
          tag: 'button',
          text: { tag: 'plain_text', content: entry.label },
          value: actionValue({ kind: 'command', name: entry.name }),
        });
      }
    }
    if (pageButtons.length > 0) elements.push({ tag: 'action', actions: pageButtons });
    if (total > 1) {
      const nav: Array<{
        readonly tag: 'button';
        readonly text: { readonly tag: 'plain_text'; readonly content: string };
        readonly value: Record<string, string>;
      }> = [];
      if (index > 0) {
        nav.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '◀️ Prev' },
          value: actionValue({ kind: 'panel-page', page: String(index - 1) }),
        });
      }
      if (index < total - 1) {
        nav.push({
          tag: 'button',
          text: { tag: 'plain_text', content: 'Next ▶️' },
          value: actionValue({ kind: 'panel-page', page: String(index + 1) }),
        });
      }
      elements.push({ tag: 'action', actions: nav });
    }
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚙️ dsh-feishu panel' },
      template: 'wathet',
    },
    elements,
  };
}

/** One permission-preset option as the picker renders it. */
export interface PermissionPresetView {
  /** The preset key (e.g. `workspace-write`). */
  readonly name: string;
  /** Human label (falls back to the key). */
  readonly label: string;
  /** One user-facing sentence, or `undefined`. */
  readonly description: string | undefined;
  /** Whether this preset is the session's current one. */
  readonly current: boolean;
}

/**
 * Build the `/permission` preset picker card: one row per switchable preset
 * (label + description) with a Select button; the current preset is marked
 * ★ and offers no button. Mirrors the sessions picker's proven v1
 * `column_set` row layout.
 * @param presets - the switchable presets, declaration order.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildPermissionPickerCard(presets: readonly PermissionPresetView[]): CardJson {
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content:
        '**Choose a permission preset** — sandbox mode + approval policy for this chat’s session.',
    },
    { tag: 'hr' },
  ];
  if (presets.length === 0) {
    elements.push({ tag: 'markdown', content: 'No presets configured on this deployment.' });
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🔐 Permission presets' },
        template: 'wathet',
      },
      elements,
    };
  }
  for (const preset of presets) {
    const title = stripAngleBrackets(preset.label);
    const description =
      preset.description === undefined || preset.description === ''
        ? ''
        : stripAngleBrackets(preset.description);
    // The ★ current badge rides on the TITLE line — a separate line reads as
    // two rows (user report).
    const titleLine = `**${title}**${preset.current ? ' ★ current' : ''}`;
    const columns: ColumnContainer[] = [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `${titleLine}${description === '' ? '' : `\n\n${description}`}`,
            },
          },
        ],
      },
    ];
    if (!preset.current) {
      columns.push({
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Select' },
            type: 'default',
            value: actionValue({ kind: 'permission-pick', preset: preset.name }),
          },
        ],
      });
    }
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'default',
      columns,
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔐 Permission presets' }, template: 'wathet' },
    elements,
  };
}
