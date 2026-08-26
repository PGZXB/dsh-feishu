/**
 * Unit tests for the operator-log helpers (`src/log-file.ts`).
 *
 * `logFilePath` derives the persistent log location under the surface data
 * dir; `readLogFile` reads it for shipping (`/log` + the error-card "Export
 * log" button). The raw log is sent un-compressed so Feishu renders it
 * readably.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logFilePath, readLogFile } from '../src/log-file.js';

describe('log-file', () => {
  it('derives the dsh-feishu log path under the data dir', () => {
    expect(logFilePath('/home/x/feishu')).toBe('/home/x/feishu/logs/dsh-feishu.log');
  });

  it('returns an error when the log file does not exist', () => {
    const dir = mkdtempSync(`${tmpdir()}/dsh-feishu-log-`);
    const result = readLogFile(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no dsh-feishu log');
  });

  it('reads the log file into bytes with a readable name', () => {
    const dir = mkdtempSync(`${tmpdir()}/dsh-feishu-log-`);
    const path = logFilePath(dir);
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(path, 'line one\nline two\n');
    const result = readLogFile(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.content)).toBe('line one\nline two\n');
      expect(result.name).toMatch(/^dsh-feishu-.*\.log$/);
    }
  });
});
