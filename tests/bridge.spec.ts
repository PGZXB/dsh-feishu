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
import { Readable } from 'node:stream';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentDefaultModelService,
  Bridge,
  type BridgeOptions,
  type LlmService,
  type ModelSelectionView,
  type PermissionPresetService,
  type PlanModeService,
  type SessionListRow,
  sniffExtension,
  turnTitle,
} from '../src/bridge.js';
import { SESSION_SELECT_MAX } from '../src/cards/session-list.js';
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
  sentFiles: Array<{ chatId: string; fileName: string; content: Uint8Array }> = [];
  async sendFile(chatId: string, fileName: string, content: Uint8Array): Promise<void> {
    this.sentFiles.push({ chatId, fileName, content });
  }
  sentImages: Array<{ chatId: string; fileName: string; bytes: Uint8Array }> = [];
  async sendImage(chatId: string, fileName: string, bytes: Uint8Array): Promise<void> {
    this.sentImages.push({ chatId, fileName, bytes });
  }
  connectionState?: () => 'ready' | 'reconnecting' | 'error';
  reactions: Array<{
    messageId: string;
    emojiType?: string;
    action: 'add' | 'remove';
    reactionId?: string;
  }> = [];
  private reactionSeq = 0;
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
    this.updatedMessageIds.push(messageId);
  }
  /** Which card each in-place update targeted (per-card stack assertions). */
  readonly updatedMessageIds: string[] = [];
  readonly deletedMessages: string[] = [];
  async deleteMessage(messageId: string): Promise<void> {
    this.deletedMessages.push(messageId);
  }
  /** Configurable inbound-download behavior (default: fail — tests seed
   *  success/failure per scenario). */
  downloadImageImpl?: (key: string) => Promise<{ data: Uint8Array; mediaType: string }>;
  downloadFileImpl?: (key: string) => Promise<Uint8Array>;
  async downloadImage(
    _messageId: string,
    key: string,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    if (this.downloadImageImpl === undefined) throw new Error(`no downloadImage for ${key}`);
    return this.downloadImageImpl(key);
  }
  async downloadFile(
    _messageId: string,
    key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; head: Uint8Array }> {
    if (this.downloadFileImpl === undefined) throw new Error(`no downloadFile for ${key}`);
    const data = await this.downloadFileImpl(key);
    return { stream: Readable.from([data]), head: data.slice(0, 16) };
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
  private readonly options = new Map<string, { provider: string; model: string }>();

  /** Set the lifecycle status of a created agent (defaults to running). */
  setStatus(sessionId: string, status: 'idle' | 'running'): void {
    this.statuses.set(sessionId, status);
  }

  /** Set the provider/model options a created agent reports. */
  setOptions(sessionId: string, options: { provider: string; model: string }): void {
    this.options.set(sessionId, options);
  }

  private makeAgent(sessionId: string): Agent {
    const statuses = this.statuses;
    const optionMap = this.options;
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
      session: { id: sessionId, events: [] },
      // A stable scoped ctx with a minimal `on` so the real
      // installModelSelection (coupled by the /model session switch) registers
      // its waterfall listeners without throwing. The listeners are never
      // invoked in a fake run; the identity is what keys the model-switch ref.
      ctx: { on: () => () => {} },
      get options() {
        return optionMap.get(sessionId) ?? {};
      },
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
    allowedUsers?: readonly string[];
    executeCommand?: (agent: Agent, line: string) => Promise<CommandResult | undefined>;
    unknownCommand?: 'error' | 'passthrough';
    repoRoots?: readonly string[];
    listSessions?: () => Promise<readonly SessionListRow[] | undefined>;
    permissionPresets?: PermissionPresetService;
    planMode?: PlanModeService;
    agentDefaultModel?: AgentDefaultModelService;
    llm?: LlmService;
    requireWorkingDir?: boolean;
    appId?: string;
    transportMode?: 'lark' | 'memory';
    reactions?: NonNullable<BridgeOptions['reactions']>;
    readSession?: NonNullable<BridgeOptions['readSession']>;
    sessionTitle?: NonNullable<BridgeOptions['sessionTitle']>;
    getWorkspaceRegistry?: NonNullable<BridgeOptions['getWorkspaceRegistry']>;
    saveInboundFile?: NonNullable<BridgeOptions['saveInboundFile']>;
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
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    ...(options.groupMentionMode !== undefined
      ? { groupMentionMode: options.groupMentionMode }
      : {}),
    ...(options.allowedChats !== undefined ? { allowedChats: options.allowedChats } : {}),
    ...(options.allowedUsers !== undefined ? { allowedUsers: options.allowedUsers } : {}),
    ...(options.executeCommand !== undefined ? { executeCommand: options.executeCommand } : {}),
    ...(options.unknownCommand !== undefined ? { unknownCommand: options.unknownCommand } : {}),
    ...(options.repoRoots !== undefined ? { repoRoots: options.repoRoots } : {}),
    ...(options.listSessions !== undefined ? { listSessions: options.listSessions } : {}),
    ...(options.permissionPresets !== undefined
      ? { permissionPresets: options.permissionPresets }
      : {}),
    ...(options.planMode !== undefined ? { planMode: options.planMode } : {}),
    ...(options.agentDefaultModel !== undefined
      ? { agentDefaultModel: options.agentDefaultModel }
      : {}),
    ...(options.llm !== undefined ? { llm: options.llm } : {}),
    ...(options.reactions !== undefined ? { reactions: options.reactions } : {}),
    ...(options.readSession !== undefined ? { readSession: options.readSession } : {}),
    ...(options.sessionTitle !== undefined ? { sessionTitle: options.sessionTitle } : {}),
    ...(options.getWorkspaceRegistry !== undefined
      ? { getWorkspaceRegistry: options.getWorkspaceRegistry }
      : {}),
    ...(options.saveInboundFile !== undefined ? { saveInboundFile: options.saveInboundFile } : {}),
    // Tests default the working-directory gate OFF (production defaults it
    // ON); the gate's own tests enable it explicitly.
    requireWorkingDir: options.requireWorkingDir ?? false,
    ...(options.appId !== undefined ? { appId: options.appId } : {}),
    ...(options.transportMode !== undefined ? { transportMode: options.transportMode } : {}),
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
    attachments: [],
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

  describe('sniffExtension', () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

    it('detects common binary formats from magic bytes', () => {
      expect(sniffExtension(enc('%PDF-1.7'))).toBe('pdf');
      expect(sniffExtension(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
      expect(sniffExtension(enc('{"a":1}'))).toBe('json');
      expect(sniffExtension(enc('<?xml version="1.0"?>'))).toBe('xml');
      expect(sniffExtension(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('png');
      expect(sniffExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
      expect(sniffExtension(enc('GIF89a'))).toBe('gif');
    });

    it('detects video containers from their magic bytes', () => {
      // MP4/MOV: 'ftyp' at offset 4 (ISO BMFF).
      const mp4 = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      ]);
      expect(sniffExtension(mp4)).toBe('mp4');
      // WebM/MKV: EBML magic 1A 45 DF A3.
      const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
      expect(sniffExtension(webm)).toBe('webm');
      // AVI: 'RIFF' + 'AVI ' at offset 8.
      const avi = enc('RIFF\x24\x00\x00\x00AVI LIST');
      expect(sniffExtension(avi)).toBe('avi');
    });

    it('classifies printable text as txt and unknown binary as bin', () => {
      expect(sniffExtension(enc('hello world\n'))).toBe('txt');
      expect(sniffExtension(new Uint8Array([0x00, 0x01, 0xff, 0xfe]))).toBe('bin');
    });
  });

  describe('inbound attachments', () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71]);

    it('registers a bare image message as pending: saved as a file, receipt card, no image block, no turn until a follow-up', async () => {
      const h = makeHarness({
        saveInboundFile: async ({ attachment, stream, extension }) => {
          // Images land in the same attachment bucket as files; the sniffed
          // extension comes from the PNG magic bytes (png).
          expect(attachment.kind).toBe('image');
          expect(extension).toBe('png');
          const chunks: Uint8Array[] = [];
          for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
            chunks.push(chunk);
          }
          expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(pngBytes.length);
          return { path: '/work/.dsh_feishu/attachments/img-1.png' };
        },
      });
      h.transport.downloadImageImpl = async () => ({ data: pngBytes, mediaType: 'image/png' });
      await h.bridge.handleMessage(
        message({
          text: '',
          attachments: [{ kind: 'image', key: 'img-1' }],
        }),
      );
      // Pending: receipt card posts, NO turn, NO image block injected.
      expect(h.transport.sentCards).toHaveLength(1);
      expect(h.transport.sentCards[0]?.header?.title.content).toBe('📎 File received');
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
      // The follow-up text drains the image as a FILE note (no image block —
      // Feishu images are plain files to the agent).
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'look at this' }));
      const followups = h.agentStore.followups.get('feishu-session-1');
      const blocks = followups?.[0]?.content as unknown[];
      expect(JSON.stringify(blocks)).toContain('/work/.dsh_feishu/attachments/img-1.png');
      expect(JSON.stringify(blocks)).not.toContain('"type":"image"');
    });

    it('a failed image download registers nothing and never wedges the chat', async () => {
      const h = makeHarness(); // downloadImageImpl left unset → throws
      await h.bridge.handleMessage(
        message({
          text: '',
          attachments: [{ kind: 'image', key: 'missing' }],
        }),
      );
      // The degraded receipt card posts (no path), nothing registers, no turn.
      expect(h.transport.sentCards).toHaveLength(1);
      expect(h.transport.sentCards[0]?.header?.title.content).toBe('📎 File received');
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
      // A follow-up text message still works normally.
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'hi' }));
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
    });

    it('registers a bare file message as pending: receipt card, no turn until a follow-up instruction', async () => {
      const h = makeHarness({
        saveInboundFile: async ({ stream, extension }) => {
          // The stream carries the full body (head re-pushed); the sniffed
          // extension comes from the downloaded bytes ([1,2,3] → bin).
          expect(extension).toBe('bin');
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
          expect(collected).toEqual(new Uint8Array([1, 2, 3]));
          return { path: '/work/.dsh_feishu/attachments/file-1.bin' };
        },
      });
      h.transport.downloadFileImpl = async () => new Uint8Array([1, 2, 3]);
      await h.bridge.handleMessage(
        message({
          text: '',
          attachments: [{ kind: 'file', key: 'file-1', name: 'notes.txt' }],
        }),
      );
      // Pending: the receipt card posts but NO turn starts (no followup).
      expect(h.transport.sentCards).toHaveLength(1);
      expect(h.transport.sentCards[0]?.header?.title.content).toBe('📎 File received');
      expect(JSON.stringify(h.transport.sentCards[0]?.elements)).toContain('.dsh_feishu');
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
      // The follow-up text drains the pending file into its turn.
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'read this file' }));
      const followups = h.agentStore.followups.get('feishu-session-1');
      const blocks = followups?.[0]?.content as unknown[];
      expect(blocks?.[0]).toEqual({
        type: 'text',
        text: '[user sent a file: notes.txt — saved at /work/.dsh_feishu/attachments/file-1.bin. You can read it with your file tools.]',
      });
    });

    it('falls back to a name-only pending entry when the save seam is absent, then drains it', async () => {
      const h = makeHarness(); // no saveInboundFile
      h.transport.downloadFileImpl = async () => new Uint8Array([1, 2, 3]);
      await h.bridge.handleMessage(
        message({
          text: '',
          attachments: [{ kind: 'file', key: 'file-1', name: 'notes.txt' }],
        }),
      );
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'what is this' }));
      const followups = h.agentStore.followups.get('feishu-session-1');
      const blocks = followups?.[0]?.content as unknown[];
      expect(blocks?.[0]).toEqual({ type: 'text', text: '[user sent a file: notes.txt]' });
    });

    it('two bare file messages pending together drain into one follow-up turn, in order', async () => {
      const paths = ['/work/.dsh_feishu/attachments/a.txt', '/work/.dsh_feishu/attachments/b.txt'];
      const h = makeHarness({
        saveInboundFile: async ({ attachment }) =>
          Promise.resolve({
            path: attachment.key === 'a' ? (paths[0] ?? '') : (paths[1] ?? ''),
          }),
      });
      h.transport.downloadFileImpl = async () => new Uint8Array([1, 2, 3]);
      await h.bridge.handleMessage(
        message({
          messageId: 'om_file1',
          text: '',
          attachments: [{ kind: 'file', key: 'a', name: 'a.txt' }],
        }),
      );
      await h.bridge.handleMessage(
        message({
          messageId: 'om_file2',
          text: '',
          attachments: [{ kind: 'file', key: 'b', name: 'b.txt' }],
        }),
      );
      // Two receipt cards (each file its own card), no turn yet.
      expect(h.transport.sentCards).toHaveLength(2);
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'analyze both' }));
      const followups = h.agentStore.followups.get('feishu-session-1');
      const blocks = followups?.[0]?.content as unknown[];
      expect(JSON.stringify(blocks)).toContain(paths[0] ?? '');
      expect(JSON.stringify(blocks)).toContain(paths[1] ?? '');
      // The list drained: a second text message does NOT re-inject.
      await h.bridge.handleMessage(message({ messageId: 'om_msg3', text: 'anything else?' }));
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(2);
      const secondBlocks = h.agentStore.followups.get('feishu-session-1')?.[1]
        ?.content as unknown[];
      expect(JSON.stringify(secondBlocks)).not.toContain(paths[0] ?? '');
    });

    it('a bare file message in a group bypasses the mention gate (registers pending); the follow-up text must @ the bot', async () => {
      const h = makeHarness({
        saveInboundFile: async () =>
          Promise.resolve({ path: '/work/.dsh_feishu/attachments/g.txt' }),
      });
      h.transport.downloadFileImpl = async () => new Uint8Array([1, 2, 3]);
      h.transport.botOpenId = 'ou_bot';
      // Group bare file, NO mention: registers (bypass).
      await h.bridge.handleMessage(
        message({
          text: '',
          chatType: 'group',
          mentions: [],
          attachments: [{ kind: 'file', key: 'g', name: 'g.txt' }],
        }),
      );
      expect(h.transport.sentCards).toHaveLength(1);
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
      // Un-@ group text: the mention gate drops it, the file stays pending.
      await h.bridge.handleMessage(
        message({ messageId: 'om_msg2', text: 'look', chatType: 'group', mentions: [] }),
      );
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
      // @-mentioned text drains it.
      await h.bridge.handleMessage(
        message({ messageId: 'om_msg3', text: 'look', chatType: 'group', mentions: ['ou_bot'] }),
      );
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
    });

    it('a bare image message without a save seam still registers a name-only pending entry', async () => {
      // No saveInboundFile: the image download succeeds but nothing can
      // persist it — the pending entry is name-only and the follow-up text
      // still drains it (no image block, no wedge).
      const h = makeHarness();
      h.transport.downloadImageImpl = async () => ({ data: pngBytes, mediaType: 'image/png' });
      await h.bridge.handleMessage(
        message({
          text: '',
          attachments: [{ kind: 'image', key: 'img-1' }],
        }),
      );
      expect(h.transport.sentCards[0]?.header?.title.content).toBe('📎 File received');
      expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
      await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'look' }));
      const followups = h.agentStore.followups.get('feishu-session-1');
      const blocks = followups?.[0]?.content as unknown[];
      expect(JSON.stringify(blocks)).toContain('img-1');
      expect(JSON.stringify(blocks)).not.toContain('"type":"image"');
    });
  });

  it('wires inbound transport messages into the bridge', async () => {
    const h = makeHarness();
    h.transport.deliver(message());
    await vi.waitFor(() => {
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
    });
  });

  it('replies with a loud notice for a known-but-unhandled message type', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message({ unsupportedType: 'folder', text: '' }));
    // The notice is a text reply, NOT a turn (no agent followup).
    expect(h.transport.sentTexts.some((t) => t.text.includes('folder'))).toBe(true);
    expect(h.transport.sentTexts.some((t) => t.text.includes("can't process"))).toBe(true);
    expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
  });

  it('deduplicates a redelivered message id', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message());
    expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
  });

  it('a blank message is delivered as-is (no crash, no special case)', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message({ text: '   ' }));
    expect(h.agentStore.followups.get('feishu-session-1')?.[0]?.content).toEqual([
      { type: 'text', text: '   ' },
    ]);
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
        (el) => el.tag === 'markdown' && 'content' in el && el.content === 'bash → read',
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

  it('a second panel tap posts a FRESH panel card (off-screen cards must not swallow it)', async () => {
    // Regression (user report): the streaming card's ⚙️ Panel button is
    // `kind: 'panel'`. It must OPEN the panel — a fresh card. Updating the
    // existing panel card in place is invisible when that card is scrolled
    // up the chat ("the button does nothing").
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    // First tap opens the panel (card #2).
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    expect(h.transport.sentCards).toHaveLength(2);
    // Second tap posts ANOTHER fresh card. Each panel card is INDEPENDENT
    // (own view stack): the first card is not recalled, and a tap on EITHER
    // card updates that card itself, never the other.
    await h.bridge.handleCardAction({
      messageId: 'mem-2',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    expect(h.transport.sentCards).toHaveLength(3);
    const panel = h.transport.sentCards.at(-1);
    expect(panel?.header?.title.content).toBe('⚙️ dsh-feishu panel');
    // Neither panel card is recalled (independent cards stay on screen).
    expect(h.transport.deletedMessages).toEqual([]);
  });

  it('tapping an OLD panel card updates that card, never the latest one', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    // Card A: first /panel tap posts card #2.
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const cardA = lastCardId(h);
    // Card B: a second tap posts card #3 — the latest panel card.
    await h.bridge.handleCardAction({
      messageId: 'mem-2',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const cardB = lastCardId(h);
    expect(cardB).not.toBe(cardA);
    h.transport.updatedMessageIds.length = 0;
    // Drive card A (an old card): its page flip must update A, never B —
    // the per-card state machine regression ("tap this card, another card
    // reacts" was the old per-chat single-stack behavior).
    await h.bridge.handleCardAction({
      messageId: cardA,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-page', page: '1' },
    });
    expect(h.transport.updatedMessageIds).toEqual([cardA]);
    // And card B's own page flip updates B (each card tracks its own page).
    await h.bridge.handleCardAction({
      messageId: cardB,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-page', page: '1' },
    });
    expect(h.transport.updatedMessageIds).toEqual([cardA, cardB]);
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
      expect(runningLabels).toEqual(['⏹ Stop current turn', '🔁 Retry last', '📋 Copy last']);
      // Turn ends → agent idle → a fresh panel tap has no Stop button.
      await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
      h.agentStore.setStatus('feishu-session-1', 'idle');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'panel' },
      });
      // The panel button always posts a FRESH panel card (user report: a tap
      // must never silently update an off-screen card).
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

    it('retry after a stopped turn starts a fresh turn with the same prompt', async () => {
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message({ text: 'retry me after stop' }));
      await h.bridge.handleEvent('feishu-session-1', chunkEvent('partial output'));
      h.agentStore.setStatus('feishu-session-1', 'running');
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'stop' },
      });
      await h.bridge.handleEvent(
        'feishu-session-1',
        turnEndEvent({ kind: 'aborted' }) as SessionEvent,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const before = h.agentStore.followups.get('feishu-session-1')?.length ?? 0;
      // Stopped is terminal but retryable: Retry queues the same prompt again.
      await h.bridge.handleCardAction({
        messageId: 'mem-1',
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'retry' },
      });
      expect(h.agentStore.followups.get('feishu-session-1')?.length).toBe(before + 1);
      const card = h.transport.sentCards.at(-1);
      expect(card?.header?.title.content).toBe('retry me after stop');
      expect(card?.header?.template).toBe('wathet');
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

    it('always: an @-only message (mention, no text) is answered', async () => {
      const h = makeHarness({ groupMentionMode: 'always' });
      await h.bridge.handleMessage(groupMessage(['ou_bot'], { text: '' }));
      expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
      expect(h.agentStore.followups.get('feishu-session-1')?.[0]?.content).toEqual([
        { type: 'text', text: '' },
      ]);
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
      // /help documents the with-arg usage, distinguishing a REQUIRED arg
      // (`<...>`: the value is the command's substance) from an OPTIONAL one
      // (`[...]`: a picker/toggle card completes the action on its own).
      expect(help?.text).toContain('/cd <path>');
      expect(help?.text).toContain('/group <name>');
      expect(help?.text).toContain('/goal <text>');
      expect(help?.text).toContain('/model <provider/model>');
      expect(help?.text).toContain('/resume <id>');
      expect(help?.text).toContain('/plan [on|off]');
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

  it('/cd resolves a relative path against the process cwd', async () => {
    const { mkdirSync } = await import('node:fs');
    const target = join(SCRATCH, 'cd-relative-target');
    mkdirSync(target, { recursive: true });
    const relative = join('_dev', 'test-bridge', 'cd-relative-target');
    const h = makeHarness();
    await h.bridge.handleMessage(message({ text: `/cd ${relative}` }));
    expect(h.sessionMap.cwdFor('oc_chat')).toBe(join(process.cwd(), relative));
  });

  it('/cd keeps spaces in the path intact', async () => {
    const { mkdirSync } = await import('node:fs');
    const target = join(SCRATCH, 'my project dir');
    mkdirSync(target, { recursive: true });
    const h = makeHarness();

    await h.bridge.handleMessage(message({ text: `/cd ${target}` }));
    expect(h.sessionMap.cwdFor('oc_chat')).toBe(target);
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
    const picker = findCardByTitle(h, (title) => title.includes('Pick a project'));
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
    // The pick lands, notifies as a result card, and — because this card was
    // seeded by a typed command (a standalone root) — it STAYS on its current
    // view instead of returning to the panel menu.
    expect(resultCardTexts(h).some((t) => t.includes('Working directory set to'))).toBe(true);
    const stay = h.transport.updatedCards.at(-1);
    expect(stay?.header?.title.content).toBe('📚 Pick a project');
  });

  it('/repo with an empty root list posts an empty picker (no crash, no dropdown)', async () => {
    const h = makeHarness({ repoRoots: [join(SCRATCH, 'no-projects-here')] });
    await h.bridge.handleMessage(message({ text: '/repo' }));
    const picker = findCardByTitle(h, (title) => title.includes('Pick a project'));
    expect(picker).toBeDefined();
    // No dropdown options — only the guidance markdown and the Back row.
    expect(
      picker?.elements.some(
        (el) =>
          el.tag === 'action' &&
          'actions' in el &&
          el.actions.some((a) => a.tag === 'select_static'),
      ),
    ).toBe(false);
  });

  it('/repo without repoRoots configured still posts the picker (empty)', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message({ text: '/repo' }));
    const picker = findCardByTitle(h, (title) => title.includes('Pick a project'));
    expect(picker).toBeDefined();
    expect(
      picker?.elements.some(
        (el) =>
          el.tag === 'action' &&
          'actions' in el &&
          el.actions.some((a) => a.tag === 'select_static'),
      ),
    ).toBe(false);
  });

  it('a repo pick applies from the panel picker view', async () => {
    const h = makeHarness({ repoRoots: [join(SCRATCH, 'projects')] });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const root = join(SCRATCH, 'projects');
    mkdirSync(join(root, 'proj-a', '.git'), { recursive: true });
    writeFileSync(join(root, 'proj-a', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await h.bridge.handleMessage(message({ text: '/repo' }));
    await h.bridge.handleCardAction({
      messageId: 'msg-999',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'repo-pick' },
      option: join(root, 'proj-a'),
    });
    expect(h.sessionMap.cwdFor('oc_chat')).toBe(join(root, 'proj-a'));
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('⚙️ dsh-feishu panel');
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
    const picker = findCardByTitle(h, (title) => title.includes('Pick a project'));
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

/** Find a panel card by header title across BOTH the sent and updated card
 *  streams (async panel views post a loading placeholder first — the real
 *  card arrives as an update). */
function findCardByTitle(h: Harness, predicate: (title: string) => boolean): CardJson | undefined {
  const all = [...h.transport.sentCards, ...h.transport.updatedCards];
  return [...all].reverse().find((card) => predicate(card.header?.title.content ?? ''));
}

/** The markdown body of every RESULT card posted (header ✅/⚠️), used to
 *  assert panel-action outcomes that now leave the panel as an inert card. */
function resultCardTexts(h: Harness): string[] {
  return h.transport.sentCards
    .filter((card) => {
      const title = card.header?.title.content;
      return title === '✅ Done' || title === '⚠️ Action failed';
    })
    .flatMap((card) =>
      card.elements
        .filter((el) => el.tag === 'markdown' && 'content' in el)
        .map((el) => (el as { readonly content: string }).content),
    );
}

describe('session commands (/sessions /resume /clear /new)', () => {
  it('/sessions on an empty corpus shows the empty state card', async () => {
    const h = makeHarness({ listSessions: async () => [] });
    await h.bridge.handleMessage(message({ text: '/sessions' }));
    const card = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    expect(card?.header?.title.content).toBe('🗂️ Sessions');
    expect(
      card?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('No sessions yet'),
      ),
    ).toBe(true);
  });

  it('/sessions lists sessions in a dropdown and marks the current one', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/sessions' }));
    const card = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    // The sessions view is a dropdown (user requirement: pick, don't page).
    const select = card?.elements.find(
      (el) => el.tag === 'action' && 'actions' in el && el.actions[0]?.tag === 'select_static',
    );
    expect(select && 'actions' in select ? select.actions[0]?.tag : undefined).toBe(
      'select_static',
    );
    const options =
      select && 'actions' in select && select.actions[0]?.tag === 'select_static'
        ? select.actions[0].options
        : [];
    expect(options.map((o) => o.value)).toEqual(['feishu-session-9', 'feishu-session-1']);
    // The current session's option carries the ★ marker.
    const currentOption = options.find((o) => o.value === 'feishu-session-1');
    expect(currentOption?.text.content).toContain('★');
    // Selecting via the callback `option` opens the detail view.
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select' },
      option: 'feishu-session-9',
    });
    const detail = h.transport.updatedCards.at(-1);
    expect(JSON.stringify(detail?.elements)).toContain('▶️ Resume');
    expect(JSON.stringify(detail?.elements)).toContain('feishu-session-9');
  });

  it('session detail renames and archives through the host seam', async () => {
    const renamed: string[] = [];
    const archived: string[] = [];
    const h = makeHarness({
      listSessions: async () => sessionRows(),
      sessionTitle: {
        rename: (session, title) => {
          renamed.push(`${(session as { id: string }).id}:${title}`);
        },
      },
      getWorkspaceRegistry: () => ({
        archivedSessionIds: [],
        archiveSession: async (sessionId) => {
          archived.push(sessionId);
        },
      }),
    });
    // Detail → Rename → input form → submit the new title.
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select', sessionId: 'feishu-session-9' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-rename', sessionId: 'feishu-session-9' },
    });
    const inputCard = h.transport.updatedCards.at(-1);
    expect(inputCard?.header?.title.content).toBe('✏️ Rename session');
    // Regression (user-reported): the input card's submit button must carry
    // the session id in its value, or a real click submits with an empty id
    // and the rename silently does nothing. The integration suite used to
    // bypass this by constructing the submit action directly with the id.
    const inputJson = JSON.stringify(inputCard?.elements ?? []);
    expect(inputJson).toContain('"sessionId":"feishu-session-9"');
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: {
        kind: 'panel-input-submit',
        command: 'rename-session',
        sessionId: 'feishu-session-9',
      },
      formValue: { title: 'New Title' },
    });
    expect(renamed).toEqual(['feishu-session-9:New Title']);
    expect(resultCardTexts(h).some((t) => t.includes('Renamed session'))).toBe(true);
    // Detail again → Archive.
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select', sessionId: 'feishu-session-9' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-archive', sessionId: 'feishu-session-9' },
    });
    expect(archived).toEqual(['feishu-session-9']);
    expect(resultCardTexts(h).some((t) => t.includes('Archived session'))).toBe(true);
    // The detail view without the seam hides rename/archive.
    const noSeam = makeHarness({ listSessions: async () => sessionRows() });
    await noSeam.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    await noSeam.bridge.handleCardAction({
      messageId: lastCardId(noSeam),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select', sessionId: 'feishu-session-9' },
    });
    const noSeamDetail = noSeam.transport.updatedCards.at(-1);
    expect(JSON.stringify(noSeamDetail?.elements)).not.toContain('✏️ Rename');
    expect(JSON.stringify(noSeamDetail?.elements)).not.toContain('🗄️ Archive');
  });

  it('caps the sessions dropdown beyond SESSION_SELECT_MAX and never pages', async () => {
    const many = Array.from({ length: SESSION_SELECT_MAX + 5 }, (_, index) => ({
      sessionId: `feishu-session-${index}`,
      title: `Session ${index}`,
      cwd: undefined,
      createdAt: Date.now() - index * 1000,
      live: false,
      persisted: true,
    }));
    const h = makeHarness({ listSessions: async () => many });
    await h.bridge.handleMessage(message({ text: '/sessions' }));
    const card = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    const select = card?.elements.find(
      (el) => el.tag === 'action' && 'actions' in el && el.actions[0]?.tag === 'select_static',
    );
    const options =
      select && 'actions' in select && select.actions[0]?.tag === 'select_static'
        ? select.actions[0].options
        : [];
    expect(options).toHaveLength(SESSION_SELECT_MAX);
    // The overflow is explained, not paginated (user requirement).
    expect(
      card?.elements.some(
        (el) => el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('5 more'),
      ),
    ).toBe(true);
    expect(
      card?.elements.some(
        (el) => el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page '),
      ),
    ).toBe(false);
  });

  it('find-session reaches ANY session past the dropdown cap', async () => {
    // Feishu caps select_static options (SESSION_SELECT_MAX); the 🔎 Find
    // session input filters by id/title so every session is reachable.
    const many = Array.from({ length: SESSION_SELECT_MAX + 5 }, (_, index) => ({
      sessionId: `feishu-session-${index}`,
      title: `Project ${index}`,
      cwd: undefined,
      createdAt: Date.now() - index * 1000,
      live: false,
      persisted: true,
    }));
    const h = makeHarness({ listSessions: async () => many });
    await h.bridge.handleMessage(message({ text: '/sessions' }));
    // The Find button is on the sessions card.
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-find' },
    });
    const inputCard = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    expect(inputCard?.header?.title.content).toBe('🔎 Find session');
    // Submit a fragment that only matches the last (out-of-cap) session.
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-input-submit', command: 'find-session' },
      formValue: { query: `feishu-session-${SESSION_SELECT_MAX + 4}` },
    });
    const filtered = h.transport.updatedCards.at(-1);
    const select = filtered?.elements.find(
      (el) => el.tag === 'action' && 'actions' in el && el.actions[0]?.tag === 'select_static',
    );
    const options =
      select && 'actions' in select && select.actions[0]?.tag === 'select_static'
        ? select.actions[0].options
        : [];
    expect(options.map((o) => o.value)).toEqual([`feishu-session-${SESSION_SELECT_MAX + 4}`]);
  });

  it('a resume button resumes a persisted session and rebinds the chat', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message());
    await finishTurn(h);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/sessions' }));
    // Resume lives in the session detail view.
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select', sessionId: 'feishu-session-9' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'resume-session', sessionId: 'feishu-session-9' },
    });
    expect(h.agentStore.resumed).toContain('feishu-session-9');
    expect(h.sessionMap.get('oc_chat')).toBe('feishu-session-9');
    expect(resultCardTexts(h).some((t) => t.includes('Resumed session feishu-session-9'))).toBe(
      true,
    );
    // The previous binding is detached (1:1 chat↔session model).
    expect(h.sessionMap.chatFor('feishu-session-1')).toBeUndefined();
  });

  it('rejects a stale resume outside the session detail view', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleMessage(message());
    await finishTurn(h);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/sessions' }));
    // A resume callback while NOT in the detail view is ignored.
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
    const card = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    expect(card?.header?.title.content).toBe('🗂️ Sessions');
    // The bound session row labels this chat's session as 'this chat'.
    expect(JSON.stringify(card?.elements)).toContain('this chat');
  });
});

