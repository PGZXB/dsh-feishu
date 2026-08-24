/**
 * Unit tests for the message-queue feature: a user message arriving while a
 * turn runs is appended to the agent inbox's next-turn queue and surfaced on
 * ONE dedicated queue card (single-card invariant: recall + re-post on every
 * mutation, recall only on empty). The card actions map to the inbox
 * (steer/edit/remove) and steer only fires while a turn runs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentStore, Bridge } from '../src/bridge.js';
import { StreamingCardManager } from '../src/cards/streaming.js';
import type { CardAction, CardJson, FeishuMessage, FeishuTransport } from '../src/feishu/types.js';
import type { SessionMap } from '../src/session-map.js';
import { SessionMap as RealSessionMap } from '../src/session-map.js';

/** A fake Feishu transport recording sent cards, recalled cards, and texts. */
class RecordingTransport implements FeishuTransport {
  sentCards: Array<{ chatId: string; card: CardJson; messageId: string }> = [];
  deletedCards: string[] = [];
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
  async sendFile(_chatId: string, _fileName: string, _content: Uint8Array): Promise<void> {}
  async sendImage(_chatId: string, _fileName: string, _bytes: Uint8Array): Promise<void> {}
  async addReaction(_messageId: string, _emojiType: string): Promise<string | undefined> {
    return undefined;
  }
  async removeReaction(_messageId: string, _reactionId: string): Promise<void> {}
  async sendCard(chatId: string, card: CardJson): Promise<{ messageId: string }> {
    const messageId = `msg-${this.sentCards.length + 1}`;
    this.sentCards.push({ chatId, card, messageId });
    return { messageId };
  }
  async updateCard(_messageId: string, _card: CardJson): Promise<void> {}
  async deleteMessage(messageId: string): Promise<void> {
    this.deletedCards.push(messageId);
  }
  async downloadImage(
    _messageId: string,
    _key: string,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    throw new Error('downloadImage not used in queue tests');
  }
  async downloadFile(
    _messageId: string,
    _key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; head: Uint8Array }> {
    throw new Error('downloadFile not used in queue tests');
  }
}

/** A fake agent inbox: enough of the dsh `Inbox` surface for the queue path. */
class FakeInbox {
  readonly nextTurn: UserMessage[] = [];
  readonly nextStep: UserMessage[] = [];
  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0;
  }
  append(target: 'next-turn' | 'next-step', message: UserMessage): void {
    (target === 'next-turn' ? this.nextTurn : this.nextStep).push(message);
  }
  prepend(target: 'next-turn' | 'next-step', message: UserMessage): void {
    (target === 'next-turn' ? this.nextTurn : this.nextStep).unshift(message);
  }
  replace(messageId: string, newMessage: UserMessage): boolean {
    const index = this.nextTurn.findIndex((m) => m.id === messageId);
    if (index < 0) return false;
    this.nextTurn[index] = newMessage;
    return true;
  }
  remove(messageId: string): boolean {
    const index = this.nextTurn.findIndex((m) => m.id === messageId);
    if (index < 0) return false;
    this.nextTurn.splice(index, 1);
    return true;
  }
}

/** A fake agent with a fake inbox and followup/steer spies. */
class FakeAgent {
  readonly inbox?: FakeInbox;
  readonly followup = vi.fn();
  readonly steer = vi.fn();
  readonly cancel = vi.fn();
  status: 'idle' | 'running' = 'running';
  readonly session: { id: string };

  constructor(sessionId: string, inbox?: FakeInbox) {
    this.session = { id: sessionId };
    if (inbox !== undefined) this.inbox = inbox;
  }
}

/** A fake agent store: create/resume return a single live fake agent. */
class FakeAgentStore implements AgentStore {
  private readonly agents = new Map<string, FakeAgent>();

  set(agent: FakeAgent): void {
    this.agents.set(agent.session.id, agent);
  }

  get(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId) as unknown as Agent | undefined;
  }

  async resume(sessionId: string): Promise<Agent> {
    const existing = this.agents.get(sessionId);
    if (existing !== undefined) return existing as unknown as Agent;
    const agent = new FakeAgent(sessionId);
    this.agents.set(sessionId, agent);
    return agent as unknown as Agent;
  }

  async create(sessionId: string, _cwd: string): Promise<Agent> {
    return this.resume(sessionId);
  }
}

interface Harness {
  bridge: Bridge;
  transport: RecordingTransport;
  agentStore: FakeAgentStore;
  inbox: FakeInbox;
  agent: FakeAgent;
  sessionMap: SessionMap;
}

const activeDirs: string[] = [];

function makeHarness(options: { noInbox?: boolean } = {}): Harness {
  const transport = new RecordingTransport();
  const agentStore = new FakeAgentStore();
  const dir = mkdtempSync(join(tmpdir(), 'queue-'));
  activeDirs.push(dir);
  const sessionMap = new RealSessionMap(join(dir, 'map.json'));
  sessionMap.set('oc_chat', 's1');
  sessionMap.setCwd('oc_chat', '/work');
  const cards = new StreamingCardManager(transport);
  const bridge = new Bridge({
    transport,
    sessionMap,
    agentStore,
    onSessionEvent: () => () => {},
    cards,
    defaultCwd: '/work',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    requireWorkingDir: false,
  });
  const inbox = new FakeInbox();
  const agent = new FakeAgent('s1', options.noInbox === true ? undefined : inbox);
  agentStore.set(agent);
  return { bridge, transport, agentStore, inbox, agent, sessionMap };
}

