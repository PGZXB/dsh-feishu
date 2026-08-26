/**
 * Unit tests for the streaming-card state machine controller: the per-chat
 * authoritative state, the event → card pipeline, the single render path,
 * and the streaming card actions (stop/copy/retry/row-details/toggle-rows).
 */

import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';
import {
  friendlyTurnError,
  StreamingCardController,
  type StreamingCardHost,
} from '../../src/cards/StreamingCardController.js';
import { StreamingCardManager } from '../../src/cards/streaming.js';
import type {
  CardAction,
  CardJson,
  ChatStats,
  FeishuMessage,
  FeishuTransport,
  SentCard,
} from '../../src/feishu/types.js';
import { SessionMap } from '../../src/session-map.js';

/** Records transport interactions for assertions. */
class RecordingTransport implements FeishuTransport {
  sentCards: CardJson[] = [];
  updatedCards: CardJson[] = [];
  /** Every in-place patch with its TARGET message id (updateCard calls). */
  updatedTargets: Array<{ messageId: string; card: CardJson }> = [];
  sentTexts: Array<{ chatId: string; text: string }> = [];
  reactions: Array<{
    messageId: string;
    emojiType?: string;
    action: 'add' | 'remove';
    reactionId?: string;
  }> = [];
  private reactionSeq = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(_handler: (message: FeishuMessage) => void): void {}
  onCardAction(_handler: (action: CardAction) => void): void {}
  getBotOpenId(): string | undefined {
    return undefined;
  }
  async chatStats(_chatId: string): Promise<ChatStats | undefined> {
    return undefined;
  }
  async createGroup(name: string, _memberOpenIds: readonly string[]): Promise<{ chatId: string }> {
    return { chatId: `oc_group_${name}` };
  }
  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }
  async sendFile(_chatId: string, _fileName: string, _content: Uint8Array): Promise<void> {}
  async sendImage(_chatId: string, _fileName: string, _bytes: Uint8Array): Promise<void> {}

  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    const reactionId = `rx-${++this.reactionSeq}`;
    this.reactions.push({ messageId, emojiType, action: 'add', reactionId });
    return reactionId;
  }
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.reactions.push({ messageId, action: 'remove', reactionId });
  }
  async sendCard(_chatId: string, card: CardJson): Promise<SentCard> {
    this.sentCards.push(card);
    return { messageId: `msg-${this.sentCards.length}` };
  }
  async updateCard(messageId: string, card: CardJson): Promise<void> {
    this.updatedCards.push(card);
    this.updatedTargets.push({ messageId, card });
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
/** A minimal live agent fake for stop/retry. */
function makeAgent(): {
  agent: Agent;
  followups: Array<{ content: string }>;
  cancels: Array<{ kind: string; keepInbox: boolean }>;
  setStatus: (status: 'idle' | 'running') => void;
} {
  const followups: Array<{ content: string }> = [];
  const cancels: Array<{ kind: string; keepInbox: boolean }> = [];
  let status: 'idle' | 'running' = 'running';
  const agent = {
    session: { id: 'feishu-session-1' },
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    get status() {
      return status;
    },
    followup(message: { content: readonly { type: string; text: string }[] }): void {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      followups.push({ content: text });
    },
    cancel(options: { kind: string }, meta: { keepInbox: boolean }): void {
      cancels.push({ kind: options.kind, keepInbox: meta.keepInbox });
    },
  } as unknown as Agent;
  return {
    agent,
    followups,
    cancels,
    setStatus: (next) => {
      status = next;
    },
  };
}

/** Build a controller wired to a recording transport + real card manager. */
function makeController(): {
  transport: RecordingTransport;
  controller: StreamingCardController;
  agent: Agent;
  followups: Array<{ content: string }>;
  cancels: Array<{ kind: string; keepInbox: boolean }>;
  setStatus: (status: 'idle' | 'running') => void;
} {
  const transport = new RecordingTransport();
  const sessionMap = new SessionMap(join(process.cwd(), '_dev', 'test-stream-map.json'));
  sessionMap.set('oc_chat', 'feishu-session-1');
  const manager = new StreamingCardManager(transport);
  const { agent, followups, cancels, setStatus } = makeAgent();
  const host: StreamingCardHost = {
    transport,
    cards: manager,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    sessionMap,
    agentStore: {
      get: (sessionId) => (sessionId === 'feishu-session-1' ? agent : undefined),
      resume: async () => agent,
      create: async () => agent,
    },
    defaultCwd: '/tmp',
    reactions: undefined,
    resolveAgent: async () => agent,
    textMentionFor: () => '',
    sendLogFile: async () => {},
  };
  return {
    transport,
    controller: new StreamingCardController(host),
    agent,
    followups,
    cancels,
    setStatus,
  };
}

function chunkEvent(text: string): SessionEvent {
  return {
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', text } },
  } as unknown as SessionEvent;
}

function turnEndEvent(reason: { kind: 'completed' | 'error' | 'aborted' }): SessionEvent {
  return {
    type: 'turn/end',
    data: {
      reason:
        reason.kind === 'error' ? { kind: 'error', error: { code: 'E', message: 'boom' } } : reason,
    },
  } as unknown as SessionEvent;
}

/** A reasoning delta (opens/folds into a think row — makes hasRows true). */
function reasoningEvent(text: string): SessionEvent {
  return {
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', text } },
  } as unknown as SessionEvent;
}

/** The last card rendered by the streaming manager (a CardJson render). */
function lastCard(h: {
  transport: RecordingTransport;
  controller: StreamingCardController;
}): CardJson | undefined {
  // Chronological: sent cards first, then in-place updates.
  const all = [...h.transport.sentCards, ...h.transport.updatedCards];
  return all.at(-1);
}

describe('StreamingCardController', () => {
  it('beginTurn opens a working card and records the prompt + reaction', async () => {
    const h = makeController();
    await h.controller.beginTurn('oc_chat', 'om-1', 'my question');
    expect(h.transport.sentCards).toHaveLength(1);
    expect(h.transport.reactions.some((r) => r.action === 'add' && r.messageId === 'om-1')).toBe(
      true,
    );
    expect(h.controller.isWorking('oc_chat')).toBe(true);
    expect(h.controller.lastPrompt('oc_chat')).toBeUndefined();
    h.controller.rememberPrompt('oc_chat', 'my question');
    expect(h.controller.lastPrompt('oc_chat')).toBe('my question');
  });

  it('folds chunks into the card and settles on turn/end', async () => {
    const h = makeController();
    await h.controller.beginTurn('oc_chat', 'om-1', 'T');
    await h.controller.handleEvent('feishu-session-1', chunkEvent('Hello'));
    await h.controller.handleEvent('feishu-session-1', chunkEvent(' world'));
    expect(h.controller.state('oc_chat')?.content).toBe('Hello world');
    await h.controller.handleEvent('feishu-session-1', turnEndEvent({ kind: 'completed' }));
    expect(h.controller.state('oc_chat')?.status).toBe('done');
    expect(h.controller.lastOutput('oc_chat')).toBe('Hello world');
    // The terminal reaction swapped received → done.
    const terminal = h.transport.reactions.filter((r) => r.action === 'add');
    expect(terminal.map((r) => r.emojiType)).toEqual(['GoGoGo', 'DONE']);
  });

  it('turn/end with an error marks the card error and notifies', async () => {
    const h = makeController();
    await h.controller.beginTurn('oc_chat', 'om-1', 'T');
    await h.controller.handleEvent('feishu-session-1', turnEndEvent({ kind: 'error' }));
    expect(h.controller.state('oc_chat')?.status).toBe('error');
    expect(h.transport.sentTexts.some((t) => t.text.includes('Turn failed'))).toBe(true);
  });

  it('resetChat clears the state and copy/retry targets', async () => {
    const h = makeController();
    await h.controller.beginTurn('oc_chat', 'om-1', 'T');
    h.controller.rememberPrompt('oc_chat', 'P');
    await h.controller.handleEvent('feishu-session-1', turnEndEvent({ kind: 'completed' }));
    h.controller.resetChat('oc_chat');
    expect(h.controller.state('oc_chat')).toBeUndefined();
    expect(h.controller.lastPrompt('oc_chat')).toBeUndefined();
    expect(h.controller.lastOutput('oc_chat')).toBeUndefined();
    expect(h.controller.isWorking('oc_chat')).toBe(false);
  });

  it('copy resends the last output; retry re-delivers the last prompt', async () => {
    const h = makeController();
    await h.controller.beginTurn('oc_chat', 'om-1', 'T');
    h.controller.rememberPrompt('oc_chat', 'retry me');
    await h.controller.handleEvent('feishu-session-1', chunkEvent('answer'));
    await h.controller.handleEvent('feishu-session-1', turnEndEvent({ kind: 'completed' }));
    await h.controller.handleStreamingAction(action('copy'));
    expect(h.transport.sentTexts.some((t) => t.text === 'answer')).toBe(true);
    await h.controller.handleStreamingAction(action('retry'));
    expect(h.followups.some((f) => f.content === 'retry me')).toBe(true);
    expect(h.controller.isWorking('oc_chat')).toBe(true);
  });

  it('copy with no completed answer explains instead of silently ignoring', async () => {
    const h = makeController();
    await h.controller.handleStreamingAction(action('copy'));
    expect(h.transport.sentTexts.some((t) => t.text.includes('Nothing to copy'))).toBe(true);
  });

  it('stop cancels the running agent and marks the card Stopping', async () => {
    const h = makeController();
    await h.controller.beginTurn('oc_chat', 'om-1', 'T');
    await h.controller.handleStreamingAction(action('stop'));
    expect(h.cancels).toHaveLength(1);
    expect(h.cancels[0]?.keepInbox).toBe(true);
    expect(h.controller.state('oc_chat')?.stopRequested).toBe(true);
  });

  it('stop on an idle agent explains instead of hanging', async () => {
    const h = makeController();
    h.setStatus('idle');
    await h.controller.beginTurn('oc_chat', 'om-1', 'T');
    await h.controller.handleStreamingAction(action('stop'));
    expect(h.cancels).toHaveLength(0);
    expect(h.transport.sentTexts.some((t) => t.text.includes('No active turn to stop'))).toBe(true);
  });

  it('toggle-rows flips the collapsed bit and re-renders', async () => {
    const h = makeController();
    await h.controller.beginTurn('oc_chat', 'om-1', 'T');
    await h.controller.handleEvent('feishu-session-1', reasoningEvent('thinking…'));
    expect(h.controller.state('oc_chat')?.collapsed).toBe(true);
    // A real callback carries the message id of the card that was clicked
    // (here: the live card just posted by beginTurn — RecordingTransport
    // assigns 'msg-1' to the first sent card).
    await h.controller.handleStreamingAction({ ...action('toggle-rows'), messageId: 'msg-1' });
    expect(h.controller.state('oc_chat')?.collapsed).toBe(false);
  });

  it('toggle-rows on a HISTORICAL card retargets that card, not the latest (regression)', async () => {
    // User report: expand/collapse on an old card cross-wired to the newest
    // one — the handler keyed everything by chatId. The callback's own
    // message id must address the clicked card.
    const h = makeController();
    // Turn 1: post a card WITH tool rows (the only cards that carry the
    // expand/collapse button), finish it, expand it so the frozen render
    // ends expanded.
    await h.controller.beginTurn('oc_chat', 'om-1', 'first turn');
    await h.controller.handleEvent('feishu-session-1', reasoningEvent('analyzing…'));
    await h.controller.handleEvent('feishu-session-1', turnEndEvent({ kind: 'completed' }));
    await new Promise((resolve) => setTimeout(resolve, 0)); // deferred final render
    const firstCardId = 'msg-1';
    await h.controller.handleStreamingAction({ ...action('toggle-rows'), messageId: firstCardId });
    expect(h.controller.state('oc_chat')?.collapsed).toBe(false); // still the live card
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Turn 2: a NEW card becomes the latest.
    await h.controller.beginTurn('oc_chat', 'om-2', 'second turn');
    expect(h.transport.sentCards).toHaveLength(2);
    await h.controller.handleEvent('feishu-session-1', turnEndEvent({ kind: 'completed' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const updatesBefore = h.transport.updatedTargets.length;
    // Click Expand on the OLD card.
    await h.controller.handleStreamingAction({
      ...action('toggle-rows'),
      messageId: firstCardId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const updates = h.transport.updatedTargets.slice(updatesBefore);
    // The re-render targeted the OLD message id…
    expect(updates.map((u) => u.messageId)).toEqual([firstCardId]);
    // …and toggled IT (frozen render was expanded -> now shows Expand, i.e.
    // clicking collapsed that historical card alone).
    expect(JSON.stringify(updates[0]?.card.elements)).toContain('▸ Expand');
    // …leaving the LATEST card's authoritative state untouched.
    expect(h.controller.state('oc_chat')?.collapsed).toBe(true);
  });

  it('toggle-rows on an unretained historical card is ignored (no cross-wiring)', async () => {
    const h = makeController();
    await h.controller.beginTurn('oc_chat', 'om-1', 'T');
    await h.controller.handleEvent('feishu-session-1', reasoningEvent('thinking…'));
    await h.controller.handleEvent('feishu-session-1', turnEndEvent({ kind: 'completed' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const updatesBefore = h.transport.updatedTargets.length;
    await h.controller.handleStreamingAction({
      ...action('toggle-rows'),
      messageId: 'msg-from-before-the-restart',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // An id we never rendered must NOT touch the current card either —
    // silently re-rendering the latest card is exactly the reported bug.
    expect(h.transport.updatedTargets.slice(updatesBefore)).toHaveLength(0);
  });

  it('a compaction transaction opens and finalizes its own card', async () => {
    const h = makeController();
    await h.controller.handleEvent('feishu-session-1', {
      type: 'compaction/start',
      data: {},
    } as unknown as SessionEvent);
    expect(h.controller.state('oc_chat')?.title).toBe('🧹 Compacting…');
    await h.controller.handleEvent('feishu-session-1', {
      type: 'compaction/summary',
      data: { summary: 'old history summarized' },
    } as unknown as SessionEvent);
    expect(h.controller.state('oc_chat')?.content).toBe('old history summarized');
    await h.controller.handleEvent('feishu-session-1', {
      type: 'compaction/end',
      data: {},
    } as unknown as SessionEvent);
    expect(h.controller.state('oc_chat')?.status).toBe('done');
    expect(h.controller.lastOutput('oc_chat')).toBe('old history summarized');
  });

  it('ignores a malformed action kind without side effects', async () => {
    const h = makeController();
    await h.controller.handleStreamingAction(action('panel'));
    expect(h.transport.sentCards).toHaveLength(0);
    expect(h.transport.sentTexts).toHaveLength(0);
  });

  it('renders a finished card through the deferred update path (lastCard)', async () => {
    const h = makeController();
    await h.controller.beginTurn('oc_chat', 'om-1', 'T');
    await h.controller.handleEvent('feishu-session-1', turnEndEvent({ kind: 'completed' }));
    // Wait for the deferred macrotask update.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastCard(h)?.header?.title.content).toBe('T');
    // The terminal render carries the Done note (finalized in place).
    expect(JSON.stringify(lastCard(h)?.elements)).toContain('✅ Done');
  });
});

describe('friendlyTurnError', () => {
  it('returns the raw code and message (UX hook, no curated copy yet)', () => {
    expect(
      friendlyTurnError({ code: 'MISSING_CREDENTIAL', message: 'llm-deepseek: no API key' }),
    ).toBe('MISSING_CREDENTIAL: llm-deepseek: no API key');
    expect(friendlyTurnError({ code: 'NO_ADAPTER', message: 'no adapter' })).toBe(
      'NO_ADAPTER: no adapter',
    );
  });

  it('falls back to the message when the code is blank', () => {
    expect(friendlyTurnError({ code: '', message: 'the sandbox exploded' })).toBe(
      'the sandbox exploded',
    );
  });

  it('falls back to the code when the message is blank', () => {
    expect(friendlyTurnError({ code: 'E_BOOM', message: '  ' })).toBe('E_BOOM');
  });

  it('never returns an empty string, even with no code and no message', () => {
    const text = friendlyTurnError({ code: '', message: '' });
    expect(text.trim()).not.toBe('');
  });
});

function action(kind: string, extra: Record<string, string> = {}): CardAction {
  return {
    messageId: 'mem-1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_user',
    value: { kind, ...extra },
  };
}
