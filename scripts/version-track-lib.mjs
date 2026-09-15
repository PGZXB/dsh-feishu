/**
 * Version-track helpers for dsh-feishu.
 *
 * `dsh-version.json` is the single source of truth for which dsh version the
 * repo is adapted to and verified against:
 *
 *   - `dsh.latest` — the dsh `@latest` CLI version. BOTH the npm `@latest`
 *     release and the `main` branch are verified against it, so the repo
 *     carries exactly ONE compatibility promise.
 *
 * Every other dsh dist-tag — the pre-release and alpha lines — is deliberately
 * ignored. An earlier design also tracked a pre-release line for `main` and
 * `@latest` for the release, which meant adapting the same code twice whenever
 * that line ran ahead of `@latest` (adapt for `@latest`, release it, then adapt
 * again for the pre-release) while telling users two different compatibility
 * stories. Only the version a user actually gets from the npm `@latest` tag is
 * a promise.
 *
 * Only the dsh CLI carries a meaningful npm `latest` tag; the family's
 * sub-packages publish only pre-release tags while their `latest` still points
 * at ancient lines (0.0.1-rc.x). "dsh `@latest`" therefore means the CLI's
 * `@latest` version with the sub-packages resolved by the carets that CLI
 * declares — exactly what a user's `npm i @deepseek-ai/dsh@latest` resolves to.
 *
 * Compatibility is empirical: the `canary` workflow runs the suite against the
 * npm `@latest` CLI, so a green run proves the promise and the label should be
 * refreshed; a red run means a real compatibility fix is due. The label is a
 * record, not a trigger.
 *
 * README.md / README.zh.md carry a "Note" that names the tracked version.
 * These helpers keep that Note in sync with the JSON (the `dsh-version-track`
 * skill and `render-version-note.mjs` write it; `check-conventions.mjs`
 * enforces it).
 *
 * @module scripts/version-track-lib
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The version-track source-of-truth file, relative to the repo root. */
export const VERSION_TRACK_FILE = 'dsh-version.json';
/** The schema this repo uses for dsh-version.json. */
export const VERSION_TRACK_SCHEMA = 'dsh-feishu-version-track/v2';

/**
 * A backtick-wrapped token that starts with a digit — i.e. a version like
 * `0.1.5-rc.1`. The `@latest` tag in the same line starts with `@`, so this
 * never matches it.
 */
const VERSION_TOKEN_RE = /`(\d[^`]*?)`/;

/** The README Note phrase that names the tracked version. */
const NOTE_MARKER = 'dsh `@latest`';

/**
 * Set the tracked-version token in the README Note.
 *
 * The Note names the tracked tag as `dsh \`@latest\``; the version may sit on
 * the same line (zh, or the single-line form) or on a following wrapped
 * blockquote line (en). The first digit-prefixed backticked token at or after
 * that marker is the one replaced; every other line is returned untouched.
 *
 * @param text - the full README / README.zh.md text.
 * @param latest - the tracked dsh `@latest` version.
 * @returns the text with the Note version token updated.
 */
export function setNoteVersions(text, latest) {
  let armed = false;
  let replaced = false;
  const out = text.split('\n').map((line) => {
    if (line.includes(NOTE_MARKER)) {
      armed = true;
      replaced = false;
    }
    if (armed && !replaced && VERSION_TOKEN_RE.test(line)) {
      armed = false;
      replaced = true;
      return line.replace(VERSION_TOKEN_RE, `\`${latest}\``);
    }
    return line;
  });
  return out.join('\n');
}

/** Whether the README Note names the tracked version at all. */
export function noteNamesTrackedVersion(text) {
  return text.includes(NOTE_MARKER);
}

/**
 * Read and validate dsh-version.json.
 * @param root - the repo root.
 * @returns `{ latest, raw }` on success, or `{ error }` on any problem.
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
  const latest = raw.dsh?.latest;
  if (typeof latest !== 'string' || latest.length === 0) {
    return { error: `${VERSION_TRACK_FILE} requires dsh.latest` };
  }
  return { latest, raw };
}

/**
 * Verify that the README Notes reflect the tracked version.
 * @param root - the repo root.
 * @param track - the loaded track (`{ latest }`).
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
    if (!noteNamesTrackedVersion(text)) {
      errors.push(
        `${file} version Note does not name the tracked dsh \`@latest\` version any more`,
      );
      continue;
    }
    if (setNoteVersions(text, track.latest) !== text) {
      errors.push(
        `${file} version Note is out of sync with ${VERSION_TRACK_FILE} ` +
          `(dsh @latest=${track.latest}) — run \`node scripts/render-version-note.mjs\``,
      );
    }
  }
  return errors;
}
