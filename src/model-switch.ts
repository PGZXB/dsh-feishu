/**
 * Per-session model switching for `/model`.
 *
 * dsh 0.2.2-rc.5 made per-session model selection durable: an agent exposes
 * `agent.model` (the `Model` accessor from `@deepseek-ai/dsh-agent`, backed by
 * the `model/selection` session projection) whose `select()` records a new
 * choice and `current()` reads it back (recorded selection, then the last
 * request header, then the agent's live options). This module adapts `/model`
 * to that accessor: switching writes the durable selection, and reading
 * prefers a recorded switch over the agent's static options (dsh web parity).
 *
 * NOTE: `Agent` is a value type from `@deepseek-ai/dsh-agent` — a deliberate
 * exception to the repo's type-only `@deepseek-ai/*` imports convention, made
 * because genuine per-session model switching requires the live agent object
 * (maintainer decision, see docs/ux-specification.md → `/model` immediate
 * switch).
 *
 * @module src/model-switch
 */

import type { Agent } from '@deepseek-ai/dsh-agent';

/**
 * Read the live agent's current model selection WITHOUT switching. Prefers a
 * recorded `/model` switch over the last request header and the agent's live
 * options; returns `undefined` when no source names both provider and model
 * (or when the agent is absent).
 * @param agent - the live agent (or `undefined` for none).
 * @returns the current provider/model selection, or `undefined`.
 */
export function sessionSelection(
  agent: Agent | undefined,
): { provider: string; model: string } | undefined {
  const current = agent?.model.current();
  return current === undefined ? undefined : { provider: current.provider, model: current.model };
}

/**
 * Switch the model for one live agent's session (`selection` becomes the model
 * the next turn assembles). Records a `model/selection` event through the
 * agent's `model.select()`; an equal recorded choice is a no-op. Does not
 * touch the deployment default — the caller saves that separately.
 * @param agent - the live agent (or `undefined` for no-op).
 * @param selection - the `{ provider, model }` to apply to this session.
 * @param logger - optional bridge logger for debug tracing (`FEISHU_DEBUG=1`).
 */
export function applySessionModelSwitch(
  agent: Agent | undefined,
  selection: { provider: string; model: string },
  logger?: { debug: (msg: string) => void },
): void {
  if (agent === undefined) return;
  agent.model.select(selection);
  logger?.debug(`[feishu] model switch session to ${selection.provider}/${selection.model}`);
}
