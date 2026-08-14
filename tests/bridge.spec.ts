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
import {
  Bridge,
  type PermissionPresetService,
  type PlanModeService,
  type SessionListRow,
  turnTitle,
} from '../src/bridge.js';
import { StreamingCardManager } from '../src/cards/streaming.js';
import type { CommandResult } from '../src/commands.js';
import type {
  ButtonAction,
  CardAction,
  CardElement,
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
  /** Live agent status (default running; tests flip to idle as needed). */
  private readonly statuses = new Map<string, 'idle' | 'running'>();

  /** Set the lifecycle status of a created agent (defaults to running). */
  setStatus(sessionId: string, status: 'idle' | 'running'): void {
    this.statuses.set(sessionId, status);
  }

  private makeAgent(sessionId: string): Agent {
    const statuses = this.statuses;
    statuses.set(sessionId, 'running');
    const followup = vi.fn((message: UserMessage) => {
      const list = this.followups.get(sessionId) ?? [];
      list.push(message);
      this.followups.set(sessionId, list);
    });
    const cancel = vi.fn(() => {
      this.cancels.push(sessionId);
    });
    return {
      followup,
      cancel,
      session: { events: [] },
      get status() {
        return statuses.get(sessionId) ?? 'running';
      },
    } as unknown as Agent;
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
    executeCommand?: (agent: Agent, line: string) => Promise<CommandResult | undefined>;
    unknownCommand?: 'error' | 'passthrough';
    repoRoots?: readonly string[];
    listSessions?: () => Promise<readonly SessionListRow[] | undefined>;
    permissionPresets?: PermissionPresetService;
    planMode?: PlanModeService;
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
    ...(options.listSessions !== undefined ? { listSessions: options.listSessions } : {}),
    ...(options.permissionPresets !== undefined
      ? { permissionPresets: options.permissionPresets }
      : {}),
    ...(options.planMode !== undefined ? { planMode: options.planMode } : {}),
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
    // Cards default collapsed: the sequence line shows, and the toggle reads
    // '▸ Expand'. Expanding reveals the ✅ row.
    const collapsed = h.transport.updatedCards.at(-1);
    expect(
      collapsed?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content === 'bash',
      ),
    ).toBe(true);
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'toggle-rows' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const expanded = h.transport.updatedCards.at(-1);
    const row = expanded?.elements.find((el) => el.tag === 'column_set');
    const text = row?.tag === 'column_set' ? row.columns[0]?.elements[0] : undefined;
    expect(text?.tag === 'div' ? text.text.content : '').toContain('✅ Bash · ls');
    // Row 1 = state actions, row 2 = the view toggle (no separate Tools
    // button).
    const doneActions = expanded?.elements.filter((el) => el.tag === 'action') ?? [];
    const doneLabels = (index: number): string[] =>
      doneActions[index] && 'actions' in doneActions[index]
        ? doneActions[index].actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : [];
    expect(doneLabels(0)).toEqual(['📋 Copy', '🔁 Retry', '⚙️ Panel']);
    expect(doneLabels(1)).toEqual(['▾ Collapse']);
  });

  it('streams the collapsed sequence as rows arrive', async () => {
    const h = makeHarness({ throttleMs: 0 });
    await h.bridge.handleMessage(message());
    // First tool call → collapsed line reads 'bash'.
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/call',
      seq: 1,
      time: 0,
      data: { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    } as unknown as SessionEvent);
    // Patch flushes on a macrotask (throttle 0) — give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = h.transport.updatedCards.at(-1);
    expect(
      first?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content === 'bash',
      ),
    ).toBe(true);
    // Second call appends to the sequence line — still collapsed.
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/call',
      seq: 2,
      time: 0,
      data: { turn: 0, step: 0, callId: 'call-2', name: 'read', arguments: '{"path":"a.ts"}' },
    } as unknown as SessionEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = h.transport.updatedCards.at(-1);
    expect(
      second?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content === 'bash -> read',
      ),
    ).toBe(true);
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
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
    // Collapsed by default: the sequence line carries 'think'.
    const last = h.transport.updatedCards.at(-1);
    expect(
      last?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content === 'think',
      ),
    ).toBe(true);
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

  it('toggle-rows expands a collapsed finished card and collapses it back', async () => {
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
    // Cards start collapsed; the finished card re-renders expanded in place.
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'toggle-rows' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const expanded = h.transport.updatedCards.at(-1);
    expect(h.transport.updatedCards.length).toBe(before + 1);
    expect(expanded?.elements.some((el) => el.tag === 'column_set')).toBe(true);
    // Toggling again collapses back to the minimal sequence.
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'toggle-rows' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const collapsed = h.transport.updatedCards.at(-1);
    expect(
      collapsed?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content === 'bash',
      ),
    ).toBe(true);
    expect(collapsed?.elements.some((el) => el.tag === 'column_set')).toBe(false);
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
  it('stop action cancels the live agent and marks the card Stopping', async () => {
    const h = makeHarness({ throttleMs: 0 });
    await h.bridge.handleMessage(message());
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'stop' },
    });
    expect(h.agentStore.cancels).toEqual(['feishu-session-1']);
    // The card shows the in-progress Stopping state — no standalone text
    // bubble (user report: the '⏹ Stopping…' message was unnecessary).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transport.sentTexts.some((t) => t.text.includes('Stopping'))).toBe(false);
    expect(
      h.transport.updatedCards
        .at(-1)
        ?.elements.some(
          (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('Stopping'),
        ),
    ).toBe(true);
  });

  it('stop on a stale card (no live agent) explains instead of silently ignoring', async () => {
    const h = makeHarness();
    // No message was delivered → the session map has no entry, so there is
    // no live agent to cancel (the restart/stale-card case).
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'stop' },
    });
    expect(h.agentStore.cancels).toEqual([]);
    expect(h.transport.sentTexts.some((t) => t.text.includes('No active session'))).toBe(true);
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
  describe('card action interaction matrix (stop/copy/retry/panel)', () => {
    it('stop on a finished (idle) turn explains instead of hanging', async () => {
      const h = makeHarness();
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
      // The agent is idle after the turn (the user-reported hang: "Stopping…
      // then nothing").
      h.agentStore.setStatus('feishu-session-1', 'idle');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'stop' },
      });
      expect(h.agentStore.cancels).toEqual([]);
      expect(h.transport.sentTexts.some((t) => t.text.includes('No active turn'))).toBe(true);
      expect(h.transport.sentTexts.some((t) => t.text.includes('Stopping'))).toBe(false);
    });

    it('copy with no completed answer explains instead of silently ignoring', async () => {
      const h = makeHarness();
      // No turn was ever completed → nothing to copy.
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'copy' },
      });
      expect(h.transport.sentTexts).toEqual([
        { chatId: 'oc_chat', text: 'Nothing to copy — no completed answer yet.' },
      ]);
    });

    it('retry with no prior prompt explains instead of silently ignoring', async () => {
      const h = makeHarness();
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'retry' },
      });
      expect(h.transport.sentTexts).toEqual([
        { chatId: 'oc_chat', text: 'Nothing to retry — send a message first.' },
      ]);
    });

    it('panel while running shows the Stop button; idle hides it', async () => {
      const h = makeHarness();
      await h.bridge.handleMessage(message());
      // Running: the panel carries ⏹ Stop current.
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'panel' },
      });
      const runningPanel = h.transport.sentCards.at(-1);
      // The FIRST action element is the core button row (Stop/Retry/Copy);
      // the palette (command buttons + page nav) follows it.
      const runningAction = runningPanel?.elements.find((el) => el.tag === 'action');
      const runningLabels =
        runningAction && 'actions' in runningAction
          ? runningAction.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [];
      expect(runningLabels).toEqual(['⏹ Stop current', '🔁 Retry last', '📋 Copy last']);
      // Turn ends → agent idle → panel has no Stop button.
      await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
      h.agentStore.setStatus('feishu-session-1', 'idle');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'panel' },
      });
      const idlePanel = h.transport.sentCards.at(-1);
      const idleAction = idlePanel?.elements.find((el) => el.tag === 'action');
      const idleLabels =
        idleAction && 'actions' in idleAction
          ? idleAction.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [];
      expect(idleLabels).toEqual(['🔁 Retry last', '📋 Copy last']);
    });

    it('stop mid-turn then aborted turn/end → card shows Stopped, not Done', async () => {
      // User report: after Stop, the card finalized green ('Done') — an
      // aborted turn must read 'Stopped' (DSH web: message.stopped).
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('partial output'));
      h.agentStore.setStatus('feishu-session-1', 'running');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'stop' },
      });
      // The card shows the in-progress Stopping state (no text bubble).
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.transport.sentTexts.some((t) => t.text.includes('Stopping'))).toBe(false);
      expect(
        h.transport.updatedCards
          .at(-1)
          ?.elements.some(
            (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('Stopping'),
          ),
      ).toBe(true);
      // The agent aborts → turn/end with kind 'aborted'.
      await h.bridge.handleEvent(
        'feishu-session-1',
        turnEndEvent({ kind: 'aborted' }) as SessionEvent,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const card = h.transport.updatedCards.at(-1);
      // Orange header (not green), status line reads Stopped.
      expect(card?.header?.template).toBe('orange');
      expect(
        card?.elements.some(
          (el) =>
            el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('Stopped'),
        ),
      ).toBe(true);
      expect(
        card?.elements.some(
          (el) => el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('Done'),
        ),
      ).toBe(false);
      // Stopped is terminal: Retry/Panel buttons, no Stop.
      const action = card?.elements.find((el) => el.tag === 'action');
      const labels =
        action && 'actions' in action
          ? action.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [];
      expect(labels).toContain('🔁 Retry');
      expect(labels).not.toContain('⏹ Stop');
      // After the abort the agent goes idle; the panel reflects stopped.
      h.agentStore.setStatus('feishu-session-1', 'idle');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'panel' },
      });
      const panel = h.transport.sentCards.at(-1);
      const panelMarkdown = panel?.elements.find(
        (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
      );
      expect(panelMarkdown?.content).toContain('Stopped');
    });
    it('panel after done does not reset the streaming card to working', async () => {
      // The user-reported regression: done → panel → the streaming card
      // reverted to the non-done state. The state machine's single syncCard
      // path must keep re-rendering from the authoritative done state.
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('answer'));
      await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
      await new Promise((resolve) => setTimeout(resolve, 0));
      const doneCard = h.transport.updatedCards.at(-1);
      expect(doneCard?.header?.template).toBe('green');
      // Open the panel; the streaming card is re-synced from the done state.
      const before = h.transport.updatedCards.length;
      await h.bridge.handleCardAction({
        messageId: 'msg-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'panel' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const after = h.transport.updatedCards.at(-1);
      expect(h.transport.updatedCards.length).toBe(before + 1); // the re-sync
      expect(after?.header?.template).toBe('green');
      // The terminal status note is still Done, not working.
      const statusNote = after?.elements.find(
        (el): el is Extract<CardElement, { tag: 'note' }> =>
          el.tag === 'note' && el.elements[0]?.content.includes('Done') === true,
      );
      expect(statusNote).toBeDefined();
      const action = after?.elements.find((el) => el.tag === 'action');
      const labels =
        action && 'actions' in action
          ? action.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [];
      expect(labels).not.toContain('⏹ Stop');
    });
    it('unknown card action kind is logged and ignored without crashing', async () => {
      const h = makeHarness();
      await h.bridge.handleMessage(message());
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'no-such-action' },
      });
      // No crash, no messages sent, agent untouched.
      expect(h.agentStore.cancels).toEqual([]);
      expect(h.transport.sentTexts).toEqual([]);
      expect(h.transport.sentCards).toHaveLength(1); // the streaming card only
    });

    it('panel with no session explains that the bot may have restarted', async () => {
      const h = makeHarness();
      // No message delivered → no session mapping.
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'panel' },
      });
      const panel = h.transport.sentCards.at(-1);
      const markdowns = panel?.elements.filter(
        (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
      );
      expect(markdowns?.[0]?.content).toContain('Idle');
      // Idle → no Stop button.
      const action = panel?.elements.find((el) => el.tag === 'action');
      const labels =
        action && 'actions' in action
          ? action.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [];
      expect(labels).toEqual(['🔁 Retry last', '📋 Copy last']);
    });
    it('a second message during a running turn opens a fresh card (lifecycle)', async () => {
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('partial'));
      // Second message → new turn card; the old one is finalized as done.
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'second' }));
      const cards = h.transport.sentCards;
      expect(cards).toHaveLength(2);
      expect(cards[1]?.header?.title.content).toBe('second');
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(2);
    });

    it('stop mid-turn then a new message recovers cleanly', async () => {
      const h = makeHarness();
      await h.bridge.handleMessage(message());
      h.agentStore.setStatus('feishu-session-1', 'running');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'stop' },
      });
      expect(h.agentStore.cancels).toEqual(['feishu-session-1']);
      // A fresh message still delivers (the chat remains usable after stop).
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'again' }));
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(2);
    });
    it('stop while running still cancels and marks the card Stopping', async () => {
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      h.agentStore.setStatus('feishu-session-1', 'running');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'stop' },
      });
      expect(h.agentStore.cancels).toEqual(['feishu-session-1']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.transport.sentTexts.some((t) => t.text.includes('Stopping'))).toBe(false);
      expect(
        h.transport.updatedCards
          .at(-1)
          ?.elements.some(
            (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('Stopping'),
          ),
      ).toBe(true);
    });
  });
  describe('full card state machine matrix (state × action)', () => {
    // Every (state, action) cell: fire the action and assert the card
    // outcome AND that the state machine did not corrupt (the single
    // syncCard path renders from the authoritative state).

    it('none × stop → restart hint', async () => {
      const h = makeHarness();
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'stop' },
      });
      expect(h.transport.sentTexts.some((t) => t.text.includes('No active session'))).toBe(true);
    });

    it('none × copy → nothing to copy', async () => {
      const h = makeHarness();
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'copy' },
      });
      expect(h.transport.sentTexts.some((t) => t.text.includes('Nothing to copy'))).toBe(true);
    });

    it('none × retry → nothing to retry', async () => {
      const h = makeHarness();
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'retry' },
      });
      expect(h.transport.sentTexts.some((t) => t.text.includes('Nothing to retry'))).toBe(true);
    });

    it('none × panel → idle panel, no stop, no streaming-card crash', async () => {
      const h = makeHarness();
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'panel' },
      });
      const panel = h.transport.sentCards.at(-1);
      const action = panel?.elements.find((el) => el.tag === 'action');
      const labels =
        action && 'actions' in action
          ? action.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [];
      expect(labels).toEqual(['🔁 Retry last', '📋 Copy last']);
    });

    it('none × toggle → no-op (no card state)', async () => {
      const h = makeHarness();
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'toggle-rows' },
      });
      expect(h.transport.updatedCards).toHaveLength(0);
    });

    it('none × row-details → ignored, no crash', async () => {
      const h = makeHarness();
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'row-details', id: 'nope' },
      });
      expect(h.transport.sentCards).toHaveLength(0);
    });

    it('working × toggle flips collapse and streams; × row-details opens the row card', async () => {
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent('feishu-session-1', {
        type: 'tool/call',
        seq: 1,
        time: 0,
        data: { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      } as unknown as SessionEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Collapsed by default → sequence line; toggle expands while working.
      expect(
        h.transport.updatedCards
          .at(-1)
          ?.elements.some(
            (el) => el.tag === 'markdown' && 'content' in el && el.content === 'bash',
          ),
      ).toBe(true);
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'toggle-rows' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.transport.updatedCards.at(-1)?.elements.some((el) => el.tag === 'column_set')).toBe(
        true,
      );
      // row-details while working opens the details card.
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'row-details', id: 'call-1' },
      });
      const details = h.transport.sentCards.find((c) => c.header?.title.content.startsWith('🔧'));
      expect(details).toBeDefined();
    });

    it('working × copy → nothing to copy (turn not finished); × retry → new turn', async () => {
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('partial'));
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'copy' },
      });
      expect(h.transport.sentTexts.some((t) => t.text.includes('Nothing to copy'))).toBe(true);
      // Retry while a turn is live: a fresh working turn (followup #2).
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'retry' },
      });
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(2);
      expect(h.transport.sentCards).toHaveLength(2); // fresh card
    });

    it('done × stop → idle explanation; × copy → last output; × retry → new turn', async () => {
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('the answer'));
      await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.agentStore.setStatus('feishu-session-1', 'idle');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'stop' },
      });
      expect(h.transport.sentTexts.some((t) => t.text.includes('No active turn'))).toBe(true);
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'copy' },
      });
      expect(h.transport.sentTexts.at(-1)?.text).toBe('the answer');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'retry' },
      });
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(2);
    });

    it('error × stop/copy/retry/panel/toggle/row-details — all safe, card stays error', async () => {
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('oops'));
      await h.bridge.handleEvent(
        'feishu-session-1',
        turnEndEvent({ kind: 'error', error: { code: 'MOCK', message: 'boom' } }) as SessionEvent,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.transport.updatedCards.at(-1)?.header?.template).toBe('red');
      // stop: agent idle → explanation (not a hang).
      h.agentStore.setStatus('feishu-session-1', 'idle');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'stop' },
      });
      expect(h.transport.sentTexts.some((t) => t.text.includes('No active turn'))).toBe(true);
      // copy: the error turn's partial text is the last output.
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'copy' },
      });
      expect(h.transport.sentTexts.at(-1)?.text).toBe('oops');
      // panel → idle (no stop) while the card is still in error state.
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'panel' },
      });
      const panelAction = h.transport.sentCards.at(-1)?.elements.find((el) => el.tag === 'action');
      const panelLabels =
        panelAction && 'actions' in panelAction
          ? panelAction.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [];
      expect(panelLabels).toEqual(['🔁 Retry last', '📋 Copy last']);
      // toggle → expand; the re-synced card stays red (error state intact).
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'toggle-rows' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.transport.updatedCards.at(-1)?.header?.template).toBe('red');
      // row-details with a nonexistent id → ignored, no crash.
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'row-details', id: 'missing' },
      });
      // retry → fresh working turn (transitions error → working).
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'retry' },
      });
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(2);
      expect(h.transport.sentCards.at(-1)?.header?.template).toBe('wathet');
    });

    it('done → new message → working (fresh card) → second done: cross-turn integrity', async () => {
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('first answer'));
      await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Second message: new turn/card, collapsed again, new content.
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'second question' }));
      const second = h.transport.sentCards.at(-1);
      expect(second?.header?.title.content).toBe('second question');
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('second answer'));
      await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.transport.updatedCards.at(-1)?.header?.template).toBe('green');
      // Copy returns the SECOND answer, not the first.
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'copy' },
      });
      expect(h.transport.sentTexts.at(-1)?.text).toBe('second answer');
    });

    it('error → retry → working → done: full recovery cycle', async () => {
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('partial'));
      await h.bridge.handleEvent(
        'feishu-session-1',
        turnEndEvent({ kind: 'error', error: { code: 'MOCK', message: 'boom' } }) as SessionEvent,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.transport.updatedCards.at(-1)?.header?.template).toBe('red');
      // Retry → working → done.
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'retry' },
      });
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('recovered'));
      await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.transport.updatedCards.at(-1)?.header?.template).toBe('green');
      expect(h.transport.updatedCards.at(-1)?.elements).toContainEqual({
        tag: 'markdown',
        content: 'recovered',
      });
    });
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
      // /compact is now a surface wrapper; use a command only the dsh
      // registry knows so the passthrough path is exercised.
      const h = makeHarness({
        executeCommand: async (_agent, line) =>
          line === '/dsh-check' ? { kind: 'success', text: 'Checked.' } : undefined,
      });
      // A live session must exist for the dsh registry to execute against.
      await h.bridge.handleMessage(message());
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/dsh-check' }));
      expect(h.transport.sentTexts.some((t) => t.text === 'Checked.')).toBe(true);
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
    // A session exists first and the turn is finished (a running turn
    // refuses mutating commands — the matrix rule); /cd then rebinds it to
    // a fresh id in the new dir.
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
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

