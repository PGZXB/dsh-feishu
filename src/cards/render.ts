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
    const note =
      snapshot.status === 'error'
        ? '⚠️ Turn ended with an error'
        : snapshot.status === 'done'
          ? '✅ Done'
          : '… working';
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: note }] });
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: snapshot.title },
      template: STATUS_TEMPLATE[snapshot.status],
    },
    elements,
  };
}
