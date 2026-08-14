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

/** Session rows per card page. */
export const SESSION_PAGE_SIZE = 10;

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

/** The one-line row label: `**title** · \`id\` · cwd · age · badges`. */
export function sessionRowLine(row: SessionRowView): string {
  const title =
    row.title === undefined || row.title.trim() === '' ? '(untitled)' : row.title.trim();
  const badges = [
    row.current ? '★ current' : undefined,
    row.live ? '● live' : undefined,
    row.persisted ? '💾 saved' : undefined,
  ].filter((badge): badge is string => badge !== undefined);
  const parts = [`**${stripAngleBrackets(title)}**`, `\`${row.sessionId}\``];
  if (row.cwd !== undefined) parts.push(row.cwd);
  const age = ageLabel(row.createdAt);
  if (age !== '') parts.push(age);
  if (badges.length > 0) parts.push(badges.join(' '));
  return parts.join(' · ');
}

/**
 * Build the `/sessions` picker card: one row per session (title, id, cwd,
 * age, live/saved badges) with a Resume button; the current session's row is
 * marked and offers no Resume. Paginated beyond {@link SESSION_PAGE_SIZE}.
 * @param sessions - the session rows, newest-first.
 * @param page - zero-based page index.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildSessionsCard(sessions: readonly SessionRowView[], page = 0): CardJson {
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content:
        '**Saved sessions** — pick one to resume it in this chat (the previous binding moves here).',
    },
    { tag: 'hr' },
  ];
  if (sessions.length === 0) {
    elements.push({
      tag: 'markdown',
      content: 'No sessions yet — send a message to start the first one.',
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
        vertical_align: 'center',
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: sessionRowLine(row) } }],
      },
    ];
    if (!row.current) {
      columns.push({
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Resume' },
            type: 'default',
            value: actionValue({ kind: 'resume-session', sessionId: row.sessionId }),
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
  if (total > 1) {
    elements.push({ tag: 'markdown', content: `page ${index + 1}/${total}` });
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
