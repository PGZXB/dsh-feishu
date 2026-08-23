/**
 * Version-track helpers for dsh-feishu.
 *
 * `dsh-version.json` is the single source of truth for which dsh versions the
 * repo tracks and is verified against:
 *   - `dsh.stable` (A) — the dsh `@latest` the stable `release/*` track is
 *     verified against;
 *   - `dsh.next` (B) — the dsh `@next` the `main` branch is verified against.
 * Compatibility is empirical: the `canary` / `release-compat` workflows run
 * the suite against the newest `@next` / `@latest`, so a green run proves the
 * track works and the label should be refreshed; a red run means a real
 * compatibility fix is due. The labels are record, not trigger.
 *
 * README.md / README.zh.md carry a "Note" that shows A and B. These helpers
 * keep that Note in sync with the JSON (the `dsh-version-track` skill and
 * `render-version-note.mjs` write it; `check-conventions.mjs` enforces it).
 *
 * @module scripts/version-track-lib
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The version-track source-of-truth file, relative to the repo root. */
export const VERSION_TRACK_FILE = 'dsh-version.json';
/** The schema this repo uses for dsh-version.json. */
export const VERSION_TRACK_SCHEMA = 'dsh-feishu-version-track/v1';

/**
 * A backtick-wrapped token that starts with a digit — i.e. a version like
 * `0.1.0-rc.8`. The `@next` / `@latest` tags in the same line start with `@`,
 * so this never matches them.
 */
const VERSION_TOKEN_RE = /`(\d[^`]*?)`/;

/**
 * Set the A/B version tokens on the README Note lines that name `@next` and
 * `@latest`. For `@next`, the version becomes `next`; for `@latest` it
 * becomes `stable`. Every other line is returned untouched.
 * @param text - the full README / README.zh.md text.
 * @param stable - the dsh `@latest` version (A).
 * @param next - the dsh `@next` version (B).
 * @returns the text with the two Note version tokens updated.
 */
export function setNoteVersions(text, stable, next) {
  const lines = text.split('\n');
  // The tag and its version may sit on the SAME line (zh, or the un-wrapped
  // single-line form) or split across a wrapped blockquote line (en). Walk
  // the lines: when a `@next` / `@latest` marker appears, remember the tag
  // and replace the FIRST digit-prefixed version token that follows with the
  // corresponding version. `replaced` guards so only that one token moves.
  let currentTag = null;
  let replaced = false;
  const out = lines.map((line) => {
    if (line.includes('dsh `@next`')) {
      currentTag = 'next';
      replaced = false;
    } else if (line.includes('dsh `@latest`')) {
      currentTag = 'stable';
      replaced = false;
    }
    if (currentTag !== null && !replaced && VERSION_TOKEN_RE.test(line)) {
      const version = currentTag === 'next' ? next : stable;
      replaced = true;
      return line.replace(VERSION_TOKEN_RE, `\`${version}\``);
    }
    return line;
  });
  return out.join('\n');
}

/**
 * Read and validate dsh-version.json.
 * @param root - the repo root.
 * @returns `{ stable, next, raw }` on success, or `{ error }` on any problem.
 */
export function loadTrack(root) {
  const path = join(root, VERSION_TRACK_FILE);
  if (!existsSync(path)) return { error: `${VERSION_TRACK_FILE} is missing` };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { error: `${VERSION_TRACK_FILE} is not valid JSON: ${String(error)}` };
  }
  if (raw.schema !== VERSION_TRACK_SCHEMA) {
    return { error: `${VERSION_TRACK_FILE} schema must be ${VERSION_TRACK_SCHEMA}` };
  }
  const stable = raw.dsh?.stable;
  const next = raw.dsh?.next;
  if (typeof stable !== 'string' || stable.length === 0) {
    return { error: `${VERSION_TRACK_FILE} requires dsh.stable (A)` };
  }
  if (typeof next !== 'string' || next.length === 0) {
    return { error: `${VERSION_TRACK_FILE} requires dsh.next (B)` };
  }
  return { stable, next, raw };
}

/**
 * Verify that the README Notes reflect the A/B values in dsh-version.json.
 * @param root - the repo root.
 * @param track - the loaded track (`{ stable, next }`).
 * @returns a list of errors (empty when the Notes are in sync).
 */
export function checkReadmeSync(root, track) {
  const errors = [];
  for (const file of ['README.md', 'README.zh.md']) {
    const path = join(root, file);
    if (!existsSync(path)) {
      errors.push(`${file} is missing`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    if (setNoteVersions(text, track.stable, track.next) !== text) {
      errors.push(
        `${file} version Note is out of sync with ${VERSION_TRACK_FILE} ` +
          `(@latest=${track.stable}, @next=${track.next}) — run \`node scripts/render-version-note.mjs\``,
      );
    }
  }
  return errors;
}
