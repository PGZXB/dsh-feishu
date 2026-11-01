/**
 * Recover messages that arrived while the long connection was down.
 *
 * Feishu pushes events over the persistent connection and does not replay them
 * after a reconnect: a message sent while the socket was down never reaches the
 * bot, even after the connection is healthy again. The only durable source is
 * the chat history API, so the surface walks `im/v1/messages` forward from a
 * persisted per-chat boundary and hands the missed text messages to the bridge.
 *
 * ## Correctness model
 *
 * Per chat the store keeps three separate things:
 *
 * - **`scannedThrough`** — the timestamp up to which history has been
 *   *completely enumerated*. It advances only when a scan session reaches an
 *   explicitly terminal page (`has_more === false`). It is never derived from a
 *   clock comparison: a socket that "looked ready" is not evidence that nothing
 *   was missed (a half-open link stays ready until the liveness watchdog fires).
 * - **`session`** — an in-progress scan: the fixed range `[since, end]` and the
 *   `pageToken` of the page currently being drained. There is deliberately no
 *   positional offset: when the budget stops mid-page the page is re-fetched
 *   and already-delivered items are skipped by message id. Re-fetching by id is
 *   robust to a server reordering same-timestamp items, which a saved offset
 *   would not be.
 * - **`seen`** — id → timestamp of messages already handed to the bridge. Ids
 *   are evicted only when strictly behind the boundary; ids at or after it are
 *   kept, because scans are inclusive at the boundary and an evicted boundary id
 *   would be delivered twice.
 *
 * ## Scheduling invariant
 *
 * `run(chatIds)` records a coverage target per chat (the time the request wants
 * scanned). A pass may complete an older session that does not reach the target;
 * the chat stays queued until `scannedThrough >= target`. Chats that end a pass
 * with a session, a backlog, or an unmet target are re-queued, so a follow-up
 * timer never runs empty and a recovery request is never consumed by an
 * unrelated in-progress scan.
 *
 * @module @dsh-feishu/dsh-feishu/catchup
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FeishuMessage, HistoryPage, RawHistoryItem } from './feishu/types.js';

/** Default look-back cap for one catch-up run (6 hours). */
export const DEFAULT_WINDOW_MS = 6 * 60 * 60_000;
/** Default maximum messages delivered by one run, across chats. */
export const DEFAULT_MAX_MESSAGES = 20;
/** Safety cap on pages fetched per chat per run. */
export const DEFAULT_MAX_PAGES = 20;
/** Default cap on remembered ids per chat (only ids behind the boundary evict). */
export const SEEN_IDS_PER_CHAT = 512;
/** Default maximum page size requested from the history API. */
export const MAX_PAGE_SIZE = 50;
/** Delay before draining a backlog left by a budget/page-cap stop. */
export const FOLLOW_UP_DELAY_MS = 5_000;
/** Delay before a coalesced rerun (a reconnect arrived during a scan). */
export const RERUN_DELAY_MS = 250;

/** Minimal logger surface the catch-up needs. */
export interface CatchupLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/** An in-progress history scan. */
export interface ScanSession {
  readonly since: number;
  readonly end: number;
  readonly pageToken?: string;
}

/** Per-chat persisted state. */
export interface CatchupEntry {
  scannedThrough: number;
  session?: ScanSession;
  seen: Map<string, number>;
}

/** Transport surface the catch-up needs. */
export interface CatchupTransport {
  listMessages(
    chatId: string,
    range: {
      startTimeSec: number;
      endTimeSec: number;
      pageSize?: number;
      pageToken?: string;
    },
  ): Promise<HistoryPage>;
}

/** A normalized replay candidate. */
export type ReplayedMessage = FeishuMessage & { readonly replayed: true };

/**
 * Parse a Feishu message-list item into the same shape `normalizeMessageEvent`
 * produces for a pushed event.
 *
 * The history API's mention shape differs from the event payload's:
 * `{ key, id: string, id_type, name }` (string id) vs `{ id: { open_id } }`.
 * Reading the event shape here silently drops every @-mention, which makes a
 * replayed group message fail the bridge's mention gate.
 *
 * Only `text` messages are replayed: attachments need a second download
 * round-trip, and silently re-uploading media minutes late is worse than telling
 * the operator it was skipped.
 * @param item - one `im.v1.message.list` item.
 * @param chatId - the chat the item belongs to.
 * @param chatType - the chat type.
 * @returns the normalized message, or `undefined` when it is not replayable.
 */