describe('UX state machine (bug 2 regression)', () => {
  it('opening row details in expanded state must not collapse the streaming card', async () => {
    const h = makeHarness({ throttleMs: 0 });
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/call',
      seq: 1,
      time: 0,
      data: { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    } as unknown as SessionEvent);
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Expand the finished card.
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'toggle-rows' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const expanded = h.transport.updatedCards.at(-1);
    expect(expanded?.elements.some((el) => el.tag === 'column_set')).toBe(true);
    // Open details of the tool row — the streaming card is re-asserted
    // (deferred) so the callback-completion restore cannot collapse it.
    const beforeDetails = h.transport.updatedCards.length;
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'row-details', id: 'call-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const detailSent = h.transport.sentCards.find((c) => c.header?.title.content.startsWith('🔧'));
    expect(detailSent).toBeDefined();
    const afterDetails = h.transport.updatedCards.at(-1);
    expect(h.transport.updatedCards.length).toBe(beforeDetails + 1);
    // The reasserted streaming card is still the EXPANDED one.
    expect(afterDetails?.elements.some((el) => el.tag === 'column_set')).toBe(true);
    expect(
      afterDetails?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content === 'bash',
      ),
    ).toBe(false);
  });

  it('toggle-rows round-trips collapsed -> expanded -> collapsed without re-rendering on row-details', async () => {
    const h = makeHarness({ throttleMs: 0 });
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'tool/call',
      seq: 1,
      time: 0,
      data: { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    } as unknown as SessionEvent);
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Collapsed by default.
    expect(
      h.transport.updatedCards
        .at(-1)
        ?.elements.some((el) => el.tag === 'markdown' && 'content' in el && el.content === 'bash'),
    ).toBe(true);
    // Expand.
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'toggle-rows' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transport.updatedCards.at(-1)?.elements.some((el) => el.tag === 'column_set')).toBe(
      true,
    );
    // Details click re-asserts the streaming card (expanded stays expanded).
    const beforeDetails = h.transport.updatedCards.length;
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'row-details', id: 'call-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transport.updatedCards.length).toBe(beforeDetails + 1);
    expect(h.transport.updatedCards.at(-1)?.elements.some((el) => el.tag === 'column_set')).toBe(
      true,
    );
    // Collapse again.
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'toggle-rows' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      h.transport.updatedCards
        .at(-1)
        ?.elements.some((el) => el.tag === 'markdown' && 'content' in el && el.content === 'bash'),
    ).toBe(true);
  });
});

