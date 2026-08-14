/**
 * Session-log export: build a readable markdown transcript from a session's
 * raw event log (for `/export` — the Feishu equivalent of the web's
 * browser-download /export; the transcript is delivered as a file message).
 *
 * Pure function, no I/O. The input is a structural subset of `SessionEvent`
 * (from `ctx.sessionQuery.readSession`), so the builder stays decoupled from
 * the dsh session packages.
 *
 * @module @dsh-feishu/dsh-feishu/session-export
 */

/** One raw session event as the exporter renders it (structural subset). */
export interface SessionExportEvent {
  readonly seq: number;
  readonly type: string;
  readonly data?: {
    readonly message?: {
      readonly role?: string;
      readonly content?: readonly {
        readonly type?: string;
        readonly text?: string;
        readonly toolCallId?: string;
        readonly content?: readonly { readonly type?: string; readonly text?: string }[];
      }[];
    };
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
    readonly name?: string;
    readonly arguments?: string;
    readonly reason?: { readonly kind?: string };
    readonly chunk?: { readonly type?: string; readonly text?: string };
  };
}

/** The plain text of a message content block list (text blocks only). */
function blockText(
  content: readonly { readonly type?: string; readonly text?: string }[] | undefined,
): string {
  return (content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

/** The transcript line(s) for one event, or `''` when the event renders
 *  nothing (streaming deltas fold into their assembled message). */
export function sessionExportLine(event: SessionExportEvent): string {
  switch (event.type) {
    case 'user/message':
    case 'message': {
      // `user/message` carries the bare UserMessage (data.content); the
      // generic `message` fallback wraps it in {message}.
      const message = event.data?.message;
      const role = message?.role ?? 'user';
      const text = blockText(event.data?.content ?? message?.content);
      return text === '' ? '' : `## ${role}\n\n${text}`;
    }
    case 'assistant/message': {
      const text = blockText(event.data?.message?.content);
      return text === '' ? '' : `## assistant\n\n${text}`;
    }
    case 'tool/call': {
      const name = event.data?.name ?? 'tool';
      const args = event.data?.arguments ?? '';
      const summary = args === '' ? name : `${name}\n\n\`\`\`json\n${args}\n\`\`\``;
      return `## tool\n\n${summary}`;
    }
    case 'tool/result': {
      // The tool-result block nests its text: content[0].content; fall
      // back to the flat content list when the block is a plain text.
      const content = event.data?.message?.content;
      const nested = content?.[0]?.content;
      const text = blockText(nested ?? content);
      return text === '' ? '' : `\`\`\`\n${text}\n\`\`\``;
    }
    case 'turn/end': {
      const kind = event.data?.reason?.kind ?? 'completed';
      return `---\n\n*turn ended: ${kind}*`;
    }
    default:
      return '';
  }
}

/**
 * Build the exported markdown transcript for a session log.
 * @param events - the raw session events in log order.
 * @param title - an optional session title for the header.
 * @returns the markdown transcript (never truncated — the file message is
 *   not bound by the card size cap).
 */
export function buildSessionExport(
  events: readonly SessionExportEvent[],
  title: string | undefined = undefined,
): string {
  const header = [
    '# dsh-feishu session log',
    ...(title === undefined || title === '' ? [] : [`\n> ${title}`]),
    '',
  ].join('\n');
  const lines = events.map(sessionExportLine).filter((line) => line !== '');
  if (lines.length === 0) return `${header}\n_(no content)_\n`;
  return `${header}\n${lines.join('\n\n')}\n`;
}
