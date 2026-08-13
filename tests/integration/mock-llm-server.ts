/**
 * Mock DeepSeek-compatible API server for the real-composition test.
 *
 * The real dsh agent loop talks to the DeepSeek adapter, which resolves its
 * endpoint from `$DEEPSEEK_BASE_URL`. Pointing that at this server lets a
 * real agent turn run end to end with only the external LLM API mocked (the
 * policy allows mocking external/nondeterministic services). The server
 * answers a canned SSE completion stream and a minimal model catalog.
 *
 * @module tests/integration/mock-llm-server
 */

import { createServer, type Server } from 'node:http';

/** A running mock server. */
export interface MockLlmServer {
  /** Base URL the adapter should call (`http://127.0.0.1:<port>`). */
  readonly url: string;
  /** Stop the server. */
  close(): Promise<void>;
  /** Number of /chat/completions requests served (for assertions). */
  completionRequests(): number;
}

function sseChunk(content: string, finish = false): string {
  const delta = finish ? {} : { content };
  return (
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-mock-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta, finish_reason: finish ? 'stop' : null }],
    }) +
    '\n\n'
  );
}

/** Start a mock DeepSeek API server on a random local port. */
export async function startMockLlmServer(): Promise<MockLlmServer> {
  let completions = 0;
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/chat/completions') {
      completions += 1;
      // Drain the request body so the connection is reusable.
      req.resume();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(sseChunk('Hello from mock LLM '));
      res.write(sseChunk('— integration ok', true));
      res.end('data: [DONE]\n\n');
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    completionRequests: () => completions,
  };
}
