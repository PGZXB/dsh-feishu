import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectArtifacts, writeManifest } from '../e2e/lib/report.js';

const TMP = join(process.cwd(), '_dev', 'e2e-unit-tmp');

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, 'html'), { recursive: true });
  mkdirSync(join(TMP, 'screenshots'), { recursive: true });
  writeFileSync(join(TMP, 'html', 'index.html'), '<html></html>');
  writeFileSync(join(TMP, 'screenshots', 'help-reply.png'), 'x');
  writeFileSync(join(TMP, 'screenshots', 'note.txt'), 'not an artifact');
  writeFileSync(join(TMP, 'run.webm'), 'y');
  writeFileSync(join(TMP, 'run.mp4'), 'z');
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('e2e report artifacts', () => {
  it('collects screenshots and videos, skipping the html report and other files', () => {
    const artifacts = collectArtifacts(TMP);
    const kinds = artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(['screenshot', 'video', 'video']);
    expect(artifacts.every((a) => !a.path.startsWith('html/'))).toBe(true);
    expect(artifacts.every((a) => a.size > 0)).toBe(true);
    // deterministic order: path ascending
    const paths = artifacts.map((a) => a.path);
    expect(paths).toEqual([...paths].sort());
  });

  it('returns [] for a missing directory', () => {
    expect(collectArtifacts(join(TMP, 'nope'))).toEqual([]);
  });

  it('writes a manifest.json', () => {
    const artifacts = collectArtifacts(TMP);
    writeManifest(TMP, artifacts);
    const manifest = JSON.parse(readFileSync(join(TMP, 'manifest.json'), 'utf8')) as {
      generatedAt: string;
      artifacts: { kind: string; path: string; size: number }[];
    };
    expect(manifest.generatedAt).toBeTruthy();
    expect(manifest.artifacts.length).toBe(artifacts.length);
    expect(manifest.artifacts[0]).toHaveProperty('path');
  });
});
