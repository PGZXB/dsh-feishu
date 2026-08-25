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

import { basename } from 'node:path';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ButtonAction, CardElement, CardJson } from '../feishu/types.js';
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

/** One steering row: a user message steered into the running turn. Line =
 *  `💬 Steer · <preview>`; the expand card shows the full steered text. */
export interface SteeringRow {
  readonly kind: 'steering';
  /** The steered message id (stable, pairs the trace row with the source). */
  readonly id: string;
  /** The full steered user message text (for the expand card). */
  readonly text: string;
}

/** Any chronological row on the live card. */
export type TurnRow = ThinkRow | ToolRow | SteeringRow;

/** Everything the card shows for one turn. */
export interface CardSnapshot {
  readonly title: string;
  /** Accumulated assistant text (rendered as markdown, bottom of the card). */
  readonly content: string;
  /** Chronological think/tool rows (all of them — no truncation). */
  readonly rows: readonly TurnRow[];
  /** Session cwd, used to relativize workspace-rooted path summaries. */
  readonly cwd?: string;
  /** Collapse the row sequence to one `think → tool → …` line. */
  readonly collapsed?: boolean;
  /** The user pressed Stop; show an in-progress Stopping state. */
  readonly stopRequested?: boolean;
  /** Paths (relative to cwd) of files produced this turn — rendered as
   *  clickable `📎 Produced` chips on the terminal card. */
  readonly producedPaths?: readonly string[];
  /** Session-scoped cumulative usage for the terminal stats line (exact
   *  counted fields only — no timing). Undefined means no stats line. */
  readonly sessionStats?: {
    readonly turnCount: number;
    readonly stepCount: number;
    readonly toolCount: number;
    readonly tokenUsage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
    };
    readonly contextWindow: number | undefined;
  };
  readonly status: CardStatus;
  /** Friendly, actionable explanation of a failed turn, shown on the error
   *  card so the user (or the admin they relay to) knows what broke. */
  readonly errorText?: string;
}

/** Header template color per status. `stopped` uses amber — the DSH web
 *  warning semantic for interrupted work (StateDot warning). */
const STATUS_TEMPLATE: Record<CardStatus, string> = {
  // wathet is Lark's soft default blue — prettier than the flat `blue`
  // while staying "in progress"; the terminal colors stay semantic.
  working: 'wathet',
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
  // `preset` is optional: the dropdown stamps the marker only (the choice
  // arrives in the callback's `option`); the legacy button carried it.
  | { readonly kind: 'permission-pick'; readonly preset?: string }
  // `selection` is optional for the same dropdown-marker reason.
  | { readonly kind: 'model-pick'; readonly selection?: string }
  | { readonly kind: 'model-page'; readonly page: string }
  // Interactive approval/question cards (Iteration 3).
  | { readonly kind: 'approval'; readonly decision: 'allow' | 'reject'; readonly id: string }
  | { readonly kind: 'question'; readonly id: string; readonly answer: string }
  | { readonly kind: 'question-toggle'; readonly id: string; readonly option: string }
  | { readonly kind: 'question-submit'; readonly id: string }
  | { readonly kind: 'question-cancel'; readonly id: string }
  // Panel state machine (Phase 1): input/confirm sub-views.
  | { readonly kind: 'panel-back' }
  | { readonly kind: 'panel-input-submit'; readonly command: string }
  | { readonly kind: 'panel-confirm'; readonly command: string }
  // Session detail sub-view (Phase 2). `sessionId` is optional: the
  // sessions dropdown stamps the marker only (the choice arrives in the
  // callback's `option`); the legacy button carried the id.
  | { readonly kind: 'session-select'; readonly sessionId?: string }
  | { readonly kind: 'sessions-archived-toggle' }
  | { readonly kind: 'session-find' }
  | { readonly kind: 'session-archive'; readonly sessionId: string }
  | { readonly kind: 'session-rename'; readonly sessionId: string }
  | { readonly kind: 'session-export'; readonly sessionId: string }
  // Dedicated queue card (message-queue) per-item mutations.
  | { readonly kind: 'queue-steer'; readonly id: string }
  | { readonly kind: 'queue-edit'; readonly id: string }
  | { readonly kind: 'queue-edit-submit'; readonly id: string }
  | { readonly kind: 'queue-edit-cancel'; readonly id: string }
  | { readonly kind: 'queue-remove'; readonly id: string };

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

/** The button rows appended by status: row 1 = state actions (working →
 *  stop; done → copy/retry/panel; error → retry/panel), row 2 = the row
 *  view toggle when the turn has rows. Two rows keep each action row short
 *  on mobile. */
function statusButtonRows(status: CardStatus, hasRows: boolean, collapsed: boolean): CardElement[] {
  const actions: Array<{
    readonly tag: 'button';
    readonly text: { readonly tag: 'plain_text'; readonly content: string };
    readonly type?: 'primary' | 'danger' | 'default';
    readonly value: Record<string, string>;
  }> = [];
  if (status === 'working') {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⏹ Stop turn' },
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
  const rows: CardElement[] = [{ tag: 'action', actions }];
  if (hasRows) {
    rows.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: collapsed ? '▸ Expand' : '▾ Collapse' },
          type: 'default',
          value: actionValue({ kind: 'toggle-rows' }),
        },
      ],
    });
  }
  return rows;
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
  if (row.kind === 'steering') {
    // A steered user message injected into the running turn. The line shows
    // the compact label + a preview; the full text lives in the expand card.
    const preview = truncateTail(row.text, QUEUE_PREVIEW_CHARS).replace(/\n+/g, ' ');
    return `💬 Steer · ${preview}`;
  }
  const icon = row.status === 'running' ? '🔧' : row.status === 'done' ? '✅' : '❌';
  return `${icon} ${toolRowTitle(row.name)} · ${row.summary}`;
}

