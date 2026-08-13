/**
 * Unit tests for the surface orchestrator: message → session → agent,
 * session events → streaming card → final message.
 *
 * The bridge is exercised against a recording transport, a fake agent
 * store, and the real streaming card manager (so the card pipeline is
 * covered end to end without any network).
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bridge, turnTitle } from '../src/bridge.js';
import { StreamingCardManager } from '../src/cards/streaming.js';
import type { CardJson, FeishuMessage, FeishuTransport, SentCard } from '../src/feishu/types.js';
import { SessionMap } from '../src/session-map.js';

const SCRATCH = join(process.cwd(), '_dev', 'test-bridge');

/** Records transport interactions for assertions. */
class RecordingTransport implements FeishuTransport {
  sentCards: CardJson[] = [];
  updatedCards: CardJson[] = [];
  sentTexts: Array<{ chatId: string; text: string }> = [];
  private handler: ((message: FeishuMessage) => void) | undefined;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(handler: (message: FeishuMessage) => void): void {
    this.handler = handler;
  }
  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }
  async sendCard(_chatId: string, card: CardJson): Promise<SentCard> {
    this.sentCards.push(card);
    return { messageId: `msg-${this.sentCards.length}` };
  }
  async updateCard(_messageId: string, card: CardJson): Promise<void> {
    this.updatedCards.push(card);
  }
  deliver(message: FeishuMessage): void {
    this.handler?.(message);
  }
}

/** A fake agent store: create/get record agents with followup spies. */
class FakeAgentStore {
  readonly created: Array<{ sessionId: string; cwd: string }> = [];
  readonly followups = new Map<string, UserMessage[]>();
  private readonly agents = new Map<string, Agent>();

  get(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId);
  }

  async create(sessionId: string, cwd: string): Promise<Agent> {
    this.created.push({ sessionId, cwd });
    const followup = vi.fn((message: UserMessage) => {
      const list = this.followups.get(sessionId) ?? [];
      list.push(message);
      this.followups.set(sessionId, list);
    });
    const agent = { followup } as unknown as Agent;
    this.agents.set(sessionId, agent);
    return agent;
  }
}

interface Harness {
  transport: RecordingTransport;
  agentStore: FakeAgentStore;
  sessionMap: SessionMap;
  bridge: Bridge;
  disposeEvents: () => void;
  emit: (sessionId: string, event: SessionEvent) => void;
}

function makeHarness(options: { throttleMs?: number } = {}): Harness {
  const transport = new RecordingTransport();
  const agentStore = new FakeAgentStore();
  const sessionMap = new SessionMap(join(SCRATCH, 'map.json'), () => 'feishu-session-1');
  const listeners: Array<(sessionId: string, event: SessionEvent) => void> = [];
  const onSessionEvent = (
    listener: (sessionId: string, event: SessionEvent) => void,
  ): (() => void) => {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  };
  const cards = new StreamingCardManager(transport, { throttleMs: options.throttleMs ?? 10_000 });
  const bridge = new Bridge({
    transport,
    sessionMap,
    agentStore,
    onSessionEvent,
    cards,
    defaultCwd: '/work',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const emit = (sessionId: string, event: SessionEvent): void => {
    for (const listener of [...listeners]) listener(sessionId, event);
  };
  return {
    transport,
    agentStore,
    sessionMap,
    bridge,
    disposeEvents: () => () => {},
    emit,
  };
}

function message(overrides: Partial<FeishuMessage> = {}): FeishuMessage {
  return {
    messageId: 'om_msg1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderOpenId: 'ou_user',
    text: 'hello',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function chunkEvent(text: string): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq: 1,
    time: 0,
    data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text } },
  } as unknown as SessionEvent;
}

function turnEndEvent(reason: { kind: string } = { kind: 'completed' }): SessionEvent {
  return {
    type: 'turn/end',
    seq: 2,
    time: 0,
    data: { turn: 0, reason },
  } as unknown as SessionEvent;
}

describe('turnTitle', () => {
  it('collapses whitespace to one line', () => {
    expect(turnTitle('a\n  b\tc')).toBe('a b c');
  });

  it('caps long messages', () => {
    const title = turnTitle('x'.repeat(100));
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('Bridge', () => {
  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
  });

  afterEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('creates a session and delivers the message to the agent', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    expect(h.agentStore.created).toEqual([{ sessionId: 'feishu-session-1', cwd: '/work' }]);
    const followups = h.agentStore.followups.get('feishu-session-1');
    expect(followups).toHaveLength(1);
    expect(followups?.[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(h.transport.sentCards).toHaveLength(1);
  });

  it('wires inbound transport messages into the bridge', async () => {
    const h = makeHarness();
    h.transport.deliver(message());
    await vi.waitFor(() => {
      expect(h.agentStore.created).toHaveLength(1);
    });
  });

  it('deduplicates a redelivered message id', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message());
    expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
  });

  it('reuses the existing agent for a second message in the same chat', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'again' }));
    expect(h.agentStore.created).toHaveLength(1);
    expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(2);
  });

  it('streams chunks into the card and sends the final answer as a fresh message', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', chunkEvent('Hello '));
    await h.bridge.handleEvent('feishu-session-1', chunkEvent('world'));
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    // The final card patch carries the accumulated text.
    const last = h.transport.updatedCards.at(-1);
    expect(last?.elements).toContainEqual({ tag: 'markdown', content: 'Hello world' });
    // The final answer is a fresh message (silent patches cannot notify).
    expect(h.transport.sentTexts).toEqual([{ chatId: 'oc_chat', text: 'Hello world' }]);
  });

  it('renders tool calls and marks them done on result', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/call',
      seq: 1,
      time: 0,
      data: { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{}' },
    } as unknown as SessionEvent);
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/result',
      seq: 2,
      time: 0,
      data: {
        turn: 0,
        step: 0,
        message: { role: 'user', content: [{ type: 'tool', callId: 'call-1' }] },
      },
    } as unknown as SessionEvent);
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    const last = h.transport.updatedCards.at(-1);
    const toolElement = last?.elements.find(
      (el) =>
        el.tag === 'markdown' && typeof el.content === 'string' && el.content.includes('bash'),
    );
    expect(toolElement).toBeDefined();
    expect(toolElement && 'content' in toolElement ? toolElement.content : '').toContain('✅ bash');
  });

  it('marks the turn card error and still delivers the final text', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', chunkEvent('oops'));
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent({ kind: 'error' }) as SessionEvent);
    const last = h.transport.updatedCards.at(-1);
    expect(last?.header?.template).toBe('red');
    expect(h.transport.sentTexts).toEqual([{ chatId: 'oc_chat', text: 'oops' }]);
  });
});
