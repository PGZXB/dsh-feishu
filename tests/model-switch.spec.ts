/**
 * Unit tests for the per-session model switch helper.
 *
 * dsh 0.2.2-rc.5 replaced the `installModelSelection(agentCtx, ref)` coupling
 * with a durable `agent.model` accessor: `model.current()` reads the recorded
 * `model/selection` (a recorded switch, then the last request header, then the
 * agent's static options), and `model.select()` records a new choice for the
 * next turn. These tests cover reading, applying, and the undefined edges.
 *
 * @module tests/model-switch
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySessionModelSwitch, sessionSelection } from '../src/model-switch.js';

const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  select: vi.fn(),
  debug: vi.fn(),
}));

/** A minimal agent stand-in exposing the `model` accessor the helper reads. */
function fakeAgent(recorded?: { provider: string; model: string }) {
  mocks.current.mockReturnValue(recorded);
  return { model: { current: mocks.current, select: mocks.select } };
}

beforeEach(() => {
  mocks.current.mockReset();
  mocks.select.mockReset();
  mocks.debug.mockReset();
});

describe('sessionSelection', () => {
  it('returns the provider/model the live agent records as current', () => {
    const agent = fakeAgent({ provider: 'deepseek-official', model: 'deepseek-v4-pro' });
    expect(sessionSelection(agent as never)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    });
  });

  it('returns undefined when the agent has no recorded selection', () => {
    expect(sessionSelection(fakeAgent() as never)).toBeUndefined();
  });

  it('returns undefined when the agent is undefined', () => {
    expect(sessionSelection(undefined)).toBeUndefined();
    expect(mocks.current).not.toHaveBeenCalled();
  });
});

describe('applySessionModelSwitch', () => {
  it('records the new selection through the agent model select', () => {
    const agent = fakeAgent();
    applySessionModelSwitch(
      agent as never,
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { debug: mocks.debug },
    );
    expect(mocks.select).toHaveBeenCalledWith({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    });
    expect(mocks.debug).toHaveBeenCalled();
  });

  it('no-ops when the agent is undefined (does not call select)', () => {
    applySessionModelSwitch(undefined, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    });
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
