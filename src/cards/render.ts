/**
 * Card rendering: pure functions that turn session events into Feishu card
 * JSON (schema 2.0). No I/O here — the streaming manager owns the card
 * pipeline and the transport owns the wire.
 *
 * @module @dsh-feishu/dsh-feishu/cards/render
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { CardElement, CardJson } from '../feishu/types.js';

/** Terminal/working state of one streaming card. */
export type CardStatus = 'working' | 'done' | 'error';

/** Everything the card shows for one turn. */
export interface CardSnapshot {
  readonly title: string;
  /** Accumulated assistant text (rendered as lark_md). */
  readonly content: string;
  /** Compact tool lines, newest last. */
  readonly toolLines: readonly string[];
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

/** Surface action payloads stamped on card buttons. */
export type SurfaceAction =
  | { readonly kind: 'stop' }
  | { readonly kind: 'copy' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'panel' }
  | { readonly kind: 'repo-select' }
  | { readonly kind: 'repo-manual' };

/** Build the interactive repo-picker card: a project dropdown plus a manual
 * path input, submitted via form buttons (botmux-style selection).
 * @param projects - candidate project paths.
 * @returns Feishu interactive card JSON (v1 layout).
 */
export function buildRepoPickerCard(projects: readonly string[]): CardJson {
  const options = projects.map((path, index) => ({
    text: { tag: 'plain_text' as const, content: `${index + 1}. ${path}` },
    value: path,
  }));
  const elements: CardElement[] = [
    { tag: 'markdown', content: '**Pick a project directory** — or type a path below.' },
    { tag: 'hr' },
  ];
  if (options.length > 0) {
    elements.push({
      tag: 'form',
      elements: [
        {
          tag: 'select_static',
          name: 'repo',
          placeholder: { tag: 'plain_text', content: 'Choose a project…' },
          options: options.slice(0, 50),
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✔ Select' },
              type: 'primary',
              value: actionValue({ kind: 'repo-select' }),
            },
          ],
        },
      ],
    });
  }
  elements.push({
    tag: 'form',
    elements: [
      {
        tag: 'input',
        name: 'repo_manual',
        placeholder: { tag: 'plain_text', content: '/abs/path/to/project' },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📁 Use path' },
            value: actionValue({ kind: 'repo-manual' }),
          },
        ],
      },
    ],
  });
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📚 Pick a project' }, template: 'wathet' },
    elements,
  };
}

/** Encode a surface action as a button value payload. */
export function actionValue(action: SurfaceAction): Record<string, string> {
  return { kind: action.kind };
}

/** The button row appended by status: working → stop; done → copy/retry/panel; error → retry/panel. */
function statusButtons(status: CardStatus): CardElement {
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
  return { tag: 'action', actions };
}

/**
 * Neutralize lark_md bold markers in untrusted text. Feishu's lark_md has no
 * reliable escape syntax, so the pragmatic approach is to collapse `**` into
 * a single `*` (code fences and links render as-is; full sanitization is
 * deferred).
 * @param text - raw text.
 * @returns text with `**` sequences collapsed.
 */
export function escapeMarkdown(text: string): string {
  return text.replaceAll('**', '*');
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

/** Extract the plain text of an assembled assistant message. */
export function assistantText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Build the card JSON for one snapshot.
 * @param snapshot - title, content, tool lines, and status.
 * @returns Feishu interactive card JSON (schema 2.0).
 */
export function buildCard(snapshot: CardSnapshot): CardJson {
  const elements: CardElement[] = [];
  const body = escapeMarkdown(truncateTail(snapshot.content)).trim();
  if (body !== '') {
    elements.push({ tag: 'markdown', content: body });
  }
  for (const line of snapshot.toolLines) {
    elements.push({ tag: 'markdown', content: line });
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
  elements.push(statusButtons(snapshot.status));
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
 * Build the control-panel card: a standing operation surface the user can
 * click without typing a slash command (stop / retry / copy / panel).
 * @param statusLine - a short current-state line for the panel body.
 * @returns Feishu interactive card JSON (schema 2.0).
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
