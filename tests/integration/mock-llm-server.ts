/**
 * Mock DeepSeek-compatible API server for the real-composition test.
 *
 * The real dsh agent loop talks to the official DeepSeek adapter, which since
 * dsh 0.1.7 speaks the Anthropic-style Messages API: it posts to
 * `<baseURL>/v1/messages` and consumes `message_start` / `content_block_*` /
 * `message_delta` / `message_stop` SSE events. Pointing `$DEEPSEEK_BASE_URL`
 * at this server lets a real agent turn run end to end with only the external
 * LLM API mocked (the policy allows mocking external/nondeterministic
 * services).
 *
 * The default response is a canned text completion. A scripted
 * tool-calling script (set via `setScripts`) emits Messages `thinking` and
 * `tool_use` content blocks so the adapter produces reasoning blocks and
 * tool-call chunks — the wire input that makes the surface render think rows
 * and tool rows on the streaming card.
 *
 * @module tests/integration/mock-llm-server
 */

import { createServer, type Server, type ServerResponse } from 'node:http';

/** One scripted chunk of a scripted Messages response. */
export interface MockScriptChunk {
  /** `thinking` delta (think rows). */
  reasoning?: string;
  /** `text` delta (visible text). */
  content?: string;
  /** `tool_use` block fragments; one block per distinct `index`. */
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
  /** Number of `/v1/messages` requests served (for assertions). */
  completionRequests(): number;
  /**
   * The raw JSON body of the MOST RECENT `/v1/messages` request, or
   * `undefined` when none arrived yet. Lets a test assert what content the
   * agent actually received (e.g. an injected attachment path).
   */
  lastRequestBody(): unknown;
  /**
   * Every parsed `/v1/messages` request body, in arrival order. Lets a test
   * assert that ANY request matched a shape (e.g. that the agent's requests
   * carried the saved default model, not just the last one — a
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

/** One framed Messages SSE event; `event:` always mirrors the payload `type`. */
function sseEvent(event: { readonly type: string } & Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Incremental writer for one Messages response body. */
interface MessagesWriter {
  /** Emit `message_start`; must precede every other event. */
  start(): void;
  /** Append one scripted chunk, opening its content block on first use. */
  append(chunk: MockScriptChunk): void;
  /** Close every content block the script opened. */
  closeBlocks(): void;
  /** Emit `message_delta` + `message_stop` with the terminal stop reason. */
  finish(stopReason: 'end_turn' | 'tool_use'): void;
}

/**
 * Build a writer that frames one logical assistant message. Reasoning, text
 * and each scripted tool-call index map to one content block, opened lazily
 * on first use, so a script may interleave them in any order.
 *
 * @param res - the streaming HTTP response.
 * @param model - model id echoed in `message_start`.
 * @returns the block-aware Messages event writer.
 */
function createMessagesWriter(res: ServerResponse, model: string): MessagesWriter {
  let nextIndex = 0;
  const blocks = new Map<string, number>();
  const open: number[] = [];
  function ensure(key: string, contentBlock: Record<string, unknown>): number {
    const existing = blocks.get(key);
    if (existing !== undefined) return existing;
    const index = nextIndex;
    nextIndex += 1;
    blocks.set(key, index);
    open.push(index);
    res.write(sseEvent({ type: 'content_block_start', index, content_block: contentBlock }));
    return index;
  }
  function delta(index: number, value: Record<string, unknown>): void {
    res.write(sseEvent({ type: 'content_block_delta', index, delta: value }));
  }
  return {
    start: () => {
      res.write(
        sseEvent({
          type: 'message_start',
          message: {
            id: 'msg_mock_1',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    },
    append: (chunk) => {
      if (chunk.reasoning !== undefined) {
        const index = ensure('reasoning', { type: 'thinking', thinking: '' });
        delta(index, { type: 'thinking_delta', thinking: chunk.reasoning });
      }
      if (chunk.content !== undefined) {
        const index = ensure('text', { type: 'text', text: '' });
        delta(index, { type: 'text_delta', text: chunk.content });
      }
      if (chunk.toolCall !== undefined) {
        const tool = chunk.toolCall;
        const index = ensure(`tool:${tool.index}`, {
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: {},
        });
        delta(index, { type: 'input_json_delta', partial_json: tool.arguments });
      }
    },
    closeBlocks: () => {
      for (const index of open) {
        res.write(sseEvent({ type: 'content_block_stop', index }));
      }
      open.length = 0;
    },
    finish: (stopReason) => {
      res.write(
        sseEvent({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          // Zero usage mirrors the old Chat-Completions mock, which carried no
          // `usage` at all: the terminal card then omits its token group, so a
          // table-rendering assertion is not confused by the stats separator.
          usage: { output_tokens: 0 },
        }),
      );
      res.write(sseEvent({ type: 'message_stop' }));
    },
  };
}

/** Stream one scripted response body (default text when none is scripted). */
function writeScriptedBody(
  writer: MessagesWriter,
  script: readonly MockScriptChunk[] | undefined,
): void {
  if (script === undefined || script.length === 0) {
    writer.append({ content: 'Hello from mock LLM ' });
    writer.append({ content: '— integration ok' });
    return;
  }
  for (const part of script) {
    // An `error` entry already answered with an HTTP failure before streaming.
    if (part.error !== undefined) continue;
    writer.append(part);
  }
}

/** Whether the script produces a tool call (drives the `tool_use` stop reason). */
function hasToolCall(script: readonly MockScriptChunk[] | undefined): boolean {
  return script?.some((part) => part.toolCall !== undefined) ?? false;
}

/** Start a mock DeepSeek Messages API server on a random local port. */
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

  /** The script for the NEXT completion request, or undefined (default). */
  function nextScript(): readonly MockScriptChunk[] | undefined {
    const script = scripts?.[0];
    if (scripts !== undefined && scripts.length > 1) scripts = scripts.slice(1);
    return script;
  }

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/v1/messages') {
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
      const writer = createMessagesWriter(res, 'deepseek-v4-flash');
      writer.start();
      if (hold) {
        hold = false;
        // Stream one leading chunk so the agent is running WITH content,
        // then keep the body open until the test releases it. If the agent
        // cancels first, its abort closes the turn regardless.
        writer.append({ content: 'starting…' });
        releaseHold = () => {
          // The agent may have aborted; writing to a dead body is a no-op.
          if (res.destroyed || res.writableEnded) return;
          writeScriptedBody(writer, script);
          writer.closeBlocks();
          writer.finish(hasToolCall(script) ? 'tool_use' : 'end_turn');
          res.end();
        };
        // Signal any waiting `waitForHold()` — the request is in flight and
        // the test may now drive stop/panel actions deterministically.
        heldResolve?.();
        heldResolve = undefined;
        heldPromise = undefined;
        return;
      }
      writeScriptedBody(writer, script);
      writer.closeBlocks();
      writer.finish(hasToolCall(script) ? 'tool_use' : 'end_turn');
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
