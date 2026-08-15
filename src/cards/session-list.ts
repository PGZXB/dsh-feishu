/**
 * Session-list card rendering: the `/sessions` picker — a paginated list of
 * saved sessions, each row a one-line summary plus a Resume button. Pure
 * rendering (no I/O): the bridge feeds the surface projection rows.
 *
 * Layout mirrors the repo picker's proven v1 pattern: `column_set` rows with
 * a `lark_md` div and an inline button, page nav buttons when the list
 * overflows one card.
 *
 * @module @dsh-feishu/dsh-feishu/cards/session-list
 */

import type { CardElement, CardJson, ColumnContainer } from '../feishu/types.js';
import { actionValue, stripAngleBrackets } from './render.js';

/** One `/sessions` row (the surface projection of a dsh session). */
export interface SessionRowView {
  readonly sessionId: string;
  /** Latest session title, or `undefined` when the log has none. */
  readonly title: string | undefined;
  /** Working directory the session was created in, or `undefined`. */
  readonly cwd: string | undefined;
  /** Unix epoch milliseconds; 0 means unknown (degraded listing). */
  readonly createdAt: number;
  /** Whether the session currently has a live agent. */
  readonly live: boolean;
  /** Whether the session has a persisted log. */
  readonly persisted: boolean;
  /** Whether this row is the chat's current session (no Resume button). */
  readonly current: boolean;
}

/** Session rows per card page (mobile-friendly: 6, not 10). */
export const SESSION_PAGE_SIZE = 6;

/**
 * Relative age label for a `createdAt` timestamp, or `''` when unknown.
 * @param createdAt - epoch milliseconds (0 or negative = unknown).
 * @param now - current epoch milliseconds (injectable for tests).
 * @returns a short label like `3h ago`, or `''`.
 */
