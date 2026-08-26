/**
 * Session-list card rendering: the `/sessions` picker — a dropdown of saved
 * sessions (each row: title · id, with ★ current / ● live badges) plus the
 * session detail sub-view (resume / rename / archive / export). Pure
 * rendering (no I/O): the bridge feeds the surface projection rows.
 *
 * Layout mirrors the repo picker's proven v1 pattern: `column_set` rows with
 * a `lark_md` div and an inline button, page nav buttons when the list
 * overflows one card.
 *
 * @module @dsh-feishu/dsh-feishu/cards/session-list
 */

import type { CardElement, CardJson } from '../feishu/types.js';
import { t } from '../i18n/index.js';
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

/** Max sessions in the dropdown picker (Feishu's real select_static option
 *  cap — botmux measured 58 options failing, so 50 is the safe bound). */
export const SESSION_SELECT_MAX = 50;

/**
 * Relative age label for a `createdAt` timestamp, or `''` when unknown.
 * @param createdAt - epoch milliseconds (0 or negative = unknown).
 * @param now - current epoch milliseconds (injectable for tests).
 * @returns a short label like `3h ago`, or `''`.
 */
export function ageLabel(createdAt: number, now = Date.now()): string {
  if (createdAt <= 0) return '';
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return t('sessions.age.justNow');
  if (minutes < 60) return t('sessions.age.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('sessions.age.hours', { count: hours });
  return t('sessions.age.days', { count: Math.floor(hours / 24) });
}

/** Line 1 of a session row: `**title** · age · badges` (badges include the
 *  ★ current marker, inline — not on its own line). */
export function sessionTitleLine(row: SessionRowView): string {
  const title =
    row.title === undefined || row.title.trim() === '' ? t('common.untitled') : row.title.trim();
  const badges = [
    row.current ? t('sessions.badge.current') : undefined,
    row.live ? t('sessions.badge.live') : undefined,
    row.persisted ? t('sessions.badge.saved') : undefined,
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
 * Build the `/sessions` picker card: a dropdown of saved sessions (title, id,
 * current/live badges) — pick one to open its detail sub-view (Resume/
 * Rename/Archive/Export); the current session's option is marked ★. Archived
 * sessions are hidden unless `archived` (then only archived ones show).
 * `query` filters by title or id substring so ANY session is reachable even
 * when the corpus exceeds the dropdown cap (Feishu caps select_static at
 * {@link SESSION_SELECT_MAX}) — the 🔎 Find session input opens that filter.
 * @param sessions - the session rows, newest-first.
 * @param archived - whether to show the archived view instead of active.
 * @param query - optional id/title substring filter (case-insensitive).
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildSessionsCard(
  sessions: readonly SessionRowView[],
  archived = false,
  query?: string,
): CardJson {
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content: archived ? t('sessions.list.archivedIntro') : t('sessions.list.intro'),
    },
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: archived ? t('sessions.list.toggleActive') : t('sessions.list.toggleArchived'),
          },
          value: actionValue({ kind: 'sessions-archived-toggle' }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('sessions.list.find') },
          value: actionValue({ kind: 'session-find' }),
        },
      ],
    },
    { tag: 'hr' },
  ];
  const filtered =
    query === undefined || query.trim() === ''
      ? sessions
      : sessions.filter(
          (row) =>
            row.sessionId.toLowerCase().includes(query.trim().toLowerCase()) ||
            (row.title ?? '').toLowerCase().includes(query.trim().toLowerCase()),
        );
  if (filtered.length === 0) {
    elements.push({
      tag: 'markdown',
      content:
        query === undefined || query.trim() === ''
          ? archived
            ? t('sessions.list.emptyArchived')
            : t('sessions.list.empty')
          : t('sessions.list.noMatch', { query }),
    });
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: t('sessions.list.title') },
        template: 'wathet',
      },
      elements,
    };
  }
  // A dropdown picks the session to inspect/edit (mobile-friendly: no long
  // list, no pagination — user requirement). Selecting opens the detail view.
  const selectSessions = filtered.slice(0, SESSION_SELECT_MAX);
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: t('sessions.list.placeholder') },
        options: selectSessions.map((row) => ({
          text: {
            tag: 'plain_text',
            content: `${stripAngleBrackets(row.title === undefined || row.title.trim() === '' ? t('common.untitled') : row.title.trim())}${row.current ? ` ${t('sessions.badge.currentMark')}` : ''}${row.live ? ` ${t('sessions.badge.liveMark')}` : ''} · ${row.sessionId}`,
          },
          value: row.sessionId,
        })),
        value: actionValue({ kind: 'session-select' }),
      },
    ],
  });
  if (filtered.length > SESSION_SELECT_MAX) {
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: t('sessions.list.moreFiltered', { count: filtered.length - SESSION_SELECT_MAX }),
        },
      ],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: t('sessions.list.title') }, template: 'wathet' },
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
    `**${stripAngleBrackets(view.title ?? t('common.untitled'))}**`,
    `\`${view.sessionId}\``,
    view.cwd !== undefined ? `cwd: \`${view.cwd}\`` : t('sessions.detail.cwdNone'),
    view.createdAt > 0 ? `created: ${ageLabel(view.createdAt)}` : t('sessions.detail.createdNone'),
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
      text: { tag: 'plain_text', content: t('sessions.action.resume') },
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
      text: { tag: 'plain_text', content: t('sessions.action.rename') },
      value: actionValue({ kind: 'session-rename', sessionId: view.sessionId }),
    });
    actions.push({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: view.archived ? t('sessions.action.restore') : t('sessions.action.archive'),
      },
      value: actionValue({ kind: 'session-archive', sessionId: view.sessionId }),
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('sessions.action.export') },
    value: actionValue({ kind: 'session-export', sessionId: view.sessionId }),
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('sessions.detail.title') },
      template: 'wathet',
    },
    elements: [
      { tag: 'markdown', content: rows.join('\n') },
      { tag: 'hr' },
      { tag: 'action', actions },
    ],
  };
}
