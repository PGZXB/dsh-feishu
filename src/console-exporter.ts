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

import type { Exporter, Message } from '@deepseek-ai/cordis';

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
 * @returns a cordis logger exporter.
 */
export function consoleExporter(): Exporter {
  const debugEnabled = process.env.FEISHU_DEBUG === '1';
  return {
    // cordis filters by exporter.levels before export(): debug is level 3,
    // the logger default is 1, so without this debug never reaches us.
    levels: { default: 3 },
    export(message) {
      if (message.type === 'debug' && !debugEnabled) return;
      const line = formatMessage(message);
      const write =
        message.type === 'error' || message.type === 'warn' ? console.error : console.log;
      write(line, ...message.args);
    },
  };
}
