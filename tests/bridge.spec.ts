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
import type {
  CardAction,
  CardJson,
  ChatStats,
  FeishuMessage,
  FeishuTransport,
  SentCard,
} from '../src/feishu/types.js';
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
  onCardAction(_handler: (action: CardAction) => void): void {}
  /** Configurable transport facts for the mention-gate tests. */
  botOpenId: string | undefined = 'ou_bot';
  stats: ChatStats | undefined = { userCount: 2, botCount: 1 };
  getBotOpenId(): string | undefined {
    return this.botOpenId;
  }
  async chatStats(_chatId: string): Promise<ChatStats | undefined> {
    return this.stats;
  }
  async createGroup(name: string, _memberOpenIds: readonly string[]): Promise<{ chatId: string }> {
    return { chatId: `oc_group_${name}` };
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

/** A fake agent store: create/resume record agents with followup spies. */
class FakeAgentStore {
  readonly created: Array<{ sessionId: string; cwd: string }> = [];
  readonly resumed: string[] = [];
  readonly followups = new Map<string, UserMessage[]>();
  private readonly agents = new Map<string, Agent>();
  /** Remaining times resume throws (simulating a missing persisted log). */
  resumeFailures = 0;
  /** Remaining times create throws (simulating an id collision). */
  createFailures = 0;

  get(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId);
  }

  async resume(sessionId: string): Promise<Agent> {
    if (this.resumeFailures > 0) {
      this.resumeFailures -= 1;
      throw new Error('no persisted log for session');
    }
    const existing = this.agents.get(sessionId);
    if (existing !== undefined) return existing;
    this.resumed.push(sessionId);
    const agent = this.makeAgent(sessionId);
    this.agents.set(sessionId, agent);
    return agent;
  }

  async create(sessionId: string, cwd: string): Promise<Agent> {
    if (this.createFailures > 0) {
      this.createFailures -= 1;
      throw new Error('id collision with persisted log');
    }
    this.created.push({ sessionId, cwd });
    const agent = this.makeAgent(sessionId);
    this.agents.set(sessionId, agent);
    return agent;
  }

  readonly cancels: string[] = [];

  private makeAgent(sessionId: string): Agent {
    const followup = vi.fn((message: UserMessage) => {
      const list = this.followups.get(sessionId) ?? [];
      list.push(message);
      this.followups.set(sessionId, list);
    });
    const cancel = vi.fn(() => {
      this.cancels.push(sessionId);
    });
    return { followup, cancel } as unknown as Agent;
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

function makeHarness(
  options: {
    throttleMs?: number;
    mint?: () => string;
    groupMentionMode?: 'always' | 'never' | 'ambient' | 'topic';
    allowedChats?: readonly string[];
    executeCommand?: (agent: Agent, line: string) => Promise<string | undefined>;
    unknownCommand?: 'error' | 'passthrough';
    repoRoots?: readonly string[];
  } = {},
): Harness {
  const transport = new RecordingTransport();
  const agentStore = new FakeAgentStore();
  const sessionMap = new SessionMap(
    join(SCRATCH, 'map.json'),
    options.mint ?? (() => 'feishu-session-1'),
  );
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
    ...(options.groupMentionMode !== undefined
      ? { groupMentionMode: options.groupMentionMode }
      : {}),
    ...(options.allowedChats !== undefined ? { allowedChats: options.allowedChats } : {}),
    ...(options.executeCommand !== undefined ? { executeCommand: options.executeCommand } : {}),
    ...(options.unknownCommand !== undefined ? { unknownCommand: options.unknownCommand } : {}),
    ...(options.repoRoots !== undefined ? { repoRoots: options.repoRoots } : {}),
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
    mentions: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** A group message with the given mention open ids. */
function groupMessage(mentions: string[], overrides: Partial<FeishuMessage> = {}): FeishuMessage {
  return message({ chatType: 'group', mentions, ...overrides });
}

function chunkEvent(text: string): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq: 1,
    time: 0,
    data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text } },
  } as unknown as SessionEvent;
}