/** Session rows for /sessions tests: a persisted older session and the live
 *  current one (the default mint `feishu-session-1` after one message). */
function sessionRows(): SessionListRow[] {
  return [
    {
      sessionId: 'feishu-session-9',
      title: 'Old project',
      cwd: '/work/old',
      createdAt: Date.now() - 3_600_000,
      live: false,
      persisted: true,
    },
    {
      sessionId: 'feishu-session-1',
      title: 'Current chat',
      cwd: '/work',
      createdAt: Date.now() - 60_000,
      live: true,
      persisted: true,
    },
  ];
}

/** End the current turn and idle the agent (the matrix rule refuses mutating
 *  commands while a turn runs). */
async function finishTurn(h: Harness): Promise<void> {
  await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.agentStore.setStatus('feishu-session-1', 'idle');
}

/** The message id the recording transport assigned to the last sent card. */
function lastCardId(h: Harness): string {
  return `msg-${h.transport.sentCards.length}`;
}

describe('session commands (/sessions /resume /clear /new)', () => {
  it('/sessions on an empty corpus shows the empty state card', async () => {
    const h = makeHarness({ listSessions: async () => [] });
    await h.bridge.handleMessage(message({ text: '/sessions' }));
    const card = h.transport.sentCards.at(-1);
    expect(card?.header?.title.content).toBe('🗂️ Sessions');
    expect(
      card?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('No sessions yet'),
      ),
    ).toBe(true);
  });

  it('/sessions lists sessions with resume buttons and marks the current one', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/sessions' }));
    const card = h.transport.sentCards.at(-1);
    // The current session's row carries the ★ current badge (row text is a
    // lark_md div inside the column_set).
    expect(
      card?.elements.some((el) => el.tag === 'column_set') &&
        card?.elements.some((el) =>
          el.tag === 'column_set'
            ? el.columns.some((column) =>
                column.elements.some(
                  (element) => element.tag === 'div' && element.text.content.includes('★ current'),
                ),
              )
            : false,
        ),
    ).toBe(true);
    // Resume buttons exist for non-current rows with the session id payload.
    const resumeValues =
      card?.elements.flatMap((el) =>
        el.tag === 'column_set'
          ? el.columns.flatMap((column) =>
              column.elements
                .filter((element) => element.tag === 'button')
                .map((button) => button.value),
            )
          : [],
      ) ?? [];
    expect(resumeValues).toContainEqual({
      kind: 'resume-session',
      sessionId: 'feishu-session-9',
    });
    // The current row offers no Resume button.
    expect(resumeValues.some((v) => v.sessionId === 'feishu-session-1')).toBe(false);
  });

  it('paginates the sessions card beyond one page', async () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      sessionId: `feishu-session-${index}`,
      title: `Session ${index}`,
      cwd: undefined,
      createdAt: Date.now() - index * 1000,
      live: false,
      persisted: true,
    }));
    const h = makeHarness({ listSessions: async () => many });
    await h.bridge.handleMessage(message({ text: '/sessions' }));
    const card = h.transport.sentCards.at(-1);
    expect(
      card?.elements.some(
        (el) =>
          el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page 1/3'),
      ),
    ).toBe(true);
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'sessions-page', page: '1' },
    });
    expect(
      h.transport.sentCards
        .at(-1)
        ?.elements.some(
          (el) =>
            el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page 2/3'),
        ),
    ).toBe(true);
  });

  it('a resume button resumes a persisted session and rebinds the chat', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message());
    await finishTurn(h);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/sessions' }));
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'resume-session', sessionId: 'feishu-session-9' },
    });
    expect(h.agentStore.resumed).toContain('feishu-session-9');
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-9');
    expect(
      h.transport.sentTexts.some((t) => t.text.includes('Resumed session feishu-session-9')),
    ).toBe(true);
    // The previous binding is detached (1:1 chat↔session model).
    expect(h.sessionMap.chatFor('feishu-session-1')).toBeUndefined();
  });

  it('rejects a stale resume from a superseded sessions card', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message());
    await finishTurn(h);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/sessions' }));
    // A callback from an older card id is ignored.
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'resume-session', sessionId: 'feishu-session-9' },
    });
    expect(h.agentStore.resumed).not.toContain('feishu-session-9');
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-1');
  });

  it('/resume with an id resumes and rebinds', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message({ text: '/resume feishu-session-9' }));
    expect(h.agentStore.resumed).toContain('feishu-session-9');
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-9');
  });

  it('/resume with no id opens the sessions picker', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message({ text: '/resume' }));
    expect(h.transport.sentCards.at(-1)?.header?.title.content).toBe('🗂️ Sessions');
  });

  it('/resume of the current session reports already active', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await finishTurn(h);
    await h.bridge.handleMessage(
      message({ messageId: 'om_msg2', text: '/resume feishu-session-1' }),
    );
    expect(h.transport.sentTexts.some((t) => t.text.includes('already active'))).toBe(true);
  });

  it('/resume of a session running in another chat is refused', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message());
    await finishTurn(h);
    // A live agent for the target session exists and is running.
    await h.agentStore.resume('feishu-session-9');
    h.agentStore.setStatus('feishu-session-9', 'running');
    await h.bridge.handleMessage(
      message({ messageId: 'om_msg2', text: '/resume feishu-session-9' }),
    );
    expect(h.transport.sentTexts.some((t) => t.text.includes('active turn'))).toBe(true);
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-1');
  });

  it('/resume of a session with no persisted log reports the failure', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    h.agentStore.resumeFailures = 1;
    await h.bridge.handleMessage(message({ text: '/resume feishu-session-9' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('could not resume session'))).toBe(
      true,
    );
    // The session map is untouched by a failed resume.
    expect(h.sessionMap.get('oc_chat')).toBeUndefined();
  });

  it('/resume while a turn is running is refused', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(
      message({ messageId: 'om_msg2', text: '/resume feishu-session-9' }),
    );
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(true);
    expect(h.agentStore.resumed).not.toContain('feishu-session-9');
  });

  it('/clear starts a fresh conversation; the old session stays listed', async () => {
    let seq = 0;
    const h = makeHarness({
      mint: () => `feishu-session-${++seq}`,
      listSessions: async () => sessionRows(),
    });
    await h.bridge.handleMessage(message());
    await finishTurn(h);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/clear' }));
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-2');
    expect(h.transport.sentTexts.some((t) => t.text.includes('New conversation started'))).toBe(
      true,
    );
    // The card state was reset: copy no longer finds the old answer.
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'copy' },
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('Nothing to copy'))).toBe(true);
  });

  it('/new is an alias of /clear', async () => {
    let seq = 0;
    const h = makeHarness({ mint: () => `feishu-session-${++seq}` });
    await h.bridge.handleMessage(message());
    await finishTurn(h);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/new' }));
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-2');
  });

  it('/clear with no session explains', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message({ text: '/clear' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('nothing to clear'))).toBe(true);
  });

  it('/clear while a turn is running is refused', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/clear' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(true);
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-1');
  });

  it('degrades to bound sessions when listSessions is absent', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/sessions' }));
    const card = h.transport.sentCards.at(-1);
    expect(card?.header?.title.content).toBe('🗂️ Sessions');
    expect(
      card?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('this chat'),
      ),
    ).toBe(true);
  });
});