/**
 * The minimal collapsed sequence for a turn: row names joined with
 * ` → ` (`think → bash → read`). Think rows read "think", tool rows read
 * their tool name. The full sequence is shown — no truncation.
 */
export function collapseSequence(rows: readonly TurnRow[]): string {
  const names = rows.map((row) => {
    if (row.kind === 'think') return 'think';
    if (row.kind === 'steering') return 'steer';
    return row.name;
  });
  return names.map(stripAngleBrackets).join(' → ');
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

/** Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three
 *  digits), mirroring the web `StatsLine.formatTokens`. */
function formatTokenCount(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
  return `${scaled(n / 1_000_000)}M`;
}

/**
 * Build the terminal stats line for a session-scoped stats snapshot. Returns
 * `|`-separated groups of exact counted fields only (no timing): counts,
 * tokens + cache, and context occupancy. Empty string when there is no
 * activity or no stats provided.
 *
 * Gated on actual token activity for the token group (a session whose steps
 * all settled without billing shows its counts without a zero-token group),
 * and omits the context group when either value is unknown. Counts render
 * only when the session has recorded turns/steps.
 */
export function statsGrouperText(stats: CardSnapshot['sessionStats']): string {
  if (stats === undefined) return '';
  const groups: string[] = [];
  if (stats.stepCount > 0) {
    const counts = [`${stats.turnCount} turns`, `${stats.stepCount} steps`];
    if (stats.toolCount > 0) counts.push(`${stats.toolCount} tools`);
    groups.push(counts.join(' · '));
  }
  const usage = stats.tokenUsage;
  const billedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (billedInput > 0 || usage.outputTokens > 0) {
    const cacheHit = billedInput > 0 ? Math.round((usage.cacheReadTokens / billedInput) * 100) : 0;
    const tokenGroup = `input ${formatTokenCount(billedInput)} · output ${formatTokenCount(usage.outputTokens)}`;
    groups.push(cacheHit > 0 ? `cache ${cacheHit}% · ${tokenGroup}` : tokenGroup);
  }
  if (stats.contextWindow !== undefined && billedInput + usage.outputTokens > 0) {
    const usedTokens = billedInput + usage.outputTokens;
    const percent = Math.min(100, Math.round((usedTokens / stats.contextWindow) * 100));
    groups.push(`context ${percent}%`);
  }
  return groups.join(' | ');
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
    // The minimal sequence, one line: `think → bash → read → …`.
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
    if (snapshot.status === 'working') {
      // In-progress state stays a visible markdown line (the user is waiting
      // on it); terminal states move to a quiet `note` — the header template
      // color already carries the semantic.
      elements.push({
        tag: 'markdown',
        content: stopping ? '**⏹ Stopping…**' : '**… working**',
      });
    } else {
      const terminalNote =
        snapshot.status === 'error'
          ? '⚠️ Turn failed'
          : snapshot.status === 'stopped'
            ? '⏹ Stopped'
            : '✅ Done';
      elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: terminalNote }] });
      // The failure reason, surfaced as a readable line instead of the dead
      // "see the card for details" — a MISSING_CREDENTIAL tells the admin
      // exactly what to fix; an unknown error stays the raw message.
      if (snapshot.status === 'error' && snapshot.errorText !== undefined) {
        elements.push({ tag: 'markdown', content: snapshot.errorText });
      }
    }
  }
  // Turn-produced files: render a `📎 Produced` chip row on the TERMINAL card
  // (done/stopped/error — after the content, once the turn has settled). Each
  // chip is a button that sends the file to the chat (send-produced action).
  const produced = snapshot.producedPaths ?? [];
  if (snapshot.status !== 'working' && produced.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: '**📎 Produced**',
    });
    elements.push({
      tag: 'action',
      actions: produced.map((path) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: basename(path) },
        type: 'primary',
        value: { kind: 'send-produced', path },
      })),
    });
  }
  // Session stats line: on the TERMINAL card, a compact `|`-separated line of
  // exact counted fields (counts + tokens + cache + context occupancy). No
  // timing group — the host cannot see the web's `node.timing`. Rendered only
  // when there is activity; omitted while working / with no stats.
  const statsText = statsGrouperText(snapshot.sessionStats);
  if (snapshot.status !== 'working' && statsText !== '') {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: statsText });
  }
  // Two button rows: row 1 = state actions (Stop / Copy·Retry·Panel), row 2
  // = the row view toggle — one row of 4 wrapped awkwardly on mobile.
  elements.push(...statusButtonRows(snapshot.status, snapshot.rows.length > 0, collapsed));
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
  if (row.kind === 'steering') {
    const text = row.text.trim();
    elements.push({
      tag: 'markdown',
      content:
        text === '' ? '_(empty steered message)_' : fencedCode(truncateHead(text, MAX_CARD_CHARS)),
    });
  } else if (row.kind === 'think') {
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
        content:
          row.kind === 'steering'
            ? '💬 Steer'
            : row.kind === 'think'
              ? '☁️ Think'
              : `🔧 ${toolRowTitle(row.name)}`,
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
  // Group commands into whole category blocks (header + its buttons). A
  // category is NEVER split across pages — the page boundary falls between
  // blocks, and a block larger than the page size simply takes its own page
  // (user report: '⚙️ System' must not be torn apart).
  const blocks: PanelPageEntry[][] = [];
  let block: PanelPageEntry[] = [];
  let lastCategory: string | undefined;
  for (const command of commands) {
    if (command.category !== lastCategory) {
      if (block.length > 0) blocks.push(block);
      block = [{ type: 'header', label: command.category }];
      lastCategory = command.category;
    }
    block.push({ type: 'button', name: command.name, label: command.buttonLabel });
  }
  if (block.length > 0) blocks.push(block);
  // Pack whole blocks into pages; only start a new page when the NEXT block
  // would overflow the page size.
  const pages: PanelPageEntry[][] = [];
  let page: PanelPageEntry[] = [];
  let buttons = 0;
  for (const next of blocks) {
    const nextButtons = next.filter((entry) => entry.type === 'button').length;
    if (buttons > 0 && buttons + nextButtons > pageSize) {
      pages.push(page);
      page = [];
      buttons = 0;
    }
    page.push(...next);
    buttons += nextButtons;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/** Category icon per panel group, making sections scannable. */
const CATEGORY_ICONS: Record<string, string> = {
  session: '🧩',
  chat: '💬',
  system: '⚙️',
};

/** Capitalize a category id for display ('session' → '🧩 Session'). */
function categoryLabel(category: string): string {
  const name =
    category === '' ? category : `${category.charAt(0).toUpperCase()}${category.slice(1)}`;
  const icon = CATEGORY_ICONS[category] ?? '';
  return `${icon} ${name}`.trim();
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
      text: { tag: 'plain_text', content: '⏹ Stop current turn' },
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
    // Quiet page indicator — a note, not another bold line.
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `Commands · page ${index + 1}/${total}` }],
    });
    const pageButtons: Array<{
      readonly tag: 'button';
      readonly text: { readonly tag: 'plain_text'; readonly content: string };
      readonly value: Record<string, string>;
    }> = [];
    // Each category renders as its own block: the header markdown line
    // followed by THAT category's button row — headers must never stack
    // before all buttons (user report: '🧩 Session' / '💬 Chat' with nothing
    // between them).
    const flushButtons = (): void => {
      if (pageButtons.length > 0) {
        elements.push({ tag: 'action', actions: [...pageButtons] });
        pageButtons.length = 0;
      }
    };
    for (const entry of entries) {
      if (entry.type === 'header') {
        flushButtons();
        elements.push({ tag: 'markdown', content: `**${categoryLabel(entry.label)}**` });
      } else {
        pageButtons.push({
          tag: 'button',
          text: { tag: 'plain_text', content: entry.label },
          value: actionValue({ kind: 'command', name: entry.name }),
        });
      }
    }
    flushButtons();
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