function turnEndEvent(
  reason: { kind: string; error?: { code: string; message: string } } = { kind: 'completed' },
): SessionEvent {
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
    // No persisted log for a brand-new chat: force the create path.
    h.agentStore.resumeFailures = 1;
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
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
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
    expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(2);
  });

  it('resumes the mapped session when no live agent exists', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    expect(h.agentStore.resumed).toContain('feishu-session-1');
    expect(h.agentStore.created).toHaveLength(0);
  });

  it('falls back to create when resume finds no persisted log', async () => {
    const h = makeHarness();
    h.agentStore.resumeFailures = 1;
    await h.bridge.handleMessage(message());
    expect(h.agentStore.resumed).toHaveLength(0);
    expect(h.agentStore.created).toEqual([{ sessionId: 'feishu-session-1', cwd: '/work' }]);
  });

  it('rebinds a fresh session when the mapped id collides', async () => {
    let seq = 0;
    const h = makeHarness({ mint: () => `feishu-session-${++seq}` });
    h.agentStore.resumeFailures = 1;
    h.agentStore.createFailures = 1;
    await h.bridge.handleMessage(message());
    expect(h.agentStore.created).toEqual([{ sessionId: 'feishu-session-2', cwd: '/work' }]);
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-2');
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
    // A completed turn sends no second bubble: the card holds the full
    // answer and finalizes green in place (the initial card send notified).
    expect(h.transport.sentTexts).toEqual([]);
  });

  it('renders tool calls as rows and marks them done on result', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/call',
      seq: 1,
      time: 0,
      data: { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    } as unknown as SessionEvent);
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/result',
      seq: 2,
      time: 0,
      data: {
        turn: 0,
        step: 0,
        message: {
          role: 'user',
          content: [
            { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      },
    } as unknown as SessionEvent);
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    const last = h.transport.updatedCards.at(-1);
    const row = last?.elements.find((el) => el.tag === 'column_set');
    const text = row?.tag === 'column_set' ? row.columns[0]?.elements[0] : undefined;
    expect(text?.tag === 'div' ? text.text.content : '').toContain('✅ Bash · ls');
    // The done card keeps the plain action row — no separate Tools button.
    const doneAction = last?.elements.find((el) => el.tag === 'action');
    const doneLabels =
      doneAction && 'actions' in doneAction
        ? doneAction.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : [];
    expect(doneLabels).toEqual(['📋 Copy', '🔁 Retry', '⚙️ Panel', '▾ Collapse']);
  });

  it('streams reasoning deltas into a think row (settled on turn end)', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'assistant/chunk',
      seq: 1,
      time: 0,
      data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm…' } },
    } as unknown as SessionEvent);
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    const last = h.transport.updatedCards.at(-1);
    const row = last?.elements.find((el) => el.tag === 'column_set');
    const text = row?.tag === 'column_set' ? row.columns[0]?.elements[0] : undefined;
    expect(text?.tag === 'div' ? text.text.content : '').toContain('Think');
  });

  it('opens a row-details card from a row expand button', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/call',
      seq: 1,
      time: 0,
      data: { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    } as unknown as SessionEvent);
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/result',
      seq: 2,
      time: 0,
      data: {
        turn: 0,
        step: 0,
        message: {
          role: 'user',
          content: [
            { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      },
    } as unknown as SessionEvent);
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'row-details', id: 'call-1' },
    });
    const details = h.transport.sentCards.find((c) => c.header?.title.content.startsWith('🔧'));
    expect(details).toBeDefined();
    expect(
      details?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('Bash'),
      ),
    ).toBe(true);
  });

  it('toggle-rows collapses a finished card to the minimal sequence', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/call',
      seq: 1,
      time: 0,
      data: { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    } as unknown as SessionEvent);
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    const before = h.transport.updatedCards.length;
    // The finished card is re-rendered in place with the collapsed sequence.
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'toggle-rows' },
    });
    const collapsed = h.transport.updatedCards.at(-1);
    expect(h.transport.updatedCards.length).toBe(before + 1);
    expect(
      collapsed?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content === 'bash',
      ),
    ).toBe(true);
    expect(collapsed?.elements.some((el) => el.tag === 'column_set')).toBe(false);
    // Toggling again expands back to the row view.
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'toggle-rows' },
    });
    const expanded = h.transport.updatedCards.at(-1);
    expect(expanded?.elements.some((el) => el.tag === 'column_set')).toBe(true);
  });

  it('marks the turn card error and still delivers the final text', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', chunkEvent('oops'));
    await h.bridge.handleEvent(
      'feishu-session-1',
      turnEndEvent({ kind: 'error', error: { code: 'MOCK', message: 'boom' } }) as SessionEvent,
    );
    const last = h.transport.updatedCards.at(-1);
    expect(last?.header?.template).toBe('red');
    expect(h.transport.sentTexts).toEqual([
      { chatId: 'oc_chat', text: '⚠️ Turn failed — see the card for details' },
    ]);
  });

  it('rebinds a fresh session when a turn fails with a corrupt session log', async () => {
    let seq = 0;
    const h = makeHarness({ mint: () => `feishu-session-${++seq}` });
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent(
      'feishu-session-1',
      turnEndEvent({
        kind: 'error',
        error: { code: 'UNKNOWN', message: 'corrupt session log: seq gap in committed region' },
      }) as SessionEvent,
    );
    // The chat is rebound to a fresh session id so the next message starts clean.
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-2');
  });
  it('stop action cancels the live agent', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'stop' },
    });
    expect(h.agentStore.cancels).toEqual(['feishu-session-1']);
  });

  it('copy action resends the last output as text', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', chunkEvent('the answer'));
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    h.transport.sentTexts = [];
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'copy' },
    });
    expect(h.transport.sentTexts).toEqual([{ chatId: 'oc_chat', text: 'the answer' }]);
  });

  it('retry action re-delivers the last prompt', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'retry' },
    });
    const followups = h.agentStore.followups.get('feishu-session-1');
    expect(followups).toHaveLength(2);
    expect(followups?.[1]?.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('panel action posts a control card', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    expect(h.transport.sentCards).toHaveLength(2);
    const panel = h.transport.sentCards.at(-1);
    expect(panel?.header?.title.content).toBe('⚙️ dsh-feishu panel');
  });
  describe('group mention gate', () => {
    it('always: responds when the bot is mentioned', async () => {
      const h = makeHarness({ groupMentionMode: 'always' });
      await h.bridge.handleMessage(groupMessage(['ou_bot']));
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
    });

    it('always: skips un-@ messages in a multi-member group', async () => {
      const h = makeHarness({ groupMentionMode: 'always' });
      await h.bridge.handleMessage(groupMessage([]));
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
    });

    it('always: relaxes the @ requirement in a 1-person-1-bot solo group', async () => {
      const h = makeHarness({ groupMentionMode: 'always' });
      h.transport.stats = { userCount: 1, botCount: 1 };
      await h.bridge.handleMessage(groupMessage([]));
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
    });

    it('never: answers un-@ messages', async () => {
      const h = makeHarness({ groupMentionMode: 'never' });
      await h.bridge.handleMessage(groupMessage([]));
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
    });

    it('ambient: answers un-@ messages', async () => {
      const h = makeHarness({ groupMentionMode: 'ambient' });
      await h.bridge.handleMessage(groupMessage([]));
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
    });

    it('ambient: stays quiet when the message redirects to another member', async () => {
      const h = makeHarness({ groupMentionMode: 'ambient' });
      await h.bridge.handleMessage(groupMessage(['ou_other']));
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
    });

    it('ambient: answers when the bot and another member are both mentioned', async () => {
      const h = makeHarness({ groupMentionMode: 'ambient' });
      await h.bridge.handleMessage(groupMessage(['ou_bot', 'ou_other']));
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
    });

    it('respects the chat allowlist', async () => {
      const h = makeHarness({ allowedChats: ['oc_allowed'] });
      await h.bridge.handleMessage(message({ chatId: 'oc_other' }));
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
    });
  });
  describe('slash commands', () => {
    it('/help replies with the command list', async () => {
      const h = makeHarness();
      await h.bridge.handleMessage(message({ text: '/help' }));
      const texts = h.transport.sentTexts;
      const help = texts.find((t) => t.text.includes('dsh-feishu commands'));
      expect(help).toBeDefined();
      expect(help?.text).toContain('/group');
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
    });

    it('/group creates a group with the sender', async () => {
      const h = makeHarness();
      await h.bridge.handleMessage(message({ text: '/group my team' }));
      const texts = h.transport.sentTexts;
      expect(texts.some((t) => t.text.includes('oc_group_my team'))).toBe(true);
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
    });

    it('/cancel stops the live agent', async () => {
      const h = makeHarness();
      await h.bridge.handleMessage(message());
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/cancel' }));
      expect(h.agentStore.cancels).toContain('feishu-session-1');
    });

    it('forwards unknown commands to the dsh registry', async () => {
      const h = makeHarness({
        executeCommand: async (_agent, line) => (line === '/compact' ? 'Compacted.' : undefined),
      });
      // A live session must exist for the dsh registry to execute against.
      await h.bridge.handleMessage(message());
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/compact' }));
      expect(h.transport.sentTexts.some((t) => t.text === 'Compacted.')).toBe(true);
    });

    it('replies unknown-command when the dsh registry has no match', async () => {
      const h = makeHarness({ executeCommand: async () => undefined });
      await h.bridge.handleMessage(message({ text: '/nope' }));
      expect(h.transport.sentTexts.some((t) => t.text.includes('Unknown command /nope'))).toBe(
        true,
      );
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
    });

    it('passes unknown commands to the model when configured', async () => {
      const h = makeHarness({
        unknownCommand: 'passthrough',
        executeCommand: async () => undefined,
      });
      await h.bridge.handleMessage(message({ text: '/something' }));
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
    });
  });
});

