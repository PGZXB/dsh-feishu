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
 * `debug` dropped (noise; raise the threshold later via config if needed).
 * @returns a cordis logger exporter.
 */
export function consoleExporter(): Exporter {
  return {
    export(message) {
      if (message.type === 'debug') return;
      const line = formatMessage(message);
      const write =
        message.type === 'error' || message.type === 'warn' ? console.error : console.log;
      write(line, ...message.args);
    },
  };
}
