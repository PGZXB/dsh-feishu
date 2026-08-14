/**
 * Markdown → Feishu card element conversion.
 *
 * Feishu's lark_md renders only a subset of CommonMark: bold/italic/inline
 * code/fenced code blocks/links/lists work, but `#` headings and tables are
 * NOT supported — they leak through as literal raw text (the exact bug
 * reported on the streaming card's final output). This module parses with
 * markdown-it and re-emits the content as card elements: headings become
 * bold lines, fences stay fenced, `hr` becomes an `hr` element, and GFM
 * tables become native Feishu `table` elements (v1 layout supports them —
 * root-level only, matching our card shape). Feishu caps native tables at
 * five per card (ErrCode 11310); any table beyond that renders as a fenced
 * code block so content is never dropped. Semantics mirror botmux's
 * `buildMarkdownElements` (markdown-it based, blank-line-normalized so
 * fences adjacent to prose still render).
 *
 * @module @dsh-feishu/dsh-feishu/cards/markdown
 */

import type { Token } from 'markdown-it';
import MarkdownIt from 'markdown-it';
import type { CardElement } from '../feishu/types.js';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

/** Build a Feishu native `table` element from a GFM table token slice
 *  (botmux `buildTableFromTokens`): the header row defines columns, body
 *  rows map column names to cell text (lark_md cells so inline code/bold
 *  render). Returns `undefined` when the table has no header.
 */
function buildTableFromTokens(tokens: readonly Token[]): CardElement | undefined {
  const headerCells: string[] = [];
  const bodyRows: string[][] = [];
  let inHead = false;
  let inBody = false;
  let currentRow: string[] | null = null;
  let inCell = false;

  for (const token of tokens) {
    switch (token.type) {
      case 'thead_open':
        inHead = true;
        break;
      case 'thead_close':
        inHead = false;
        break;
      case 'tbody_open':
        inBody = true;
        break;
      case 'tbody_close':
        inBody = false;
        break;
      case 'tr_open':
        currentRow = [];
        break;
      case 'tr_close':
        if (inBody && currentRow !== null) bodyRows.push(currentRow);
        currentRow = null;
        break;
      case 'th_open':
      case 'td_open':
        inCell = true;
        break;
      case 'th_close':
      case 'td_close':
        inCell = false;
        break;
      case 'inline':
        if (inCell && currentRow !== null) {
          if (inHead) headerCells.push(token.content);
          else currentRow.push(token.content);
        }
        break;
      default:
        break;
    }
  }

  if (headerCells.length === 0) return undefined;

  const columns = headerCells.map((header, index) => ({
    name: `c${index}`,
    display_name: header || ' ',
    data_type: 'lark_md' as const,
    width: 'auto' as const,
  }));
  const rows = bodyRows.map((row) => {
    const record: Record<string, string> = {};
    for (let i = 0; i < headerCells.length; i += 1) {
      record[`c${i}`] = row[i] ?? '';
    }
    return record;
  });
  return {
    tag: 'table' as const,
    page_size: Math.min(10, Math.max(1, rows.length || 1)),
    row_height: 'low' as const,
    header_style: {
      text_align: 'left' as const,
      text_size: 'normal' as const,
      background_style: 'grey' as const,
      text_color: 'default' as const,
      bold: true,
      lines: 1,
    },
    columns,
    rows,
  };
}

/** Render a table's source lines as a fenced code block (the over-cap
 *  fallback — keeps the content, in a monospace block). */
function fencedTableSource(lines: readonly string[], map: readonly [number, number]): string {
  return '```\n' + sliceLines(lines, map).trim() + '\n```';
}

/** Index of the token that closes the block opened at `openIndex`. */
function findMatchingClose(tokens: readonly Token[], openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.type.endsWith('_open')) depth += 1;
    else if (token.type.endsWith('_close')) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return openIndex;
}

/** Slice the source lines covered by a token's line map. */
function sliceLines(lines: readonly string[], map: readonly [number, number]): string {
  return lines.slice(map[0], map[1]).join('\n');
}

/**
 * Convert markdown text into Feishu card elements (lark_md-compatible).
 * @param input - raw markdown (model output).
 * @returns card elements; empty array for empty input.
 */
/** Feishu's hard cap on native `table` elements per card (ErrCode 11310:
 *  'card table number over limit'). Beyond this, tables degrade to fenced
 *  code blocks so content is preserved and the patch does not fail. */
export const MAX_CARD_TABLES = 5;

export function markdownToElements(input: string): CardElement[] {
  if (input === '') return [];
  const tokens = md.parse(input, {});
  const lines = input.split('\n');
  const elements: CardElement[] = [];
  const buf: string[] = [];
  let tableCount = 0;

  const flushBuf = (): void => {
    const text = buf
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text !== '') elements.push({ tag: 'markdown', content: text });
    buf.length = 0;
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.level !== 0) {
      i += 1;
      continue;
    }

    if (token.type === 'heading_open') {
      // lark_md has no heading syntax — render as bold.
      const inline = tokens[i + 1];
      const text = (inline?.content ?? '').replace(/^#{1,6}\s+/, '').trim();
      if (text !== '') buf.push(`**${text}**`);
      i += 3; // heading_open, inline, heading_close
      continue;
    }

    if (token.type === 'fence' || token.type === 'code_block') {
      const fence = token.markup || '```';
      const info = (token.info ?? '').trim();
      const content = token.content.replace(/\n+$/, '');
      buf.push(`${fence}${info}\n${content}\n${fence}`);
      i += 1;
      continue;
    }

    if (token.type === 'hr') {
      flushBuf();
      elements.push({ tag: 'hr' });
      i += 1;
      continue;
    }

    if (token.type === 'table_open') {
      flushBuf();
      const close = findMatchingClose(tokens, i);
      const table = buildTableFromTokens(tokens.slice(i, close + 1));
      if (table !== undefined) {
        if (tableCount < MAX_CARD_TABLES) {
          tableCount += 1;
          elements.push(table);
        } else if (token.map !== null) {
          // Over the Feishu cap: preserve the content as a code block
          // (never drop it, and never fail the whole card patch).
          buf.push(fencedTableSource(lines, token.map));
          flushBuf();
        }
      }
      i = close + 1;
      continue;
    }

    if (token.type === 'html_block') {
      if (token.map !== null) buf.push(sliceLines(lines, token.map));
      i += 1;
      continue;
    }

    // Generic block open (paragraph, list, blockquote, …): emit the source
    // slice verbatim (lark_md renders lists/blockquotes natively) and jump
    // past the matching close.
    if (token.type.endsWith('_open') && token.map !== null) {
      buf.push(sliceLines(lines, token.map));
      i = findMatchingClose(tokens, i) + 1;
      continue;
    }

    i += 1;
  }

  flushBuf();
  return elements;
}
