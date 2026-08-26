/**
 * Unit tests for the message-queue feature: a user message arriving while a
 * turn runs is kept in the SURFACE's OWN queue (NOT appended to the agent
 * inbox's `nextTurn`, which the agent loop auto-claims at its step boundary and
 * would bypass `deliverTurn`) and surfaced on its OWN dedicated card (one card
 * per queued message, one lifecycle state machine per card — NO shared card and
 * NO recall/re-post invariant). After the owning turn ends the surface drains
 * the queue, delivering each non-steer message as its own turn (opening its
 * streaming card). The card actions drive each item's state machine
 * (queued/editing/steering/steered/sent/removed), and steer only fires while a
 * turn runs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentStore, Bridge } from '../src/bridge.js';
import { StreamingCardController } from '../src/cards/StreamingCardController.js';
import { StreamingCardManager } from '../src/cards/streaming.js';
import type { CardAction, CardJson, FeishuMessage, FeishuTransport } from '../src/feishu/types.js';
import type { SessionMap } from '../src/session-map.js';
import { SessionMap as RealSessionMap } from '../src/session-map.js';

/** A fake Feishu transport recording sent cards, updated cards, and texts. */
class RecordingTransport implements FeishuTransport {
  sentCards: Array<{ chatId: string; card: CardJson; messageId: string }> = [];
  updatedCards: Array<{ messageId: string; card: CardJson }> = [];
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
  async updateCard(messageId: string, card: CardJson): Promise<void> {
    this.updatedCards.push({ messageId, card });
  }
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

/** A fake agent inbox: kept for shape parity, but the message-queue never
 *  feeds it — queued messages live in the surface's own queue. */
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
    dataDir: '/work',
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

/** Whether a card is a per-item queue card (every lifecycle state's header
 *  title starts with `⏳`). */
function isQueueCard(card: CardJson): boolean {
  return card.header?.title.content.startsWith('⏳') ?? false;
}

/** Whether a card is a streaming turn card (NOT a per-item queue card). */
function isStreamingCard(card: CardJson): boolean {
  return !isQueueCard(card);
}

/** The message id of the queue card for the N-th queued item (0-indexed), in
 *  arrival order (one card per item). */
function queueCardIdForIndex(transport: RecordingTransport, index: number): string {
  const id = queueCardMessageIds(transport)[index];
  if (id === undefined) throw new Error(`no queue card at index ${index}`);
  return id;
}

/** The CURRENT card for a queue message id (the last in-place update, or the
 *  original send when never updated). */
function queueCardFor(messageId: string, transport: RecordingTransport): CardJson | undefined {
  const updated = transport.updatedCards.filter((u) => u.messageId === messageId).at(-1);
  if (updated !== undefined) return updated.card;
  return transport.sentCards.find((e) => e.messageId === messageId)?.card;
}

/** Count the queue cards sent. */
function queueCardsSent(transport: RecordingTransport): number {
  return transport.sentCards.filter((entry) => isQueueCard(entry.card)).length;
}

/** Count the streaming (non-queue) cards sent. */
function streamingCardsSent(transport: RecordingTransport): number {
  return transport.sentCards.filter((entry) => isStreamingCard(entry.card)).length;
}

/** Message ids of the queue cards sent, in order. */
function queueCardMessageIds(transport: RecordingTransport): string[] {
  return transport.sentCards
    .filter((entry) => isQueueCard(entry.card))
    .map((entry) => entry.messageId);
}

/** The action button value payload (kind + id) for a given kind on a card, or
 *  `undefined` when no such button is rendered. */
function queueCardValue(card: CardJson, kind: string): Record<string, string> | undefined {
  for (const el of card.elements) {
    if (el.tag === 'action') {
      for (const a of el.actions) {
        if (a.tag === 'button' && a.value.kind === kind) return a.value;
      }
    } else if (el.tag === 'form') {
      for (const sub of el.elements) {
        if (sub.tag === 'button' && sub.value.kind === kind) return sub.value;
      }
    }
  }
  return undefined;
}

/** The item id carried by the N-th queue card (0-indexed), read from its
 *  action button payloads. */
function queuedItemId(transport: RecordingTransport, index: number): string {
  const card = queueCardFor(queueCardIdForIndex(transport, index), transport) as CardJson;
  const id =
    queueCardValue(card, 'queue-edit')?.id ??
    queueCardValue(card, 'queue-steer')?.id ??
    queueCardValue(card, 'queue-remove')?.id ??
    queueCardValue(card, 'queue-edit-submit')?.id;
  if (id === undefined) throw new Error(`no item id on the queue card at index ${index}`);
  return id;
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

/** Whether the card renders any interactive button row (`queued` state). */
function hasActionRow(card: CardJson): boolean {
  return card.elements.some((el) => el.tag === 'action');
}

/** Whether the card renders the inline edit form (`editing` state). */
function hasEditForm(card: CardJson): boolean {
  return card.elements.some((el) => el.tag === 'form' && el.name === 'queue-edit');
}

/** The text of a queued user message (joined text blocks). */
function lastText(message: UserMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n');
}

/** The text of the N-th `followup` call (1-indexed), or throw when none. */
function followupText(agent: FakeAgent, index: number): string {
  const call = agent.followup.mock.calls[index - 1];
  if (call === undefined) throw new Error(`no followup call at index ${index}`);
  return lastText(call[0] as UserMessage);
}

/** A `user/message` session event carrying the given message (the surface
 *  event that records a steered message consumed into the running turn). */
function userMessageEvent(id: string, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: 3,
    time: 0,
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  } as unknown as SessionEvent;
}

describe('message-queue', () => {
  afterEach(() => {
    for (const dir of activeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a message arriving while a turn runs in the SURFACE queue (its own card), not inbox next-turn', async () => {
    const { bridge, transport, inbox, agent } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    expect(agent.followup).toHaveBeenCalledTimes(1);
    await bridge.handleMessage(inboundMessage('second'));
    // Not interrupted: no second followup; the message is queued instead.
    expect(agent.followup).toHaveBeenCalledTimes(1);
    // The queued message does NOT enter the agent inbox's next-turn list — it
    // lives in the surface's OWN queue (the fix: the agent loop must not
    // auto-claim it, which would bypass deliverTurn and open no card).
    expect(inbox.nextTurn).toHaveLength(0);
    // One dedicated card for the one queued item; the header folds the preview.
    expect(queueCardsSent(transport)).toBe(1);
    const cardId = queueCardIdForIndex(transport, 0);
    const card = queueCardFor(cardId, transport) as CardJson;
    expect(card.header?.title.content).toContain('second');
  });

  it('each queued message posts its OWN card — no shared card, no recall/re-post', async () => {
    const { bridge, transport, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    await bridge.handleMessage(inboundMessage('third'));
    // The inbox stays empty (the surface owns the queue); the cards fold each preview.
    expect(inbox.nextTurn).toHaveLength(0);
    // Two queued items -> two dedicated cards, each a distinct message id.
    expect(queueCardsSent(transport)).toBe(2);
    const ids = queueCardMessageIds(transport);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // NO single-card invariant: nothing is ever recalled/deleted.
    expect(transport.deletedCards).toHaveLength(0);
    // Each card title folds its own item preview.
    const card0 = queueCardFor(queueCardIdForIndex(transport, 0), transport) as CardJson;
    const card1 = queueCardFor(queueCardIdForIndex(transport, 1), transport) as CardJson;
    expect(card0.header?.title.content).toContain('second');
    expect(card1.header?.title.content).toContain('third');
    // Each card is updated in place (never deleted+re-sent) on the next action.
    await bridge.handleCardAction(queueAction('queue-edit', queuedItemId(transport, 0), {}));
    expect(new Set(ids).size).toBe(2);
    expect(queueCardsSent(transport)).toBe(2);
  });

  it('each queued item card offers Steer / Edit / Remove while a turn runs', async () => {
    const { bridge, transport } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const card = queueCardFor(queueCardIdForIndex(transport, 0), transport) as CardJson;
    const labels = queueButtonLabels(card);
    expect(labels).toContain('➡️ Steer');
    expect(labels).toContain('✏️ Edit');
    expect(labels).toContain('🗑️ Remove');
    expect(hasActionRow(card)).toBe(true);
    expect(hasEditForm(card)).toBe(false);
  });

  it('a stray steer after the turn drained never fires agent.steer', async () => {
    const { bridge, transport, agent } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const id = queuedItemId(transport, 0);
    // End the running turn → the surface drains the queue, delivering 'second'
    // as its own turn (a streaming card opens) and marking its card Sent.
    await bridge.handleEvent('s1', turnEndEvent());
    expect(agent.followup).toHaveBeenCalledTimes(2);
    // A stray steer on the now-delivered item must NOT call agent.steer; the
    // item was already consumed, so a notice posts and the card stays Sent.
    await bridge.handleCardAction(queueAction('queue-steer', id));
    expect(agent.steer).not.toHaveBeenCalled();
    expect(transport.sentTexts.some((t) => t.text.includes('already consumed'))).toBe(true);
  });

  it('steer while running routes to agent.steer (not inbox) and marks the card steering', async () => {
    const { bridge, transport, agent, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const id = queuedItemId(transport, 0);
    const cardId = queueCardIdForIndex(transport, 0);
    await bridge.handleCardAction(queueAction('queue-steer', id));
    expect(agent.steer).toHaveBeenCalledTimes(1);
    // The steered message never enters the inbox next-turn list (steer routes
    // to the running turn's next-step boundary via agent.steer).
    expect(inbox.nextTurn).toHaveLength(0);
    expect(agent.steer.mock.calls[0]?.[0]).toBeDefined();
    // The card is UPDATED in place (same message id, not a fresh send) to the
    // steering marker — NOT immediately removed/hidden.
    expect(transport.deletedCards).toHaveLength(0);
    const card = queueCardFor(cardId, transport) as CardJson;
    expect(JSON.stringify(card.elements)).toContain('💬 Steering…');
    expect(hasActionRow(card)).toBe(false);
    expect(hasEditForm(card)).toBe(false);
  });

  it('when the agent consumes the steer (a later user/message), the card flips to Steered', async () => {
    const { bridge, transport } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const id = queuedItemId(transport, 0);
    const cardId = queueCardIdForIndex(transport, 0);
    await bridge.handleCardAction(queueAction('queue-steer', id));
    // The agent consumes the steered message at its step boundary: its
    // `user/message` event arrives -> the trace adds a steering row and the
    // item card flips to Steered (no buttons).
    await bridge.handleEvent('s1', userMessageEvent(id, 'second'));
    const card = queueCardFor(cardId, transport) as CardJson;
    expect(JSON.stringify(card.elements)).toContain('✅ Steered');
    expect(hasActionRow(card)).toBe(false);
    expect(hasEditForm(card)).toBe(false);
  });

  it('a steered user/message adds a steering row to the streaming trace', async () => {
    const { transport, sessionMap, agentStore, agent } = makeHarness();
    const cards = new StreamingCardManager(transport, { throttleMs: 0 });
    const controller = new StreamingCardController({
      transport,
      cards,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      sessionMap,
      agentStore,
      defaultCwd: '/work',
      reactions: undefined,
      resolveAgent: async () => agent as unknown as Agent,
      textMentionFor: () => '',
      sendLogFile: async () => {},
    });
    await controller.beginTurn('oc_chat', 'msg-1', 'first turn');
    controller.noteSteer('oc_chat', 'steer-m1');
    await controller.handleEvent('s1', userMessageEvent('steer-m1', 'inserted into the turn'));
    const rows = controller.state('oc_chat')?.rows ?? [];
    expect(rows).toContainEqual({
      kind: 'steering',
      id: 'steer-m1',
      text: 'inserted into the turn',
    });
  });

  it('edit opens the inline form (editing); submit returns to queued with new text', async () => {
    const { bridge, transport, agent, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const id = queuedItemId(transport, 0);
    const cardId = queueCardIdForIndex(transport, 0);
    // Edit opens the inline form on THIS card (in place, same message id).
    await bridge.handleCardAction(queueAction('queue-edit', id));
    const editingCard = queueCardFor(cardId, transport) as CardJson;
    expect(hasEditForm(editingCard)).toBe(true);
    // The editing card keeps a Cancel button row (outside the form).
    expect(hasActionRow(editingCard)).toBe(true);
    expect(queueButtonLabels(editingCard)).toContain('↩️ Cancel');
    expect(inbox.nextTurn).toHaveLength(0);
    // Submit returns to queued with the new text.
    await bridge.handleCardAction(queueAction('queue-edit-submit', id, { text: 'rewritten' }));
    const queuedCard = queueCardFor(cardId, transport) as CardJson;
    expect(hasEditForm(queuedCard)).toBe(false);
    expect(hasActionRow(queuedCard)).toBe(true);
    expect(JSON.stringify(queuedCard.elements)).toContain('rewritten');
    // After the turn ends, the surface delivers the EDITED content.
    await bridge.handleEvent('s1', turnEndEvent());
    expect(agent.followup).toHaveBeenCalledTimes(2);
    expect(followupText(agent, 2)).toBe('rewritten');
  });

  it('edit cancel returns to queued unchanged', async () => {
    const { bridge, transport, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const id = queuedItemId(transport, 0);
    const cardId = queueCardIdForIndex(transport, 0);
    await bridge.handleCardAction(queueAction('queue-edit', id));
    await bridge.handleCardAction(queueAction('queue-edit-cancel', id));
    expect(inbox.nextTurn).toHaveLength(0);
    const card = queueCardFor(cardId, transport) as CardJson;
    expect(hasEditForm(card)).toBe(false);
    expect(hasActionRow(card)).toBe(true);
    expect(JSON.stringify(card.elements)).toContain('second');
  });

  it('edit reads the replacement text from a form submission', async () => {
    const { bridge, transport, agent } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    const id = queuedItemId(transport, 0);
    await bridge.handleCardAction(queueAction('queue-edit', id));
    await bridge.handleCardAction({
      ...queueAction('queue-edit-submit', id),
      formValue: { text: 'from-form' },
    });
    // The edited content is what the surface later delivers.
    await bridge.handleEvent('s1', turnEndEvent());
    expect(followupText(agent, 2)).toBe('from-form');
  });

  it('remove marks the card removed (🗑️ Removed) and retains it — no recall', async () => {
    const { bridge, transport, agent } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    await bridge.handleMessage(inboundMessage('third'));
    const id = queuedItemId(transport, 0);
    const cardId = queueCardIdForIndex(transport, 0);
    await bridge.handleCardAction(queueAction('queue-remove', id));
    // The removed card is RETAINED showing its marker; nothing is recalled.
    expect(transport.deletedCards).toHaveLength(0);
    const card = queueCardFor(cardId, transport) as CardJson;
    expect(JSON.stringify(card.elements)).toContain('🗑️ Removed');
    expect(hasActionRow(card)).toBe(false);
    expect(hasEditForm(card)).toBe(false);
    // The removed item is NOT delivered when the turn ends — only 'third' is.
    await bridge.handleEvent('s1', turnEndEvent());
    expect(agent.followup).toHaveBeenCalledTimes(2);
    expect(followupText(agent, 2)).toBe('third');
  });

  it('on turn/end the surface delivers the queued non-steer message: a streaming card opens (beginTurn + followup)', async () => {
    const { bridge, transport, inbox, agent } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    // The first message opened a streaming card + followup.
    expect(agent.followup).toHaveBeenCalledTimes(1);
    expect(streamingCardsSent(transport)).toBe(1);
    await bridge.handleMessage(inboundMessage('second'));
    // Queued into the surface queue (NOT the inbox); no extra followup/card yet.
    expect(inbox.nextTurn).toHaveLength(0);
    expect(agent.followup).toHaveBeenCalledTimes(1);
    expect(queueCardsSent(transport)).toBe(1);
    // The owning turn ends -> the surface delivers the queued message as its
    // own turn: a second streaming card opens (beginTurn) and followup runs.
    await bridge.handleEvent('s1', turnEndEvent());
    expect(agent.followup).toHaveBeenCalledTimes(2);
    expect(followupText(agent, 2)).toBe('second');
    expect(streamingCardsSent(transport)).toBe(2);
    // The queue card is retained as Sent.
    const cardId = queueCardIdForIndex(transport, 0);
    const card = queueCardFor(cardId, transport) as CardJson;
    expect(JSON.stringify(card.elements)).toContain('📤 Sent');
    expect(hasActionRow(card)).toBe(false);
    expect(hasEditForm(card)).toBe(false);
  });

  it('drains multiple queued messages in order, one turn per turn/end', async () => {
    const { bridge, agent, inbox } = makeHarness();
    await bridge.handleMessage(inboundMessage('first'));
    await bridge.handleMessage(inboundMessage('second'));
    await bridge.handleMessage(inboundMessage('third'));
    expect(inbox.nextTurn).toHaveLength(0);
    // First turn/end delivers 'second' as its own turn.
    await bridge.handleEvent('s1', turnEndEvent());
    expect(agent.followup).toHaveBeenCalledTimes(2);
    expect(followupText(agent, 2)).toBe('second');
    // The next turn/end delivers 'third'.
    await bridge.handleEvent('s1', turnEndEvent());
    expect(agent.followup).toHaveBeenCalledTimes(3);
    expect(followupText(agent, 3)).toBe('third');
  });

  it('degrades to a normal turn when the agent has no inbox', async () => {
    const { bridge, transport, agent } = makeHarness({ noInbox: true });
    await bridge.handleMessage(inboundMessage('first'));
    expect(agent.followup).toHaveBeenCalledTimes(1);
    await bridge.handleMessage(inboundMessage('second'));
    // No queue card; both messages were delivered as normal turns (the surface
    // queue path needs an agent inbox to gate on, today's degrade behavior).
    expect(agent.followup).toHaveBeenCalledTimes(2);
    expect(queueCardsSent(transport)).toBe(0);
  });
});
