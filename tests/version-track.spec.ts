/**
 * Unit tests for the dsh version-track helpers.
 *
 * The helpers keep `dsh-version.json` (the A/B source of truth) and the README
 * Notes in sync, and are what both `render-version-note.mjs` and the
 * `checkVersionTrack()` convention check run on. These tests cover the pure
 * Note-rewriting logic and the JSON load/validation + README-sync check.
 *
 * @module tests/version-track
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkReadmeSync,
  loadTrack,
  setNoteVersions,
  VERSION_TRACK_SCHEMA,
} from '../scripts/version-track-lib.mjs';

const EN_NOTE = [
  '- the `main` branch (installed from git) tracks **dsh `@next`** — currently **`0.1.0-rc.8`**;',
  '- the npm `@latest` release tracks **dsh `@latest`** — currently **`0.1.0-rc.7`**.',
].join('\n');

const ZH_NOTE = [
  '- `main` 分支（git 安装）跟踪 **dsh `@next`**——当前为 **`0.1.0-rc.8`**；',
  '- npm `@latest` release 跟踪 **dsh `@latest`**——当前为 **`0.1.0-rc.7`**。',
].join('\n');

function tempRepo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'vt-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('setNoteVersions', () => {
  it('rewrites only the @next and @latest version tokens', () => {
    const out = setNoteVersions(EN_NOTE, '0.2.0-rc.1', '0.1.1-rc.2');
    expect(out).toContain('dsh `@next`** — currently **`0.1.1-rc.2`**');
    expect(out).toContain('dsh `@latest`** — currently **`0.2.0-rc.1`**');
    // The tag name must not be clobbered by the version rewrite.
    expect(out).not.toContain('dsh `0.1.1-rc.2`');
  });

  it('rewrites the zh Note the same way', () => {
    const out = setNoteVersions(ZH_NOTE, '0.2.0-rc.1', '0.1.1-rc.2');
    expect(out).toContain('当前为 **`0.1.1-rc.2`**');
    expect(out).toContain('**`0.2.0-rc.1`**');
  });

  it('leaves lines without the dsh tags untouched', () => {
    const text = ['# title', EN_NOTE, 'plain line'].join('\n');
    const out = setNoteVersions(text, '0.2.0-rc.1', '0.1.1-rc.2');
    expect(out).toContain('# title');
    expect(out).toContain('plain line');
  });

  it('handles the wrapped blockquote form (tag and version on separate lines)', () => {
    const wrapped = [
      '> **Note:** still pre-release (`0.1.0-rc.x`).',
      '> - the `main` branch tracks **dsh `@next`** — currently',
      '>   **`0.1.0-rc.8`**;',
      '> - npm `@latest` tracks **dsh `@latest`** — currently',
      '>   **`0.1.0-rc.7`**.',
    ].join('\n');
    const out = setNoteVersions(wrapped, '0.1.1-rc.2', '0.1.1-rc.2');
    // Both wrapped versions move to the new value; the unrelated pre-release
    // caveat token (before any tag) and the tags themselves are untouched.
    expect(out).toContain('**`0.1.1-rc.2`**');
    expect(out).toContain('> **Note:** still pre-release (`0.1.0-rc.x`).');
    expect(out).toContain('**dsh `@next`**');
    expect(out).toContain('**dsh `@latest`**');
  });
});

describe('loadTrack', () => {
  it('reads and validates a well-formed dsh-version.json', () => {
    const dir = tempRepo({
      'dsh-version.json': JSON.stringify({
        schema: VERSION_TRACK_SCHEMA,
        dsh: { stable: '0.1.0-rc.7', next: '0.1.0-rc.8' },
      }),
    });
    try {
      const track = loadTrack(dir);
      expect(track.error).toBeUndefined();
      expect(track.stable).toBe('0.1.0-rc.7');
      expect(track.next).toBe('0.1.0-rc.8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors on the wrong schema', () => {
    const dir = tempRepo({
      'dsh-version.json': '{"schema":"nope","dsh":{"stable":"a","next":"b"}}',
    });
    try {
      expect(loadTrack(dir).error).toMatch(/schema/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors when the file is missing', () => {
    const dir = tempRepo({});
    try {
      expect(loadTrack(dir).error).toMatch(/missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkReadmeSync', () => {
  it('passes when the README Notes match the JSON', () => {
    const dir = tempRepo({
      'dsh-version.json': JSON.stringify({
        schema: VERSION_TRACK_SCHEMA,
        dsh: { stable: '0.1.0-rc.7', next: '0.1.0-rc.8' },
      }),
      'README.md': EN_NOTE,
      'README.zh.md': ZH_NOTE,
    });
    try {
      expect(checkReadmeSync(dir, { stable: '0.1.0-rc.7', next: '0.1.0-rc.8' })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a stale README Note against the JSON', () => {
    const dir = tempRepo({
      'dsh-version.json': JSON.stringify({
        schema: VERSION_TRACK_SCHEMA,
        dsh: { stable: '0.1.0-rc.7', next: '0.1.0-rc.8' },
      }),
      // README still names the older @next version.
      'README.md': EN_NOTE,
      'README.zh.md': ZH_NOTE.replace('0.1.0-rc.8', '0.1.0-rc.6'),
    });
    try {
      const errors = checkReadmeSync(dir, { stable: '0.1.0-rc.7', next: '0.1.0-rc.8' });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/README\.zh\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
