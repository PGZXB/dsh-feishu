/**
 * Unit tests for the session-stats line + context occupancy on the terminal
 * streaming card: the StreamingCardController folds turn/step/tool/token
 * figures from the event stream into a session-scoped accumulator, and
 * render's `statsGrouperText` produces the `|`-separated exact-fields line
 * (counts + tokens + cache + context occupancy; no timing).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCard, statsGrouperText } from '../src/cards/render.js';
import {
  StreamingCardController,
  type StreamingCardHost,
} from '../src/cards/StreamingCardController.js';
import { StreamingCardManager } from '../src/cards/streaming.js';
import type { CardAction, CardJson, FeishuTransport } from '../src/feishu/types.js';
import { SessionMap } from '../src/session-map.js';

class RecordingTransport implements FeishuTransport {
  sentCards: CardJson[] = [];
  updatedCards: CardJson[] = [];
  sentTexts: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(_handler: unknown): void {}
  onCardAction(_handler: unknown): void {}
  getBotOpenId(): string | undefined {
    return undefined;
  }
  async chatStats(_chatId: string) {
    return undefined;
  }
  async createGroup(_name: string, _members: readonly string[]) {
    return { chatId: 'oc_g' };
  }
  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }
  async sendFile(chatId: string, fileName: string, content: Uint8Array): Promise<void> {
    void chatId;
    void fileName;
    void content;
  }
  async sendImage(chatId: string, fileName: string, bytes: Uint8Array): Promise<void> {
    void chatId;
    void fileName;
    void bytes;
  }
  async addReaction(_messageId: string, _emojiType: string): Promise<string | undefined> {
    return undefined;
  }
  async removeReaction(_messageId: string, _reactionId: string): Promise<void> {}
  async sendCard(chatId: string, card: CardJson): Promise<{ messageId: string }> {
    void chatId;
    void card;
    return { messageId: 'm1' };
  }
  async updateCard(_messageId: string, card: CardJson): Promise<void> {
    this.updatedCards.push(card);
  }
  async deleteMessage(_messageId: string): Promise<void> {}
  async downloadImage(
    _messageId: string,
    _key: string,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    throw new Error('downloadImage not implemented in this fake');
  }
  async downloadFile(
    _messageId: string,
    _key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; head: Uint8Array }> {
    throw new Error('downloadFile not implemented in this fake');
  }
}

function makeController(cwd: string): {
  controller: StreamingCardController;
  transport: RecordingTransport;
  statsFor: (chatId: string) => {
    turnCount: number;
    stepCount: number;
    toolCount: number;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
    contextWindow: number | undefined;
  };
} {
  const transport = new RecordingTransport();
  const sessionMap = new SessionMap(join(cwd, 'session-map.json'));
  sessionMap.set('oc_chat', 's1');
  sessionMap.setCwd('oc_chat', cwd);
  const cards = new StreamingCardManager(transport);
  const host = {
    transport,
    cards,
    logger: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
    sessionMap,
    agentStore: {
      get: () => undefined,
      resume: async () => undefined,
      create: async () => undefined,
    },
    defaultCwd: cwd,
    reactions: undefined,
    resolveAgent: async () => undefined,
    resolveContextWindow: async () => 128_000,
    textMentionFor: () => '',
  } as unknown as StreamingCardHost;
  const controller = new StreamingCardController(host);
  const statsFor = (chatId: string) =>
    (
      controller as unknown as {
        sessionStatsFor: (id: string) => {
          turnCount: number;
          stepCount: number;
          toolCount: number;
          tokenUsage: {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
          };
          contextWindow: number | undefined;
        };
      }
    ).sessionStatsFor(chatId);
  return { controller, transport, statsFor };
}

function turnStartEvent(turn: number): SessionEvent {
  return { type: 'turn/start', seq: 1, time: 1_000, data: { turn } } as unknown as SessionEvent;
}

function assistantMessageEvent(usage?: unknown): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 2,
    time: 2_000,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'hi' }] }, usage },
  } as unknown as SessionEvent;
}

function toolCallEvent(name: string, callId = 'c1'): SessionEvent {
  return {
    type: 'tool/call',
    seq: 3,
    time: 3_000,
    data: { turn: 1, step: 1, callId, name, arguments: '{}' },
  } as unknown as SessionEvent;
}

function turnEndEvent(kind: 'completed' | 'error' | 'aborted'): SessionEvent {
  return {
    type: 'turn/end',
    seq: 9,
    time: 9_000,
    data: { reason: { kind } },
  } as unknown as SessionEvent;
}

describe('statsGrouperText', () => {
  it('renders counts + tokens + cache + context for exact fields', () => {
    const text = statsGrouperText({
      turnCount: 2,
      stepCount: 3,
      toolCount: 1,
      tokenUsage: {
        inputTokens: 500,
        outputTokens: 120,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
      },
      contextWindow: 128_000,
    });
    expect(text).toContain('2 turns · 3 steps · 1 tools');
    expect(text).toContain('cache 38%');
    expect(text).toContain('input 800 · output 120');
    expect(text).toContain('context 1%');
  });

  it('omits the stats line when there is no step activity', () => {
    expect(
      statsGrouperText({
        turnCount: 0,
        stepCount: 0,
        toolCount: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextWindow: 128_000,
      }),
    ).toBe('');
  });

  it('omits the context group when contextWindow is unknown', () => {
    const text = statsGrouperText({
      turnCount: 1,
      stepCount: 1,
      toolCount: 0,
      tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextWindow: undefined,
    });
    expect(text).not.toContain('context');
    expect(text).toContain('1 turns · 1 steps');
  });

  it('omits the token group when there was no billing', () => {
    const text = statsGrouperText({
      turnCount: 1,
      stepCount: 1,
      toolCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextWindow: 128_000,
    });
    expect(text).toBe('1 turns · 1 steps');
  });

  it('formats large token counts compactly', () => {
    const text = statsGrouperText({
      turnCount: 1,
      stepCount: 1,
      toolCount: 0,
      tokenUsage: {
        inputTokens: 12_200,
        outputTokens: 1_200_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      contextWindow: undefined,
    });
    expect(text).toContain('input 12.2K · output 1.2M');
  });
});

describe('StreamingCardController session stats accumulation', () => {
  let dir: string;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('accumulates turn/step/tool counts and token usage from events', async () => {
    dir = mkdtempSync(join(tmpdir(), 'stats-'));
    const { controller, statsFor } = makeController(dir);
    await controller.beginTurn('oc_chat', 'om-1', 't');
    await controller.handleEvent('s1', turnStartEvent(1));
    await controller.handleEvent(
      's1',
      assistantMessageEvent({ inputTokens: 100, outputTokens: 50 } as unknown),
    );
    await controller.handleEvent('s1', toolCallEvent('bash'));
    await controller.handleEvent(
      's1',
      assistantMessageEvent({ inputTokens: 200, outputTokens: 30, cacheReadTokens: 40 } as unknown),
    );
    const stats = statsFor('oc_chat');
    expect(stats.turnCount).toBe(1);
    expect(stats.stepCount).toBe(2);
    expect(stats.toolCount).toBe(1);
    expect(stats.tokenUsage.inputTokens).toBe(300);
    expect(stats.tokenUsage.outputTokens).toBe(80);
    expect(stats.tokenUsage.cacheReadTokens).toBe(40);
  });

  it('a step with no usage contributes no tokens', async () => {
    dir = mkdtempSync(join(tmpdir(), 'stats-'));
    const { controller, statsFor } = makeController(dir);
    await controller.beginTurn('oc_chat', 'om-1', 't');
    await controller.handleEvent('s1', turnStartEvent(1));
    await controller.handleEvent('s1', assistantMessageEvent());
    const stats = statsFor('oc_chat');
    expect(stats.stepCount).toBe(1);
    expect(stats.tokenUsage.inputTokens).toBe(0);
    expect(stats.tokenUsage.outputTokens).toBe(0);
  });

  it('stats accumulate across turns (session-scoped, not reset)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'stats-'));
    const { controller, statsFor } = makeController(dir);
    await controller.beginTurn('oc_chat', 'om-1', 't1');
    await controller.handleEvent('s1', turnStartEvent(1));
    await controller.handleEvent('s1', assistantMessageEvent({ inputTokens: 10 } as unknown));
    await controller.handleEvent('s1', turnEndEvent('completed'));

    await controller.beginTurn('oc_chat', 'om-2', 't2');
    await controller.handleEvent('s1', turnStartEvent(2));
    await controller.handleEvent('s1', assistantMessageEvent({ inputTokens: 20 } as unknown));
    await controller.handleEvent('s1', turnEndEvent('completed'));

    const stats = statsFor('oc_chat');
    expect(stats.turnCount).toBe(2);
    expect(stats.stepCount).toBe(2);
    expect(stats.tokenUsage.inputTokens).toBe(30);
  });

  it('the terminal card renders the stats line only when not working', async () => {
    dir = mkdtempSync(join(tmpdir(), 'stats-'));
    const { controller, transport } = makeController(dir);
    await controller.beginTurn('oc_chat', 'om-1', 't');
    await controller.handleEvent('s1', turnStartEvent(1));
    await controller.handleEvent(
      's1',
      assistantMessageEvent({ inputTokens: 100, outputTokens: 50 } as unknown),
    );
    // Working card does NOT render the stats line.
    const workingJson = JSON.stringify(transport.updatedCards);
    expect(workingJson.includes('turns')).toBe(false);
    await controller.handleEvent('s1', turnEndEvent('completed'));
    const terminalJson = JSON.stringify(transport.updatedCards);
    expect(terminalJson).toContain('turns');
    expect(terminalJson).toContain('steps');
    // card action (send-produced) style: no mutation of state, just a re-render
    await controller.handleStreamingAction({
      chatId: 'oc_chat',
      messageId: 'm1',
      operatorOpenId: 'u1',
      value: { kind: 'copy' },
    } as CardAction);
  });
});
