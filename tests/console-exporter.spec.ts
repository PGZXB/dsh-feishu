/**
 * Unit tests for the console log exporter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleExporter, formatMessage } from '../src/console-exporter.js';

/** One structured message shaped like a cordis Logger record. */
function message(
  type: 'error' | 'info' | 'warn' | 'debug',
  args: unknown[] = [],
): Parameters<ReturnType<typeof consoleExporter>['export']>[0] {
  return { sn: 1, ts: 1_700_000_000_000, name: 'test', type, level: 1, args };
}

describe('formatMessage', () => {
  it('formats an ISO timestamp with name and type', () => {
    expect(formatMessage({ ts: 1_700_000_000_000, name: 'feishu', type: 'info' })).toBe(
      '[2023-11-14T22:13:20.000Z] feishu [info]',
    );
  });
});

describe('consoleExporter', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
  });

  it('prints info messages to stdout with the formatted prefix and args', () => {
    const exporter = consoleExporter();
    exporter.export(message('info', ['hello', 42]));
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0]?.[0]).toContain('test [info]');
    expect(logSpy.mock.calls[0]?.[1]).toBe('hello');
  });

  it('prints warn and error messages to stderr', () => {
    const exporter = consoleExporter();
    exporter.export(message('warn', ['careful']));
    exporter.export(message('error', ['boom']));
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('drops debug messages', () => {
    const exporter = consoleExporter();
    exporter.export(message('debug', ['noise']));
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
