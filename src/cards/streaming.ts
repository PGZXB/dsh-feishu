/**
 * Streaming card pipeline: one card per turn, patched live.
 *
 * The mechanism (verified against botmux): POST one interactive card when a
 * turn starts, then repeatedly `im.v1.message.patch` the same message as
 * output arrives. Patching is silent — no unread notification — which is
 * exactly right for intermediate progress; the final answer is delivered as
 * a fresh message by the bridge (botmux rule).
 *
 * Updates are throttled and coalesced: at most one patch in flight per card,
 * and the newest snapshot always wins, so a burst of chunks costs one patch.
 *
 * @module @dsh-feishu/dsh-feishu/cards/streaming
 */

import type { CardJson, FeishuTransport } from '../feishu/types.js';
import { buildCard, type CardSnapshot } from './render.js';

/** Options for the streaming card manager. */
export interface StreamingCardOptions {
  /** Minimum gap between patches per card (default 150 ms). */
  readonly throttleMs?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

/** One chat's active card state (bridge owns the turn content). */
interface ActiveCard {
  readonly chatId: string;
  messageId: string;
  pending: CardSnapshot | null;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  closed: boolean;
}

/**
 * Manages one active streaming card per chat.
 */
export class StreamingCardManager {
  private readonly active = new Map<string, ActiveCard>();
  /** The most recently opened card's message id per chat, kept after the
   *  card retires so the bridge can still re-render it (e.g. the rows
   *  collapse toggle on a finished card). */
  private readonly lastMessageIds = new Map<string, string>();
  private readonly throttleMs: number;

  /**
   * @param transport - the Feishu transport used to send and patch cards.
   * @param options - throttle tuning.
   */
  constructor(
    private readonly transport: FeishuTransport,
    options: StreamingCardOptions = {},
  ) {
    this.throttleMs = options.throttleMs ?? 150;
  }

  /**
   * The message id of the most recently opened card for a chat, or
   * `undefined` when none was opened yet (or it was superseded/cleared).
   */
  lastMessageId(chatId: string): string | undefined {
    return this.lastMessageIds.get(chatId);
  }

  /**
   * Open a new streaming card for one chat, replacing any stale active card
   * (flushed as done first). Resolves once the card is posted.
   * @param chatId - the chat to post the card in.
   * @param title - the card header title for this turn.
   */
  async open(chatId: string, title: string): Promise<void> {
    const stale = this.active.get(chatId);
    if (stale !== undefined) {
      await this.finalize(chatId, 'done');
    }
    const card = buildCard({ title, content: '', rows: [], status: 'working' });
    const { messageId } = await this.transport.sendCard(chatId, card);
    this.lastMessageIds.set(chatId, messageId);
    this.active.set(chatId, {
      chatId,
      messageId,
      pending: null,
      timer: null,
      flushing: false,
      closed: false,
    });
  }

  /**
   * Stage the next snapshot for a chat. Patches are throttled and coalesced:
   * the latest snapshot wins and is flushed after `throttleMs`, or
   * immediately after the in-flight patch settles.
   * @param chatId - the chat whose card to update.
   * @param snapshot - the new card content.
   */
  patch(chatId: string, snapshot: CardSnapshot): void {
    const card = this.active.get(chatId);
    if (card === undefined || card.closed) return;
    card.pending = snapshot;
    if (card.timer === null && !card.flushing) {
      card.timer = setTimeout(() => {
        card.timer = null;
        void this.flush(card);
      }, this.throttleMs);
    }
  }

  /**
   * Mark the card terminal: flush any pending snapshot with the final
   * status, then retire the active entry (no further patches).
   * @param chatId - the chat whose card to finalize.
   * @param status - terminal status (`done` or `error`).
   */
  async finalize(chatId: string, status: 'done' | 'error'): Promise<void> {
    const card = this.active.get(chatId);
    if (card === undefined || card.closed) return;
    card.closed = true;
    if (card.timer !== null) {
      clearTimeout(card.timer);
      card.timer = null;
    }
    if (card.pending !== null) {
      card.pending = { ...card.pending, status };
      await this.flush(card);
    }
    this.active.delete(chatId);
  }

  /** Discard the active card without further patching. */
  close(chatId: string): void {
    const card = this.active.get(chatId);
    if (card === undefined) return;
    card.closed = true;
    if (card.timer !== null) clearTimeout(card.timer);
    this.active.delete(chatId);
  }

  /** Whether a chat currently has an active streaming card. */
  isActive(chatId: string): boolean {
    return this.active.has(chatId);
  }

  /** Flush pending patches until quiescent, coalescing in-flight updates. */
  private async flush(card: ActiveCard): Promise<void> {
    if (card.flushing) return;
    card.flushing = true;
    try {
      while (card.pending !== null) {
        const snapshot = card.pending;
        card.pending = null;
        await this.transport.updateCard(card.messageId, buildCard(snapshot) as CardJson);
      }
    } finally {
      card.flushing = false;
    }
  }
}