/** One panel sub-view (input form / confirm) renders as a card payload. */
export interface PanelInputCardOptions {
  readonly title: string;
  readonly hint: string;
  readonly fieldName: string;
  readonly placeholder: string;
  readonly submitLabel: string;
  readonly command: string;
  /** Carried through to the submit button value (e.g. the session id for rename). */
  readonly sessionId?: string;
}

/**
 * A panel text-input card: a root-level v1 `form` with ONE `input` plus a
 * `form_submit` button (botmux v1 schema, verified on device — the form
 * holds ONLY input+button; labels stay outside, or the whole card renders
 * empty), followed by a Back action row. The submit callback carries
 * `formValue[fieldName]` and the command marker in `value`.
 */
export function buildInputCard(options: PanelInputCardOptions): CardJson {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: options.title }, template: 'wathet' },
    elements: [
      { tag: 'markdown', content: options.hint },
      { tag: 'hr' },
      {
        tag: 'form',
        name: 'panel-input',
        elements: [
          {
            tag: 'input',
            name: options.fieldName,
            placeholder: { tag: 'plain_text', content: options.placeholder },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: options.submitLabel },
            type: 'primary',
            // Feishu requires a name for form-container buttons (ErrCode
            // 200530, user-tested).
            name: 'panel-input-submit',
            action_type: 'form_submit',
            value: actionValue({
              kind: 'panel-input-submit',
              command: options.command,
              ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            }),
          },
        ],
      },
    ],
  };
}

