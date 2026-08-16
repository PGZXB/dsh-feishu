/**
 * Working-directory resolution for user-supplied paths (/cd, /repo).
 *
 * @module @dsh-feishu/dsh-feishu/directory
 */

import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** Resolve and validate a user-supplied working-directory path. */
export function resolveDirectory(
  input: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const resolvedPath = resolvePath(input.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  if (!existsSync(resolvedPath)) {
    return { ok: false, error: `directory does not exist: ${resolvedPath}` };
  }
  let isDir = false;
  try {
    isDir = statSync(resolvedPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { ok: false, error: `not a directory: ${resolvedPath}` };
  return { ok: true, path: resolvedPath };
}
