/**
 * Shared log-file helpers: where dsh-feishu writes its dsh-feishu log and how
 * the surface ships it to a chat.
 *
 * The console exporter appends every record to `$dataDir/logs/dsh-feishu.log`
 * (see `consoleExporter`); this module locates that file and reads it so the
 * `/log` command and the error-card "Export log" button can hand the raw log
 * to the chat (the log is sent un-compressed so Feishu renders it readably).
 *
 * @module @dsh-feishu/dsh-feishu/log-file
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The surface data directory (default `$DSH_HOME/feishu`). Pass the same
 *  value the plugin resolved so the path is deterministic. */
export type LogFileDataDir = string;

/** The absolute path of the persistent dsh-feishu log. */
export function logFilePath(dataDir: string): string {
  return join(dataDir, 'logs', 'dsh-feishu.log');
}

/**
 * Read the dsh-feishu log for shipping.
 * @param dataDir - the surface data directory the plugin resolved.
 * @returns the raw log bytes + a display name, or a user-facing error when the
 *   log is absent/unreadable.
 */
export function readLogFile(
  dataDir: string,
): { ok: true; content: Uint8Array; name: string } | { ok: false; error: string } {
  const path = logFilePath(dataDir);
  if (!existsSync(path)) {
    return { ok: false, error: `no dsh-feishu log at ${path} (writing it needs a running turn)` };
  }
  try {
    const buffer = readFileSync(path);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return { ok: true, content: new Uint8Array(buffer), name: `dsh-feishu-${stamp}.log` };
  } catch (error: unknown) {
    return { ok: false, error: `could not read the dsh-feishu log at ${path}: ${String(error)}` };
  }
}