export function normalizeApiMessage(
  item: RawHistoryItem,
  chatId: string,
  chatType: 'p2p' | 'group',
): ReplayedMessage | undefined {
  if (item.msg_type !== 'text') return undefined;
  const sender = item.sender;
  if (sender?.sender_type !== 'user') return undefined;
  const createdAt = Number(item.create_time);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined;
  let text = '';
  try {
    text = (JSON.parse(item.body?.content ?? '{}') as { text?: string }).text ?? '';
  } catch {
    return undefined;
  }
  text = text
    .replace(/<at[^>]*>.*?<\/at>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return undefined;
  const mentions = (item.mentions ?? [])
    .filter((mention) => mention.id_type === undefined || mention.id_type === 'open_id')
    .map((mention) => mention.id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  return {
    messageId: item.message_id ?? '',
    chatId,
    chatType,
    senderOpenId: sender.id ?? '',
    text,
    attachments: [],
    mentions,
    createdAt,
    replayed: true,
  };
}

/**
 * Durable per-chat scan state. Accepts v1 (bare timestamp), v2
 * (`{scannedThrough, seenIds}`) and v3 (`{seen: {id: ts}}`, with or without an
 * offset) files and upgrades them to v4 on load.
 */
export class CatchupStore {
  private readonly file: string;
  private readonly logger: CatchupLogger | undefined;
  private readonly seenCap: number;
  private readonly entries = new Map<string, CatchupEntry>();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(file: string, logger?: CatchupLogger, options: { seenCap?: number } = {}) {
    this.file = file;
    this.logger = logger;
    this.seenCap = options.seenCap ?? SEEN_IDS_PER_CHAT;
  }

  /** Load the state file, upgrading older versions. */
  load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as {
        cursors?: Record<string, unknown>;
      };
      if (typeof parsed.cursors !== 'object' || parsed.cursors === null) return;
      for (const [chatId, value] of Object.entries(parsed.cursors)) {
        if (typeof value === 'number') {
          this.apply(chatId, { scannedThrough: value });
          continue;
        }
        if (typeof value !== 'object' || value === null) continue;
        const record = value as {
          scannedThrough?: unknown;
          seenIds?: unknown;
          seen?: unknown;
          session?: unknown;
        };
        const through = Number(record.scannedThrough);
        if (!Number.isFinite(through) || through <= 0) continue;
        const seen = new Map<string, number>();
        // v2: an id list with no timestamps. The only safe assumption is "seen
        // at or before the boundary", so stamp them at the boundary.
        if (Array.isArray(record.seenIds)) {
          for (const id of record.seenIds) {
            if (typeof id === 'string') seen.set(id, through);
          }
        }
        // v3/v4: id → timestamp.
        if (typeof record.seen === 'object' && record.seen !== null) {
          for (const [id, ts] of Object.entries(record.seen as Record<string, unknown>)) {
            const at = Number(ts);
            if (Number.isFinite(at)) seen.set(id, at);
          }
        }
        const session = normalizeSession(record.session);
        this.apply(chatId, {
          scannedThrough: through,
          ...(session === undefined ? {} : { session }),
          seen,
        });
      }
      this.logger?.debug(`catchup state loaded (${this.entries.size} chat(s))`);
    } catch {
      // Missing on first run; anything else is a corrupt file, treated the same.
    }
  }

  /** Install an entry directly (tests/migration). */
  apply(
    chatId: string,
    entry: { scannedThrough: number; session?: ScanSession; seen?: Map<string, number> },
  ): void {
    this.entries.set(chatId, {
      scannedThrough: entry.scannedThrough,
      ...(entry.session === undefined ? {} : { session: entry.session }),
      seen: entry.seen ?? new Map(),
    });
  }

  /** @returns the chat entry, or `undefined`. */
  get(chatId: string): CatchupEntry | undefined {
    return this.entries.get(chatId);
  }

  /** @returns the fully-scanned boundary, or `undefined`. */
  scannedThrough(chatId: string): number | undefined {
    return this.entries.get(chatId)?.scannedThrough;
  }

  /** @returns the in-progress session, or `undefined`. */
  session(chatId: string): ScanSession | undefined {
    return this.entries.get(chatId)?.session;
  }

  /** @returns whether the id was already handed to the bridge. */
  hasSeen(chatId: string, messageId: string): boolean {
    return this.entries.get(chatId)?.seen.has(messageId) ?? false;
  }

  /**
   * Record a message id as delivered (live or replayed). Never moves the scan
   * boundary; evicts only ids strictly behind it.
   */
  recordSeen(chatId: string, messageId: string, createdAt?: number): void {
    let entry = this.entries.get(chatId);
    if (entry === undefined) {
      if (createdAt === undefined) return;
      entry = { scannedThrough: createdAt, seen: new Map() };
      this.entries.set(chatId, entry);
    }
    if (entry.seen.has(messageId)) return;
    entry.seen.set(messageId, createdAt ?? 0);
    this.evict(entry);
    this.scheduleFlush();
  }

  /**
   * Drop ids strictly behind the boundary. Ids at or after it are kept: scans
   * are inclusive at the boundary, so evicting `ts === scannedThrough` would
   * make the next pass deliver them again.
   */
  private evict(entry: CatchupEntry): void {
    if (entry.seen.size <= this.seenCap) return;
    for (const [id, ts] of entry.seen) {
      if (entry.seen.size <= this.seenCap) return;
      if (ts >= entry.scannedThrough) return;
      entry.seen.delete(id);
    }
  }

  /** Persist an in-progress scan session (no positional offset by design). */
  saveSession(chatId: string, session: ScanSession): void {
    const entry = this.entries.get(chatId);
    if (entry === undefined) return;
    entry.session = session;
    this.scheduleFlush();
  }

  /** Mark a scan session complete: commit its upper bound and clear it. */
  completeSession(chatId: string, through: number): void {
    const entry = this.entries.get(chatId);
    if (entry === undefined) return;
    if (through > entry.scannedThrough) entry.scannedThrough = through;
    delete entry.session;
    this.evict(entry);
    this.scheduleFlush();
  }

  /** Debounced write (2s) so a busy chat does not rewrite the file per message. */
  scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 2000);
    this.flushTimer.unref?.();
  }

  /** Write the state atomically; keeps `dirty` and retries on failure. */
  flush(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const cursors: Record<string, unknown> = {};
      for (const [chatId, entry] of this.entries) {
        cursors[chatId] = {
          scannedThrough: entry.scannedThrough,
          seen: Object.fromEntries(entry.seen),
          ...(entry.session === undefined ? {} : { session: entry.session }),
        };
      }
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 4, cursors }, null, 2));
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (error: unknown) {
      this.logger?.warn(`catchup state write failed: ${String(error)}`);
      if (this.flushTimer === undefined) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          this.flush();
        }, 5000);
        this.flushTimer.unref?.();
      }
    }
  }

  /** Flush and stop the debounce timer. */
  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }
}

