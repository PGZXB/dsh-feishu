#!/usr/bin/env node
/**
 * Standalone mock DeepSeek API server for the E2E suite — a plain-JS port of
 * `tests/integration/mock-llm-server.ts`'s default behavior (the E2E launcher
 * cannot import TS). The default response is a canned text completion; the
 * reply text is overridable via `E2E_MOCK_REPLY`.
 *
 * The surface commands the anchor scenario exercises (`/help` and friends)
 * resolve locally in the plugin and never call the LLM, so the mock only
 * needs to keep the agent loop healthy for scenarios that do.
 *
 * Prints `PORT=<n>` on stdout when listening; the launcher parses it.
 */

import { createServer } from 'node:http';

const REPLY = process.env.E2E_MOCK_REPLY ?? 'Hello from mock LLM — e2e ok';

function sseChunk(delta, finish = false) {
  const body = finish ? {} : delta;
  return (
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-e2e-mock-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: body, finish_reason: finish ? 'stop' : null }],
    }) +
    '\n\n'
  );
}

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'POST' && url === '/chat/completions') {
    req.resume();
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(sseChunk({ content: REPLY }));
    res.write(sseChunk({}, true));
    res.end('data: [DONE]\n\n');
    return;
  }
  if (req.method === 'GET' && url === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model', owned_by: 'mock' }] }));
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