describe('panel command palette', () => {
  it('panel-back pops to the PARENT view (stack semantics)', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    // Open the panel (fresh card), then drive it with that card's id.
    await h.bridge.handleCardAction({
      messageId: 'mem-open',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const cardId = lastCardId(h);
    // menu → sessions (via the Sessions button) → detail → back → sessions.
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'sessions' },
    });
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select', sessionId: 'feishu-session-9' },
    });
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('🗂️ Session');
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-back' },
    });
    // Back from detail → the sessions list.
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('🗂️ Sessions');
    // Back from the list → menu.
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-back' },
    });
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('⚙️ dsh-feishu panel');
    // Back from the menu → still the menu (no-op).
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-back' },
    });
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('⚙️ dsh-feishu panel');
  });

  it('panel-page is ignored outside the menu root', async () => {
    const h = makeHarness({ listSessions: async () => sessionRows() });
    await h.bridge.handleCardAction({
      messageId: 'mem-open',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const cardId = lastCardId(h);
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'cd' },
    });
    const before = h.transport.updatedCards.length;
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-page', page: '1' },
    });
    expect(h.transport.updatedCards.length).toBe(before);
    // The cd input card (first panel render) is untouched.
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe(
      '📁 Change working directory',
    );
  });

  it('bare /group /goal /feedback open the same text-input card as their panel button (consistency)', async () => {
    const h = makeHarness();
    const cases: Array<[string, string]> = [
      ['/group', '👥 New group'],
      ['/goal', '🎯 Goal'],
      ['/feedback', '💬 Feedback'],
    ];
    for (const [cmd, title] of cases) {
      await h.bridge.handleMessage(message({ text: cmd, messageId: `om-${cmd}` }));
      const card = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
      expect(card?.header?.title.content).toBe(title);
    }
  });

  it('typing /cd posts the input card directly — no transient menu flash (regression)', async () => {
    const h = makeHarness();
    const before = h.transport.sentCards.length;
    await h.bridge.handleMessage(message({ text: '/cd' }));
    // The FIRST card posted by the typed /cd is the input card, never the
    // control panel menu (a sync non-menu seed must not flash the menu).
    const first = h.transport.sentCards[before];
    expect(first?.header?.title.content).toBe('📁 Change working directory');
    expect(
      h.transport.sentCards
        .slice(before)
        .some((c) => c.header?.title.content === '⚙️ dsh-feishu panel'),
    ).toBe(false);
  });

  it('an empty input submit runs the command with an empty argument', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'cd' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-input-submit', command: 'cd' },
      formValue: { path: '' },
    });
    // /cd with no argument no longer raises a usage error (the handler now
    // opens the text-input card for a bare /cd); the panel-button flow still
    // returns to the menu after the submit.
    expect(resultCardTexts(h).some((t) => t.includes('usage: /cd'))).toBe(false);
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('⚙️ dsh-feishu panel');
  });

  it('archive failure notifies and returns to the active list', async () => {
    const h = makeHarness({
      listSessions: async () => sessionRows(),
      getWorkspaceRegistry: () => ({
        archivedSessionIds: [],
        archiveSession: async () => {
          throw new Error('archive backend down');
        },
      }),
    });
    await h.bridge.handleCardAction({
      messageId: 'mem-open',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const cardId = lastCardId(h);
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'sessions' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select', sessionId: 'feishu-session-9' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-archive', sessionId: 'feishu-session-9' },
    });
    expect(resultCardTexts(h).some((t) => t.includes('Archiving failed'))).toBe(true);
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('🗂️ Sessions');
  });

  it('the archived toggle filters the list by the host archive set', async () => {
    const h = makeHarness({
      listSessions: async () => sessionRows(),
      getWorkspaceRegistry: () => ({
        archivedSessionIds: ['feishu-session-9'],
        archiveSession: async () => {},
      }),
    });
    await h.bridge.handleCardAction({
      messageId: 'mem-open',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const cardId = lastCardId(h);
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'sessions' },
    });
    // Active view hides the archived session.
    const active = h.transport.updatedCards.at(-1);
    expect(JSON.stringify(active?.elements)).not.toContain('feishu-session-9');
    // Toggle to archived: only the archived session shows.
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'sessions-archived-toggle' },
    });
    const archived = h.transport.updatedCards.at(-1);
    expect(JSON.stringify(archived?.elements)).toContain('feishu-session-9');
    expect(JSON.stringify(archived?.elements)).not.toContain('feishu-session-1');
  });

  it('an unknown session detail renders an unknown card and export failure notifies', async () => {
    const h = makeHarness({
      listSessions: async () => sessionRows(),
      readSession: async () => {
        throw new Error('corrupt log');
      },
    });
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'sessions' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select', sessionId: 'nope' },
    });
    expect(JSON.stringify(h.transport.updatedCards.at(-1)?.elements)).toContain('(unknown)');
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-export', sessionId: 'nope' },
    });
    expect(resultCardTexts(h).some((t) => t.includes('session export failed'))).toBe(true);
  });

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
    expect(labels).toContain('➕ New chat');
    // /clear is the same action as /new and stays slash-only (one panel
    // button, user report) — its button is hidden.
    expect(labels).not.toContain('✨ Fresh start');
    // Resume lives inside the Sessions flow; a standalone button is
    // redundant (user report).
    expect(labels).not.toContain('↩️ Resume session');
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-page', page: '1' },
    });
    const panel2 = h.transport.updatedCards.at(-1);
    const labels2 =
      panel2?.elements.flatMap((el) =>
        el.tag === 'action'
          ? el.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [],
      ) ?? [];
    expect(labels2).toContain('🗺️ Plan mode');
    expect(labels2).toContain('🤖 Model');
    expect(labels2).toContain('📤 Export');
    expect(labels2).toContain('🎯 Goal');
    expect(labels2).toContain('🔐 Permission');
    // /panel is reachable as a slash line but its palette button is hidden —
    // a palette button that opens the panel would be the panel launching
    // itself (user report).
    const allLabels = (card: CardJson | undefined): string[] =>
      card?.elements.flatMap((el) =>
        el.tag === 'action'
          ? el.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
          : [],
      ) ?? [];
    expect(allLabels(panel)).not.toContain('⚙️ Panel');
    expect(allLabels(panel2)).not.toContain('⚙️ Panel');
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
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-page', page: '1' },
    });
    const panel2 = h.transport.updatedCards.at(-1);
    expect(
      panel2?.elements.some(
        (el) =>
          el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page 2/2'),
      ),
    ).toBe(true);
    expect(navLabels(panel2)).toEqual(['◀️ Prev']);
  });

  it('panel-page clamps out-of-range pages and ignores non-numeric ones', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const before = h.transport.updatedCards.length;
    // A huge page number clamps to the last page — the panel card is updated
    // in place (no crash, no new card).
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-page', page: '99' },
    });
    expect(h.transport.updatedCards.at(-1)?.elements.some((el) => el.tag === 'action')).toBe(true);
    // Non-numeric, fractional, and negative pages are ignored entirely.
    for (const page of ['abc', '1.5', '-1']) {
      await h.bridge.handleCardAction({
        messageId: lastCardId(h),
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'panel-page', page },
      });
    }
    expect(h.transport.updatedCards.length).toBe(before + 1);
  });

  it('panel page flips update the panel card IN PLACE (no new card)', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const panelId = lastCardId(h);
    // The page flip targets the CURRENT panel card: it is updated in place.
    await h.bridge.handleCardAction({
      messageId: panelId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-page', page: '1' },
    });
    const updated = h.transport.updatedCards.at(-1);
    expect(
      updated?.elements.some(
        (el) =>
          el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page 2/2'),
      ),
    ).toBe(true);
    expect(h.transport.sentCards).toHaveLength(1);
  });

  it('a direct-result button on page 2 keeps the panel on page 2 (no pre-click revert)', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-page', page: '1' },
    });
    // help/status/plan are direct-result commands: no input/confirm/picker
    // sub-view. The state-machine completion exit MUST patch the panel card
    // back to the menu root — that patch is what stops Lark from restoring
    // the pre-click (page-1) card (user report: clicking help on page 2
    // jumped back to page 1).
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'help' },
    });
    const afterHelp = h.transport.updatedCards.at(-1);
    expect(
      afterHelp?.elements.some(
        (el) =>
          el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page 2/2'),
      ),
    ).toBe(true);
    // The panel card itself was never re-posted — only the inert result card
    // is new (panel card + result card).
    expect(h.transport.sentCards).toHaveLength(2);
    // The outcome left the panel as an inert result card (panel principle).
    expect(resultCardTexts(h).some((t) => t.includes('dsh-feishu commands'))).toBe(true);
  });

  it('a permission pick renders for a persisted session (resume, not create)', async () => {
    // Regression: the permission picker called ensureAgent which CREATED the
    // session outright — a session the persisted state already owns throws
    // ("persisted state already owns this identity"), the panel render
    // failed, and every later panel button went dead. ensureAgent must
    // RESUME a persisted session before create (user report).
    const service = new FakePermissionService();
    const h = makeHarness({ permissionPresets: service });
    // The session exists in the map but has no live agent (e.g. after a bot
    // restart): resume is the only legal path.
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'permission' },
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('could not be rendered'))).toBe(false);
    const picker = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    expect(JSON.stringify(picker?.elements)).toContain('read-only');
    expect(h.agentStore.resumed).toContain('feishu-session-1');
    // The panel is NOT dead: a pick still works and returns to the menu.
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'permission-pick' },
      option: 'read-only',
    });
    expect(service.applied).toEqual(['read-only']);
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('⚙️ dsh-feishu panel');
  });

  it('plan toggle still notifies and pops to menu for a persisted session', async () => {
    const planMode = new FakePlanModeService();
    const h = makeHarness({ planMode });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'plan' },
    });
    expect(resultCardTexts(h).some((t) => t.includes('Plan mode on'))).toBe(true);
    expect(
      (h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1))?.header?.title.content,
    ).toBe('⚙️ dsh-feishu panel');
  });

  it('async panel views post a loading placeholder before the real card', async () => {
    // Regression: sessions/detail/pickers render from async data; without a
    // placeholder the callback carried no panel patch while the data loaded
    // and Lark restored the pre-click (menu) card — the panel visibly
    // reverted mid-transition (user report: "退回菜单").
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      listSessions: async () => {
        await gate;
        return sessionRows();
      },
    });
    const actionPromise = h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'sessions' },
    });
    // Let the loading placeholder land while the data is still pending.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    expect(JSON.stringify(pending?.elements)).toContain('Loading');
    release?.();
    await actionPromise;
    const loaded = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    expect(JSON.stringify(loaded?.elements)).toContain('Choose a session');
  });

  it('async panel OPERATIONS post an operating placeholder before the work (runPanelOperation)', async () => {
    // Regression: archive/export/resume/rename/picks awaited async work with
    // NO panel patch during the await — Lark restored the pre-click card
    // mid-action (user report: "sessions界面内的操作没有loading占位卡").
    // Every async panel operation now goes through runPanelOperation, which
    // posts an operating placeholder FIRST (the callback always carries a
    // panel patch).
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      listSessions: async () => sessionRows(),
      getWorkspaceRegistry: () => ({
        archivedSessionIds: [],
        archiveSession: async () => {
          await gate;
        },
      }),
    });
    // Open the sessions list, then a detail view.
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'sessions' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select', sessionId: 'feishu-session-9' },
    });
    // Archive: the operating placeholder lands while the work is pending.
    const before = h.transport.updatedCards.length;
    const actionPromise = h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-archive', sessionId: 'feishu-session-9' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const during = h.transport.updatedCards.slice(before);
    expect(during.length).toBeGreaterThan(0);
    expect(JSON.stringify(during[0]?.elements)).toContain('Operating');
    release?.();
    await actionPromise;
    expect(resultCardTexts(h).some((t) => t.includes('Archived session'))).toBe(true);
  });

  it('a text-input command opens the input form; submit runs it with the value', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-open',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const cardId = lastCardId(h);

    const { mkdirSync } = await import('node:fs');
    const target = join(SCRATCH, 'cd-panel-input');
    mkdirSync(target, { recursive: true });
    // The cd button opens the input sub-view: a root-level form with one
    // input and a form_submit button (botmux v1 schema).
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'cd' },
    });
    const inputCard = h.transport.updatedCards.at(-1);
    expect(inputCard?.header?.title.content).toBe('📁 Change working directory');
    const form = inputCard?.elements.find((el) => el.tag === 'form');
    expect(form && 'elements' in form ? form.elements.some((e) => e.tag === 'input') : false).toBe(
      true,
    );
    // Submit carries the typed path in form_value (callback shape).
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-input-submit', command: 'cd' },
      formValue: { path: target },
    });
    expect(h.sessionMap.cwdFor('oc_chat')).toBe(target);
    expect(resultCardTexts(h).some((t) => t.includes('Working directory set to'))).toBe(true);
    // The panel returned to the menu root (same card, updated in place) and
    // the outcome left the panel as an inert result card.
    const menu = h.transport.updatedCards.at(-1);
    expect(JSON.stringify(menu?.elements)).toContain('📁 Change dir');
    expect(h.transport.sentCards).toHaveLength(2); // input card + result card
  });

  it('a command button executes the same handler as the slash line', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-open',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const cardId = lastCardId(h);

    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'help' },
    });
    // The outcome leaves the panel as a pure-information result card and the
    // panel returns to the menu root (state-machine completion exit; a fresh
    // panel posts its first card here).
    expect(resultCardTexts(h).some((t) => t.includes('dsh-feishu commands'))).toBe(true);
    expect(
      (h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1))?.header?.title.content,
    ).toBe('⚙️ dsh-feishu panel');
    // clear is destructive: the panel button first shows the confirm view
    // (the panel card already exists after the help exit, so it updates)…
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'clear' },
    });
    const confirmCard = h.transport.updatedCards.at(-1);
    expect(JSON.stringify(confirmCard?.elements)).toContain('Start new chat');
    // …and the confirm button runs the command (no session → nothing to clear).
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-confirm', command: 'clear' },
    });
    expect(resultCardTexts(h).some((t) => t.includes('nothing to clear'))).toBe(true);
    // The panel returned to the menu root.
    const menu = h.transport.updatedCards.at(-1);
    expect(JSON.stringify(menu?.elements)).toContain('📁 Change dir');
  });

  it('a mutating command button is refused while working; read-only allowed', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleCardAction({
      messageId: 'mem-open',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const cardId = lastCardId(h);
    // clear's panel button opens the confirm view even while working; the
    // gate fires on the CONFIRM button (the mutating step).
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'clear' },
    });
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('✨ New chat');
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-confirm', command: 'clear' },
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(true);
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-back' },
    });
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'help' },
    });
    expect(resultCardTexts(h).some((t) => t.includes('dsh-feishu commands'))).toBe(true);
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

  it('a malformed card action (missing kind) is ignored without side effects', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: {},
    });
    expect(h.transport.sentTexts).toHaveLength(0);
    expect(h.transport.sentCards).toHaveLength(0);
    expect(h.agentStore.followups.size).toBe(0);
  });

  it('an unknown action kind is ignored without side effects', async () => {
    const h = makeHarness();
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'totally-unknown' },
    });
    expect(h.transport.sentTexts).toHaveLength(0);
    expect(h.transport.sentCards).toHaveLength(0);
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
    // An agent is bound to the session — created on a fresh chat, or resumed
    // when the persisted state already owns it (ensureAgent ladder).
    expect(
      h.agentStore.created.some((c) => c.sessionId === 'feishu-session-1') ||
        h.agentStore.resumed.includes('feishu-session-1'),
    ).toBe(true);
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
    // Some value: a bare /goal now opens the panel text-input card, so use
    // an argument to reach the harness wrapper's missing-registry path.
    await h.bridge.handleMessage(message({ text: '/goal run tests' }));
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
    // Enter the detail view first (resume only fires there).
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select', sessionId: 'feishu-session-9' },
    });
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
    const card = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
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
    await h.bridge.handleCardAction({
      messageId: 'mem-open',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
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
    expect(resultCardTexts(h).some((t) => t.includes('switched to read-only'))).toBe(true);
  });

  it('a permission pick applies from the panel picker view', async () => {
    const service = new FakePermissionService();
    const h = makeHarness({ permissionPresets: service });
    await h.bridge.handleMessage(message({ text: '/permission' }));
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'permission-pick' },
      option: 'read-only',
    });
    expect(service.applied).toEqual(['read-only']);
    // A typed-command card STAYS on its result (the permission picker is
    // redrawn) instead of returning to the panel menu.
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('🔐 Permission presets');
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
    expect(resultCardTexts(h).some((t) => t.includes('Plan mode on'))).toBe(true);
    // The completion exit pops to the menu root (a fresh panel posts here).
    expect(
      (h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1))?.header?.title.content,
    ).toBe('⚙️ dsh-feishu panel');
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

  it('/plan on|off sets plan mode directly — the arg is not echoed as a message (bug)', async () => {
    const planMode = new FakePlanModeService();
    const h = makeHarness({ planMode });
    await h.bridge.handleMessage(message({ text: '/plan on' }));
    expect(planMode.calls).toEqual([true]);
    expect(h.transport.sentTexts.some((t) => t.text.includes('Plan mode on'))).toBe(true);
    // 'on' must not leak as a standalone message.
    expect(h.transport.sentTexts.some((t) => t.text === 'on')).toBe(false);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/plan off' }));
    expect(planMode.calls).toEqual([true, false]);
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

/** Fake `ctx.agentDefaultModel` service for the /model tests. */
class FakeAgentDefaultModelService implements AgentDefaultModelService {
  selection: ModelSelectionView = { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  readonly saved: ModelSelectionView[] = [];
  currentSelection(): ModelSelectionView {
    return this.selection;
  }
  async saveSelection(next: ModelSelectionView): Promise<void> {
    this.saved.push(next);
    this.selection = next;
  }
}

describe('/model command', () => {
  it('shows the deployment default when no live agent exists', async () => {
    const service = new FakeAgentDefaultModelService();
    const h = makeHarness({ agentDefaultModel: service });
    await h.bridge.handleMessage(message({ text: '/model' }));
    expect(
      h.transport.sentTexts.some((t) => t.text === 'model: deepseek-official · deepseek-v4-flash'),
    ).toBe(true);
  });

  it('shows the live agent’s own model when one exists', async () => {
    const h = makeHarness({ agentDefaultModel: new FakeAgentDefaultModelService() });
    await h.bridge.handleMessage(message());
    h.agentStore.setOptions('feishu-session-1', { provider: 'pi-ai', model: 'deepseek-r1' });
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/model' }));
    expect(h.transport.sentTexts.some((t) => t.text === 'model: pi-ai · deepseek-r1')).toBe(true);
  });

  it('/model <provider>/<model> sets the default for new sessions', async () => {
    const service = new FakeAgentDefaultModelService();
    const h = makeHarness({ agentDefaultModel: service });
    await h.bridge.handleMessage(message({ text: '/model pi-ai/deepseek-r1' }));
    expect(service.saved).toEqual([{ provider: 'pi-ai', model: 'deepseek-r1' }]);
    expect(
      h.transport.sentTexts.some(
        (t) => t.text === 'Model set to pi-ai · deepseek-r1 (this session + default).',
      ),
    ).toBe(true);
  });

  it('/model rejects a bare token without a provider', async () => {
    const h = makeHarness({ agentDefaultModel: new FakeAgentDefaultModelService() });
    await h.bridge.handleMessage(message({ text: '/model deepseek-v4-flash' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('usage: /model'))).toBe(true);
  });

  it('reports loudly when the service is missing', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message({ text: '/model' }));
    expect(
      h.transport.sentTexts.some((t) =>
        t.text.includes('agentDefaultModel service is not mounted'),
      ),
    ).toBe(true);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/model pi-ai/x' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('model switching unavailable'))).toBe(
      true,
    );
  });

  it('is allowed while a turn is running (read-only display / future default)', async () => {
    const service = new FakeAgentDefaultModelService();
    const h = makeHarness({ agentDefaultModel: service });
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/model' }));
    expect(
      h.transport.sentTexts.some((t) => t.text === 'model: deepseek-official · deepseek-v4-flash'),
    ).toBe(true);
  });

  it('shows the SESSION-switched model, not the static agent options (regression #40)', async () => {
    const service = new FakeAgentDefaultModelService();
    const h = makeHarness({ agentDefaultModel: service }); // no llm -> /model text display
    await h.bridge.handleMessage(message()); // create the live agent
    // The live agent's STATIC options (what /model used to read) differ from the
    // session model the user switches to — the bug read `live.options` (never
    // mutated by a switch) first, so it showed the pre-switch model.
    h.agentStore.setOptions('feishu-session-1', {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    });
    // Switch the session model (raw arg path — allowed while a turn runs).
    await h.bridge.handleMessage(
      message({ messageId: 'om_msg2', text: '/model pi-ai/deepseek-r1' }),
    );
    expect(
      h.transport.sentTexts.some(
        (t) => t.text === 'Model set to pi-ai · deepseek-r1 (this session + default).',
      ),
    ).toBe(true);
    // The /model display now shows the SWITCHED model, not the static options.
    await h.bridge.handleMessage(message({ messageId: 'om_msg3', text: '/model' }));
    expect(h.transport.sentTexts.some((t) => t.text === 'model: pi-ai · deepseek-r1')).toBe(true);
  });
});

/** Fake `ctx.llm` service for the /model picker tests. */
class FakeLlmService implements LlmService {
  listProviders(): readonly { readonly id: string; readonly name: string }[] {
    return [{ id: 'deepseek-official', name: 'DeepSeek' }];
  }
  async listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]> {
    return [
      { provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { provider, id: 'deepseek-r1', name: 'DeepSeek R1' },
    ];
  }
}

describe('/model picker', () => {
  it('each typed /model opens a FRESH, independent card (regression: never reusing an earlier panel card)', async () => {
    const llm = new FakeLlmService();
    const defaults = new FakeAgentDefaultModelService();
    const h = makeHarness({ llm, agentDefaultModel: defaults });
    const before = h.transport.sentCards.length;
    // First typed /model posts a NEW card.
    await h.bridge.handleMessage(message({ text: '/model' }));
    expect(h.transport.sentCards.length).toBe(before + 1);
    // Second typed /model posts ANOTHER NEW card — it must NOT refresh/update
    // the first card (typed commands are independent state machines).
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/model' }));
    expect(h.transport.sentCards.length).toBe(before + 2);
    // A different card-opening command also opens its own fresh card.
    await h.bridge.handleMessage(message({ messageId: 'om_msg3', text: '/repo' }));
    expect(h.transport.sentCards.length).toBe(before + 3);
  });

  it('a typed-command picker card renders NO Back (it has no parent to return to)', async () => {
    const llm = new FakeLlmService();
    const h = makeHarness({ llm, agentDefaultModel: new FakeAgentDefaultModelService() });
    await h.bridge.handleMessage(message({ text: '/model' }));
    const card = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    // The picker card is a standalone seed (stack depth 1) → no ⬅ Back.
    expect(JSON.stringify(card?.elements ?? [])).not.toContain('⬅ Back');
  });

  it('a bare /model opens the picker card with the model catalog', async () => {
    const llm = new FakeLlmService();
    const defaults = new FakeAgentDefaultModelService();
    const h = makeHarness({ llm, agentDefaultModel: defaults });
    await h.bridge.handleMessage(message({ text: '/model' }));
    const card = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    expect(card?.header?.title.content).toBe('🤖 Model');
    const action = card?.elements.find((el) => el.tag === 'action');
    const select =
      action && 'actions' in action
        ? action.actions.find((a) => a.tag === 'select_static')
        : undefined;
    expect(select && 'options' in select ? select.options.map((o) => o.value) : []).toEqual([
      'deepseek-official/deepseek-v4-flash',
      'deepseek-official/deepseek-r1',
    ]);
    // The current default is preselected.
    expect(select && 'initial_option' in select ? select.initial_option : undefined).toBe(
      'deepseek-official/deepseek-v4-flash',
    );
  });

  it('the picker current reflects a session switch (not the static agent options) — regression #40', async () => {
    const llm = new FakeLlmService();
    const defaults = new FakeAgentDefaultModelService();
    const h = makeHarness({ llm, agentDefaultModel: defaults });
    await h.bridge.handleMessage(message()); // create the live agent (a turn runs)
    // The live agent's STATIC options differ from the session the user picks —
    // the bug read `live.options` (never mutated by a switch) first.
    h.agentStore.setOptions('feishu-session-1', {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    });
    // Switch the session model (raw arg path — allowed even while a turn runs).
    await h.bridge.handleMessage(
      message({ messageId: 'om_msg2', text: '/model deepseek-official/deepseek-r1' }),
    );
    // Re-open the picker: the CURRENT (preselected) model is the switched one,
    // NOT the static agent options.
    await h.bridge.handleMessage(message({ messageId: 'om_msg3', text: '/model' }));
    const card = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    expect(card?.header?.title.content).toBe('🤖 Model');
    const action = card?.elements.find((el) => el.tag === 'action');
    const select =
      action && 'actions' in action
        ? action.actions.find((a) => a.tag === 'select_static')
        : undefined;
    expect(select && 'initial_option' in select ? select.initial_option : undefined).toBe(
      'deepseek-official/deepseek-r1',
    );
  });

  it('a bare /model with an empty provider catalog still posts a picker card (no crash)', async () => {
    const llm: LlmService = {
      listProviders: () => [],
      async listModels() {
        return [];
      },
    };
    const h = makeHarness({ llm });
    await h.bridge.handleMessage(message({ text: '/model' }));
    const card = h.transport.updatedCards.at(-1) ?? h.transport.sentCards.at(-1);
    expect(card?.header?.title.content).toBe('🤖 Model');
    // No dropdown options — the card is posted without a select.
    const action = card?.elements.find((el) => el.tag === 'action');
    expect(
      action && 'actions' in action ? action.actions.some((a) => a.tag === 'select_static') : false,
    ).toBe(false);
  });

  it('a model pick applies the selection through the default service', async () => {
    const llm = new FakeLlmService();
    const defaults = new FakeAgentDefaultModelService();
    const h = makeHarness({ llm, agentDefaultModel: defaults });
    await h.bridge.handleMessage(message({ text: '/model' }));
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'model-pick' },
      option: 'deepseek-official/deepseek-r1',
    });
    expect(defaults.saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-r1' }]);
    expect(
      resultCardTexts(h).some((t) =>
        t.includes('Model set to deepseek-official · deepseek-r1 (this session + default)'),
      ),
    ).toBe(true);
  });

  it('a model pick applies from the panel picker view', async () => {
    const llm = new FakeLlmService();
    const defaults = new FakeAgentDefaultModelService();
    const h = makeHarness({ llm, agentDefaultModel: defaults });
    await h.bridge.handleMessage(message({ text: '/model' }));
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'model-pick' },
      option: 'deepseek-official/deepseek-r1',
    });
    expect(defaults.saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-r1' }]);
  });

  it('a model pick while a turn runs is refused', async () => {
    const llm = new FakeLlmService();
    const defaults = new FakeAgentDefaultModelService();
    const h = makeHarness({ llm, agentDefaultModel: defaults });
    await h.bridge.handleMessage(message({ text: '/model' }));
    const pickerId = lastCardId(h);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'start a turn' }));
    await h.bridge.handleCardAction({
      messageId: pickerId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'model-pick' },
      option: 'deepseek-official/deepseek-r1',
    });
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(true);
    expect(defaults.saved).toHaveLength(0);
  });
});