/** One destructive-action confirmation card (panel confirm sub-view). */
export function buildConfirmCard(options: {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly command: string;
}): CardJson {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: options.title }, template: 'wathet' },
    elements: [
      { tag: 'markdown', content: options.message },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: options.confirmLabel },
            type: 'primary',
            value: actionValue({ kind: 'panel-confirm', command: options.command }),
          },
        ],
      },
    ],
  };
}

/**
 * A pure-information panel sub-view card (no interactive controls — e.g. a
 * text-input step that awaits the next chat message, or a notice). Feishu's
 * v1 layout rejects `form`/`input` (HTTP 400 on send — user-tested), so
 * text entry goes through the chat message instead.
 */
export function buildPanelNoticeCard(options: {
  readonly title: string;
  readonly hint: string;
}): CardJson {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: options.title }, template: 'wathet' },
    elements: [{ tag: 'markdown', content: options.hint }, { tag: 'hr' }],
  };
}

/**
 * The inbound-file receipt card: posted when a user sends a file message
 * (or a bare attachment message registered as pending — inbound-wait-
 * instruction). The file bytes are saved under the chat's working directory
 * (`<cwd>/.dsh_feishu/attachments/…`) and the card shows the path so the
 * user knows where it landed; the agent receives the path too and reads the
 * file with its workspace tools. Each file posts its OWN card — the running
 * `count` (1, 2, …) tells the user how many files are awaiting an
 * instruction; the previous cards stay in chat history. NO action buttons:
 * the single interaction model is "send an instruction".
 * @param name - the file display name.
 * @param savedPath - the real on-disk path, when the save succeeded.
 * @param count - the number of files pending an instruction (1 for a single
 *   file message; N for the N-th bare attachment awaiting follow-up).
 */
