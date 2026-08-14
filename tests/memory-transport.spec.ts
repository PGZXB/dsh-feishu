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
    await transport.sendFile('oc_chat', 'session-x.md', '# log');
    const records = transport.outbox();
    expect(records[0]).toMatchObject({
      kind: 'file',
      chatId: 'oc_chat',
      fileName: 'session-x.md',
      content: '# log',
    });
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
});