describe('panel command palette', () => {
  it('includes every registered command as a button', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const panel = h.transport.sentCards.at(-1);
    const labels =
      panel?.elements.flatMap((el) =>
        el.tag === 'action'
          ? el.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [],
      ) ?? [];
    // Page 1 holds the session group (7) plus chat (1) — 8 buttons; the
    // system group (help/status + the dsh web wrappers) is on page 2.
    expect(labels).toContain('🗂️ Sessions');
    expect(labels).toContain('✨ Fresh start');
    expect(labels).toContain('➕ New chat');
    expect(labels).toContain('↩️ Resume session');
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-page', page: '1' },
    });
    const panel2 = h.transport.sentCards.at(-1);
    const labels2 =
      panel2?.elements.flatMap((el) =>
        el.tag === 'action'
          ? el.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [],
      ) ?? [];
    expect(labels2).toContain('🗺️ Plan mode');
    expect(labels2).toContain('🎯 Goal');
    expect(labels2).toContain('🔐 Permission');
  });

  it('paginates the palette with nav buttons at page bounds', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const panel = h.transport.sentCards.at(-1);
    expect(
      panel?.elements.some(
        (el) =>
          el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page 1/2'),
      ),
    ).toBe(true);
    const navLabels = (card: CardJson | undefined): string[] =>
      card?.elements.flatMap((el) =>
        el.tag === 'action'
          ? el.actions
              .filter(
                (a): a is ButtonAction =>
                  a.tag === 'button' &&
                  (a.text.content === 'Next ▶️' || a.text.content === '◀️ Prev'),
              )
              .map((a) => a.text.content)
          : [],
      ) ?? [];
    expect(navLabels(panel)).toEqual(['Next ▶️']);
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-page', page: '1' },
    });
    const panel2 = h.transport.sentCards.at(-1);
    expect(
      panel2?.elements.some(
        (el) =>
          el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page 2/2'),
      ),
    ).toBe(true);
    expect(navLabels(panel2)).toEqual(['◀️ Prev']);
  });

  it('a command button executes the same handler as the slash line', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'help' },
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('dsh-feishu commands'))).toBe(true);
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'clear' },
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('nothing to clear'))).toBe(true);
  });

  it('a mutating command button is refused while working; read-only allowed', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'clear' },
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(true);
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'help' },
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('dsh-feishu commands'))).toBe(true);
  });

  it('an unknown command button is logged and ignored', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'nope' },
    });
    expect(h.transport.sentTexts).toHaveLength(0);
  });
});