export function buildInboundFileCard(name: string, savedPath?: string, count = 1): CardJson {
  const pendingLine = count > 1 ? `\n\n**${count} files awaiting your instruction.**` : '';
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📎 File received' }, template: 'blue' },
    elements: [
      {
        tag: 'markdown',
        content:
          savedPath === undefined
            ? `**${name}**\n\nTell me what to do with it.${pendingLine}`
            : `**${name}**\n\nSaved to \`${savedPath}\` — tell me what to do with it.${pendingLine}`,
      },
    ],
  };
}

/**
 * A busy/operating placeholder card (NO buttons — blocks mis-taps while an
 * async panel operation runs). Posted FIRST in the callback so the panel
 * always carries an immediate patch (Lark otherwise restores the pre-click
 * card while the work awaits — the root of the "panel reverts mid-action"
 * bugs).
 */
export function buildPanelBusyCard(title: string): CardJson {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'wathet' },
    elements: [{ tag: 'markdown', content: '⏳ Operating…' }],
  };
}

/**
 * A pure-information RESULT card (no buttons/inputs — the final outcome of a
 * panel action posts as a NEW card, per the panel principle: intermediate
 * steps live in the panel card, results leave it as an inert card).
 */
export function buildResultCard(title: string, text: string, error = false): CardJson {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: error ? 'red' : 'green' },
    elements: [{ tag: 'markdown', content: text }],
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
  const current = presets.find((preset) => preset.current);
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
  // A single-choice dropdown (repo-picker pattern: select_static DIRECTLY
  // inside an `action` container — v1 cards drop it inside a `form`). The
  // select's own `value` carries the {kind:'permission-pick'} marker and the
  // chosen preset arrives in the callback's `option` field. `initial_option`
  // preselects the current preset; a `custom` effective state (not in the
  // table) cannot be preselected, so the placeholder shows instead.
  const currentName = current?.name;
  const optionValues = new Set(presets.map((preset) => preset.name));
  const canPreselect = currentName !== undefined && optionValues.has(currentName);
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: 'Choose a preset…' },
        ...(canPreselect ? { initial_option: currentName } : {}),
        options: presets.map((preset) => ({
          text: { tag: 'plain_text', content: preset.label },
          value: preset.name,
        })),
        value: actionValue({ kind: 'permission-pick' }),
      },
    ],
  });
  // The current preset stays visible even when it is `custom` (no option).
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: current === undefined ? 'No preset selected yet.' : `★ current: ${current.label}`,
      },
    ],
  });
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔐 Permission presets' }, template: 'wathet' },
    elements,
  };
}

/** One model option as the /model picker renders it. */
export interface ModelOptionView {
  /** The selection arg: `provider/model`. */
  readonly value: string;
  /** Display label: `provider · name`. */
  readonly label: string;
  /** Whether this option is the session's current model. */
  readonly current: boolean;
}

/** Model buttons per page in the >50-option fallback. */
export const MODEL_PAGE_SIZE = 8;