describe('working directory commands', () => {
  it('/cd sets the chat working directory and rebinds the session', async () => {
    let seq = 0;
    const h = makeHarness({ mint: () => `feishu-session-${++seq}` });
    const { mkdirSync } = await import('node:fs');
    const target = join(SCRATCH, 'proj-cd');
    mkdirSync(target, { recursive: true });
    // A session exists first; /cd rebinds it to a fresh id in the new dir.
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: `/cd ${target}` }));
    expect(h.sessionMap.cwdFor('oc_chat')).toBe(target);
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-2');
  });

  it('/cd rejects a missing directory', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message({ text: '/cd /no/such/dir' }));
    expect(h.sessionMap.cwdFor('oc_chat')).toBeUndefined();
    expect(h.transport.sentTexts.some((t) => t.text.includes('does not exist'))).toBe(true);
  });

  it('/repo posts a dropdown picker card and selects via callback option', async () => {
    const h = makeHarness({ repoRoots: [join(SCRATCH, 'projects')] });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const root = join(SCRATCH, 'projects');
    // A valid git marker needs `.git/HEAD` (bare `.git/` dirs are skipped).
    for (const name of ['proj-a', 'proj-b']) {
      mkdirSync(join(root, name, '.git'), { recursive: true });
      writeFileSync(join(root, name, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    }
    await h.bridge.handleMessage(message({ text: '/repo' }));
    const picker = h.transport.sentCards.find((c) =>
      c.header?.title.content.includes('Pick a project'),
    );
    expect(picker).toBeDefined();
    const action = picker?.elements.find((el) => el.tag === 'action');
    expect(action && 'actions' in action ? action.actions[0]?.tag : undefined).toBe(
      'select_static',
    );
    // Dropdown selection arrives in `action.option` (botmux repo_switch pattern).
    // The picker was the first card sent by the recording transport (msg-1).
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'repo-pick' },
      option: join(root, 'proj-b'),
    });
    expect(h.sessionMap.cwdFor('oc_chat')).toBe(join(root, 'proj-b'));
    // The picker card is disabled: patched to a static confirmation with no
    // actions, so further taps do nothing (feedback: repeated picks felt off).
    const disabled = h.transport.updatedCards.at(-1);
    expect(disabled?.elements.some((el) => el.tag === 'action')).toBe(false);
    expect(
      disabled?.elements.some(
        (el) =>
          el.tag === 'markdown' && 'content' in el && el.content.includes(join(root, 'proj-b')),
      ),
    ).toBe(true);
  });

  it('rejects a stale repo pick from a superseded picker card', async () => {
    const h = makeHarness({ repoRoots: [join(SCRATCH, 'projects')] });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const root = join(SCRATCH, 'projects');
    mkdirSync(join(root, 'proj-a', '.git'), { recursive: true });
    writeFileSync(join(root, 'proj-a', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await h.bridge.handleMessage(message({ text: '/repo' }));
    // A stale callback (messageId not matching the active picker card) must
    // not change the working directory.
    await h.bridge.handleCardAction({
      messageId: 'msg-999',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'repo-pick' },
      option: join(root, 'proj-a'),
    });
    expect(h.sessionMap.cwdFor('oc_chat')).toBeUndefined();
  });

  it('/repo discovers nested git checkouts recursively (botmux depth-3 scan)', async () => {
    const h = makeHarness({ repoRoots: [join(SCRATCH, 'nested-root')] });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const root = join(SCRATCH, 'nested-root');
    // Depth 1 repo, a depth-2 repo under a non-project dir, and a dot-dir
    // repo that must be skipped.
    for (const rel of ['top', 'mid/inner', '.hidden']) {
      mkdirSync(join(root, rel, '.git'), { recursive: true });
      writeFileSync(join(root, rel, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    }
    await h.bridge.handleMessage(message({ text: '/repo' }));
    const picker = h.transport.sentCards.find((c) =>
      c.header?.title.content.includes('Pick a project'),
    );
    const action = picker?.elements.find((el) => el.tag === 'action');
    const select = action && 'actions' in action ? action.actions[0] : undefined;
    if (select?.tag === 'select_static') {
      const paths = select.options.map((o) => o.value).sort();
      expect(paths).toEqual([join(root, 'mid/inner'), join(root, 'top')]);
    } else {
      expect.fail('expected a dropdown picker card');
    }
  });
});
