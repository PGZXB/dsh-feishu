/**
 * Unit tests for the file-channel memory transport (the integration-test
 * seam): inbox delivery, outbox recording, and lifecycle.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuMessage } from '../src/feishu/types.js';
import { MemoryTransport } from '../src/memory-transport.js';

const SCRATCH = join(process.cwd(), '_dev', 'test-memory-transport');

function message(overrides: Partial<FeishuMessage> = {}): FeishuMessage {
  return {
    messageId: 'om_int_1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderOpenId: 'ou_user',
    text: 'hello',
    mentions: [],
    attachments: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('MemoryTransport', () => {
  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('delivers messages dropped into the inbox and removes the file', async () => {
    const transport = new MemoryTransport({ dir: SCRATCH, pollIntervalMs: 100 });
    const delivered: FeishuMessage[] = [];
    transport.onMessage((m) => delivered.push(m));
    await transport.start();
    writeFileSync(join(SCRATCH, 'inbox', 'om_int_1.json'), JSON.stringify(message()), 'utf8');
    await vi.advanceTimersByTimeAsync(100);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe('hello');
    // File was removed after delivery; a second poll delivers nothing new.
    await vi.advanceTimersByTimeAsync(200);
    expect(delivered).toHaveLength(1);
  });

  it('supports direct same-process delivery', async () => {
    const transport = new MemoryTransport({ dir: SCRATCH });
    const delivered: FeishuMessage[] = [];
    transport.onMessage((m) => delivered.push(m));
    await transport.start();
    transport.deliver(message());
    expect(delivered).toHaveLength(1);
  });

  it('records text sends in the outbox', async () => {
    const transport = new MemoryTransport({ dir: SCRATCH });
    await transport.start();
    await transport.sendText('oc_chat', 'the answer');
    const records = transport.outbox();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'text', chatId: 'oc_chat', text: 'the answer' });
  });

  it('records file sends in the outbox (/export seam)', async () => {
    const transport = new MemoryTransport({ dir: SCRATCH });
    await transport.start();
    await transport.sendFile('oc_chat', 'session-x.md', new TextEncoder().encode('# log'));
    const records = transport.outbox();
    expect(records[0]).toMatchObject({
      kind: 'file',
      chatId: 'oc_chat',
      fileName: 'session-x.md',
    });
    // `content` holds the raw bytes as a number array (binary-safe seam).
    expect(Buffer.from(records[0]?.content ?? []).toString('utf8')).toBe('# log');
  });

  it('records card sends and patches in order', async () => {
    const transport = new MemoryTransport({ dir: SCRATCH });
    await transport.start();
    const { messageId } = await transport.sendCard('oc_chat', {
      elements: [],
    });
    await transport.updateCard(messageId, {
      elements: [{ tag: 'hr' }],
    });
    const records = transport.outbox();
    expect(records.map((r) => r.kind)).toEqual(['card', 'patch']);
    expect(records[0]?.messageId).toBe(messageId);
  });

  it('records reaction adds and removals in the outbox (two-stage ack seam)', async () => {
    const transport = new MemoryTransport({ dir: SCRATCH });
    await transport.start();
    const messageId = 'om_reaction_1';
    const reactionId = await transport.addReaction(messageId, 'GoGoGo');
    expect(reactionId).toMatch(/^reaction-\d+$/);
    await transport.removeReaction(messageId, reactionId as string);
    const records = transport.outbox();
    expect(records.map((r) => r.kind)).toEqual(['reaction', 'reaction']);
    expect(records[0]).toMatchObject({
      kind: 'reaction',
      messageId,
      action: 'add',
      emojiType: 'GoGoGo',
      reactionId,
    });
    expect(records[1]).toMatchObject({
      kind: 'reaction',
      messageId,
      action: 'remove',
      reactionId,
    });
  });

  it('stops polling after stop()', async () => {
    const transport = new MemoryTransport({ dir: SCRATCH, pollIntervalMs: 100 });
    const delivered: FeishuMessage[] = [];
    transport.onMessage((m) => delivered.push(m));
    await transport.start();
    await transport.stop();
    writeFileSync(join(SCRATCH, 'inbox', 'om_int_2.json'), JSON.stringify(message()), 'utf8');
    await vi.advanceTimersByTimeAsync(300);
    expect(delivered).toHaveLength(0);
  });

  describe('inbound attachment downloads', () => {
    const bytes = new Uint8Array([1, 2, 3]);

    it('downloadImage resolves seeded bytes with the declared media type', async () => {
      const transport = new MemoryTransport({
        dir: SCRATCH,
        attachments: new Map([['img-1', { data: bytes, mediaType: 'image/jpeg' }]]),
      });
      const result = await transport.downloadImage('om_x', 'img-1');
      expect(result.data).toEqual(bytes);
      expect(result.mediaType).toBe('image/jpeg');
    });

    it('downloadImage defaults the media type to png when undeclared', async () => {
      const transport = new MemoryTransport({
        dir: SCRATCH,
        attachments: new Map([['img-1', { data: bytes }]]),
      });
      expect((await transport.downloadImage('om_x', 'img-1')).mediaType).toBe('image/png');
    });

    it('downloadImage throws for an unknown key', async () => {
      const transport = new MemoryTransport({ dir: SCRATCH });
      await expect(transport.downloadImage('om_x', 'nope')).rejects.toThrow(/no seeded image/);
    });

    it('downloadFile streams seeded bytes with the head re-pushed, and throws for an unknown key', async () => {
      const transport = new MemoryTransport({
        dir: SCRATCH,
        attachments: new Map([['file-1', { data: bytes }]]),
      });
      const { stream, head } = await transport.downloadFile('om_x', 'file-1');
      expect(head).toEqual(bytes); // smaller than 16 bytes → whole body
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const collected = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        collected.set(chunk, offset);
        offset += chunk.length;
      }
      expect(collected).toEqual(bytes);
      await expect(transport.downloadFile('om_x', 'nope')).rejects.toThrow(/no seeded file/);
    });
  });
});