/**
 * Build the /model picker card: a dropdown of the available models
 * (selection = `provider/model`), preselecting the current one, with a
 * quiet note spelling out the current model. Beyond the select option cap
 * it falls back to paginated Select buttons (repo-picker pattern).
 * @param options - the model catalog (provider/model entries).
 * @param currentSelection - the current `provider/model`, or `undefined`.
 * @param page - zero-based page index (button fallback only).
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildModelPickerCard(
  options: readonly ModelOptionView[],
  currentSelection: string | undefined,
  page = 0,
): CardJson {
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content:
        '**Choose a model** — the pick switches THIS session’s model immediately and saves the default for new sessions.',
    },
    { tag: 'hr' },
  ];
  const current = options.find((option) => option.current);
  if (options.length === 0) {
    elements.push({
      tag: 'markdown',
      content: 'No models available on this deployment — use /model <provider>/<model> to set one.',
    });
  } else if (options.length <= REPO_SELECT_MAX_OPTIONS) {
    const canPreselect =
      currentSelection !== undefined && options.some((option) => option.value === currentSelection);
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: 'Choose a model…' },
          ...(canPreselect ? { initial_option: currentSelection } : {}),
          options: options.map((option) => ({
            text: { tag: 'plain_text', content: option.label },
            value: option.value,
          })),
          value: actionValue({ kind: 'model-pick' }),
        },
      ],
    });
  } else {
    const total = Math.ceil(options.length / MODEL_PAGE_SIZE);
    const index = Math.min(Math.max(page, 0), total - 1);
    const start = index * MODEL_PAGE_SIZE;
    const pageOptions = options.slice(start, start + MODEL_PAGE_SIZE);
    const buttons = pageOptions.map((option) => ({
      tag: 'button' as const,
      text: { tag: 'plain_text' as const, content: option.label },
      value: actionValue({ kind: 'model-pick', selection: option.value }),
    }));
    if (buttons.length > 0) elements.push({ tag: 'action', actions: buttons });
    if (total > 1) {
      const nav: Array<{
        readonly tag: 'button';
        readonly text: { readonly tag: 'plain_text'; readonly content: string };
        readonly value: Record<string, string>;
      }> = [];
      if (index > 0) {
        nav.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '‹ Prev' },
          value: actionValue({ kind: 'model-page', page: String(index - 1) }),
        });
      }
      if (index < total - 1) {
        nav.push({
          tag: 'button',
          text: { tag: 'plain_text', content: 'Next ›' },
          value: actionValue({ kind: 'model-page', page: String(index + 1) }),
        });
      }
      elements.push({ tag: 'action', actions: nav });
    }
  }
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content:
          current === undefined
            ? currentSelection === undefined
              ? 'No model selected yet.'
              : `★ current: ${currentSelection}`
            : `★ current: ${current.label}`,
      },
    ],
  });
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🤖 Model' }, template: 'wathet' },
    elements,
  };
}

/**
 * Build the approval card for one `approval/request`: the tool and the
 * asker's reason, with Allow-once / Reject buttons. The card is a standalone
 * interaction (not part of the streaming-card state machine).
 * @param toolName - the tool the approval is about.
 * @param reason - the asker's human-readable explanation, or undefined.
 * @param requestId - the approval request id echoed in the button values.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildApprovalCard(
  toolName: string,
  reason: string | undefined,
  requestId: string,
  mention = '',
): CardJson {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔐 Approval needed' }, template: 'orange' },
    elements: [
      {
        tag: 'markdown',
        content: `${mention}**${stripAngleBrackets(toolName)}** wants to run${
          reason === undefined || reason === '' ? '.' : `:\n\n${stripAngleBrackets(reason)}`
        }`,
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ Allow once' },
            type: 'primary',
            value: actionValue({ kind: 'approval', decision: 'allow', id: requestId }),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ Reject' },
            type: 'danger',
            value: actionValue({ kind: 'approval', decision: 'reject', id: requestId }),
          },
        ],
      },
    ],
  };
}

/** The static card an approval card becomes once a decision is made (no
 *  buttons — further taps do nothing). */
export function buildApprovalDecidedCard(outcome: string): CardJson {
  const label =
    outcome === 'allowed-once'
      ? '✅ Allowed once'
      : outcome === 'rejected'
        ? '❌ Rejected'
        : outcome === 'unavailable'
          ? '⚠️ Unavailable'
          : '⏹ Cancelled';
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔐 Approval' }, template: 'wathet' },
    elements: [{ tag: 'note', elements: [{ tag: 'plain_text', content: label }] }],
  };
}

/** One user-question as the question card renders it (structural subset of
 *  `AskUserQuestionItem`). */
