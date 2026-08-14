/**
 * Unit tests for the session-log transcript builder (/export).
 */

import { describe, expect, it } from 'vitest';
import {
  buildSessionExport,
  type SessionExportEvent,
  sessionExportLine,
} from '../src/session-export.js';

function event(type: string, seq: number, data?: SessionExportEvent['data']): SessionExportEvent {
  return { type, seq, ...(data !== undefined ? { data } : {}) };
}

describe('sessionExportLine', () => {
  it('renders user and assistant messages', () => {
    // The inbound user message is logged as `user/message`.
    const user = sessionExportLine(
      event('user/message', 1, {
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      }),
    );
    expect(user).toBe('## user\n\nhello');
    const assistant = sessionExportLine(
      event('assistant/message', 2, {
        message: { content: [{ type: 'text', text: 'hi there' }] },
      }),
    );
    expect(assistant).toBe('## assistant\n\nhi there');
  });

  it('renders tool calls with JSON args and results', () => {
    const call = sessionExportLine(
      event('tool/call', 3, { name: 'bash', arguments: '{"command":"ls"}' }),
    );
    expect(call).toContain('## tool');
    expect(call).toContain('```json');
    const result = sessionExportLine(
      event('tool/result', 4, {
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              content: [{ type: 'text', text: 'ok' }],
            },
          ],
        },
      }),
    );
    expect(result).toBe('```\nok\n```');
  });

  it('renders turn end reasons', () => {
    const line = sessionExportLine(event('turn/end', 5, { reason: { kind: 'aborted' } }));
    expect(line).toContain('turn ended: aborted');
  });

  it('renders nothing for streaming deltas', () => {
    expect(
      sessionExportLine(event('assistant/chunk', 1, { chunk: { type: 'text-delta', text: 'x' } })),
    ).toBe('');
  });
});

describe('buildSessionExport', () => {
  it('builds a header plus all rendered lines in order', () => {
    const transcript = buildSessionExport(
      [
        event('message', 1, { message: { role: 'user', content: [{ type: 'text', text: 'q' }] } }),
        event('assistant/message', 2, { message: { content: [{ type: 'text', text: 'a' }] } }),
        event('turn/end', 3, { reason: { kind: 'completed' } }),
      ],
      'My session',
    );
    expect(transcript).toContain('# dsh-feishu session log');
    expect(transcript).toContain('> My session');
    expect(transcript.indexOf('## user')).toBeLessThan(transcript.indexOf('## assistant'));
    expect(transcript).toContain('turn ended: completed');
  });

  it('marks an empty log and never truncates', () => {
    const empty = buildSessionExport([]);
    expect(empty).toContain('_(no content)_');
    const long = buildSessionExport([
      event('assistant/message', 1, {
        message: { content: [{ type: 'text', text: 'x'.repeat(200_000) }] },
      }),
    ]);
    expect(long).toContain('x'.repeat(200_000));
  });
});
