/**
 * Type declarations for scripts/version-track-lib.mjs.
 *
 * The library itself is plain JavaScript (no build step); this declaration
 * lets the TypeScript test suite (and editor) type-check its imports under
 * `strict` / `NodeNext` without pulling the module into the build.
 *
 * @module scripts/version-track-lib
 */

export const VERSION_TRACK_FILE: string;
export const VERSION_TRACK_SCHEMA: string;

export function setNoteVersions(text: string, latest: string): string;

export function noteNamesTrackedVersion(text: string): boolean;

export function loadTrack(
  root: string,
): { error?: string; latest?: string; raw?: Record<string, unknown> };

export function checkReadmeSync(root: string, track: { latest: string }): string[];
