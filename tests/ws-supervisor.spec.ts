/**
 * Unit tests for the long-connection watchdog.
 *
 * The transport is a stub: these tests cover the supervisor's own policy
 * (generation change detection, rebuild budget, heartbeat) without a socket.
 */

import { describe, expect, it, vi } from 'vitest';
import { formatDuration, WsSupervisor } from '../src/ws-supervisor.js';

function stubTransport(initial: {
  state?: 'ready' | 'reconnecting' | 'error';
  generation?: number;
  readyAt?: number | null;
}) {
  const health = {
    state: initial.state ?? 'ready',
    readyAt: initial.readyAt ?? 0,
    generation: initial.generation ?? 1,
    lastError: null as string | null,
    pingTimeoutSec: 30,
  };
  let restarts = 0;
  return {
    health: () => ({ ...health }),
    restartLongConnection: async () => {
      restarts += 1;
    },
    set(next: Partial<typeof health>) {
      Object.assign(health, next);
    },
    get restarts() {
      return restarts;
    },
  };
}

describe('formatDuration', () => {
  it('renders compact durations', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(95_000)).toBe('1m35s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(3_900_000)).toBe('1h05m');
  });
});

describe('WsSupervisor', () => {
  it('fires onReady when a reconnect happens between two samples', async () => {
    const transport = stubTransport({ generation: 1 });
    const supervisor = new WsSupervisor({
      transport,
      staleMs: 1000,
      checkMs: 1000,
      cooldownMs: 1000,
    });
    const onReady = vi.fn();
    // The constructor takes onReady as an option; recreate with the spy.
    const sup = new WsSupervisor({
      transport,
      staleMs: 1000,
      checkMs: 1000,
      cooldownMs: 1000,
      onReady,
      now: () => Date.now(),
    });
    try {
      sup.start();
      await sup.tick();
      expect(onReady).not.toHaveBeenCalled();

      transport.set({ generation: 2 });
      await sup.tick();
      expect(onReady).toHaveBeenCalledTimes(1);

      await sup.tick();
      expect(onReady).toHaveBeenCalledTimes(1);
    } finally {
      sup.stop();
      supervisor.stop();
    }
  });

  it('rebuilds after the stale budget and respects the cooldown', async () => {
    const transport = stubTransport({ state: 'reconnecting', generation: 1 });
    let now = 0;
    const sup = new WsSupervisor({
      transport,
      staleMs: 1000,
      checkMs: 1000,
      cooldownMs: 10_000,
      now: () => now,
    });
    try {
      now = 0;
      await sup.tick();
      expect(transport.restarts).toBe(0);

      now = 2000;
      await sup.tick();
      expect(transport.restarts).toBe(1);
      expect(sup.rebuilds).toBe(1);

      now = 3000;
      await sup.tick();
      expect(transport.restarts).toBe(1);
    } finally {
      sup.stop();
    }
  });

  it('does not fire on a steady ready connection', async () => {
    const transport = stubTransport({ generation: 3 });
    const onReady = vi.fn();
    const sup = new WsSupervisor({ transport, onReady, now: () => 0 });
    try {
      sup.start();
      await sup.tick();
      await sup.tick();
      expect(onReady).not.toHaveBeenCalled();
    } finally {
      sup.stop();
    }
  });
});