describe('dsh web command wrappers', () => {
  it('/goal executes through the dsh registry, minting an agent when needed', async () => {
    const h = makeHarness({
      executeCommand: async (_agent, line) =>
        line === '/goal set the thing' ? { kind: 'success', text: 'Goal set.' } : undefined,
    });
    await h.bridge.handleMessage(message({ text: '/goal set the thing' }));
    expect(h.transport.sentTexts.some((t) => t.text === 'Goal set.')).toBe(true);
    expect(h.agentStore.created.some((c) => c.sessionId === 'feishu-session-1')).toBe(true);
  });

  it('wrapper surfaces registry error kinds as ⚠️', async () => {
    const h = makeHarness({
      executeCommand: async (_agent, line) =>
        line === '/permission nope' ? { kind: 'error', text: 'unknown preset "nope"' } : undefined,
    });
    await h.bridge.handleMessage(message({ text: '/permission nope' }));
    expect(
      h.transport.sentTexts.some((t) => t.text.includes('⚠️') && t.text.includes('unknown preset')),
    ).toBe(true);
  });

  it('wrapper reports unavailable when the dsh registry is not mounted', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message({ text: '/goal' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('not mounted'))).toBe(true);
  });

  it('wrapper is refused while a turn is running', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/goal' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(true);
  });
});