export function ageLabel(createdAt: number, now = Date.now()): string {
  if (createdAt <= 0) return '';
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Line 1 of a session row: `**title** · age · badges` (badges include the
 *  ★ current marker, inline — not on its own line). */
export function sessionTitleLine(row: SessionRowView): string {
  const title =
    row.title === undefined || row.title.trim() === '' ? '(untitled)' : row.title.trim();
  const badges = [
    row.current ? '★ current' : undefined,
    row.live ? '● live' : undefined,
    row.persisted ? '💾 saved' : undefined,
  ].filter((badge): badge is string => badge !== undefined);
  const parts = [`**${stripAngleBrackets(title)}**`];
  const age = ageLabel(row.createdAt);
  if (age !== '') parts.push(age);
  if (badges.length > 0) parts.push(badges.join(' '));
  return parts.join(' · ');
}

/** Line 2 of a session row: `\`id\`` · cwd (the stable identity, quiet). */
export function sessionMetaLine(row: SessionRowView): string {
  const parts = [`\`${row.sessionId}\``];
  if (row.cwd !== undefined) parts.push(row.cwd);
  return parts.join(' · ');
}

/** The single-line form (used by tests and compact contexts). */
export function sessionRowLine(row: SessionRowView): string {
  return `${sessionTitleLine(row)} · ${sessionMetaLine(row)}`;
}

/**
 * Build the `/sessions` picker card: one row per session (title, id, cwd,
 * age, live/saved badges) with a Details button (the detail sub-view holds
 * Resume/Rename/Archive/Export); the current session's row is marked.
 * Archived sessions are hidden unless `archived` (then only archived ones
 * show). Paginated beyond {@link SESSION_PAGE_SIZE}.
 * @param sessions - the session rows, newest-first.
 * @param page - zero-based page index.
 * @param archived - whether to show the archived view instead of active.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildSessionsCard(
  sessions: readonly SessionRowView[],
  page = 0,
  archived = false,
): CardJson {
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content: archived
        ? '**Archived sessions** — pick one to view and restore.'
        : '**Saved sessions** — pick one to view details and act on it.',
    },
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: archived ? '◀️ Active sessions' : '🗄️ Archived',
          },
          value: actionValue({ kind: 'sessions-archived-toggle' }),
        },
      ],
    },
    { tag: 'hr' },
  ];
  if (sessions.length === 0) {
    elements.push({
      tag: 'markdown',
      content: archived
        ? 'No archived sessions.'
        : 'No sessions yet — send a message to start the first one.',
    });
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🗂️ Sessions' }, template: 'wathet' },
      elements,
    };
  }
  const total = Math.ceil(sessions.length / SESSION_PAGE_SIZE);
  const index = Math.min(Math.max(page, 0), total - 1);
  const start = index * SESSION_PAGE_SIZE;
  for (const row of sessions.slice(start, start + SESSION_PAGE_SIZE)) {
    const columns: ColumnContainer[] = [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'top',
        // Two stacked lines: the title line, then the quiet id · cwd line.
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: sessionTitleLine(row) } },
          { tag: 'div', text: { tag: 'lark_md', content: sessionMetaLine(row) } },
        ],
      },
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Details' },
            type: 'default',
            value: actionValue({ kind: 'session-select', sessionId: row.sessionId }),
          },
        ],
      },
    ];
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'default',
      columns,
    });
  }
  if (total > 1) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `page ${index + 1}/${total}` }],
    });
    const nav: Array<{
      readonly tag: 'button';
      readonly text: { readonly tag: 'plain_text'; readonly content: string };
      readonly value: Record<string, string>;
    }> = [];
    if (index > 0) {
      nav.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '‹ Prev' },
        value: actionValue({ kind: 'sessions-page', page: String(index - 1) }),
      });
    }
    if (index < total - 1) {
      nav.push({
        tag: 'button',
        text: { tag: 'plain_text', content: 'Next ›' },
        value: actionValue({ kind: 'sessions-page', page: String(index + 1) }),
      });
    }
    elements.push({ tag: 'action', actions: nav });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🗂️ Sessions' }, template: 'wathet' },
    elements,
  };
}

/** One session's detail view content. */
export interface SessionDetailView {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly cwd: string | undefined;
  readonly createdAt: number;
  readonly messageCount: number;
  /** The most recent turn's final answer text (truncated), or undefined. */
  readonly lastSummary: string | undefined;
  readonly live: boolean;
  readonly current: boolean;
  readonly archived: boolean;
}

/**
 * Build the session detail card: the session's info plus action buttons —
 * Resume / Rename / Archive (or Restore when archived) / Export / Back.
 * Rename and Archive are hidden when the host seam is unavailable (the
 * bridge decides and passes `canMutate`).
 */
export function buildSessionDetailCard(view: SessionDetailView, canMutate: boolean): CardJson {
  const rows = [
    `**${stripAngleBrackets(view.title ?? '(untitled)')}**`,
    `\`${view.sessionId}\``,
    view.cwd !== undefined ? `cwd: \`${view.cwd}\`` : 'cwd: —',
    view.createdAt > 0 ? `created: ${ageLabel(view.createdAt)}` : 'created: —',
    `messages: ${view.messageCount}`,
    ...(view.lastSummary !== undefined && view.lastSummary !== ''
      ? ['', `**Last answer**`, view.lastSummary.slice(0, 200)]
      : []),
  ];
  const actions: Array<{
    readonly tag: 'button';
    readonly text: { readonly tag: 'plain_text'; readonly content: string };
    readonly type?: 'primary' | 'danger' | 'default';
    readonly value: Record<string, string>;
  }> = [];
  if (!view.current) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '▶️ Resume' },
      type: 'primary',
      value: actionValue({
        kind: 'resume-session',
        sessionId: view.sessionId,
        ...(view.cwd !== undefined ? { cwd: view.cwd } : {}),
      }),
    });
  }
  if (canMutate) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '✏️ Rename' },
      value: actionValue({ kind: 'session-rename', sessionId: view.sessionId }),
    });
    actions.push({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: view.archived ? '♻️ Restore' : '🗄️ Archive',
      },
      value: actionValue({ kind: 'session-archive', sessionId: view.sessionId }),
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '📤 Export' },
    value: actionValue({ kind: 'session-export', sessionId: view.sessionId }),
  });
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '⬅ Back' },
    value: actionValue({ kind: 'panel-back' }),
  });
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🗂️ Session' }, template: 'wathet' },
    elements: [
      { tag: 'markdown', content: rows.join('\n') },
      { tag: 'hr' },
      { tag: 'action', actions },
    ],
  };
}
