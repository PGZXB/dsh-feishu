/**
 * Unit tests for the outbound `send_file` tool: argument validation, image
 * vs file classification, byte upload, the 📤 Sent receipt card, and
 * feature-detect when the `tools` service is absent.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import type { CardJson, FeishuTransport } from '../src/feishu/types.js';
import { type OutboundHost, registerSendFileTool } from '../src/outbound.js';
import type { SessionMap } from '../src/session-map.js';

/** A minimal fake Feishu transport recording sends (only the seam used by
 *  `send_file` needs real behavior; the rest are stubbed). */
class FakeTransport {
  sentFiles: Array<{ chatId: string; fileName: string; content: Uint8Array }> = [];
  sentImages: Array<{ chatId: string; fileName: string; bytes: Uint8Array }> = [];
  sentCards: Array<{ chatId: string; card: CardJson }> = [];
  sentTexts: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }
  async sendFile(chatId: string, fileName: string, content: Uint8Array): Promise<void> {
    this.sentFiles.push({ chatId, fileName, content });
  }
  async sendImage(chatId: string, fileName: string, bytes: Uint8Array): Promise<void> {
    this.sentImages.push({ chatId, fileName, bytes });
  }
  async sendCard(chatId: string, card: CardJson): Promise<{ messageId: string }> {
    this.sentCards.push({ chatId, card });
    return { messageId: 'om-card' };
  }
  async updateCard(_messageId: string, _card: CardJson): Promise<void> {}
  async deleteMessage(_messageId: string): Promise<void> {}
  async addReaction(_messageId: string, _emojiType: string): Promise<string> {
    return 'rx';
  }
  async removeReaction(_messageId: string, _reactionId: string): Promise<void> {}
  async deliver(_message: unknown): Promise<void> {}
  async close(): Promise<void> {}
}

function makeHost(
  cwd: string,
  sessionId = 'feishu-session-1',
  chatId = 'oc_chat',
): {
  host: OutboundHost;
  transport: FakeTransport;
  sessionMap: SessionMap;
} {
  const transport = new FakeTransport();
  const sessionMap = { chatFor: () => chatId } as unknown as SessionMap;
  const host: OutboundHost = {
    transport: transport as unknown as FeishuTransport,
    sessionMap,
    appId: 'cli_test',
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  };
  return { host, transport, sessionMap };
}

function makeCtx(withTools: boolean): Context {
  const registered: unknown[] = [];
  const ctx = {
    get(name: string) {
      if (name === 'tools' && withTools) {
        return {
          register: (def: unknown) => {
            registered.push(def);
            return () => {};
          },
        };
      }
      return undefined;
    },
  } as unknown as Context & { __registered?: unknown[] };
  (ctx as { __registered?: unknown[] }).__registered = registered;
  return ctx;
}

function makeExec(cwd: string, sessionId = 'feishu-session-1'): ToolRunContext {
  return {
    agent: { session: { id: sessionId, header: { cwd } } },
  } as unknown as ToolRunContext;
}

describe('registerSendFileTool', () => {
  it('registers the send_file tool when the tools service is present', () => {
    const ctx = makeCtx(true);
    const { host } = makeHost('/work');
    const dispose = registerSendFileTool(ctx, host);
    expect(dispose).toBeDefined();
    expect((ctx as unknown as { __registered?: unknown[] }).__registered).toHaveLength(1);
  });

  it('returns undefined and does not register when the tools service is absent', () => {
    const ctx = makeCtx(false);
    const { host } = makeHost('/work');
    const dispose = registerSendFileTool(ctx, host);
    expect(dispose).toBeUndefined();
    expect((ctx as unknown as { __registered?: unknown[] }).__registered).toHaveLength(0);
  });
});

