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
  async sendText(_chatId: string, _text: string): Promise<void> {}
  async sendCard(_chatId: string, card: CardJson): Promise<SentCard> {
    this.sent.push(card);
    const messageId = `msg-${this.sent.length}`;
    this.sentMessageIds.push(messageId);
    return { messageId };
  }
  async updateCard(_messageId: string, card: CardJson): Promise<void> {
    this.updated.push(card);
  }
}

function snapshot(overrides: Partial<CardSnapshot> = {}): CardSnapshot {
  return { title: 'T', content: '', toolLines: [], status: 'working', ...overrides };
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