describe('/panel command', () => {
  it('opens the control panel card from a fresh chat (no prior message)', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message({ text: '/panel' }));
    const panel = h.transport.sentCards.at(-1);
    expect(panel?.header?.title.content).toBe('⚙️ dsh-feishu panel');
    // The fresh-chat panel is idle (no Stop) and shows the context line.
    const core = panel?.elements.find((el) => el.tag === 'action');
    const coreLabels =
      core && 'actions' in core
        ? core.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : [];
    expect(coreLabels).toEqual(['🔁 Retry last', '📋 Copy last']);
    expect(
      panel?.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('No session yet'),
      ),
    ).toBe(true);
  });

  it('is allowed while a turn is running (the panel carries Stop)', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/panel' }));
    const panel = h.transport.sentCards.at(-1);
    const core = panel?.elements.find((el) => el.tag === 'action');
    const coreLabels =
      core && 'actions' in core
        ? core.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : [];
    expect(coreLabels).toEqual(['⏹ Stop current turn', '🔁 Retry last', '📋 Copy last']);
  });
});

describe('working-directory gate (requireWorkingDir)', () => {
  it('refuses a turn until a working directory is chosen', async () => {
    const h = makeHarness({ requireWorkingDir: true });
    await h.bridge.handleMessage(message({ text: 'do some work' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('No working directory chosen'))).toBe(
      true,
    );
    // No session was created and the agent never saw the message.
    expect(h.sessionMap.get('oc_chat')).toBeUndefined();
    expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
    expect(h.agentStore.created).toHaveLength(0);
  });

  it('allows the turn after /cd pins a directory', async () => {
    const { mkdirSync } = await import('node:fs');
    const target = join(SCRATCH, 'proj-gate-cd');
    mkdirSync(target, { recursive: true });
    const h = makeHarness({ requireWorkingDir: true });
    await h.bridge.handleMessage(message({ text: `/cd ${target}` }));
    expect(h.sessionMap.cwdFor('oc_chat')).toBe(target);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'now work' }));
    expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
  });

  it('allows the turn after a working directory is set', async () => {
    const { mkdirSync } = await import('node:fs');
    const target = join(SCRATCH, 'proj-gate-repo');
    mkdirSync(target, { recursive: true });
    const h = makeHarness({ requireWorkingDir: true });
    // /repo <path> now opens the picker (it scans that path) and never pins
    // the cwd — pin it with /cd (the working-dir gate is what's under test).
    await h.bridge.handleMessage(message({ text: `/cd ${target}` }));
    expect(h.sessionMap.cwdFor('oc_chat')).toBe(target);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'now work' }));
    expect(h.agentStore.followups.get('feishu-session-1')).toHaveLength(1);
  });

  it('keeps read-only commands usable while unpinned', async () => {
    const h = makeHarness({ requireWorkingDir: true });
    await h.bridge.handleMessage(message({ text: '/help' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('dsh-feishu commands'))).toBe(true);
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/status' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('session: (none yet)'))).toBe(true);
    // The panel opens and surfaces the unpinned state.
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
          el.tag === 'markdown' && 'content' in el && el.content.includes('No working directory'),
      ),
    ).toBe(true);
  });

  it('parses an @-mentioned command ("@bot /help") as the slash command, bypassing the gate', async () => {
    const h = makeHarness({ requireWorkingDir: true });
    await h.bridge.handleMessage(groupMessage(['ou_bot'], { text: '@bot /help' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('dsh-feishu commands'))).toBe(true);
    expect(h.transport.sentTexts.some((t) => t.text.includes('No working directory chosen'))).toBe(
      false,
    );
    // No session was created and the agent never saw a turn.
    expect(h.agentStore.created).toHaveLength(0);
    expect(h.sessionMap.get('oc_chat')).toBeUndefined();
  });

  it('strips a mention with punctuation ("@bot，/help") and a mid-text mention', async () => {
    const h = makeHarness({ requireWorkingDir: true });
    await h.bridge.handleMessage(groupMessage(['ou_bot'], { text: '@bot，/help' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('dsh-feishu commands'))).toBe(true);
    await h.bridge.handleMessage(
      groupMessage(['ou_bot'], { messageId: 'om_msg3', text: 'see @bot /status' }),
    );
    // A mention after ordinary words is not a command — the cleaned text
    // ("see /status") still goes through the working-directory gate.
    expect(h.transport.sentTexts.some((t) => t.text.includes('No working directory chosen'))).toBe(
      true,
    );
  });

  it('still gates an @-mentioned plain message without a working directory', async () => {
    const h = makeHarness({ requireWorkingDir: true });
    await h.bridge.handleMessage(groupMessage(['ou_bot'], { text: '@bot do some work' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('No working directory chosen'))).toBe(
      true,
    );
    expect(h.agentStore.created).toHaveLength(0);
  });

  it('/clear keeps the pinned working directory', async () => {
    const { mkdirSync } = await import('node:fs');
    const target = join(SCRATCH, 'proj-gate-clear');
    mkdirSync(target, { recursive: true });
    let seq = 0;
    const h = makeHarness({ requireWorkingDir: true, mint: () => `feishu-session-${++seq}` });
    await h.bridge.handleMessage(message({ text: `/cd ${target}` }));
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/clear' }));
    expect(h.sessionMap.cwdFor('oc_chat')).toBe(target);
    await h.bridge.handleMessage(message({ messageId: 'om_msg3', text: 'work again' }));
    expect(h.agentStore.followups.get('feishu-session-2')).toHaveLength(1);
  });

  it('resume adopts the session cwd carried by the picker button', async () => {
    const h = makeHarness({
      requireWorkingDir: true,
      listSessions: async () => [
        {
          sessionId: 'feishu-session-9',
          title: 'Old project',
          cwd: '/work/old',
          createdAt: Date.now() - 3_600_000,
          live: false,
          persisted: true,
        },
      ],
    });
    await h.bridge.handleMessage(message({ text: '/sessions' }));
    // Enter the detail view: the detail card carries the cwd on Resume.
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'session-select', sessionId: 'feishu-session-9' },
    });
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'resume-session', sessionId: 'feishu-session-9', cwd: '/work/old' },
    });
    expect(h.sessionMap.cwdFor('oc_chat')).toBe('/work/old');
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'continue the work' }));
    expect(h.agentStore.followups.get('feishu-session-9')).toHaveLength(1);
  });

  it('typed /resume looks up the session cwd from the list', async () => {
    const h = makeHarness({
      requireWorkingDir: true,
      listSessions: async () => [
        {
          sessionId: 'feishu-session-9',
          title: 'Old project',
          cwd: '/work/old',
          createdAt: Date.now() - 3_600_000,
          live: false,
          persisted: true,
        },
      ],
    });
    await h.bridge.handleMessage(message({ text: '/resume feishu-session-9' }));
    expect(h.sessionMap.cwdFor('oc_chat')).toBe('/work/old');
  });
});

