/**
 * Unit tests for the per-session model switch helper.
 *
 * dsh 0.2.2 keeps the model selection on the agent and applies a switch
 * through the session business API, so the surface no longer couples a mutable
 * ref: `sessionSelection` only reads the agent's own `model.current()`, and
 * `applySessionModelSwitch` delegates to the injected
 * `ctx.sessionController.selectModel` seam. These tests cover the read path,
 * the delegate, and both degrade edges (no seam, failing seam).
 *
 * @module tests/model-switch
 */

import { describe, expect, it, vi } from 'vitest';
import { applySessionModelSwitch, sessionSelection } from '../src/model-switch.js';

/** An agent whose model answers with a fixed selection. */
function agentWith(selection: { provider: string; model: string } | undefined): {
  model: { current: () => typeof selection };
} {
  return { model: { current: () => selection } };
}

describe('sessionSelection', () => {
  it('reads the selection the agent reports (a switched model wins there)', () => {
    expect(sessionSelection(agentWith({ provider: 'pi-ai', model: 'deepseek-r1' }))).toEqual({
      provider: 'pi-ai',
      model: 'deepseek-r1',
    });
  });

  it('returns undefined when the agent has no selection yet', () => {
    expect(sessionSelection(agentWith(undefined))).toBeUndefined();
  });

  it('returns undefined for no agent, or an agent without a model surface', () => {
    expect(sessionSelection(undefined)).toBeUndefined();
    expect(sessionSelection({})).toBeUndefined();
    // A pre-0.2.2 agent object has a `model` that is not the AgentModel shape.
    expect(sessionSelection({ model: {} as never })).toBeUndefined();
  });

  it('answers undefined instead of throwing when the model read throws', () => {
    const agent = {
      model: {
        current: () => {
          throw new Error('model projection unavailable');
        },
      },
    };
    expect(sessionSelection(agent)).toBeUndefined();
  });
});

describe('applySessionModelSwitch', () => {
  it('applies the selection through the seam with the real session id', async () => {
    const select = vi.fn(async () => {});
    const applied = await applySessionModelSwitch(select, 'feishu-session-1', {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    });
    expect(applied).toBe(true);
    expect(select).toHaveBeenCalledWith('feishu-session-1', {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    });
  });

  it('degrades loudly when no sessionController seam is mounted', async () => {
    const warn = vi.fn();
    const applied = await applySessionModelSwitch(
      undefined,
      'feishu-session-1',
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { warn, debug: () => {} },
    );
    expect(applied).toBe(false);
    expect(warn.mock.calls[0]?.[0]).toContain('sessionController service is unavailable');
  });

  it('degrades loudly when the chat has no session yet', async () => {
    const warn = vi.fn();
    const applied = await applySessionModelSwitch(
      vi.fn(async () => {}),
      undefined,
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { warn, debug: () => {} },
    );
    expect(applied).toBe(false);
    expect(warn.mock.calls[0]?.[0]).toContain('(no session)');
  });

  it('reports a refusing seam instead of pretending the switch happened', async () => {
    const warn = vi.fn();
    const applied = await applySessionModelSwitch(
      async () => {
        throw new Error('session/model-unavailable');
      },
      'feishu-session-1',
      { provider: 'pi-ai', model: 'deepseek-r1' },
      { warn, debug: () => {} },
    );
    expect(applied).toBe(false);
    expect(warn.mock.calls[0]?.[0]).toContain('session/model-unavailable');
  });

  it('traces the applied switch for the debug pipeline', async () => {
    const debug = vi.fn();
    await applySessionModelSwitch(
      vi.fn(async () => {}),
      'feishu-session-1',
      { provider: 'pi-ai', model: 'deepseek-r1' },
      { warn: () => {}, debug },
    );
    expect(debug).toHaveBeenCalledWith(
      '[feishu] model switch session feishu-session-1 to pi-ai/deepseek-r1',
    );
  });
});
