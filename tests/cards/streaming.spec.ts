/**
 * Unit tests for the streaming card pipeline: open, throttled/coalesced
 * patches, finalize, and the no-patch-after-close contract.
 *
 * Uses fake timers and a recording fake transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardSnapshot } from '../../src/cards/render.js';
import { StreamingCardManager } from '../../src/cards/streaming.js';
import type {
  CardAction,
  CardJson,
  ChatStats,
  FeishuMessage,
  FeishuTransport,
  SentCard,
} from '../../src/feishu/types.js';

/** Records every transport interaction for assertions. */
class RecordingTransport implements FeishuTransport {
  sent: CardJson[] = [];
  updated: CardJson[] = [];
  sentMessageIds: string[] = [];
  onMessageCalled = false;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(_handler: (message: FeishuMessage) => void): void {
    this.onMessageCalled = true;
  }
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
  async sendText(_chatId: string, _text: string): Promise<void> {}
  async sendFile(_chatId: string, _fileName: string, _content: string): Promise<void> {}
  async addReaction(_messageId: string, _emojiType: string): Promise<string | undefined> {
    return undefined;
  }
  async removeReaction(_messageId: string, _reactionId: string): Promise<void> {}

  async sendCard(_chatId: string, card: CardJson): Promise<SentCard> {
    this.sent.push(card);
    const messageId = `msg-${this.sent.length}`;
    this.sentMessageIds.push(messageId);
    return { messageId };
  }
  /** Remaining times updateCard rejects (simulating a Feishu 400). */
  updateFailures = 0;

  async updateCard(_messageId: string, card: CardJson): Promise<void> {
    if (this.updateFailures > 0) {
      this.updateFailures -= 1;
      throw new Error('card table number over limit');
    }
    this.updated.push(card);
  }
  async deleteMessage(_messageId: string): Promise<void> {}
  async downloadImage(
    _messageId: string,
    _key: string,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    throw new Error('downloadImage not implemented in this fake');
  }
  async downloadFile(_messageId: string, _key: string): Promise<Uint8Array> {
    throw new Error('downloadFile not implemented in this fake');
  }
}
function snapshot(overrides: Partial<CardSnapshot> = {}): CardSnapshot {
  return { title: 'T', content: '', rows: [], status: 'working', ...overrides };
}

describe('StreamingCardManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts one card on open', async () => {
    const transport = new RecordingTransport();
    const manager = new StreamingCardManager(transport);
    await manager.open('oc_chat', 'hello');
    expect(transport.sent).toHaveLength(1);
    expect(manager.isActive('oc_chat')).toBe(true);
  });

  it('coalesces bursts of patches into a single update', async () => {
    const transport = new RecordingTransport();
    const manager = new StreamingCardManager(transport, { throttleMs: 100 });
    await manager.open('oc_chat', 'hello');
    manager.patch('oc_chat', snapshot({ content: 'a' }));
    manager.patch('oc_chat', snapshot({ content: 'ab' }));
    manager.patch('oc_chat', snapshot({ content: 'abc' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.updated).toHaveLength(1);
    expect(transport.updated[0]?.elements).toContainEqual({ tag: 'markdown', content: 'abc' });
  });

  it('flushes pending work that arrives while a patch is in flight', async () => {
    const transport = new RecordingTransport();
    // Keep the first update pending so a second snapshot lands mid-flight.
    let release: (() => void) | undefined;
    transport.updateCard = (_messageId, card) => {
      transport.updated.push(card);
      return new Promise<void>((resolve) => {
        release = () => resolve();
      });
    };
    const manager = new StreamingCardManager(transport, { throttleMs: 100 });
    await manager.open('oc_chat', 'hello');
    manager.patch('oc_chat', snapshot({ content: 'one' }));
    await vi.advanceTimersByTimeAsync(100);
    manager.patch('oc_chat', snapshot({ content: 'two' }));
    await vi.advanceTimersByTimeAsync(100);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.updated.map((c) => (c.elements[0] as { content?: string }).content)).toEqual([
      'one',
      'two',
    ]);
  });

  it('a failed patch is logged and the stream continues with the newest snapshot', async () => {
    // Regression: a Feishu 400 (e.g. 'card table number over limit', which
    // surfaces as '目标回调服务未在线') must not kill the streaming card.
    const transport = new RecordingTransport();
    transport.updateFailures = 1; // the first patch fails
    const warnings: string[] = [];
    const manager = new StreamingCardManager(transport, {
      throttleMs: 100,
      logger: { warn: (message) => warnings.push(message), debug: () => {} },
    });
    await manager.open('oc_chat', 'hello');
    manager.patch('oc_chat', snapshot({ content: 'first (fails)' }));
    await vi.advanceTimersByTimeAsync(100);
    // The failure is logged, the manager stays live, and the next patch lands.
    expect(warnings.some((w) => w.includes('patch failed'))).toBe(true);
    manager.patch('oc_chat', snapshot({ content: 'second (lands)' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.updated.map((c) => (c.elements[0] as { content?: string }).content)).toEqual([
      'second (lands)',
    ]);
    expect(manager.isActive('oc_chat')).toBe(true);
  });

  it('finalize flushes the terminal snapshot and retires the card', async () => {
    const transport = new RecordingTransport();
    const manager = new StreamingCardManager(transport, { throttleMs: 100 });
    await manager.open('oc_chat', 'hello');
    manager.patch('oc_chat', snapshot({ content: 'final', status: 'working' }));
    await manager.finalize('oc_chat', 'done');
    expect(transport.updated).toHaveLength(1);
    expect(transport.updated[0]?.header?.template).toBe('green');
    expect(manager.isActive('oc_chat')).toBe(false);
  });

  it('finalize without pending snapshot still retires the card', async () => {
    const transport = new RecordingTransport();
    const manager = new StreamingCardManager(transport);
    await manager.open('oc_chat', 'hello');
    await manager.finalize('oc_chat', 'done');
    expect(transport.updated).toHaveLength(0);
    expect(manager.isActive('oc_chat')).toBe(false);
  });

  it('ignores patches after finalize', async () => {
    const transport = new RecordingTransport();
    const manager = new StreamingCardManager(transport, { throttleMs: 100 });
    await manager.open('oc_chat', 'hello');
    await manager.finalize('oc_chat', 'done');
    manager.patch('oc_chat', snapshot({ content: 'late' }));
    await vi.advanceTimersByTimeAsync(200);
    expect(transport.updated).toHaveLength(0);
  });

  it('replaces a stale active card when a new turn opens', async () => {
    const transport = new RecordingTransport();
    const manager = new StreamingCardManager(transport, { throttleMs: 100 });
    await manager.open('oc_chat', 'first');
    manager.patch('oc_chat', snapshot({ content: 'stale' }));
    await manager.open('oc_chat', 'second');
    expect(transport.sent).toHaveLength(2);
    // The stale card was finalized (done) before the new one posted.
    expect(transport.updated).toHaveLength(1);
    expect(transport.updated[0]?.header?.template).toBe('green');
    expect(manager.isActive('oc_chat')).toBe(true);
  });
});
