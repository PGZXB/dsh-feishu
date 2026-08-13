/**
 * Unit tests for the inbound-message deduplicator.
 */

import { describe, expect, it } from 'vitest';
import { MessageDeduplicator } from '../src/message-dedup.js';

describe('MessageDeduplicator', () => {
  it('claims an unseen id once', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.claim('msg-1')).toBe(true);
    expect(dedup.claim('msg-1')).toBe(false);
    expect(dedup.claim('msg-1')).toBe(false);
  });

  it('accepts distinct ids', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.claim('msg-1')).toBe(true);
    expect(dedup.claim('msg-2')).toBe(true);
    expect(dedup.size).toBe(2);
  });

  it('evicts the oldest id beyond capacity, allowing it to be claimed again', () => {
    const dedup = new MessageDeduplicator(2);
    expect(dedup.claim('a')).toBe(true);
    expect(dedup.claim('b')).toBe(true);
    expect(dedup.claim('c')).toBe(true); // evicts 'a' (FIFO)
    expect(dedup.claim('a')).toBe(true); // evicted → claimable again (evicts 'b')
    expect(dedup.claim('c')).toBe(false); // still remembered
  });
});
