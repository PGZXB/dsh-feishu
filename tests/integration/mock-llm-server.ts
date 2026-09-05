/**
 * Mock DeepSeek-compatible API server for the real-composition test.
 *
 * The real dsh agent loop talks to the DeepSeek adapter, which resolves its
 * endpoint from `$DEEPSEEK_BASE_URL`. Pointing that at this server lets a
 * real agent turn run end to end with only the external LLM API mocked (the
 * policy allows mocking external/nondeterministic services).
 *
 * The default response is a canned text completion. A scripted
 * tool-calling script (set via `setScript`) emits OpenAI-compatible
 * `reasoning_content` + `tool_calls` SSE deltas so the adapter produces
 * reasoning blocks and tool-call chunks — the wire input that makes the
 * surface render think rows and tool rows on the streaming card.
 *
 * @module tests/integration/mock-llm-server
 */

import { createServer, type Server, type ServerResponse } from 'node:http';

/** One SSE chunk of a scripted response. */
export interface MockScriptChunk {
  /** `reasoning_content` delta (think rows). */
  reasoning?: string;
  /** `content` delta (visible text). */
  content?: string;
  /** `tool_calls` delta fragments. */
  toolCall?: { index: number; id: string; name: string; arguments: string };
  /**
   * Respond with HTTP 500 instead of streaming — the adapter surfaces it as
   * an LLM error and the turn ends with `turn/end(error)` (red card).
   */
  error?: string;
}

/** A running mock server. */
export interface MockLlmServer {
  /** Base URL the adapter should call (`http://127.0.0.1:<port>`). */
  readonly url: string;
  /** Stop the server. */
  close(): Promise<void>;
  /** Number of /chat/completions requests served (for assertions). */
  completionRequests(): number;
  /**
   * The raw JSON body of the MOST RECENT /chat/completions request, or
   * `undefined` when none arrived yet. Lets a test assert what content the
   * agent actually received (e.g. an injected `image` content block).
   */
  lastRequestBody(): unknown;
  /**
   * Every parsed /chat/completions request body, in arrival order. Lets a
   * test assert that ANY request matched a shape (e.g. that the agent's
   * requests carried the saved default model, not just the last one — a
   * title-generation completion can interleave with the turn's requests).
   */
  requestBodies(): unknown[];
  /**
   * Serve one scripted response per completion request, in order. The agent
   * loop issues a new completion request after each tool result, so a
   * tool-calling turn needs two entries (tool call, then final answer).
   */
  setScripts(scripts: readonly (readonly MockScriptChunk[])[]): void;
  /**
   * Stream the response to the next completion request with a leading chunk
   * and then pause until `release()` — the agent enters `running` with some
   * content, and stays running while the test drives card actions (stop
   * mid-turn, panel-while-running). After cancel, the agent aborts the turn
   * (turn/end aborted) whether or not the stream was released.
   */
  holdNextResponse(): void;
  /**
   * Resolve when the next completion request has actually been received and
   * held. A test must await this AFTER `holdNextResponse()` and BEFORE
   * driving a stop/panel action: the working card appears as soon as the
   * turn starts, but the agent's LLM request is established asynchronously —
   * a stop issued before the request reaches the server (and its abort
   * signal binds to the in-flight body) silently cancels nothing and the
   * turn completes normally (no stopped card → test timeout on slow/loaded
   * CI runners). Awaiting the hold guarantees the abort will land.
   */
  waitForHold(): Promise<void>;
  /** Release a held response; no-op when none is held. */
  release(): void;
}

function sseChunk(delta: Record<string, unknown>, finish = false): string {
  const body = finish ? {} : delta;
  return (
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-mock-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: body, finish_reason: finish ? 'stop' : null }],
    }) +
    '\n\n'
  );
}

function sseToolCallDelta(index: number, id: string, name: string, argumentsDelta: string): string {
  return sseChunk({
    tool_calls: [{ index, id, type: 'function', function: { name, arguments: argumentsDelta } }],
  });
}