describe('state machine matrix extension (command / resume-session actions)', () => {
  it('working × mutating command → refused; done × mutating command → allowed', async () => {
    const h = makeHarness({ throttleMs: 0 });
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/clear' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(true);
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.bridge.handleMessage(message({ messageId: 'om_msg3', text: '/clear' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('New conversation started'))).toBe(
      true,
    );
  });

  it('working × resume-session → refused (session untouched)', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/sessions' }));
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'resume-session', sessionId: 'feishu-session-9' },
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(true);
    expect(h.agentStore.resumed).not.toContain('feishu-session-9');
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-1');
  });
});

/** Fake `ctx.permissionPresets` service for the picker tests. */
class FakePermissionService implements PermissionPresetService {
  currentPreset = 'workspace-write';
  readonly applied: string[] = [];
  readonly names: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access'];
  optionOf(name: string): { value: string; name?: string; description?: string } {
    const descriptions: Record<string, string> = {
      'read-only': 'Sandbox read-only, approval ask.',
      'workspace-write': 'Sandbox workspace-write, approval ask.',
      'danger-full-access': 'Sandbox danger-full-access, approval never.',
    };
    const description = descriptions[name];
    return description === undefined ? { value: name, name } : { value: name, name, description };
  }
  current(_events: readonly unknown[]): string {
    return this.currentPreset;
  }
  set(_session: unknown, name: string): void {
    this.applied.push(name);
    this.currentPreset = name;
  }
}

