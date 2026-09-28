#!/usr/bin/env node
/**
 * Standalone mock DeepSeek API server for the E2E suite — a plain-JS port of
 * `tests/integration/mock-llm-server.ts`'s default behavior (the E2E launcher
 * cannot import TS). The default response is a canned text completion; the
 * reply text is overridable via `E2E_MOCK_REPLY`.
 *
 * Since dsh 0.1.7 the official DeepSeek adapter speaks the Anthropic-style
 * Messages API, so this mock answers `POST /v1/messages` with Messages SSE
 * events (`message_start` / `content_block_*` / `message_delta` /
 * `message_stop`) instead of OpenAI chat-completion chunks.
 *
 * The surface commands the anchor scenario exercises (`/help` and friends)
 * resolve locally in the plugin and never call the LLM, so the mock only
 * needs to keep the agent loop healthy for scenarios that do.
 *
 * Prints `PORT=<n>` on stdout when listening; the launcher parses it.
 */

import { createServer } from 'node:http';

const REPLY = process.env.E2E_MOCK_REPLY ?? 'Hello from mock LLM — e2e ok';

/** One framed Messages SSE event; `event:` always mirrors the payload `type`. */
function sseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'POST' && url === '/v1/messages') {
    req.resume();
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(
      sseEvent({
        type: 'message_start',
        message: {
          id: 'msg_e2e_mock_1',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-v4-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
    res.write(
      sseEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    res.write(
      sseEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: REPLY },
      }),
    );
    res.write(sseEvent({ type: 'content_block_stop', index: 0 }));
    res.write(
      sseEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
    );
    res.write(sseEvent({ type: 'message_stop' }));
    res.end();
    return;
  }
  if (req.method === 'GET' && url === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'deepseek-v4-flash', object: 'model', owned_by: 'mock' }],
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const port = Number(process.env.E2E_MOCK_PORT ?? 0);
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const actual = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`PORT=${actual}`);
});
