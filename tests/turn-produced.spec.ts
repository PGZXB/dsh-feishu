/**
 * Unit tests for turn-produced-files: the StreamingCardController collects
 * write/edit mutation paths from `tool/result` meta.diffs into the card
 * state, the terminal card renders `📎 Produced` chips, and a chip tap
 * (`send-produced` action) sends the file to the chat.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCard } from '../src/cards/render.js';
import {
  StreamingCardController,
  type StreamingCardHost,
} from '../src/cards/StreamingCardController.js';
import { StreamingCardManager } from '../src/cards/streaming.js';
import type { CardAction, CardJson, FeishuTransport } from '../src/feishu/types.js';
import { SessionMap } from '../src/session-map.js';

class RecordingTransport implements FeishuTransport {
  sentCards: CardJson[] = [];
  updatedCards: CardJson[] = [];
  sentImages: Array<{ chatId: string; fileName: string; bytes: Uint8Array }> = [];
  sentFiles: Array<{ chatId: string; fileName: string; content: Uint8Array }> = [];
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
  async sendFile(chatId: string, fileName: string, content: Uint8Array): Promise<void> {
    this.sentFiles.push({ chatId, fileName, content });
  }
  async sendImage(chatId: string, fileName: string, bytes: Uint8Array): Promise<void> {
    this.sentImages.push({ chatId, fileName, bytes });
  }
  async addReaction(_messageId: string, _emojiType: string): Promise<string | undefined> {
    return undefined;
  }
  async removeReaction(_messageId: string, _reactionId: string): Promise<void> {}
  async sendCard(chatId: string, card: CardJson): Promise<{ messageId: string }> {
    this.sentCards.push({ ...card, chatId } as CardJson);
    return { messageId: `m-${this.sentCards.length}` };
  }
  async updateCard(_messageId: string, card: CardJson): Promise<void> {
    this.updatedCards.push(card);
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

function makeController(cwd: string): {
  controller: StreamingCardController;
  transport: RecordingTransport;
} {
  const transport = new RecordingTransport();
  const sessionMap = new SessionMap(join(cwd, 'session-map.json'));
  sessionMap.set('oc_chat', 's1');
  sessionMap.setCwd('oc_chat', cwd);
  const cards = new StreamingCardManager(transport);
  const host = {
    transport,
    cards,
    logger: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
    sessionMap,
    agentStore: {
      get: () => undefined,
      resume: async () => undefined,
      create: async () => undefined,
    },
    defaultCwd: cwd,
    reactions: undefined,
    resolveAgent: async () => undefined,
    textMentionFor: () => '',
  } as unknown as StreamingCardHost;
  const controller = new StreamingCardController(host);
  return { controller, transport };
}

function toolCallEvent(name: string, args: string, callId = 'c1'): SessionEvent {
  return {
    type: 'tool/call',
    seq: 1,
    time: 0,
    data: { turn: 1, step: 1, callId, name, arguments: args },
  } as unknown as SessionEvent;
}

function toolResultEvent(diffs?: { path: string }[], callId = 'c1'): SessionEvent {
  return {
    type: 'tool/result',
    seq: 1,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        content: [{ text: 'ok', type: 'tool-result', toolCallId: callId }],
        source: { callId },
      },
      ...(diffs !== undefined ? { meta: { diffs } } : {}),
    },
  } as unknown as SessionEvent;
}

describe('turn-produced-files', () => {
  let dir: string;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('collects write/edit mutation paths from tool/result meta.diffs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tpf-'));
    const { controller } = makeController(dir);
    await controller.beginTurn('oc_chat', 'om-1', 'do work');
    expect(controller.state('oc_chat')?.producedPaths).toEqual([]);
    await controller.handleEvent('s1', toolResultEvent([{ path: 'report.md' }]));
    await controller.handleEvent('s1', toolResultEvent([{ path: 'plot.png' }]));
    expect(controller.state('oc_chat')?.producedPaths).toEqual(['report.md', 'plot.png']);
  });

  it('does NOT collect a read tool (meta without diffs)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tpf-'));
    const { controller } = makeController(dir);
    await controller.beginTurn('oc_chat', 'om-1', 'do work');
    // A read carries a window/snippet meta, NOT diffs.
    await controller.handleEvent('s1', {
      type: 'tool/result',
      seq: 1,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: { content: [], source: { callId: 'r1' } },
        meta: { snippet: 'abc' },
      },
    } as unknown as SessionEvent);
    expect(controller.state('oc_chat')?.producedPaths).toEqual([]);
  });

  it('collects a NEW-file create path from the correlate tool/call file_path (empty meta.diffs)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tpf-'));
    const { controller } = makeController(dir);
    await controller.beginTurn('oc_chat', 'om-1', 'do work');
    // A `write` CREATE carries `meta.diffs: []` (no before-image to diff), so
    // the path is derived from the correlated tool/call arguments' file_path.
    await controller.handleEvent(
      's1',
      toolCallEvent('write', '{"file_path":"report.md","content":"x"}'),
    );
    await controller.handleEvent('s1', toolResultEvent([], 'c1'));
    expect(controller.state('oc_chat')?.producedPaths).toEqual(['report.md']);
  });

  it('ignores an empty meta.diffs without a correlating file_path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tpf-'));
    const { controller } = makeController(dir);
    await controller.beginTurn('oc_chat', 'om-1', 'do work');
    // No tool/call row to correlate to -> no path (never a broken chip).
    await controller.handleEvent('s1', toolResultEvent([]));
    expect(controller.state('oc_chat')?.producedPaths).toEqual([]);
  });

  it('resets producedPaths on a new turn (beginTurn)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tpf-'));
    const { controller } = makeController(dir);
    await controller.beginTurn('oc_chat', 'om-1', 'first');
    await controller.handleEvent('s1', toolResultEvent([{ path: 'a.md' }]));
    expect(controller.state('oc_chat')?.producedPaths).toEqual(['a.md']);
    await controller.beginTurn('oc_chat', 'om-2', 'second');
    expect(controller.state('oc_chat')?.producedPaths).toEqual([]);
  });

  it('renders 📎 Produced chips on the terminal card only when there are produced paths', () => {
    const withProduced = buildCard({
      title: 't',
      content: 'done',
      rows: [],
      status: 'done',
      producedPaths: ['report.md', 'plot.png'],
    });
    const json = JSON.stringify(withProduced.elements);
    expect(json).toContain('📎 Produced');
    expect(json).toContain('report.md');
    expect(json).toContain('plot.png');
    // No produced paths -> no chips row.
    const noneProduced = buildCard({ title: 't', content: 'x', rows: [], status: 'done' });
    expect(JSON.stringify(noneProduced.elements)).not.toContain('📎 Produced');
    // Working card never renders chips.
    const working = buildCard({
      title: 't',
      content: 'x',
      rows: [],
      status: 'working',
      producedPaths: ['a.md'],
    });
    expect(JSON.stringify(working.elements)).not.toContain('📎 Produced');
  });

  it('a send-produced action sends an image for an image path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tpf-'));
    writeFileSync(join(dir, 'plot.png'), new Uint8Array([137, 80, 78, 71]));
    const { controller, transport } = makeController(dir);
    await controller.handleStreamingAction({
      chatId: 'oc_chat',
      messageId: 'm1',
      operatorOpenId: 'u1',
      value: { kind: 'send-produced', path: 'plot.png' },
    } as CardAction);
    expect(transport.sentImages).toHaveLength(1);
    expect(transport.sentImages[0]?.fileName).toBe('plot.png');
    expect(transport.sentFiles).toHaveLength(0);
  });

  it('a send-produced action sends a file for a non-image path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tpf-'));
    writeFileSync(join(dir, 'report.md'), 'content');
    const { controller, transport } = makeController(dir);
    await controller.handleStreamingAction({
      chatId: 'oc_chat',
      messageId: 'm1',
      operatorOpenId: 'u1',
      value: { kind: 'send-produced', path: 'report.md' },
    } as CardAction);
    expect(transport.sentFiles).toHaveLength(1);
    expect(transport.sentFiles[0]?.fileName).toBe('report.md');
    expect(transport.sentImages).toHaveLength(0);
  });

  it('a send-produced action with a missing file fails loud and sends a notice', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tpf-'));
    const { controller, transport } = makeController(dir);
    await controller.handleStreamingAction({
      chatId: 'oc_chat',
      messageId: 'm1',
      operatorOpenId: 'u1',
      value: { kind: 'send-produced', path: 'nope.md' },
    } as CardAction);
    expect(transport.sentFiles).toHaveLength(0);
    expect(transport.sentTexts.some((t) => t.text.includes('Could not send'))).toBe(true);
  });
});
