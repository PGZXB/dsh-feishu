/**
 * Console log exporter for the cordis Logger service.
 *
 * dsh surfaces do not mount a console exporter by default: `ctx.logger.*`
 * records land in the in-memory buffer and are never printed. A bridge
 * plugin needs operator-visible logs, so this module turns structured logger
 * messages into plain console lines.
 *
 * @module @dsh-feishu/dsh-feishu/console-exporter
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Exporter, Message } from '@deepseek-ai/cordis';

/** Best-effort JSON for a non-string log arg (never throws; Error → message). */
function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/**
 * Format one structured message as a console line prefix.
 * @param message - the structured log record (fields used for the prefix).
 * @returns an ISO-timestamped `[time] name [type]` prefix.
 */
export function formatMessage(message: Pick<Message, 'ts' | 'name' | 'type'>): string {
  const time = new Date(message.ts).toISOString();
  return `[${time}] ${message.name} [${message.type}]`;
}

/**
 * Build a console exporter: `error`/`warn` to stderr, `info` to stdout,
 * `debug` printed ONLY when `FEISHU_DEBUG` is set (the test bot runs with
 * it; production stays quiet).
 *
 * When `logFile` is given, every exported record is ALSO appended to that
 * file (so the dsh-feishu log survives the terminal and can be shipped by the
 * `/log` command / error-card "Export log" button). `debug` stays gated by
 * `FEISHU_DEBUG` in both sinks to keep the file bounded.
 * @param logFile - optional absolute path to append the dsh-feishu log to.
 * @returns a cordis logger exporter.
 */
export function consoleExporter(logFile?: string): Exporter {
  const debugEnabled = process.env.FEISHU_DEBUG === '1';
  return {
    // cordis filters by exporter.levels before export(): debug is level 3,
    // the logger default is 1, so without this debug never reaches us.
    levels: { default: 3 },
    export(message) {
      if (message.type === 'debug' && !debugEnabled) return;
      const line = formatMessage(message);
      if (logFile !== undefined) {
        try {
          // Best-effort: a failed file write must never break a log record.
          mkdirSync(dirname(logFile), { recursive: true });
          appendFileSync(
            logFile,
            `${line} ${message.args.map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg))).join(' ')}\n`,
          );
        } catch {
          // swallow
        }
      }
      const write =
        message.type === 'error' || message.type === 'warn' ? console.error : console.log;
      write(line, ...message.args);
    },
  };
}
