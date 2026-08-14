/**
 * Unified pending-interaction registry: approval cards and question cards
 * share one mechanism — a request posts a card, the surface waits for the
 * card callback (or a timeout / abort), and resolves exactly once. Late or
 * stale callbacks (after resolution, after timeout, from a superseded card)
 * are ignored; every entry is cleaned up on settle.
 *
 * One authoritative registry, one resolve path — the same rule as the card
 * state machine: no per-case reasserts.
 *
 * @module @dsh-feishu/dsh-feishu/cards/interactions
 */

/** One pending card interaction, keyed by request id. */
interface PendingInteraction {
  /** The chat the card was posted to (a callback is only accepted from it). */
  readonly chatId: string;
  /** The posted card's message id (a callback must target it). */
  readonly messageId: string;
  /** Settle the interaction once with the given outcome. */
  readonly resolve: (outcome: string) => void;
  /** Timer that settles the interaction with `cancelled` on timeout. */
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Default time (ms) a pending interaction waits for a card callback. */
export const INTERACTION_TIMEOUT_MS = 5 * 60_000;

/**
 * The pending-interaction registry. `register` returns a `settle` handle;
 * `resolveOnce` claims the entry and clears its timer, so a late callback is
 * a no-op.
 */
export class InteractionRegistry {
  private readonly pending = new Map<string, PendingInteraction>();

  /**
   * Register a pending interaction.
   * @param id - the request id (approval request id / question id).
   * @param chatId - the chat the card was posted to.
   * @param messageId - the posted card's message id.
   * @param onSettle - called exactly once with the outcome on resolve/timeout.
   * @param timeoutMs - how long to wait before settling `cancelled`.
   */
  register(
    id: string,
    chatId: string,
    messageId: string,
    onSettle: (outcome: string) => void,
    timeoutMs = INTERACTION_TIMEOUT_MS,
  ): void {
    // A duplicate id supersedes the previous entry (its timer is cleared).
    const previous = this.pending.get(id);
    if (previous !== undefined) clearTimeout(previous.timer);
    let settled = false;
    const settle = (outcome: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.pending.delete(id);
      onSettle(outcome);
    };
    const timer = setTimeout(() => settle('cancelled'), timeoutMs);
    this.pending.set(id, { chatId, messageId, resolve: settle, timer });
  }

  /**
   * Settle a pending interaction from a card callback. A callback from the
   * wrong chat/card or for an unknown/already-settled id is ignored.
   * @param id - the request id.
   * @param chatId - the chat the callback came from.
   * @param messageId - the card the callback came from.
   * @param outcome - the outcome to settle with.
   * @returns whether the interaction was settled (false = stale/unknown).
   */
  resolveOnce(id: string, chatId: string, messageId: string, outcome: string): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    if (entry.chatId !== chatId || entry.messageId !== messageId) return false;
    entry.resolve(outcome);
    return true;
  }

  /** Abort a pending interaction (e.g. the agent's request was cancelled). */
  abort(id: string, outcome = 'cancelled'): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    entry.resolve(outcome);
    return true;
  }

  /**
   * Settle a pending interaction from a NON-card source (e.g. a free-text
   * question answered by the next chat message) — the message-id match is
   * skipped, but the chat scope is still enforced.
   * @param id - the request id.
   * @param chatId - the chat the answer came from.
   * @param outcome - the settlement value.
   * @returns whether the interaction was settled.
   */
  resolveDirect(id: string, chatId: string, outcome: string): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    if (entry.chatId !== chatId) return false;
    entry.resolve(outcome);
    return true;
  }

  /**
   * Re-target a pending interaction to a freshly re-posted card (e.g. a
   * multi-select question card re-posted with checkmarks) — the callback
   * must come from the newest card.
   */
  retarget(id: string, newMessageId: string): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    this.pending.set(id, { ...entry, messageId: newMessageId });
    return true;
  }

  /** Whether an interaction is still pending. */
  has(id: string): boolean {
    return this.pending.has(id);
  }

  /** Clear every pending interaction (bridge disposal). */
  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve('cancelled');
    }
    this.pending.clear();
  }
}