/** Validate a persisted session (v3 positional offsets are intentionally dropped). */
function normalizeSession(session: unknown): ScanSession | undefined {
  if (typeof session !== 'object' || session === null) return undefined;
  const record = session as { since?: unknown; end?: unknown; pageToken?: unknown };
  const since = Number(record.since);
  const end = Number(record.end);
  if (!Number.isFinite(since) || !Number.isFinite(end) || end <= since) return undefined;
  return {
    since,
    end,
    ...(typeof record.pageToken === 'string' ? { pageToken: record.pageToken } : {}),
  };
}

/** Options for {@link Catchup}. */
export interface CatchupOptions {
  readonly transport: CatchupTransport;
  readonly store: CatchupStore;
  /** Hands a normalized message to the bridge. */
  readonly deliver: (message: ReplayedMessage) => Promise<void> | void;
  readonly logger?: CatchupLogger;
  /** Maximum look-back. Default {@link DEFAULT_WINDOW_MS}. */
  readonly windowMs?: number;
  /** Maximum delivered per run. Default {@link DEFAULT_MAX_MESSAGES}. */
  readonly maxMessages?: number;
  /** Maximum pages scanned per chat/run. Default {@link DEFAULT_MAX_PAGES}. */
  readonly maxPages?: number;
  /** Backlog retry delay. Default {@link FOLLOW_UP_DELAY_MS}. */
  readonly followUpDelayMs?: number;
  /** Coalesced rerun delay. Default {@link RERUN_DELAY_MS}. */
  readonly rerunDelayMs?: number;
  /** Injectable clock (tests). */
  readonly now?: () => number;
  /**
   * Resolve a chat's type. **Must throw** when it cannot be determined — the
   * runner then skips the chat instead of guessing `p2p` and bypassing the
   * group mention gate.
   */
  readonly resolveChatType?: (chatId: string) => Promise<'p2p' | 'group'>;
}

