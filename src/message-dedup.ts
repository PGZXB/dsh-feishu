/**
 * In-memory deduplication of inbound Feishu message ids.
 *
 * Feishu may redeliver an event (6-hour replay window, daemon restarts), so
 * the surface must ignore a message id it has already processed. Durable
 * dedup (surviving process restarts) is deferred; this bounded in-memory
 * ring covers the live process lifetime.
 *
 * @module @dsh-feishu/dsh-feishu/message-dedup
 */

/** Bounded dedup set with FIFO eviction. */
export class MessageDeduplicator {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  /**
   * @param capacity - maximum remembered ids; oldest ids evict beyond it.
   */
  constructor(private readonly capacity = 4096) {}

  /**
   * Claim an id: `true` the first time, `false` on every repeat.
   * @param messageId - the Feishu message id to claim.
   * @returns whether the id was not seen before (i.e. should be processed).
   */
  claim(messageId: string): boolean {
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    this.order.push(messageId);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }

  /** Number of distinct ids currently remembered. */
  get size(): number {
    return this.seen.size;
  }
}