/** Fake `ctx.planMode` controller for the toggle tests. */
class FakePlanModeService implements PlanModeService {
  active = false;
  readonly calls: boolean[] = [];
  get(): { active: boolean; pending?: boolean } {
    return { active: this.active };
  }
  set(_agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    this.calls.push(active);
    if (active === this.active) return 'noop';
    this.active = active;
    return 'committed';
  }
}

describe('stateful web wrappers (/permission picker, /plan toggle)', () => {
  it('/permission with no args opens the preset picker card', async () => {
    const service = new FakePermissionService();
    const h = makeHarness({ permissionPresets: service });
    await h.bridge.handleMessage(message({ text: '/permission' }));
    const card = h.transport.sentCards.at(-1);
    expect(card?.header?.title.content).toBe('🔐 Permission presets');
    // A dropdown (repo-picker pattern) lists every preset; the current one
    // is preselected and spelled out in a note.
    const action = card?.elements.find((el) => el.tag === 'action');
    const select =
      action && 'actions' in action
        ? action.actions.find((a) => a.tag === 'select_static')
        : undefined;
    expect(select && 'options' in select ? select.options.map((o) => o.value) : []).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ]);
    expect(select && 'initial_option' in select ? select.initial_option : undefined).toBe(
      'workspace-write',
    );
    expect(
      card?.elements.some(
        (el) =>
          el.tag === 'note' &&
          'elements' in el &&
          el.elements[0]?.content.includes('★ current: workspace-write'),
      ),
    ).toBe(true);
  });

  it('a permission pick applies the preset through the service and replies', async () => {
    const service = new FakePermissionService();
    const h = makeHarness({ permissionPresets: service });
    await h.bridge.handleMessage(message({ text: '/permission' }));
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      // Dropdown selection: the marker payload + the preset in `option`.
      value: { kind: 'permission-pick' },
      option: 'read-only',
    });
    expect(service.applied).toEqual(['read-only']);
    expect(h.transport.sentTexts.some((t) => t.text.includes('switched to read-only'))).toBe(true);
  });

  it('rejects a stale permission pick from a superseded picker card', async () => {
    const service = new FakePermissionService();
    const h = makeHarness({ permissionPresets: service });
    await h.bridge.handleMessage(message({ text: '/permission' }));
    await h.bridge.handleCardAction({
      messageId: 'msg-0',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'permission-pick' },
      option: 'read-only',
    });
    expect(service.applied).toHaveLength(0);
  });

  it('a permission pick while a turn runs is refused', async () => {
    const service = new FakePermissionService();
    const h = makeHarness({ permissionPresets: service });
    await h.bridge.handleMessage(message({ text: '/permission' }));
    // The picker id is the card sent by /permission (captured before the
    // turn opens its own streaming card).
    const pickerId = lastCardId(h);
    // Start a turn, then press the picker button.
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'start a turn' }));
    await h.bridge.handleCardAction({
      messageId: pickerId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'permission-pick' },
      option: 'read-only',
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(true);
    expect(service.applied).toHaveLength(0);
  });

  it('/permission degrades to the harness report when the service is absent', async () => {
    const h = makeHarness({
      executeCommand: async (_agent, line) =>
        line === '/permission'
          ? {
              kind: 'success',
              text: 'current preset workspace-write (available: read-only, workspace-write, danger-full-access)',
            }
          : undefined,
    });
    await h.bridge.handleMessage(message({ text: '/permission' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('current preset'))).toBe(true);
  });

  it('/permission <preset> passes through to the harness command', async () => {
    const h = makeHarness({
      executeCommand: async (_agent, line) =>
        line === '/permission read-only'
          ? { kind: 'success', text: 'preset read-only' }
          : undefined,
    });
    await h.bridge.handleMessage(message({ text: '/permission read-only' }));
    expect(h.transport.sentTexts.some((t) => t.text === 'preset read-only')).toBe(true);
  });

  it('/plan toggles: enters when inactive, leaves when active', async () => {
    const planMode = new FakePlanModeService();
    const h = makeHarness({ planMode });
    await h.bridge.handleMessage(message({ text: '/plan' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('Plan mode on'))).toBe(true);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/plan' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('Plan mode off'))).toBe(true);
    expect(planMode.calls).toEqual([true, false]);
  });

  it('/plan button toggles like the slash line', async () => {
    const planMode = new FakePlanModeService();
    const h = makeHarness({ planMode });
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'plan' },
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('Plan mode on'))).toBe(true);
  });

  it('/plan reports queued wording when the controller queues the flip', async () => {
    const planMode: PlanModeService = {
      get: () => ({ active: true }),
      set: () => 'queued',
    };
    const h = makeHarness({ planMode });
    await h.bridge.handleMessage(message({ text: '/plan' }));
    expect(
      h.transport.sentTexts.some((t) =>
        t.text.includes('Leaving plan mode (applies from the next step)'),
      ),
    ).toBe(true);
  });

  it('/plan off and /plan <message> pass through to the harness command', async () => {
    const h = makeHarness({
      executeCommand: async (_agent, line) =>
        line === '/plan off'
          ? { kind: 'success', text: 'Plan mode off.' }
          : line === '/plan implement the thing'
            ? { kind: 'success', text: 'Entering plan mode.' }
            : undefined,
    });
    await h.bridge.handleMessage(message({ text: '/plan off' }));
    expect(h.transport.sentTexts.some((t) => t.text === 'Plan mode off.')).toBe(true);
    await h.bridge.handleMessage(
      message({ messageId: 'om_msg2', text: '/plan implement the thing' }),
    );
    expect(h.transport.sentTexts.some((t) => t.text === 'Entering plan mode.')).toBe(true);
  });

  it('bare /plan falls back to the harness command when the service is absent', async () => {
    const h = makeHarness({
      executeCommand: async (_agent, line) =>
        line === '/plan'
          ? { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' }
          : undefined,
    });
    await h.bridge.handleMessage(message({ text: '/plan' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('Plan mode on'))).toBe(true);
  });
});