describe('interactive approvals (Iteration 3)', () => {
  /** The id stamped on the approval card's buttons. */
  function approvalRequestId(h: Harness): string {
    const card = h.transport.sentCards.at(-1);
    const action = card?.elements.find((el) => el.tag === 'action');
    const allow =
      action && 'actions' in action
        ? action.actions.find(
            (a) => a.tag === 'button' && 'value' in a && a.value.kind === 'approval',
          )
        : undefined;
    return (allow && 'value' in allow ? allow.value.id : undefined) ?? '';
  }

  it('posts an approval card and settles allowed-once on Allow', async () => {
    const h = makeHarness();
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    const agent = h.agentStore.resume ? await h.agentStore.resume('feishu-session-1') : undefined;
    if (agent === undefined) throw new Error('fake agent missing');
    const pending = h.bridge.handleApprovalRequest({
      agent,
      toolName: 'bash',
      reason: 'delete the files',
    });
    // Flush microtasks: register() runs after the awaited card send.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The approval card carries Allow/Reject buttons with the request id.
    const card = h.transport.sentCards.at(-1);
    expect(card?.header?.title.content).toBe('🔐 Approval needed');
    expect(JSON.stringify(card?.elements)).toContain('delete the files');
    const requestId = approvalRequestId(h);
    expect(requestId).not.toBe('');
    // Press Allow via the card callback.
    await h.bridge.handleCardAction({
      messageId: `msg-${h.transport.sentCards.length}`,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'approval', decision: 'allow', id: requestId },
    });
    await expect(pending).resolves.toBe('allowed-once');
    // The card is updated to a static decided state.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.stringify(h.transport.updatedCards.at(-1)?.elements)).toContain('Allowed once');
  });

  it('settles rejected on Reject and cancelled on timeout', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.sessionMap.set('oc_chat', 'feishu-session-1');
      const agent = await h.agentStore.resume('feishu-session-1');
      const pendingReject = h.bridge.handleApprovalRequest({
        agent,
        toolName: 'bash',
        reason: 'run',
      });
      // Under fake timers the flush must advance timers, not setTimeout.
      await vi.advanceTimersByTimeAsync(0);
      const requestId = approvalRequestId(h);
      await h.bridge.handleCardAction({
        messageId: `msg-${h.transport.sentCards.length}`,
        chatId: 'oc_chat',
        operatorOpenId: 'ou_user',
        value: { kind: 'approval', decision: 'reject', id: requestId },
      });
      await expect(pendingReject).resolves.toBe('rejected');
      // Timeout settles cancelled without a callback.
      const pendingTimeout = h.bridge.handleApprovalRequest({
        agent,
        toolName: 'read',
        reason: '',
      });
      await vi.advanceTimersByTimeAsync(0);
      h.transport.sentCards.pop();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await expect(pendingTimeout).resolves.toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed to unavailable when the session has no chat', async () => {
    const h = makeHarness();
    const agent = await h.agentStore.resume('feishu-session-1');
    const outcome = await h.bridge.handleApprovalRequest({ agent, toolName: 'bash', reason: '' });
    expect(outcome).toBe('unavailable');
    expect(h.transport.sentCards).toHaveLength(0);
  });
});

