/**
 * File-channel in-memory Feishu transport — the integration-test seam.
 *
 * The surface normally talks to Feishu over the lark-oapi long connection.
 * For integration tests (and debugging without a Feishu app), the plugin
 * honors `FEISHU_TRANSPORT=memory`: this transport swaps the wire for two
 * directories under `FEISHU_MEMORY_DIR` (or the surface data dir):
 *
 * - `inbox/` — drop `<messageId>.json` files here; each is delivered to the
 *   bridge as one {@link FeishuMessage} (file removed after delivery).
 * - `outbox/` — every send/update is recorded as `<seq>.json` in
 *   {@link MemoryOutboxRecord} shape, oldest first.
 *
 * This keeps the whole real composition (dsh profile → agent loop →
 * session/event → cards) testable end to end with only the two external
 * services mocked: Feishu here, and the LLM API by a mock server.
 *
 * @module @dsh-feishu/dsh-feishu/memory-transport
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CardAction,
  CardJson,
  ChatStats,
  FeishuMessage,
  FeishuTransport,
  SentCard,
} from './feishu/types.js';

/** Options for {@link MemoryTransport}. */
export interface MemoryTransportOptions {
  /** Root directory holding `inbox/` and `outbox/`. */
  readonly dir: string;
  /** Inbox poll interval in ms (default 200). */
  readonly pollIntervalMs?: number;
  /** The bot's own open id (mention-gate tests). */
  readonly botOpenId?: string;
  /** Membership counts served for every chat (mention-gate tests). */
  readonly chatStats?: ChatStats;
}

/** One recorded send/update in the outbox. */
export interface MemoryOutboxRecord {
  readonly seq: number;
  readonly kind: 'text' | 'card' | 'patch';
  readonly at: number;
  readonly chatId?: string;
  readonly messageId?: string;
  readonly text?: string;
  readonly card?: CardJson;
}

/**
 * The file-channel in-memory transport.
 */
export class MemoryTransport implements FeishuTransport {
  private handler: ((message: FeishuMessage) => void) | undefined;
  private actionHandler: ((action: CardAction) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly botOpenId: string | undefined;
  private readonly stats: ChatStats | undefined;
  private seq = 0;
  private readonly inboxDir: string;
  private readonly outboxDir: string;
  private readonly pollIntervalMs: number;

  constructor(options: MemoryTransportOptions) {
    this.inboxDir = join(options.dir, 'inbox');
    this.outboxDir = join(options.dir, 'outbox');
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.botOpenId = options.botOpenId;
    this.stats = options.chatStats;
  }

  /** The bot's own open id configured for this transport. */
  getBotOpenId(): string | undefined {
    return this.botOpenId;
  }

  /** Membership counts configured for this transport. */
  async chatStats(_chatId: string): Promise<ChatStats | undefined> {
    return this.stats;
  }

  /** Create the directories and begin polling the inbox. */
  async start(): Promise<void> {
    mkdirSync(this.inboxDir, { recursive: true });
    mkdirSync(this.outboxDir, { recursive: true });
    this.timer = setInterval(() => this.drainInbox(), this.pollIntervalMs);
  }

  /** Stop polling the inbox. */
  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Register the single inbound-message handler (last registration wins). */
  onMessage(handler: (message: FeishuMessage) => void): void {
    this.handler = handler;
  }

  /** Register the single card-button handler (last registration wins). */
  onCardAction(handler: (action: CardAction) => void): void {
    this.actionHandler = handler;
  }

  /** Deliver a card action directly (same-process) for tests. */
  deliverAction(action: CardAction): void {
    this.actionHandler?.(action);
  }

  /** Record a text send in the outbox. */
  async sendText(chatId: string, text: string): Promise<void> {
    this.record({ kind: 'text', chatId, text });
  }

  /** Record a card send; the created message id is the outbox seq. */
  async sendCard(chatId: string, card: CardJson): Promise<SentCard> {
    const messageId = `mem-${++this.seq}`;
    this.record({ kind: 'card', chatId, messageId, card });
    return { messageId };
  }

  /** Record a card update in the outbox. */
  async updateCard(messageId: string, card: CardJson): Promise<void> {
    this.record({ kind: 'patch', messageId, card });
  }

  /** Direct same-process delivery (bypasses the file channel) for tests. */
  deliver(message: FeishuMessage): void {
    this.handler?.(message);
  }

  /** All outbox records, oldest first. */
  outbox(): MemoryOutboxRecord[] {
    let files: string[];
    try {
      files = readdirSync(this.outboxDir).filter((file) => file.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((file) => {
        try {
          return JSON.parse(readFileSync(join(this.outboxDir, file), 'utf8')) as MemoryOutboxRecord;
        } catch {
          return undefined;
        }
      })
      .filter((record): record is MemoryOutboxRecord => record !== undefined)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Deliver every pending inbox file to the handler, then remove it. */
  private drainInbox(): void {
    let files: string[];
    try {
      files = readdirSync(this.inboxDir).filter((file) => file.endsWith('.json'));
    } catch {
      return;
    }
    for (const file of files) {
      const path = join(this.inboxDir, file);
      try {
        const message = JSON.parse(readFileSync(path, 'utf8')) as FeishuMessage;
        this.handler?.(message);
      } catch {
        // Malformed inbox file: drop it rather than redelivering forever.
      } finally {
        rmSync(path, { force: true });
      }
    }
  }

  private record(record: Omit<MemoryOutboxRecord, 'seq' | 'at'>): void {
    this.seq += 1;
    const full: MemoryOutboxRecord = { ...record, seq: this.seq, at: Date.now() };
    writeFileSync(
      join(this.outboxDir, `${String(this.seq).padStart(6, '0')}.json`),
      JSON.stringify(full),
      'utf8',
    );
  }
}

/** Create a file-channel memory transport. */
export function createMemoryTransport(options: MemoryTransportOptions): FeishuTransport {
  return new MemoryTransport(options);
}