describe('send_file execution', () => {
  let dir: string;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  function setupTool(): {
    transport: FakeTransport;
    sessionMap: SessionMap;
    execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>;
  } {
    dir = mkdtempSync(join(tmpdir(), 'outbound-'));
    const { host, transport, sessionMap } = makeHost(dir);
    const ctx = makeCtx(true);
    registerSendFileTool(ctx, host);
    // The registered definition is captured in ctx.__registered[0].
    const def = (ctx as unknown as { __registered?: unknown[] }).__registered?.[0] as {
      execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>;
    };
    return { transport, sessionMap, execute: (args, exec) => def.execute(args, exec) };
  }

  it('sends an image when the path has an image extension', async () => {
    const { transport, execute } = setupTool();
    writeFileSync(join(dir, 'plot.png'), new Uint8Array([137, 80, 78, 71]));
    const exec = makeExec(dir);
    const result = await execute({ path: 'plot.png', description: 'A plot:' }, exec);
    expect(transport.sentImages).toHaveLength(1);
    expect(transport.sentImages[0]?.fileName).toBe('plot.png');
    expect(transport.sentImages[0]?.chatId).toBe('oc_chat');
    expect(transport.sentFiles).toHaveLength(0);
    expect(result).toEqual({ name: 'plot.png', sent: true });
    // A short text line announces the send (description used verbatim); no card.
    expect(transport.sentTexts).toEqual([{ chatId: 'oc_chat', text: 'A plot:' }]);
    expect(transport.sentCards).toHaveLength(0);
  });

  it('sends a file for a non-image path', async () => {
    const { transport, execute } = setupTool();
    writeFileSync(join(dir, 'report.txt'), 'hello\n');
    const exec = makeExec(dir);
    const result = await execute({ path: 'report.txt' }, exec);
    expect(transport.sentFiles).toHaveLength(1);
    expect(transport.sentFiles[0]?.fileName).toBe('report.txt');
    expect(Buffer.from(transport.sentFiles[0]?.content ?? []).toString()).toBe('hello\n');
    expect(transport.sentImages).toHaveLength(0);
    expect(result).toEqual({ name: 'report.txt', sent: true });
    // No description → the intro line falls back to `Sending <name>:` (English).
    expect(transport.sentTexts).toEqual([{ chatId: 'oc_chat', text: 'Sending report.txt:' }]);
    expect(transport.sentCards).toHaveLength(0);
  });

  it('resolves an ABSOLUTE path as-is instead of joining it onto the cwd', async () => {
    // Regression (#31): the produced path is absolute; join(cwd, abs) double-
    // prefixed it. send_file must accept an absolute path directly.
    const { transport, execute } = setupTool();
    const absDir = mkdtempSync(join(tmpdir(), 'outbound-abs-'));
    const absPath = join(absDir, 'greetings.py');
    writeFileSync(absPath, 'def greet(): pass\n');
    const exec = makeExec(dir);
    const result = await execute(
      { path: absPath, description: 'greetings.py 模块示例文件:' },
      exec,
    );
    expect(transport.sentFiles).toHaveLength(1);
    expect(transport.sentFiles[0]?.fileName).toBe('greetings.py');
    expect(Buffer.from(transport.sentFiles[0]?.content ?? []).toString()).toBe(
      'def greet(): pass\n',
    );
    expect(result).toEqual({ name: 'greetings.py', sent: true });
    // Description (already ending with a colon) is used verbatim.
    expect(transport.sentTexts).toEqual([
      { chatId: 'oc_chat', text: 'greetings.py 模块示例文件:' },
    ]);
    rmSync(absDir, { recursive: true, force: true });
  });

  it('returns an error for a missing path (no upload, no announcement)', async () => {
    const { transport, execute } = setupTool();
    const exec = makeExec(dir);
    await expect(execute({ path: 'nope.txt' }, exec)).rejects.toThrow('could not read');
    expect(transport.sentFiles).toHaveLength(0);
    expect(transport.sentImages).toHaveLength(0);
    expect(transport.sentCards).toHaveLength(0);
    expect(transport.sentTexts).toHaveLength(0);
  });

  it('rejects a call without the required path', async () => {
    const { execute } = setupTool();
    const exec = makeExec(dir);
    // `path` is a required parameter — the runtime validates before execute.
    await expect(execute({ description: 'x' }, exec)).rejects.toThrow(/path/);
  });
});