describe('interactive questions (Iteration 3)', () => {
  it('answers a single-select question from an option button', async () => {
    const h = makeHarness();
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    const agent = await h.agentStore.resume('feishu-session-1');
    const pending = h.bridge.askQuestions({
      agent,
      questions: [
        {
          id: 'q1',
          question: 'Which stack?',
          options: [{ label: 'Go' }, { label: 'Rust' }],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The question card lists the options as buttons.
    const card = h.transport.sentCards.at(-1);
    expect(JSON.stringify(card?.elements)).toContain('Which stack?');
    const action = card?.elements.find((el) => el.tag === 'action');
    const optionButton =
      action && 'actions' in action
        ? action.actions.find(
            (a) => a.tag === 'button' && 'value' in a && a.value.kind === 'question',
          )
        : undefined;
    // The card stamps the RAW question id; the bridge prefixes it into the
    // registry key.
    expect(optionButton && 'value' in optionButton ? optionButton.value.id : '').toBe('q1');
    await h.bridge.handleCardAction({
      messageId: `msg-${h.transport.sentCards.length}`,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'question', id: 'q1', answer: 'Rust' },
    });
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Rust'] }] });
    // The question card becomes a static confirmation (user report: it must
    // be disabled after answering).
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answered = h.transport.updatedCards.at(-1);
    expect(JSON.stringify(answered?.elements)).toContain('Answer: Rust');
    expect(answered?.elements.some((el) => el.tag === 'action')).toBe(false);
  });

  it('collects multi-select answers via toggles and submit', async () => {
    const h = makeHarness();
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    const agent = await h.agentStore.resume('feishu-session-1');
    const pending = h.bridge.askQuestions({
      agent,
      questions: [
        {
          id: 'q1',
          question: 'Pick any',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Toggle A then B: each re-posts the card with checkmarks.
    await h.bridge.handleCardAction({
      messageId: 'mem-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'question-toggle', id: 'q1', option: 'A' },
    });
    const card2 = h.transport.sentCards.at(-1);
    expect(JSON.stringify(card2?.elements)).toContain('✅ A');
    await h.bridge.handleCardAction({
      messageId: `msg-${h.transport.sentCards.length}`,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'question-toggle', id: 'q1', option: 'B' },
    });
    // Submit resolves with the collected selection.
    await h.bridge.handleCardAction({
      messageId: `msg-${h.transport.sentCards.length}`,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'question-submit', id: 'q1' },
    });
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['A', 'B'] }],
    });
  });

  it('finalizes the LATEST multi-select card after toggles (regression)', async () => {
    const h = makeHarness();
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    const agent = await h.agentStore.resume('feishu-session-1');
    const pending = h.bridge.askQuestions({
      agent,
      questions: [
        {
          id: 'q1',
          question: 'Pick any',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Toggle A: the card is re-posted (new message id) and the interaction
    // is retargeted to it.
    await h.bridge.handleCardAction({
      messageId: 'msg-1',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'question-toggle', id: 'q1', option: 'A' },
    });
    const rePostedId = `msg-${h.transport.sentCards.length}`;
    // Submit from the NEWEST card.
    await h.bridge.handleCardAction({
      messageId: rePostedId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'question-submit', id: 'q1' },
    });
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The LATEST card was finalized as a static answer — no buttons left.
    const last = h.transport.updatedCards.at(-1);
    expect(last?.elements.some((el) => el.tag === 'action')).toBe(false);
    expect(JSON.stringify(last?.elements)).toContain('Answer: A');
  });

  it('submitting a multi-select question with no selection settles an empty answer', async () => {
    const h = makeHarness();
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    const agent = await h.agentStore.resume('feishu-session-1');
    const pending = h.bridge.askQuestions({
      agent,
      questions: [{ id: 'q1', question: 'Pick any', multiSelect: true, options: [{ label: 'A' }] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Submit without toggling anything: the empty selection settles.
    await h.bridge.handleCardAction({
      messageId: `msg-${h.transport.sentCards.length}`,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'question-submit', id: 'q1' },
    });
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }] });
  });

  it('captures the next chat message as a free-text answer', async () => {
    const h = makeHarness();
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    const agent = await h.agentStore.resume('feishu-session-1');
    const pending = h.bridge.askQuestions({
      agent,
      questions: [{ id: 'q1', question: 'Describe it' }],
    });
    expect(JSON.stringify(h.transport.sentCards.at(-1)?.elements)).toContain(
      'Reply with your answer as a message',
    );
    // The next plain message is the answer (not a turn).
    await h.bridge.handleMessage(message({ text: 'my free text answer' }));
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: 'my free text answer' }],
    });
    expect(h.agentStore.followups.get('feishu-session-1')).toBeUndefined();
  });

  it('cancels a question when the request aborts', async () => {
    const h = makeHarness();
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    const agent = await h.agentStore.resume('feishu-session-1');
    const controller = new AbortController();
    const pending = h.bridge.askQuestions({
      agent,
      signal: controller.signal,
      questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }] });
  });

  it('answers cancelled when no chat maps to the agent', async () => {
    const h = makeHarness();
    const agent = await h.agentStore.resume('feishu-session-1');
    const answer = await h.bridge.askQuestions({
      agent,
      questions: [{ id: 'q1', question: 'Which?' }],
    });
    expect(answer).toEqual({ answers: [{ id: 'q1', selected: [] }] });
    expect(h.transport.sentCards).toHaveLength(0);
  });
});

