/**
 * Inbound-attachment file naming: turn a user-supplied file name into a
 * safe on-disk name under the attachment bucket, WeChat-style — the first
 * `report.pdf` lands as `report.pdf`, the second as `report(1).pdf`, the
 * third `report(2).pdf`, and so on, so a repeated file never overwrites an
 * earlier one.
 *
 * Safety is non-negotiable (AGENTS.md): the name becomes a path segment
 * under the chat's working directory, so separators, traversal segments,
 * control characters, and Windows-reserved characters are stripped or
 * replaced. Unicode is preserved (real-world file names are not ASCII).
 *
 * @module @dsh-feishu/dsh-feishu/attachment-naming
 */

import { join } from 'node:path';

/** Windows-reserved / path-dangerous characters (replaced with `_`). */
const UNSAFE_CHARS = /[/\\<>:"|?*]/g;
/** C0 control characters (replaced with `_`). */
const CONTROL_CHARS = /[\p{Cc}]/gu;
/** Traversal or current-directory segments, checked on the whole name. */
const DANGEROUS_SEGMENTS = /^(\.|\.\.)$/;
/** Maximum on-disk name length (bytes, UTF-8) — keeps paths sane. */
const MAX_NAME_BYTES = 200;

/**
 * Sanitize a user-supplied file name into a safe single path segment.
 * @param name - the raw file name from the Feishu event (`file_name`).
 * @returns the sanitized name, or `undefined` when nothing usable remains
 *   (empty, or a bare `.`/`..` segment) — the caller falls back to
 *   key-based naming.
 */
export function sanitizeFileName(name: string): string | undefined {
  const cleaned = name
    .replace(UNSAFE_CHARS, '_')
    .replace(CONTROL_CHARS, '_')
    .replace(/_+/g, '_')
    .trim();
  if (cleaned === '' || DANGEROUS_SEGMENTS.test(cleaned)) return undefined;
  // Trim to a byte budget so a long Unicode name cannot blow the path.
  let result = cleaned;
  while (Buffer.byteLength(result, 'utf8') > MAX_NAME_BYTES && result.length > 0) {
    result = result.slice(0, -1);
  }
  return result === '' ? undefined : result;
}

/**
 * Pick the on-disk file name for one attachment, WeChat-style: try the
 * sanitized user name first (its own extension is kept — a `report.pdf`
 * stays `report.pdf`, the sniffed extension only fills in when the user
 * name has none), then `name(1).ext`, `name(2).ext`, … until an unused
 * name is found; when no user name survives sanitization, fall back to
 * `<safeKey>.<ext>` (with the same deduping).
 * @param dir - the bucket directory (must exist).
 * @param name - the raw user file name (`file_name`), may be absent.
 * @param key - the resource key (fallback stem when the name is unusable).
 * @param ext - the sniffed extension, no leading dot.
 * @param exists - filesystem probe for a candidate (injectable for tests).
 * @returns the chosen file name (no directory component).
 */
export function pickAttachmentFileName(
  dir: string,
  name: string | undefined,
  key: string,
  ext: string,
  exists: (path: string) => boolean,
): string {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const raw = sanitizeFileName(name ?? '');
  // Keep the user's own extension when present; otherwise the sniffed one.
  let stem: string;
  let useExt: string;
  const dot = raw === undefined ? -1 : raw.lastIndexOf('.');
  if (raw !== undefined && dot > 0 && dot < raw.length - 1) {
    stem = raw.slice(0, dot);
    useExt = raw.slice(dot + 1);
  } else {
    stem = raw ?? safeKey;
    useExt = ext;
  }
  const base = `${stem}.${useExt}`;
  if (!exists(join(dir, base))) return base;
  for (let n = 1; ; n++) {
    const candidate = `${stem}(${n}).${useExt}`;
    if (!exists(join(dir, candidate))) return candidate;
  }
}
