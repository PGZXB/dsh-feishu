/**
 * Per-session model switching for `/model`.
 *
 * dsh-web's `/model` switches the CURRENT session's model immediately (and
 * saves the default). The host implements the per-session switch by coupling a
 * mutable {@link ModelSelectionRef} to the live agent's scoped context via
 * `installModelSelection` (see `dsh-host-apiproxy`'s `selectionFor`). This
 * module replicates that: an agent gets ONE coupled selection ref (installed
 * once, cached in a `WeakMap`), and `/model` mutates its `current` so the next
 * prompt assembly uses the new provider/model.
 *
 * NOTE: this is a runtime import from `@deepseek-ai/dsh-agent` — a deliberate
 * exception to the repo's "type-only `@deepseek-ai/*` imports" convention, made
 * because genuine per-session model switching requires it (maintainer decision,
 * see docs/ux-specification.md → `/model` immediate switch).
 *
 * @module src/model-switch
 */

import type { Context } from '@deepseek-ai/cordis';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

/** A selected provider/model (structural subset of dsh's `ModelSelection`). */
export interface ModelSelectionRef {
  current: { provider: string; model: string } | undefined;
  assembled: { provider: string; model: string } | undefined;
}

const refs = new WeakMap<object, ModelSelectionRef>();

/**
 * Couple a mutable model-selection to `agentCtx` ONCE and return it. Repeated
 * calls for the same context return the cached ref without re-installing so
 * the waterfall listeners are not stacked.
 * @param agentCtx - the live agent's scoped context.
 * @returns the agent's mutable selection ref.
 */
export function sessionSelectionFor(agentCtx: Context): ModelSelectionRef {
  let ref = refs.get(agentCtx);
  if (ref === undefined) {
    ref = { current: undefined, assembled: undefined };
    refs.set(agentCtx, ref);
    installModelSelection(agentCtx, ref);
  }
  return ref;
}

/**
 * Switch the model for one live agent's session (`next` becomes the model the
 * next turn assembles). No-op when `agentCtx` is undefined (already handled by
 * the caller). Does not touch the deployment default — the caller saves that
 * separately.
 * @param agentCtx - the live agent's scoped context (or undefined for no-op).
 * @param selection - the `{ provider, model }` to apply to this session.
 * @param logger - optional bridge logger for debug tracing (`FEISHU_DEBUG=1`).
 */
export function applySessionModelSwitch(
  agentCtx: Context | undefined,
  selection: { provider: string; model: string },
  logger?: { debug: (msg: string) => void },
): void {
  if (agentCtx === undefined) return;
  sessionSelectionFor(agentCtx).current = selection;
  logger?.debug(`[feishu] model switch session to ${selection.provider}/${selection.model}`);
}