/** Start a mock DeepSeek API server on a random local port. */
export async function startMockLlmServer(): Promise<MockLlmServer> {
  let completions = 0;
  let lastBody: unknown;
  const bodies: unknown[] = [];
  let scripts: readonly (readonly MockScriptChunk[])[] | undefined;
  let hold = false;
  let releaseHold: (() => void) | undefined;
  /** Resolver for the next `waitForHold()` — resolved when a request is
   *  actually held, so tests can stop AFTER the agent's request (and its
   *  abort binding) is in flight. */
  let heldResolve: (() => void) | undefined;
  let heldPromise: Promise<void> | undefined;

  /** Stream one scripted response: reasoning, a tool call, then the answer. */
  /** The script for the NEXT completion request, or undefined (default). */
  function nextScript(): readonly MockScriptChunk[] | undefined {
    const script = scripts?.[0];
    if (scripts !== undefined && scripts.length > 1) scripts = scripts.slice(1);
    return script;
  }

  /** Stream one scripted response. The script is passed in — the request
   *  handler already consumed it (one consumption per request). */
  function writeScripted(
    res: ServerResponse,
    script: readonly MockScriptChunk[] | undefined,
  ): void {
    if (script === undefined || script.length === 0) {
      res.write(sseChunk({ content: 'Hello from mock LLM ' }));
      res.write(sseChunk({ content: '— integration ok' }, true));
      return;
    }
    const parts = [...script];
    const firstReasoning = { seen: false };
    for (const part of parts) {
      if (part.reasoning !== undefined) {
        // The adapter treats the first reasoning delta specially (empty
        // string opens the block); emit an opening marker once.
        if (!firstReasoning.seen) {
          res.write(sseChunk({ reasoning_content: '' }));
          firstReasoning.seen = true;
        }
        res.write(sseChunk({ reasoning_content: part.reasoning }));
      }
      if (part.content !== undefined) {
        res.write(sseChunk({ content: part.content }));
      }
      if (part.toolCall !== undefined) {
        res.write(
          sseToolCallDelta(
            part.toolCall.index,
            part.toolCall.id,
            part.toolCall.name,
            part.toolCall.arguments,
          ),
        );
      }
    }
    res.write(sseChunk({}, true));
  }

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/chat/completions') {
      completions += 1;
      // Capture the full request body for `lastRequestBody()` assertions —
      // the body is drained anyway, so read it instead of discarding it.
      const bodyChunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
          lastBody = body;
          bodies.push(body);
        } catch {
          lastBody = undefined;
        }
      });
      // A scripted error responds 500 BEFORE any streaming headers — writing
      // them first would make the 500 throw ("headers already sent") and hang
      // the adapter on an open body.
      const script = nextScript();
      const failing = script?.find((part) => part.error !== undefined);
      if (failing !== undefined) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(failing.error ?? 'mock LLM error');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      if (hold) {
        hold = false;
        // Stream one leading chunk so the agent is running WITH content,
        // then keep the body open until the test releases it. If the agent
        // cancels first, its abort closes the turn regardless.
        res.write(sseChunk({ content: 'starting…' }));
        releaseHold = () => {
          writeScripted(res, script);
          res.end('data: [DONE]\n\n');
        };
        // Signal any waiting `waitForHold()` — the request is in flight and
        // the test may now drive stop/panel actions deterministically.
        heldResolve?.();
        heldResolve = undefined;
        heldPromise = undefined;
        return;
      }
      writeScripted(res, script);
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
    lastRequestBody: () => lastBody,
    requestBodies: () => bodies.slice(),
    setScripts: (next) => {
      scripts = next;
    },
    holdNextResponse: () => {
      hold = true;
      if (heldPromise === undefined) {
        heldPromise = new Promise<void>((resolve) => {
          heldResolve = resolve;
        });
      }
    },
    waitForHold: async () => {
      // A caller that forgot holdNextResponse would deadlock forever; only
      // wait when a hold is actually armed.
      if (heldPromise === undefined) return;
      await heldPromise;
    },
    release: () => {
      releaseHold?.();
      releaseHold = undefined;
    },
  };
}
