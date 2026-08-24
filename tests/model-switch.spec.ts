/**
 * Unit tests for the per-session model switch helper.
 *
 * The helper couples a single mutable `ModelSelection` to a live agent's
 * scoped context (`installModelSelection`) so `/model` can switch the CURRENT
 * session's model immediately, and caches the ref per context so the waterfall
 * listeners are installed once. These tests cover the caching, the apply, and
 * the no-op edge.
 *
 * @module tests/model-switch
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySessionModelSwitch,
  sessionSelection,
  sessionSelectionFor,
} from '../src/model-switch.js';

const mocks = vi.hoisted(() => ({ installModelSelection: vi.fn(() => () => {}) }));

vi.mock('@deepseek-ai/dsh-agent', () => ({
  installModelSelection: mocks.installModelSelection,
}));

/** A minimal, unrelated object to stand in for an agent's scoped Context. */
function fakeCtx(): object {
  return {};
}

beforeEach(() => {
  mocks.installModelSelection.mockClear();
});

describe('sessionSelectionFor', () => {
  it('installs the selection ref ONCE and returns the cached ref for a context', () => {
    const ctx = fakeCtx();
    const first = sessionSelectionFor(ctx as never);
    const second = sessionSelectionFor(ctx as never);
    expect(mocks.installModelSelection).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('installs a SEPARATE ref per distinct context', () => {
    const a = fakeCtx();
    const b = fakeCtx();
    const ra = sessionSelectionFor(a as never);
    const rb = sessionSelectionFor(b as never);
    expect(mocks.installModelSelection).toHaveBeenCalledTimes(2);
    expect(ra).not.toBe(rb);
  });
});

describe('applySessionModelSwitch', () => {
  it("sets the context's current selection to the new model", () => {
    const ctx = fakeCtx();
    const ref = sessionSelectionFor(ctx as never);
    applySessionModelSwitch(ctx as never, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    });
    expect(ref.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' });
  });

  it('no-ops when the agent context is undefined (does not install)', () => {
    applySessionModelSwitch(undefined, { provider: 'deepseek-official', model: 'deepseek-v4-pro' });
    expect(mocks.installModelSelection).toHaveBeenCalledTimes(0);
  });
});

describe('sessionSelection', () => {
  it('returns undefined for a context with no session switch (never installs)', () => {
    const ctx = fakeCtx();
    expect(sessionSelection(ctx as never)).toBeUndefined();
    expect(mocks.installModelSelection).not.toHaveBeenCalled();
  });

  it('returns undefined when the agent context is undefined', () => {
    expect(sessionSelection(undefined)).toBeUndefined();
    expect(mocks.installModelSelection).not.toHaveBeenCalled();
  });

  it('returns the coupled ref (its current is the switched model) without re-installing', () => {
    const ctx = fakeCtx();
    applySessionModelSwitch(ctx as never, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    });
    const ref = sessionSelection(ctx as never);
    expect(mocks.installModelSelection).toHaveBeenCalledTimes(1);
    expect(ref?.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' });
    expect(ref).toBe(sessionSelectionFor(ctx as never));
  });
});
