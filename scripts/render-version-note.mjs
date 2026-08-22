#!/usr/bin/env node
/**
 * Regenerate the README "Note" version lines from dsh-version.json.
 *
 * README.md and README.zh.md carry a Note that names the two dsh versions the
 * repo tracks (A = dsh `@latest` the stable release tracks, B = dsh `@next`
 * the `main` branch tracks). This script rewrites just those two version
 * tokens from the single source of truth, so the Note never drifts from the
 * JSON. The `dsh-version-track` skill calls this after it adapts a track; a
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
  const updated = setNoteVersions(text, track.stable, track.next);
  if (updated !== text) {
    writeFileSync(path, updated);
    console.log(`✓ ${file} Note updated (dsh @latest=${track.stable}, @next=${track.next})`);
  } else {
    console.log(`- ${file} Note already in sync`);
  }
}