describe('/export command', () => {
  function makeExportHarness(readSession?: (id: string) => Promise<unknown>) {
    const h = makeHarness({});
    if (readSession !== undefined) {
      const bridge = h.bridge as unknown as { options: { readSession?: unknown } };
      bridge.options.readSession = readSession;
    }
    return h;
  }

  it('exports the session log as a file message', async () => {
    const h = makeExportHarness(async () => ({
      session: { id: 'feishu-session-1' },
      events: [
        {
          type: 'message',
          seq: 1,
          data: { message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
        },
        {
          type: 'assistant/message',
          seq: 2,
          data: { message: { content: [{ type: 'text', text: 'hi' }] } },
        },
        { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
      ],
    }));
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleMessage(message({ text: '/export' }));
    expect(h.transport.sentFiles).toHaveLength(1);
    const file = h.transport.sentFiles[0];
    expect(file?.fileName).toBe('session-feishu-session-1.md');
    const content = Buffer.from(file?.content ?? []).toString('utf8');
    expect(content).toContain('## user');
    expect(content).toContain('hi');
    expect(h.transport.sentTexts.some((t) => t.text.includes('Exported 3 events'))).toBe(true);
  });

  it('reports when there is no session yet', async () => {
    const h = makeExportHarness();
    await h.bridge.handleMessage(message({ text: '/export' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('no session to export'))).toBe(true);
    expect(h.transport.sentFiles).toHaveLength(0);
  });

  it('reports loudly when the session query service is absent', async () => {
    const h = makeExportHarness();
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleMessage(message({ text: '/export' }));
    expect(
      h.transport.sentTexts.some((t) => t.text.includes('session query service is not mounted')),
    ).toBe(true);
    expect(h.transport.sentFiles).toHaveLength(0);
  });

  it('surfaces a failed read as an error', async () => {
    const h = makeExportHarness(async () => {
      throw new Error('corrupt log');
    });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleMessage(message({ text: '/export' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('session export failed'))).toBe(true);
  });

  it('exports an empty session log as a file with a no-content marker', async () => {
    const h = makeExportHarness(async () => ({
      session: { id: 'feishu-session-1' },
      events: [],
    }));
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleMessage(message({ text: '/export' }));
    expect(h.transport.sentFiles).toHaveLength(1);
    expect(Buffer.from(h.transport.sentFiles[0]?.content ?? []).toString('utf8')).toContain(
      'no content',
    );
    expect(h.transport.sentTexts.some((t) => t.text.includes('Exported 0 events'))).toBe(true);
  });
});

describe('two-stage reaction ack', () => {
  it('adds the received emoji to an accepted turn message', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message({ text: 'work please' }));
    expect(h.transport.reactions).toEqual([
      { messageId: 'om_msg1', emojiType: 'GoGoGo', action: 'add', reactionId: 'rx-1' },
    ]);
  });

  it('swaps to DONE when the turn completes', async () => {
    const h = makeHarness({ throttleMs: 0 });
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', chunkEvent('answer'));
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const actions = h.transport.reactions.filter(
      (r) => r.action === 'add' || r.action === 'remove',
    );
    expect(actions).toEqual([
      { messageId: 'om_msg1', emojiType: 'GoGoGo', action: 'add', reactionId: 'rx-1' },
      { messageId: 'om_msg1', action: 'remove', reactionId: 'rx-1' },
      { messageId: 'om_msg1', emojiType: 'DONE', action: 'add', reactionId: 'rx-2' },
    ]);
  });

  it('swaps to ERROR on error and stopped (WARN is not a valid Feishu emoji_type)', async () => {
    for (const reason of ['error', 'aborted']) {
      const h = makeHarness({ throttleMs: 0 });
      await h.bridge.handleMessage(message());
      await h.bridge.handleEvent(
        'feishu-session-1',
        reason === 'error'
          ? (turnEndEvent({ kind: 'error', error: { code: 'X', message: 'boom' } }) as SessionEvent)
          : (turnEndEvent({ kind: 'aborted' }) as SessionEvent),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const adds = h.transport.reactions.filter((r) => r.action === 'add').map((r) => r.emojiType);
      expect(adds).toEqual(['GoGoGo', 'ERROR']);
      expect(h.transport.reactions.some((r) => r.action === 'remove')).toBe(true);
    }
  });

  it('does not react to slash commands or gated-away messages', async () => {
    const h = makeHarness({ requireWorkingDir: true });
    await h.bridge.handleMessage(message({ text: '/help' }));
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: 'no cwd yet' }));
    expect(h.transport.reactions).toHaveLength(0);
  });

  it('survives reaction failures (turn still completes)', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const transport = h.transport;
    const original = transport.addReaction.bind(transport);
    transport.addReaction = async () => {
      throw new Error('reaction api down');
    };
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', chunkEvent('answer'));
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transport.updatedCards.at(-1)?.header?.template).toBe('green');
    void original;
  });

  it('honors configured reaction emojis', async () => {
    const h = makeHarness({
      reactions: { received: 'OK', done: 'THUMBSUP', error: 'WOW', stopped: 'WOW' },
    });
    await h.bridge.handleMessage(message());
    expect(h.transport.reactions[0]?.emojiType).toBe('OK');
  });
});

