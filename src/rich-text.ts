/**
 * Feishu rich-text (`post`) message serialization.
 *
 * A Feishu `post` message's `content` is a 2-D JSON array of inline element
 * groups: each outer element is a paragraph, the inner elements are ordered
 * and may mix text and attachments (`img` / `media` / `file`). The ORDER is
 * information — "look at the picture, then read this" differs from the
 * reverse — so the surface must not flatten it into text + a loose
 * attachment list.
 *
 * This module serializes the element array into a linearized markdown-ish
 * string with inline `<image N>` / `<video N>` / `<file N>` placeholders,
 * plus an ordered attachment list whose indexes match the placeholders. The
 * official client-authored `md` field is preferred when present (it already
 * carries formatting and `![img](image_key)` tokens); the element array is
 * the fallback.
 *
 * @module @dsh-feishu/dsh-feishu/rich-text
 */

import type { InboundAttachment } from './feishu/types.js';

/** One inline element of a Feishu rich-text post. */
interface PostElement {
  readonly tag: string;
  readonly text?: string;
  readonly style?: readonly string[];
  readonly href?: string;
  readonly user_id?: string;
  readonly user_name?: string;
  readonly image_key?: string;
  readonly file_key?: string;
  readonly language?: string;
  readonly emoji_type?: string;
  [key: string]: unknown;
}

/** The parsed shape of a Feishu `post` message's content JSON. */
interface PostContent {
  readonly title?: string;
  readonly content?: readonly (readonly PostElement[])[];
  readonly md?: string;
}

/** The result of serializing a `post` message. */
export interface SerializedPost {
  /** The linearized markdown-ish text with inline attachment placeholders. */
  readonly text: string;
  /** The attachments in placeholder order (1-based indexes). */
  readonly attachments: readonly InboundAttachment[];
}

/** Map an element's text styles to markdown-ish markers. */
function styledText(text: string, style?: readonly string[]): string {
  let out = text;
  if (style?.includes('bold')) out = `**${out}**`;
  if (style?.includes('italic')) out = `*${out}*`;
  if (style?.includes('lineThrough')) out = `~~${out}~~`;
  if (style?.includes('underline')) out = `<u>${out}</u>`;
  return out;
}

/** Serialize one inline element to its text fragment; `img`/`media`/`file`
 *  become placeholders and push an attachment. Returns the fragment, or ''
 *  when the element is skipped (unknown tag — forward-compat). */
function serializeElement(element: PostElement, attachments: InboundAttachment[]): string {
  switch (element.tag) {
    case 'text':
      return styledText(element.text ?? '', element.style);
    case 'a': {
      const label = element.text ?? element.href ?? '';
      return element.href === undefined || element.href === ''
        ? label
        : `[${label}](${element.href})`;
    }
    case 'at': {
      const name = element.user_name ?? element.user_id ?? '';
      return name === '' ? '@' : `@${name}`;
    }
    case 'code_block':
      return `\`\`\`${element.language ?? ''}\n${element.text ?? ''}\n\`\`\``;
    case 'hr':
      return '---';
    case 'emotion':
      return element.emoji_type ?? '';
    case 'img': {
      const key = element.image_key;
      if (typeof key !== 'string' || key === '') return '';
      attachments.push({ kind: 'image', key });
      return `<image ${attachments.length}>`;
    }
    case 'media': {
      const key = element.file_key;
      if (typeof key !== 'string' || key === '') return '';
      const name = element.file_name;
      attachments.push({
        kind: 'file',
        key,
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
      });
      return `<video ${attachments.length}>`;
    }
    case 'file': {
      const key = element.file_key;
      if (typeof key !== 'string' || key === '') return '';
      const name = element.file_name;
      attachments.push({
        kind: 'file',
        key,
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
      });
      return `<file ${attachments.length}>`;
    }
    default:
      // Unknown tag (forward-compat): skip it — a new Feishu element must
      // degrade gracefully instead of breaking the whole post's parse.
      return '';
  }
}

/** Rewrite markdown image tokens in the client-authored `md` source to
 *  `<image N>` / `<video N>` placeholders (the `md` field references
 *  `image_key` values; the placeholder numbering must match the attachment
 *  list built from those same keys). Returns the rewritten text and the
 *  ordered attachment list. */
function serializeMarkdown(
  md: string,
  keys: readonly { readonly key: string; readonly kind: 'image' | 'file' }[],
): { text: string; attachments: InboundAttachment[] } {
  const attachments: InboundAttachment[] = [];
  const byKey = new Map(keys.map((entry, index) => [entry.key, index]));
  // `![img](img_…)` or `![video](file_…)` → `<image N>` / `<video N>`.
  const text = md.replace(/!\[(img|video|file)\]\(([^)]+)\)/g, (match, kind, rawKey) => {
    const key = String(rawKey).trim();
    const index = byKey.get(key);
    if (index === undefined) return match; // key not in the attachment map — leave as-is
    const entry = keys[index];
    if (entry === undefined) return match;
    if (attachments.length === 0) {
      // First pass: push all keys in order so numbering matches placeholders.
      for (const k of keys) {
        if (k.kind === 'image') attachments.push({ kind: 'image', key: k.key });
        else attachments.push({ kind: 'file', key: k.key });
      }
    }
    void kind;
    return `<${entry.kind === 'image' ? 'image' : 'video'} ${index + 1}>`;
  });
  return { text, attachments };
}

/**
 * Serialize a Feishu `post` message's content into ordered rich text +
 * attachments. The `md` field (client-authored markdown) is preferred when
 * present; otherwise the element array is serialized with the same
 * placeholder mapping. The returned text is never empty when usable content
 * exists.
 * @param content - the raw `post` message content JSON string.
 * @returns the serialized text + ordered attachments, or `undefined` when
 *   the content is not parseable or carries no usable content.
 */
export function serializePost(content: string): SerializedPost | undefined {
  let parsed: PostContent;
  try {
    parsed = JSON.parse(content) as PostContent;
  } catch {
    return undefined;
  }
  const md = parsed.md;
  if (typeof md === 'string' && md.trim() !== '') {
    // Collect the attachment keys the md references (img/media/file tags).
    const keys: { readonly key: string; readonly kind: 'image' | 'file' }[] = [];
    for (const group of parsed.content ?? []) {
      for (const element of group) {
        if (
          element.tag === 'img' &&
          typeof element.image_key === 'string' &&
          element.image_key !== ''
        ) {
          keys.push({ key: element.image_key, kind: 'image' });
        } else if (
          (element.tag === 'media' || element.tag === 'file') &&
          typeof element.file_key === 'string' &&
          element.file_key !== ''
        ) {
          keys.push({ key: element.file_key, kind: 'file' });
        }
      }
    }
    if (keys.length > 0) {
      const { text, attachments } = serializeMarkdown(md, keys);
      if (attachments.length > 0) {
        return { text, attachments };
      }
    }
    // No attachments in the md: fall through to element serialization for
    // the text (the md itself is the text when there are no placeholders).
    return { text: md, attachments: [] };
  }
  // Element-array serialization (the `md` field is absent).
  const attachments: InboundAttachment[] = [];
  const groups = (parsed.content ?? []).map((group) =>
    group.map((element) => serializeElement(element, attachments)).join(''),
  );
  const text = groups.join('\n').trim();
  if (text === '' && attachments.length === 0) return undefined;
  return { text, attachments };
}