export interface QuestionView {
  readonly id: string;
  readonly question: string;
  readonly detail: string | undefined;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect: boolean;
}

/**
 * Build the question card for one `AskUserQuestionItem`. Single-select
 * questions answer on the first option tap; multi-select questions toggle
 * options (re-posted with checkmarks) and confirm via a Submit button;
 * free-text questions (no options) ask the user to reply with a message.
 * @param question - the question to display (its id is echoed in the button
 *   values — the bridge prefixes it into the registry key).
 * @param selected - currently selected option labels (multi-select re-post).
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildQuestionCard(
  question: QuestionView,
  selected: readonly string[] = [],
  mention = '',
): CardJson {
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content: `${mention}**${stripAngleBrackets(question.question)}**${
        question.detail === undefined || question.detail === ''
          ? ''
          : `\n\n${stripAngleBrackets(question.detail)}`
      }`,
    },
    { tag: 'hr' },
  ];
  if (question.options.length === 0) {
    elements.push({
      tag: 'markdown',
      content: 'Reply with your answer as a message — no options to pick from.',
    });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✖ Cancel' },
          type: 'default',
          value: actionValue({ kind: 'question-cancel', id: question.id }),
        },
      ],
    });
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '❓ Question' }, template: 'wathet' },
      elements,
    };
  }
  const buttons = question.options.map((option) => {
    const isSelected = selected.includes(option.label);
    return {
      tag: 'button' as const,
      text: {
        tag: 'plain_text' as const,
        content: `${isSelected ? '✅ ' : ''}${option.label}`,
      },
      type: isSelected ? ('primary' as const) : ('default' as const),
      value: question.multiSelect
        ? actionValue({ kind: 'question-toggle', id: question.id, option: option.label })
        : actionValue({ kind: 'question', id: question.id, answer: option.label }),
    };
  });
  elements.push({ tag: 'action', actions: buttons });
  if (question.multiSelect) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ Submit' },
          type: 'primary',
          value: actionValue({ kind: 'question-submit', id: question.id }),
        },
      ],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '❓ Question' }, template: 'wathet' },
    elements,
  };
}

/** The static card a question card becomes once answered (no buttons). */
export function buildQuestionAnsweredCard(question: string, answer: string): CardJson {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '❓ Question' }, template: 'wathet' },
    elements: [
      { tag: 'markdown', content: `**${stripAngleBrackets(question)}**` },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `Answer: ${answer}` }] },
    ],
  };
}

/** Everything the `/feishu-status` diagnostic card shows. */
export interface StatusView {
  readonly appId: string;
  /** Live wire state; 'memory' for the file-channel test/demo transport. */
  readonly connection: 'ready' | 'reconnecting' | 'error' | 'memory' | 'unknown';
  readonly sessionCount: number;
  /** Epoch ms of the last accepted inbound message, or undefined (none yet). */
  readonly lastInboundAt: number | undefined;
}

/** The connection line label per state. */
const CONNECTION_LABEL: Record<StatusView['connection'], string> = {
  ready: '✅ ready',
  reconnecting: '⚠️ reconnecting',
  error: '❌ error',
  memory: '🧪 memory (test transport)',
  unknown: '❓ unknown',
};

/**
 * Build the `/feishu-status` diagnostic card: app id, live connection
 * state, session count, and last inbound activity — the health of the
 * surface at a glance.
 * @param view - the current status snapshot.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildStatusCard(view: StatusView): CardJson {
  const last =
    view.lastInboundAt === undefined ? 'never' : new Date(view.lastInboundAt).toISOString();
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📊 dsh-feishu status' }, template: 'wathet' },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**app:** \`${view.appId}\``,
          `**connection:** ${CONNECTION_LABEL[view.connection]}`,
          `**sessions:** ${view.sessionCount}`,
          `**last inbound:** ${last}`,
        ].join('\n'),
      },
    ],
  };
}

/** Lifecycle state of ONE queue item's dedicated card (message-queue). Every
 *  queued message is its own card with its own lifecycle; a state machine per
 *  card, not a shared card. */
export type QueueItemStatus = 'queued' | 'editing' | 'steering' | 'steered' | 'sent' | 'removed';