/** Runs the reconnect catch-up. */
export class Catchup {
  private readonly transport: CatchupTransport;
  private readonly store: CatchupStore;
  private readonly deliver: (message: ReplayedMessage) => Promise<void> | void;
  private readonly logger: CatchupLogger | undefined;
  private readonly windowMs: number;
  private readonly maxMessages: number;
  private readonly maxPages: number;
  private readonly followUpDelayMs: number;
  private readonly rerunDelayMs: number;
  private readonly now: () => number;
  private readonly resolveChatType: ((chatId: string) => Promise<'p2p' | 'group'>) | undefined;
  private readonly chatTypeCache = new Map<string, 'p2p' | 'group'>();
  private running = false;
  private disposed = false;
  /** chatId → coverage target (the `now` of the request that queued it). */
  private readonly pending = new Map<string, number>();
  /** A run was requested while a pass was running. */
  private rerun = false;
  private followUpTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: CatchupOptions) {
    this.transport = options.transport;
    this.store = options.store;
    this.deliver = options.deliver;
    this.logger = options.logger;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.followUpDelayMs = options.followUpDelayMs ?? FOLLOW_UP_DELAY_MS;
    this.rerunDelayMs = options.rerunDelayMs ?? RERUN_DELAY_MS;
    this.now = options.now ?? (() => Date.now());
    this.resolveChatType = options.resolveChatType;
  }

  /**
   * Replay anything missed. Each call records a coverage target per chat; a
   * chat stays queued until its boundary reaches that target.
   * @param chatIds - chats to scan.
   * @returns messages delivered by *this* call.
   */
  async run(chatIds: Iterable<string>): Promise<number> {
    if (this.disposed) return 0;
    const target = this.now();
    for (const chatId of chatIds) {
      this.pending.set(chatId, Math.max(this.pending.get(chatId) ?? 0, target));
    }
    if (this.running) {
      this.rerun = true;
      return 0;
    }
    this.running = true;
    let delivered = 0;
    try {
      const targets = new Map(this.pending);
      this.pending.clear();
      for (const [chatId, want] of targets) {
        if (this.disposed) break;
        try {
          const result = await this.runChat(chatId, this.maxMessages - delivered);
          delivered += result.delivered;
        } catch (error: unknown) {
          // Per-chat isolation: one broken chat must not stop the rest.
          this.logger?.warn(`catch-up for ${chatId} failed: ${String(error)}`);
          this.pending.set(chatId, want);
          continue;
        }
        // Re-queue unless this pass fully covered the request: a live session,
        // a page/budget stop, or a target still ahead of the boundary all mean
        // more work.
        const through = this.store.scannedThrough(chatId) ?? 0;
        if (this.store.session(chatId) !== undefined || through < want) {
          this.pending.set(chatId, want);
        }
      }
    } finally {
      this.running = false;
    }
    if (delivered > 0) this.logger?.info(`catch-up delivered ${delivered} missed message(s)`);
    if (this.rerun) {
      this.rerun = false;
      this.scheduleFollowUp(this.rerunDelayMs);
    } else if (this.pending.size > 0) {
      this.scheduleFollowUp(this.followUpDelayMs);
    }
    return delivered;
  }

  /**
   * Scan one chat forward, resuming an in-progress session when present.
   * @param chatId - the chat.
   * @param budget - remaining delivery budget.
   * @returns delivered count and whether more work remains.
   */
  private async runChat(
    chatId: string,
    budget: number,
  ): Promise<{ delivered: number; backlog: boolean }> {
    const now = this.now();
    const chatType = await this.chatTypeOf(chatId);
    const entry = this.store.get(chatId);
    if (entry === undefined) {
      // First sight of this chat: start counting from now, never replay the
      // pre-install history. No session, no fetch.
      this.store.apply(chatId, { scannedThrough: now, seen: new Map() });
      this.store.scheduleFlush();
      return { delivered: 0, backlog: false };
    }
    let session = entry.session;
    if (session === undefined) {
      const since = Math.max(entry.scannedThrough, now - this.windowMs);
      if (now - entry.scannedThrough > this.windowMs) {
        this.logger?.warn(
          `catch-up gap for ${chatId} is ${Math.round((now - entry.scannedThrough) / 60_000)}m, ` +
            `clamped to the ${Math.round(this.windowMs / 60_000)}m window`,
        );
      }
      session = { since, end: now };
      this.store.saveSession(chatId, session);
    }
    let delivered = 0;
    let pages = 0;
    let skipped = 0;
    const range = { since: session.since, end: session.end };
    while (pages < this.maxPages) {
      if (this.disposed) return { delivered, backlog: true };
      const remaining = budget - delivered;
      if (remaining <= 0) {
        this.store.saveSession(chatId, session);
        this.logSkips(skipped, chatId);
        return { delivered, backlog: true };
      }
      const pageSize = Math.min(MAX_PAGE_SIZE, remaining);
      const page = await this.transport.listMessages(chatId, {
        startTimeSec: Math.floor(session.since / 1000),
        endTimeSec: Math.ceil(session.end / 1000),
        pageSize,
        ...(session.pageToken === undefined ? {} : { pageToken: session.pageToken }),
      });
      pages += 1;
      const items = page.items;
      let pageHadUndelivered = false;
      for (const item of items) {
        if (this.disposed) return { delivered, backlog: true };
        const createdAt = Number(item.create_time);
        const messageId = item.message_id;
        if (!Number.isFinite(createdAt) || typeof messageId !== 'string') continue;
        if (createdAt < session.since || createdAt > session.end) continue;
        if (this.store.hasSeen(chatId, messageId)) continue;
        const message = normalizeApiMessage(item, chatId, chatType);
        if (message === undefined && item.sender?.sender_type === 'user') skipped += 1;
        if (message !== undefined) {
          if (delivered >= budget) {
            // The page will be re-fetched and already-delivered ids skipped, so
            // the same token is kept (no positional offset that a reordered
            // page could invalidate).
            pageHadUndelivered = true;
            break;
          }
          this.logger?.info(
            `replaying missed message ${messageId} (sent ${new Date(createdAt).toISOString()})`,
          );
          await this.deliver(message);
          delivered += 1;
        }
        this.store.recordSeen(chatId, messageId, createdAt);
      }
      if (pageHadUndelivered) {
        this.store.saveSession(chatId, session);
        this.logSkips(skipped, chatId);
        return { delivered, backlog: true };
      }
      if (page.hasMore === false) {
        // Explicitly terminal: only now does the boundary advance.
        this.store.completeSession(chatId, session.end);
        this.logSkips(skipped, chatId);
        return { delivered, backlog: false };
      }
      if (page.pageToken !== undefined && page.pageToken !== '') {
        session = { ...range, pageToken: page.pageToken };
        this.store.saveSession(chatId, session);
        continue;
      }
      // Anything short of an explicit `has_more: false` keeps the session: a
      // short page is NOT proof of a terminal page, and `has_more: true`
      // without a token is a protocol error.
      this.logger?.warn(
        `catch-up: history page lacks a terminal signal ` +
          `(chat ${chatId}, hasMore=${String(page.hasMore)}, items=${items.length}, pageSize=${pageSize}); ` +
          `keeping the scan session`,
      );
      this.store.saveSession(chatId, session);
      this.logSkips(skipped, chatId);
      return { delivered, backlog: true };
    }
    // Page cap reached with more work pending: keep the session.
    this.store.saveSession(chatId, session);
    this.logSkips(skipped, chatId);
    return { delivered, backlog: true };
  }

  private logSkips(skipped: number, chatId: string): void {
    if (skipped > 0) {
      this.logger?.info(
        `catch-up skipped ${skipped} non-text user message(s) in ${chatId} ` +
          `(images/files/rich post are not replayed)`,
      );
    }
  }

  /**
   * Resolve (and cache) a chat's type. Only a successful answer is cached —
   * caching a failure as `p2p` would bypass the group mention gate.
   */
  private async chatTypeOf(chatId: string): Promise<'p2p' | 'group'> {
    const cached = this.chatTypeCache.get(chatId);
    if (cached !== undefined) return cached;
    if (this.resolveChatType === undefined) return 'p2p';
    const type = await this.resolveChatType(chatId);
    this.chatTypeCache.set(chatId, type);
    return type;
  }

  private scheduleFollowUp(delay: number): void {
    if (this.disposed || this.followUpTimer !== undefined) return;
    this.followUpTimer = setTimeout(() => {
      this.followUpTimer = undefined;
      const chats = [...this.pending.keys()];
      void this.run(chats);
    }, delay);
    this.followUpTimer.unref?.();
  }

  /** Stop timers. Does not abort an in-flight HTTP request. */
  dispose(): void {
    this.disposed = true;
    if (this.followUpTimer !== undefined) {
      clearTimeout(this.followUpTimer);
      this.followUpTimer = undefined;
    }
  }
}
