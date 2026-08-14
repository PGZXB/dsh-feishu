/**
 * Unit tests for the pending-interaction registry: one authoritative resolve
 * path shared by approval and question cards.
 */

import { describe, expect, it, vi } from 'vitest';
import { InteractionRegistry } from '../../src/cards/interactions.js';

describe('InteractionRegistry', () => {
  it('settles once via a matching card callback', () => {
    const registry = new InteractionRegistry();
    const onSettle = vi.fn();
    registry.register('req-1', 'oc_chat', 'mem-1', onSettle, 60_000);
    expect(registry.resolveOnce('req-1', 'oc_chat', 'mem-1', 'allowed-once')).toBe(true);
    expect(onSettle).toHaveBeenCalledWith('allowed-once');
    // A late callback is a no-op.
    expect(registry.resolveOnce('req-1', 'oc_chat', 'mem-1', 'rejected')).toBe(false);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('ignores callbacks from the wrong chat or card', () => {
    const registry = new InteractionRegistry();
    const onSettle = vi.fn();
    registry.register('req-1', 'oc_chat', 'mem-1', onSettle, 60_000);
    expect(registry.resolveOnce('req-1', 'oc_other', 'mem-1', 'allowed-once')).toBe(false);
    expect(registry.resolveOnce('req-1', 'oc_chat', 'mem-2', 'allowed-once')).toBe(false);
    expect(registry.resolveOnce('unknown', 'oc_chat', 'mem-1', 'allowed-once')).toBe(false);
    expect(onSettle).not.toHaveBeenCalled();
  });

  it('settles cancelled on timeout', () => {
    vi.useFakeTimers();
    try {
      const registry = new InteractionRegistry();
      const onSettle = vi.fn();
      registry.register('req-1', 'oc_chat', 'mem-1', onSettle, 1_000);
      vi.advanceTimersByTime(1_001);
      expect(onSettle).toHaveBeenCalledWith('cancelled');
      expect(registry.has('req-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort settles with the given outcome and clears the timer', () => {
    vi.useFakeTimers();
    try {
      const registry = new InteractionRegistry();
      const onSettle = vi.fn();
      registry.register('req-1', 'oc_chat', 'mem-1', onSettle, 60_000);
      expect(registry.abort('req-1', 'cancelled')).toBe(true);
      expect(onSettle).toHaveBeenCalledWith('cancelled');
      vi.advanceTimersByTime(60_001);
      expect(onSettle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolveDirect settles from a non-card source with chat scope', () => {
    const registry = new InteractionRegistry();
    const onSettle = vi.fn();
    registry.register('q-1', 'oc_chat', 'mem-1', onSettle, 60_000);
    expect(registry.resolveDirect('q-1', 'oc_other', 'my answer')).toBe(false);
    expect(registry.resolveDirect('q-1', 'oc_chat', 'my answer')).toBe(true);
    expect(onSettle).toHaveBeenCalledWith('my answer');
  });

  it('retarget points the callback check at the newest card', () => {
    const registry = new InteractionRegistry();
    const onSettle = vi.fn();
    registry.register('q-1', 'oc_chat', 'mem-1', onSettle, 60_000);
    expect(registry.retarget('q-1', 'mem-2')).toBe(true);
    expect(registry.resolveOnce('q-1', 'oc_chat', 'mem-1', 'x')).toBe(false);
    expect(registry.resolveOnce('q-1', 'oc_chat', 'mem-2', 'x')).toBe(true);
    expect(onSettle).toHaveBeenCalledWith('x');
  });

  it('re-registering an id supersedes the previous entry', () => {
    const registry = new InteractionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.register('req-1', 'oc_chat', 'mem-1', first, 60_000);
    registry.register('req-1', 'oc_chat', 'mem-2', second, 60_000);
    expect(registry.resolveOnce('req-1', 'oc_chat', 'mem-1', 'x')).toBe(false);
    expect(registry.resolveOnce('req-1', 'oc_chat', 'mem-2', 'x')).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('x');
  });

  it('dispose settles everything as cancelled', () => {
    const registry = new InteractionRegistry();
    const onSettle = vi.fn();
    registry.register('req-1', 'oc_chat', 'mem-1', onSettle, 60_000);
    registry.register('req-2', 'oc_chat', 'mem-1', onSettle, 60_000);
    registry.dispose();
    expect(onSettle).toHaveBeenCalledTimes(2);
    expect(registry.has('req-1')).toBe(false);
  });
});
