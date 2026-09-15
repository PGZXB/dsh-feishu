#!/usr/bin/env node
/**
 * Regenerate the README "Note" version lines from dsh-version.json.
 *
 * README.md and README.zh.md carry a Note that names the dsh `@latest` version
 * the repo is adapted to (one tracked version for both `main` and the npm
 * release). This script rewrites just that version token from the single
 * source of truth, so the Note never drifts from the JSON. The
 * `dsh-version-track` skill calls this after it adapts to a new dsh; a
 * convention check (`pnpm run check`) fails if the Notes are stale.
 *
 * Usage: node scripts/render-version-note.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTrack, setNoteVersions } from './version-track-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const track = loadTrack(ROOT);
if (track.error) {
  console.error(`✗ ${track.error}`);
  process.exit(1);
}

for (const file of ['README.md', 'README.zh.md']) {
  const path = join(ROOT, file);
  const text = readFileSync(path, 'utf8');
  const updated = setNoteVersions(text, track.latest);
  if (updated !== text) {
    writeFileSync(path, updated);
    console.log(`✓ ${file} Note updated (dsh @latest=${track.latest})`);
  } else {
    console.log(`- ${file} Note already in sync`);
  }
}