/** A normal inbound text message (unique id per call). */
let msgSeq = 0;
function inboundMessage(text: string, overrides: Partial<FeishuMessage> = {}): FeishuMessage {
  msgSeq += 1;
  return {
    messageId: `om-queue-${Date.now()}-${msgSeq}`,
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderOpenId: 'ou_user',
    text,
    mentions: [],
    attachments: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

/** A turn-end session event that finalizes the working card. */
function turnEndEvent(): SessionEvent {
  return {
    type: 'turn/end',
    seq: 2,
    time: 0,
    data: { turn: 0, reason: { kind: 'completed' } },
  } as unknown as SessionEvent;
}

/** A queue-card button callback for the given item id. */
function queueAction(kind: string, id: string, extra: Record<string, string> = {}): CardAction {
  return {
    messageId: 'msg-queue',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_user',
    value: { kind, id, ...extra },
  };
}

/** Whether a card is the dedicated queue card (has a queue action/form). */
function isQueueCard(card: CardJson): boolean {
  return card.elements.some((el) => {
    if (el.tag === 'action') {
      return (
        'actions' in el &&
        el.actions.some(
          (a) =>
            'value' in a &&
            String((a as { value: Record<string, string> }).value.kind).startsWith('queue-'),
        )
      );
    }
    return el.tag === 'form' && el.name === 'queue-edit';
  });
}

/** The last queue card sent, or `undefined` when none. */
function lastQueueCard(transport: RecordingTransport): CardJson | undefined {
  const ids = queueCardMessageIds(transport);
  const lastId = ids.at(-1);
  if (lastId === undefined) return undefined;
  return transport.sentCards.find((entry) => entry.messageId === lastId)?.card;
}

/** Count the queue cards sent. */
function queueCardsSent(transport: RecordingTransport): number {
  return transport.sentCards.filter((entry) => isQueueCard(entry.card)).length;
}

/** Message ids of the queue cards sent, in order. */
function queueCardMessageIds(transport: RecordingTransport): string[] {
  return transport.sentCards
    .filter((entry) => isQueueCard(entry.card))
    .map((entry) => entry.messageId);
}

/** The message id of the last queue card sent. */
function lastQueueCardMessageId(transport: RecordingTransport): string | undefined {
  return queueCardMessageIds(transport).at(-1);
}

/** All button labels across a queue card's action rows and forms. */
function queueButtonLabels(card: CardJson): string[] {
  const labels: string[] = [];
  for (const el of card.elements) {
    if (el.tag === 'action') {
      for (const a of el.actions) {
        if (a.tag === 'button') labels.push(a.text.content);
      }
    }
    if (el.tag === 'form') {
      for (const sub of el.elements) {
        if (sub.tag === 'button') labels.push(sub.text.content);
      }
    }
  }
  return labels;
}

/** The item ids targeted by queue actions in a card's action rows. */
function queueItemIds(card: CardJson): string[] {
  const ids: string[] = [];
  for (const el of card.elements) {
    if (el.tag === 'action') {
      for (const a of el.actions) {
        if ('value' in a) {
          const value = (a as { value: Record<string, string> }).value;
          if (value.kind?.startsWith('queue-') && value.id !== undefined) ids.push(value.id);
        }
      }
    }
  }
  return ids;
}

/** The text of a queued user message (joined text blocks). */
function lastText(message: UserMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n');
}

describe('message-queue', () => {
  afterEach(() => {
    for (const dir of activeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('enqueues a message arriving while a turn runs, onto inbox next-turn + one queue card', async () => {
    const { bridge, transport, inbox, agent } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    expect(agent.followup).toHaveBeenCalledTimes(1);
    await bridge.handleMessage(inboundMessage('second'));
    // Not interrupted: no second followup; the message is queued instead.
    expect(agent.followup).toHaveBeenCalledTimes(1);
    expect(inbox.nextTurn.map((m) => lastText(m))).toEqual(['second']);
    const card = lastQueueCard(transport);
    expect(card).toBeDefined();
    expect(card?.header?.title.content).toContain('second');
    expect(queueCardsSent(transport)).toBe(1);
  });

  it('a second queue mutation re-posts a single card (recall + post, never two live)', async () => {
    const { bridge, transport, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    expect(queueCardsSent(transport)).toBe(1);
    const firstCardId = lastQueueCardMessageId(transport);
    await bridge.handleMessage(inboundMessage('third'));
    expect(queueCardsSent(transport)).toBe(2);
    // The prior queue card was recalled; only the latest is live.
    expect(transport.deletedCards).toContain(firstCardId);
    expect(inbox.nextTurn.map((m) => lastText(m))).toEqual(['second', 'third']);
  });

  it('each item row offers Steer / Edit / Remove while a turn runs', async () => {
    const { bridge, transport, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const card = lastQueueCard(transport) as CardJson;
    const labels = queueButtonLabels(card);
    expect(labels).toContain('➡️ Steer');
    expect(labels).toContain('✏️ Edit');
    expect(labels).toContain('🗑️ Remove');
    expect(queueItemIds(card)).toContain(inbox.nextTurn[0]?.id);
  });

  it('steer is unavailable when idle: hint shown, and a stray steer never fires', async () => {
    const { bridge, transport, agent, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    // End the running turn → idle. The queue card is re-posted on the next
    // mutation (the agent did not claim the queued items in this fake), so a
    // non-emptying mutation (edit) re-posts it while idle.
    await bridge.handleEvent('s1', turnEndEvent());
    const id = queuedId(inbox);
    await bridge.handleCardAction(queueAction('queue-edit', id, { text: 'rewritten' }));
    const idleCard = lastQueueCard(transport) as CardJson;
    expect(queueButtonLabels(idleCard)).not.toContain('➡️ Steer');
    const hintEl = idleCard.elements[0];
    expect(hintEl?.tag).toBe('markdown');
    expect(hintEl !== undefined && 'content' in hintEl ? hintEl.content : '').toContain(
      'Steer unavailable',
    );
    // A stray steer while idle must NOT call agent.steer.
    const nextId = queuedId(agent.inbox as FakeInbox);
    await bridge.handleCardAction(queueAction('queue-steer', nextId));
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it('steer while running removes the item and steers the running turn', async () => {
    const { bridge, agent, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const id = queuedId(inbox);
    await bridge.handleCardAction(queueAction('queue-steer', id));
    expect(agent.steer).toHaveBeenCalledTimes(1);
    expect(inbox.nextTurn).toHaveLength(0);
  });

  it('edit re-posts the item with new text and a fresh card', async () => {
    const { bridge, inbox, transport } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const id = queuedId(inbox);
    await bridge.handleCardAction(queueAction('queue-edit', id, { text: 'rewritten' }));
    expect(inbox.nextTurn.map((m) => lastText(m))).toEqual(['rewritten']);
    expect(queueCardsSent(transport)).toBe(2);
    expect(lastQueueCard(transport)?.header?.title.content).toContain('rewritten');
  });

  it('edit reads the replacement text from a form submission', async () => {
    const { bridge, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const id = queuedId(inbox);
    await bridge.handleCardAction({
      ...queueAction('queue-edit', id),
      formValue: { text: 'from-form' },
    });
    expect(inbox.nextTurn.map((m) => lastText(m))).toEqual(['from-form']);
  });

  it('remove re-posts the card and drops the item', async () => {
    const { bridge, inbox, transport } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    await bridge.handleMessage(inboundMessage('third'));
    const id = queuedId(inbox);
    await bridge.handleCardAction(queueAction('queue-remove', id));
    expect(inbox.nextTurn.map((m) => lastText(m))).toEqual(['third']);
    // One item remains → the queue card re-posts (3 cards over time: 2 from
    // the enqueues + 1 from the remove).
    expect(queueCardsSent(transport)).toBe(3);
  });

  it('queue empty → recall the card only (no re-post)', async () => {
    const { bridge, transport, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const cardId = lastQueueCardMessageId(transport);
    const id = queuedId(inbox);
    await bridge.handleCardAction(queueAction('queue-remove', id));
    expect(transport.deletedCards).toContain(cardId);
    // Only ONE queue card was ever posted, and it was recalled — no live card.
    expect(queueCardsSent(transport)).toBe(1);
    expect(
      queueCardMessageIds(transport).every((mid) => transport.deletedCards.includes(mid)),
    ).toBe(true);
  });

  it('an action on an already-consumed item posts a notice and re-posts the current queue', async () => {
    const { bridge, transport, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    await bridge.handleMessage(inboundMessage('third'));
    // Force the first item out of the queue (e.g. the turn boundary claimed it).
    const id = queuedId(inbox);
    inbox.remove(id);
    await bridge.handleCardAction(queueAction('queue-remove', id));
    expect(transport.sentTexts.some((t) => t.text.includes('already consumed'))).toBe(true);
    expect(inbox.nextTurn.map((m) => lastText(m))).toEqual(['third']);
  });

  it('degrades to a normal turn when the agent has no inbox', async () => {
    const { bridge, transport, agent } = makeHarness({ noInbox: true });
    await bridge.handleMessage(inboundMessage('first'));
    expect(agent.followup).toHaveBeenCalledTimes(1);
    await bridge.handleMessage(inboundMessage('second'));
    // No queue card; both messages delivered as normal turns.
    expect(agent.followup).toHaveBeenCalledTimes(2);
    expect(lastQueueCard(transport)).toBeUndefined();
  });
});

/** The first queued item id in the fake inbox, or throw when empty. */
function queuedId(inbox: FakeInbox): string {
  const first = inbox.nextTurn[0];
  if (first === undefined) throw new Error('no queued item');
  return first.id;
}
