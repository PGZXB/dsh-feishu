/**
 * Report artifacts: collect the screenshots / videos a run produced and write
 * a machine-readable manifest next to the Playwright HTML report. The walk is
 * pure (a directory listing) so it is unit-testable without a browser.
 *
 * @module e2e/lib/report
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One artifact the run produced. */
export interface E2eArtifact {
  readonly kind: 'screenshot' | 'video';
  /** Path relative to the report dir (stable across machines). */
  readonly path: string;
  /** Size in bytes. */
  readonly size: number;
}

/** The run manifest written to `reportDir/manifest.json`. */
export interface E2eManifest {
  readonly generatedAt: string;
  readonly artifacts: E2eArtifact[];
}

/** File extensions counted as screenshots / videos. */
const SCREENSHOT_EXT = new Set(['.png', '.jpg', '.jpeg']);
const VIDEO_EXT = new Set(['.webm', '.mp4']);

/**
 * Collect the artifacts under `reportDir` (recursively, excluding the
 * Playwright html output). Deterministic order: path ascending.
 * @param reportDir - the report output directory.
 * @returns the collected artifacts.
 */
export function collectArtifacts(reportDir: string): E2eArtifact[] {
  if (!existsSync(reportDir)) return [];
  const out: E2eArtifact[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync> | undefined;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat === undefined) continue;
      if (stat.isDirectory()) {
        if (entry === 'html') continue; // Playwright's html report, not an artifact
        walk(full);
      } else {
        const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
        const kind = SCREENSHOT_EXT.has(ext)
          ? 'screenshot'
          : VIDEO_EXT.has(ext)
            ? 'video'
            : undefined;
        if (kind !== undefined) {
          out.push({ kind, path: relative(reportDir, full), size: stat.size });
        }
      }
    }
  };
  walk(reportDir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Write the run manifest (`manifest.json`) into `reportDir`.
 * @param reportDir - the report output directory.
 * @param artifacts - artifacts to record (from {@link collectArtifacts}).
 */
export function writeManifest(reportDir: string, artifacts: E2eArtifact[]): void {
  mkdirSync(reportDir, { recursive: true });
  const manifest: E2eManifest = { generatedAt: new Date().toISOString(), artifacts };
  writeFileSync(join(reportDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