describe('proactive @ mentions in groups', () => {
  it('error notice @s the requester in a group', async () => {
    const h = makeHarness({ groupMentionMode: 'never' });
    await h.bridge.handleMessage(groupMessage([], { senderOpenId: 'ou_user' }));
    await h.bridge.handleEvent(
      'feishu-session-1',
      turnEndEvent({ kind: 'error', error: { code: 'X', message: 'boom' } }) as SessionEvent,
    );
    const notice = h.transport.sentTexts.at(-1);
    expect(notice?.text).toContain('<at user_id="ou_user"></at>');
    expect(notice?.text).toContain('Turn failed');
  });

  it('p2p error notices carry no mention', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent(
      'feishu-session-1',
      turnEndEvent({ kind: 'error', error: { code: 'X', message: 'boom' } }) as SessionEvent,
    );
    expect(h.transport.sentTexts.at(-1)?.text).toBe('⚠️ Turn failed — see the card for details');
  });

  it('approval card @s the requester in a group', async () => {
    const h = makeHarness({ groupMentionMode: 'never' });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleMessage(groupMessage([], { senderOpenId: 'ou_user' }));
    const agent = await h.agentStore.resume('feishu-session-1');
    void h.bridge.handleApprovalRequest({ agent, toolName: 'bash', reason: 'run' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const markdown = h.transport.sentCards.at(-1)?.elements.find((el) => el.tag === 'markdown');
    expect(markdown && 'content' in markdown ? markdown.content : '').toContain(
      '<at id="ou_user"></at>',
    );
  });

  it('question card @s the requester in a group', async () => {
    const h = makeHarness({ groupMentionMode: 'never' });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleMessage(groupMessage([], { senderOpenId: 'ou_user' }));
    const agent = await h.agentStore.resume('feishu-session-1');
    void h.bridge.askQuestions({
      agent,
      questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'Go' }] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const markdown = h.transport.sentCards.at(-1)?.elements.find((el) => el.tag === 'markdown');
    expect(markdown && 'content' in markdown ? markdown.content : '').toContain(
      '<at id="ou_user"></at>',
    );
  });
});

describe('/feishu-status diagnostic card', () => {
  it('posts a diagnostic card with app, connection, sessions and last inbound', async () => {
    const h = makeHarness({ appId: 'cli_test', transportMode: 'memory' });
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/feishu-status' }));
    const card = h.transport.sentCards.at(-1);
    expect(card?.header?.title.content).toBe('📊 dsh-feishu status');
    const markdown = card?.elements.find((el) => el.tag === 'markdown');
    const content = markdown && 'content' in markdown ? markdown.content : '';
    expect(content).toContain('cli_test');
    expect(content).toContain('memory (test transport)');
    expect(content).toContain('**sessions:** 1');
    expect(content).not.toContain('never');
  });

  it('reads a lark transport connection state; never-received shows never', async () => {
    const h = makeHarness({ appId: 'cli_live', transportMode: 'lark' });
    const transport = h.transport;
    transport.connectionState = () => 'reconnecting';
    await h.bridge.handleMessage(message({ text: '/feishu-status' }));
    const card = h.transport.sentCards.at(-1);
    const markdown = card?.elements.find((el) => el.tag === 'markdown');
    const content = markdown && 'content' in markdown ? markdown.content : '';
    expect(content).toContain('⚠️ reconnecting');
  });

  it('is read-only and answers while a turn is running', async () => {
    const h = makeHarness({ throttleMs: 0, appId: 'cli_test', transportMode: 'memory' });
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/feishu-status' }));
    // The working card exists (the turn is held open by the throttle); the
    // diagnostic still posts.
    const status = h.transport.sentCards.filter(
      (c) => c.header?.title.content === '📊 dsh-feishu status',
    );
    expect(status).toHaveLength(1);
  });
});

describe('agent-initiated turns (schedule reminders)', () => {
  function pluginUserMessage(plugin = 'schedule'): SessionEvent {
    return {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: {
        id: 'reminder-1',
        role: 'user',
        content: [{ type: 'text', text: 'reminder_prompt_json: {"prompt":"check the build"}' }],
        source: { kind: 'plugin', plugin },
      },
    } as unknown as SessionEvent;
  }

  function userUserMessage(): SessionEvent {
    return {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: {
        id: 'history-1',
        role: 'user',
        content: [{ type: 'text', text: 'old message' }],
        source: { kind: 'user' },
      },
    } as unknown as SessionEvent;
  }

  it('renders a plugin-sourced (reminder) turn on a fresh card', async () => {
    const h = makeHarness({ throttleMs: 0 });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleEvent('feishu-session-1', pluginUserMessage());
    await h.bridge.handleEvent('feishu-session-1', chunkEvent('reminder answer'));
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    const opened = h.transport.sentCards.at(-1);
    expect(opened?.header?.title.content).toBe('⏰ Reminder');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finalized = h.transport.updatedCards.at(-1);
    expect(finalized?.header?.template).toBe('green');
    expect(JSON.stringify(finalized?.elements)).toContain('reminder answer');
  });

  it('does not open a card for a user-sourced message on a card-less chat (resume no-replay)', async () => {
    const h = makeHarness({ throttleMs: 0 });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleEvent('feishu-session-1', userUserMessage());
    await h.bridge.handleEvent('feishu-session-1', chunkEvent('stale output'));
    expect(h.transport.sentCards).toHaveLength(0);
  });

  it('a non-schedule plugin still opens a card with a generic title', async () => {
    const h = makeHarness({ throttleMs: 0 });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleEvent('feishu-session-1', pluginUserMessage('some-other-plugin'));
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    expect(h.transport.sentCards.at(-1)?.header?.title.content).toBe(
      '⏰ some-other-plugin notification',
    );
  });
});

describe('/schedule reminder listing', () => {
  it('reports no reminders when the session has none', async () => {
    const h = makeHarness({
      readSession: async () => ({ session: { id: 'feishu-session-1' }, events: [] }),
    });
    await h.bridge.handleMessage(message());
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/schedule' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('No active reminders'))).toBe(true);
  });

  it('errors without a session (no reminders to list)', async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(message({ text: '/schedule' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('no session yet'))).toBe(true);
  });
});

describe('compaction lifecycle (user report regression)', () => {
  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
  });

  afterEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  function compactionStartEvent(): SessionEvent {
    return {
      type: 'compaction/start',
      seq: 1,
      time: 0,
      data: { compactionId: 'comp-1' },
    } as unknown as SessionEvent;
  }

  function compactionSummaryEvent(summary: string): SessionEvent {
    return {
      type: 'compaction/summary',
      seq: 2,
      time: 0,
      data: { compactionId: 'comp-1', summary },
    } as unknown as SessionEvent;
  }

  function compactionEndEvent(): SessionEvent {
    return {
      type: 'compaction/end',
      seq: 3,
      time: 0,
      data: { compactionId: 'comp-1' },
    } as unknown as SessionEvent;
  }

  function compactCheckpointMessage(): SessionEvent {
    return {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: {
        id: 'checkpoint-1',
        role: 'user',
        content: [{ type: 'text', text: 'compact checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact' },
      },
    } as unknown as SessionEvent;
  }

  it('compaction/start opens a Compacting card immediately (button feedback)', async () => {
    const h = makeHarness({ throttleMs: 0 });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleEvent('feishu-session-1', compactionStartEvent());
    const opened = h.transport.sentCards.at(-1);
    expect(opened?.header?.title.content).toBe('🧹 Compacting…');
  });

  it('compaction/summary renders the summary into the compaction card', async () => {
    const h = makeHarness({ throttleMs: 0 });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleEvent('feishu-session-1', compactionStartEvent());
    await h.bridge.handleEvent('feishu-session-1', compactionSummaryEvent('summarized history'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const updated = h.transport.updatedCards.at(-1);
    expect(JSON.stringify(updated?.elements)).toContain('summarized history');
  });

  it('compaction/end finalizes the card and unlocks the chat (regression)', async () => {
    const h = makeHarness({ throttleMs: 0 });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleEvent('feishu-session-1', compactionStartEvent());
    await h.bridge.handleEvent('feishu-session-1', compactionSummaryEvent('summarized history'));
    await h.bridge.handleEvent('feishu-session-1', compactionEndEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finalized = h.transport.updatedCards.at(-1);
    expect(finalized?.header?.template).toBe('green');
    // The regression: the chat is NOT left permanently "working" — a
    // mutating command is servable again instead of being refused with
    // "a turn is running — stop it first." (user report).
    await h.bridge.handleMessage(message({ messageId: 'om_clear', text: '/clear' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(false);
    expect(h.transport.sentTexts.some((t) => t.text.includes('New conversation started'))).toBe(
      true,
    );
  });

  it('a compaction checkpoint message without a start event opens a Compacting card (fallback)', async () => {
    const h = makeHarness({ throttleMs: 0 });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleEvent('feishu-session-1', compactCheckpointMessage());
    expect(h.transport.sentCards.at(-1)?.header?.title.content).toBe('🧹 Compacting…');
  });

  it('compaction/end without an open compaction card is a no-op', async () => {
    const h = makeHarness({ throttleMs: 0 });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleEvent('feishu-session-1', compactionEndEvent());
    expect(h.transport.sentCards).toHaveLength(0);
  });

  it('a failed compaction (end with error) finalizes as error and still unlocks the chat', async () => {
    const h = makeHarness({ throttleMs: 0 });
    await h.bridge.handleCardAction({
      messageId: 'mem-open',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    h.sessionMap.set('oc_chat', 'feishu-session-1');
    await h.bridge.handleEvent('feishu-session-1', compactionStartEvent());
    await h.bridge.handleEvent('feishu-session-1', {
      type: 'compaction/end',
      seq: 3,
      time: 0,
      data: {
        compactionId: 'comp-1',
        error: { name: 'E', code: 'summary', message: 'no summary' },
      },
    } as unknown as SessionEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finalized = h.transport.updatedCards.at(-1);
    expect(finalized?.header?.template).toBe('red');
    expect(h.transport.sentTexts.some((t) => t.text.includes('Compaction failed'))).toBe(true);
    // The chat is unlocked even when compaction failed (regression).
    await h.bridge.handleMessage(message({ messageId: 'om_clear', text: '/clear' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('a turn is running'))).toBe(false);
    expect(h.transport.sentTexts.some((t) => t.text.includes('New conversation started'))).toBe(
      true,
    );
  });

  it('compact with no compactable history replies and never wedges the chat', async () => {
    const h = makeHarness({
      executeCommand: async () => ({ kind: 'success', text: 'No compactable history yet.' }),
    });
    await h.bridge.handleMessage(message());
    await h.bridge.handleEvent('feishu-session-1', turnEndEvent());
    await h.bridge.handleCardAction({
      messageId: 'mem-open',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel' },
    });
    const cardId = lastCardId(h);
    // compact's panel button opens the confirm view first (first panel
    // render posts a card)…
    await h.bridge.handleCardAction({
      messageId: cardId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'command', name: 'compact' },
    });
    expect(h.transport.updatedCards.at(-1)?.header?.title.content).toBe('🧹 Compact');
    // …the confirm button runs it: informational reply, no compaction card,
    // chat NOT left working.
    await h.bridge.handleCardAction({
      messageId: lastCardId(h),
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'panel-confirm', command: 'compact' },
    });
    expect(resultCardTexts(h).some((t) => t.includes('No compactable history'))).toBe(true);
    expect(h.transport.sentCards.some((c) => c.header?.title.content === '🧹 Compacting…')).toBe(
      false,
    );
    await h.bridge.handleMessage(message({ messageId: 'om_msg2', text: '/clear' }));
    expect(h.transport.sentTexts.some((t) => t.text.includes('New conversation started'))).toBe(
      true,
    );
  });
});