/** One queued item rendered as its OWN dedicated card (message-queue). */
export interface QueueItemView {
  /** The inbox message id (the action target for steer/edit/remove). */
  readonly id: string;
  /** The text preview shown on the card (and the edit form's input). */
  readonly text: string;
  /** The item's lifecycle state — determines the card's actions/marker. */
  readonly status: QueueItemStatus;
}

/** Longest item preview shown on a queue card. */
export const QUEUE_PREVIEW_CHARS = 200;

/** Longest preview folded into a queue-card header. */
const QUEUE_HEADER_CHARS = 40;

/** Header label per non-queued lifecycle state (message-queue). */
const QUEUE_STATUS_TITLE: Record<Exclude<QueueItemStatus, 'queued'>, string> = {
  editing: 'Editing',
  steering: 'Steering…',
  steered: 'Steered',
  sent: 'Sent',
  removed: 'Removed',
};

/** The status marker shown on a terminal/in-progress queue card. */
const QUEUE_STATUS_MARKER: Partial<Record<QueueItemStatus, string>> = {
  steering: '💬 Steering…',
  steered: '✅ Steered',
  sent: '📤 Sent',
  removed: '🗑️ Removed',
};

/**
 * Build ONE queue item's dedicated card (message-queue): a card per queued
 * message, a state machine per card — no shared "N queued" card and no
 * recall/re-post single-card invariant. The card renders the item's preview
 * plus the actions (only while `queued`) or the lifecycle marker (steering /
 * steered / sent / removed). The inline edit form is shown only in the
 * `editing` state: a single `input` + a `form_submit` Submit + a Cancel
 * button, with NO `default_value` (the verified `buildInputCard` shape — a
 * `default_value` on the input is what produced the Feishu 400).
 * @param item - the queue item to render.
 * @param running - whether a turn is currently running (Steer availability).
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildQueueItemCard(item: QueueItemView, running: boolean): CardJson {
  const title =
    item.status === 'queued'
      ? `⏳ ${truncateTail(item.text, QUEUE_HEADER_CHARS)}`
      : `⏳ ${QUEUE_STATUS_TITLE[item.status]}`;
  const elements: CardElement[] = [];
  const marker = QUEUE_STATUS_MARKER[item.status];
  if (marker !== undefined) elements.push({ tag: 'markdown', content: marker });
  if (!running && item.status === 'queued') {
    elements.push({
      tag: 'markdown',
      content: '➡️ Steer unavailable — no turn is running.',
    });
  }
  elements.push({ tag: 'markdown', content: truncateTail(item.text, QUEUE_PREVIEW_CHARS) });
  elements.push({ tag: 'hr' });
  if (item.status === 'queued') {
    const buttons: ButtonAction[] = [];
    if (running) {
      buttons.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '➡️ Steer' },
        value: actionValue({ kind: 'queue-steer', id: item.id }),
      });
    }
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '✏️ Edit' },
      value: actionValue({ kind: 'queue-edit', id: item.id }),
    });
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🗑️ Remove' },
      type: 'default',
      value: actionValue({ kind: 'queue-remove', id: item.id }),
    });
    elements.push({ tag: 'action', actions: buttons });
  } else if (item.status === 'editing') {
    // The edit form holds ONLY input + form_submit (botmux v1 rule — other
    // elements render the whole card empty); the Cancel button lives in its
    // own action row OUTSIDE the form (same split as buildInputCard).
    elements.push({
      tag: 'form',
      name: 'queue-edit',
      elements: [
        {
          tag: 'input',
          name: 'text',
          placeholder: { tag: 'plain_text', content: 'Edit queued text' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✏️ Submit' },
          type: 'primary',
          // Feishu requires a name for form-container buttons (ErrCode 200530).
          name: 'queue-edit-submit',
          action_type: 'form_submit',
          value: actionValue({ kind: 'queue-edit-submit', id: item.id }),
        },
      ],
    });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '↩️ Cancel' },
          type: 'default',
          value: actionValue({ kind: 'queue-edit-cancel', id: item.id }),
        },
      ],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'wathet' },
    elements,
  };
}
