/**
 * Unit tests for the dsh version-track helpers.
 *
 * The helpers keep `dsh-version.json` (the single tracked dsh version) and the
 * README Notes in sync, and are what both `render-version-note.mjs` and the
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
  noteNamesTrackedVersion,
  setNoteVersions,
  VERSION_TRACK_SCHEMA,
} from '../scripts/version-track-lib.mjs';

const EN_NOTE = [
  '> **Note:** dsh is still pre-release. dsh-feishu tracks **one** dsh version —',
  '> **dsh `@latest`**, currently **`0.1.0-rc.7`** — for both `main` and the npm',
  '> `@latest` release. Other dsh dist-tags are ignored.',
].join('\n');

const ZH_NOTE = [
  '> **注意：** dsh-feishu 只跟踪**一个** dsh 版本——**dsh `@latest`**，当前为',
  '> **`0.1.0-rc.7`**——`main` 与 npm `@latest` release 都以它为准；其余 tag 忽略。',
].join('\n');

function tempRepo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'vt-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('setNoteVersions', () => {
  it('rewrites the tracked @latest version token', () => {
    const out = setNoteVersions(EN_NOTE, '0.2.0-rc.1');
    expect(out).toContain('**dsh `@latest`**, currently **`0.2.0-rc.1`**');
    // The tag name must not be clobbered by the version rewrite.
    expect(out).not.toContain('dsh `0.2.0-rc.1`');
  });

  it('rewrites the zh Note the same way', () => {
    const out = setNoteVersions(ZH_NOTE, '0.2.0-rc.1');
    expect(out).toContain('**`0.2.0-rc.1`**');
    expect(out).toContain('**dsh `@latest`**');
  });

  it('leaves lines without the tracked tag untouched', () => {
    const text = ['# title', EN_NOTE, 'plain line'].join('\n');
    const out = setNoteVersions(text, '0.2.0-rc.1');
    expect(out).toContain('# title');
    expect(out).toContain('plain line');
  });

  it('handles the wrapped blockquote form (version on a later line)', () => {
    const wrapped = [
      '> **Note:** still pre-release (`0.1.0-rc.x`).',
      '> dsh-feishu tracks **one** dsh version — **dsh `@latest`**,',
      '> currently **`0.1.0-rc.7`**.',
    ].join('\n');
    const out = setNoteVersions(wrapped, '0.1.1-rc.2');
    expect(out).toContain('> currently **`0.1.1-rc.2`**.');
    // The unrelated pre-release caveat token (before the marker) is untouched.
    expect(out).toContain('> **Note:** still pre-release (`0.1.0-rc.x`).');
    expect(out).toContain('**dsh `@latest`**');
  });

  it('does not touch a note that names some other dist-tag', () => {
    // Only the tracked `@latest` marker arms the rewrite; a note that names
    // any other tag must be left exactly as it is.
    const text = '> main tracks a pre-release tag — currently **`0.1.5-rc.2`**.';
    expect(setNoteVersions(text, '0.1.5-rc.1')).toBe(text);
    expect(noteNamesTrackedVersion(text)).toBe(false);
  });
});

describe('loadTrack', () => {
  it('reads and validates a well-formed dsh-version.json', () => {
    const dir = tempRepo({
      'dsh-version.json': JSON.stringify({
        schema: VERSION_TRACK_SCHEMA,
        dsh: { latest: '0.1.5-rc.1' },
      }),
    });
    try {
      const track = loadTrack(dir);
      expect(track.error).toBeUndefined();
      expect(track.latest).toBe('0.1.5-rc.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects the retired A/B schema', () => {
    const dir = tempRepo({
      'dsh-version.json': JSON.stringify({
        schema: 'dsh-feishu-version-track/v1',
        dsh: { stable: '0.1.0-rc.7', next: '0.1.0-rc.8' },
      }),
    });
    try {
      expect(loadTrack(dir).error).toMatch(/schema/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors when dsh.latest is missing', () => {
    const dir = tempRepo({
      'dsh-version.json': JSON.stringify({ schema: VERSION_TRACK_SCHEMA, dsh: {} }),
    });
    try {
      expect(loadTrack(dir).error).toMatch(/dsh\.latest/);
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
  it('passes when both README Notes match the tracked version', () => {
    const dir = tempRepo({
      'dsh-version.json': JSON.stringify({
        schema: VERSION_TRACK_SCHEMA,
        dsh: { latest: '0.1.0-rc.7' },
      }),
      'README.md': EN_NOTE,
      'README.zh.md': ZH_NOTE,
    });
    try {
      expect(checkReadmeSync(dir, { latest: '0.1.0-rc.7' })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a stale README Note against the tracked version', () => {
    const dir = tempRepo({
      'dsh-version.json': JSON.stringify({
        schema: VERSION_TRACK_SCHEMA,
        dsh: { latest: '0.1.5-rc.1' },
      }),
      'README.md': EN_NOTE,
      'README.zh.md': ZH_NOTE.replace('0.1.0-rc.7', '0.1.0-rc.6'),
    });
    try {
      const errors = checkReadmeSync(dir, { latest: '0.1.5-rc.1' });
      expect(errors).toHaveLength(2);
      expect(errors.join('\n')).toMatch(/README\.md/);
      expect(errors.join('\n')).toMatch(/README\.zh\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a README that no longer names the tracked version', () => {
    const dir = tempRepo({
      // README.md no longer names the tracked tag at all; the zh Note is
      // already in sync, so exactly one error must surface.
      'README.md': '> main tracks a pre-release dsh tag.',
      'README.zh.md': ZH_NOTE.replace('0.1.0-rc.7', '0.1.5-rc.1'),
    });
    try {
      const errors = checkReadmeSync(dir, { latest: '0.1.5-rc.1' });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/does not name the tracked/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
