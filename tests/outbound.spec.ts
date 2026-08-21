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
import { buildSentFileCard } from '../src/cards/render.js';
import type { CardJson, FeishuTransport } from '../src/feishu/types.js';
import { type OutboundHost, registerSendFileTool } from '../src/outbound.js';
import type { SessionMap } from '../src/session-map.js';

/** A minimal fake Feishu transport recording sends (only the seam used by
 *  `send_file` needs real behavior; the rest are stubbed). */
class FakeTransport {
  sentFiles: Array<{ chatId: string; fileName: string; content: Uint8Array }> = [];
  sentImages: Array<{ chatId: string; fileName: string; bytes: Uint8Array }> = [];
  sentCards: Array<{ chatId: string; card: CardJson }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendText(_chatId: string, _text: string): Promise<void> {}
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
    const result = await execute({ path: 'plot.png', description: 'A plot' }, exec);
    expect(transport.sentImages).toHaveLength(1);
    expect(transport.sentImages[0]?.fileName).toBe('plot.png');
    expect(transport.sentImages[0]?.chatId).toBe('oc_chat');
    expect(transport.sentFiles).toHaveLength(0);
    expect(result).toEqual({ name: 'plot.png', sent: true });
    // A 📤 Sent receipt card posts.
    expect(transport.sentCards).toHaveLength(1);
    expect(transport.sentCards[0]?.card?.header?.title.content).toBe('📤 Sent');
    expect(JSON.stringify(transport.sentCards[0]?.card)).toContain('A plot');
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
  });

  it('returns an error for a missing path (no upload, no receipt card)', async () => {
    const { transport, execute } = setupTool();
    const exec = makeExec(dir);
    await expect(execute({ path: 'nope.txt' }, exec)).rejects.toThrow('could not read');
    expect(transport.sentFiles).toHaveLength(0);
    expect(transport.sentImages).toHaveLength(0);
    expect(transport.sentCards).toHaveLength(0);
  });

  it('rejects a call without the required path', async () => {
    const { execute } = setupTool();
    const exec = makeExec(dir);
    // `path` is a required parameter — the runtime validates before execute.
    await expect(execute({ description: 'x' }, exec)).rejects.toThrow(/path/);
  });
});

describe('buildSentFileCard', () => {
  it('shows the name and the description', () => {
    const card = buildSentFileCard('plot.png', 'The training loss');
    expect(card.header?.title.content).toBe('📤 Sent');
    expect(card.header?.template).toBe('green');
    expect(JSON.stringify(card.elements)).toContain('plot.png');
    expect(JSON.stringify(card.elements)).toContain('The training loss');
    expect(card.elements.some((el) => el.tag === 'action')).toBe(false);
  });

  it('omits the description line when none given', () => {
    const card = buildSentFileCard('report.txt');
    expect(JSON.stringify(card.elements)).not.toContain('>');
  });
});
