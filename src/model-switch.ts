/**
 * Per-session model switching for `/model`.
 *
 * dsh 0.2.2 moved model state onto the agent and made it durable: the agent
 * owns an `AgentModel` whose `select()` appends a `modelSelection` projection
 * row, and the session business API exposes the whole switch as
 * `ctx.sessionController.selectModel({ sessionId, provider, model })` — it
 * validates the model against the live catalog, records the selection for the
 * next step, and saves the deployment default.
 *
 * 0.2.2 also took the old coupling away: `installModelSelection(agentCtx, ref)`
 * became `installModelSelection(agentCtx)`, which only installs the scoped
 * switch-notice listener (the host's own agent setup calls it). The surface
 * therefore no longer keeps a mutable ref — it asks the service to write and
 * reads the agent's own selection to display, which also ends this module's
 * runtime import from `@deepseek-ai/dsh-agent`.
 *
 * @module src/model-switch
 */

/** A selected provider/model (structural subset of dsh's `ModelSelection`). */
export interface ModelSelectionRef {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/**
 * The agent's model surface (`Agent.model`), structurally.
 *
 * `current()` resolves the choice for the next step: a recorded selection
 * wins, then the last request, then the agent's live options — so it reports
 * the model a `/model` switch actually applied rather than the pre-switch
 * static options (the `#40 display bug`).
 */
export interface AgentModelLike {
  current(): Readonly<ModelSelectionRef> | undefined;
}

/** An agent reduced to what this module reads (no harness type dependency). */
export interface AgentWithModel {
  readonly model?: AgentModelLike;
}

/** Host seam that applies a model selection to one session. */
export type SessionModelSelector = (
  sessionId: string,
  selection: { provider: string; model: string },
) => Promise<void>;

/**
 * Read the live agent's current model selection without touching any state.
 *
 * A read path (the panel's "current model", `/model` with no argument, the
 * picker's preselection) must never install listeners or mutate the agent, so
 * this only asks the agent's own model — and answers `undefined` when nothing
 * names both provider and model.
 *
 * @param agent - the live agent (or `undefined` when the chat has none).
 * @returns the current selection, if any.
 */
export function sessionSelection(agent: AgentWithModel | undefined): ModelSelectionRef | undefined {
  if (agent === undefined) return undefined;
  const model = agent.model;
  if (model === undefined || typeof model.current !== 'function') return undefined;
  try {
    return model.current();
  } catch {
    return undefined;
  }
}

/**
 * Switch one live session's model through the session business API, which
 * validates the model, records the selection for the next step and saves the
 * deployment default.
 *
 * The seam is optional: a profile without the controller keeps the saved
 * default for future sessions and leaves this session's model alone, which is
 * reported loudly rather than silently pretended.
 *
 * @param select - the host seam, `undefined` when no controller is mounted.
 * @param sessionId - the session to switch (`undefined` for none yet).
 * @param selection - the `provider/model` to apply.
 * @param logger - logger for the degrade path and the switch trace.
 * @returns whether the session selection was applied.
 */
export async function applySessionModelSwitch(
  select: SessionModelSelector | undefined,
  sessionId: string | undefined,
  selection: { provider: string; model: string },
  logger?: { warn: (message: string) => void; debug: (message: string) => void },
): Promise<boolean> {
  if (sessionId === undefined || select === undefined) {
    logger?.warn(
      `model switch skipped for ${sessionId ?? '(no session)'}: the sessionController service is unavailable, so only the default was saved`,
    );
    return false;
  }
  try {
    await select(sessionId, selection);
    logger?.debug(
      `[feishu] model switch session ${sessionId} to ${selection.provider}/${selection.model}`,
    );
    return true;
  } catch (error: unknown) {
    logger?.warn(`model switch failed for ${sessionId}: ${String(error)}`);
    return false;
  }
}
