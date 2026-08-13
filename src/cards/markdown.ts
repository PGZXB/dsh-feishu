/**
 * Markdown → Feishu card element conversion.
 *
 * Feishu's lark_md renders only a subset of CommonMark: bold/italic/inline
 * code/fenced code blocks/links/lists work, but `#` headings and tables are
 * NOT supported — they leak through as literal raw text (the exact bug
 * reported on the streaming card's final output). This module parses with
 * markdown-it and re-emits the content as card elements: headings become
 * bold lines, fences stay fenced, `hr` becomes an `hr` element, and tables
 * fall back to their source lines. Semantics mirror botmux's
 * `buildMarkdownElements` (markdown-it based, blank-line-normalized so
 * fences adjacent to prose still render).
 *
 * @module @dsh-feishu/dsh-feishu/cards/markdown
 */

import type { Token } from 'markdown-it';
import MarkdownIt from 'markdown-it';
import type { CardElement } from '../feishu/types.js';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

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
export function markdownToElements(input: string): CardElement[] {
  if (input === '') return [];
  const tokens = md.parse(input, {});
  const lines = input.split('\n');
  const elements: CardElement[] = [];
  const buf: string[] = [];

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
