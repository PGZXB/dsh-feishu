# Feature Spec Template

Fill this out in `docs/ux-specification.md` as a new `## Part: <name>` section
BEFORE writing any code. The spec is the contract between intent and
implementation; it also doubles as the acceptance checklist.

## Part: <feature name>

> One-line summary of the feature.

### Intended behavior

**Trigger** — what starts this feature (a message, a command, a card action, a
session event, a schedule)?

**States & transitions** — the ONE authoritative state object and every
transition, including every edge:

| From | Event | To | Side effects |
|---|---|---|---|
| ... | ... | ... | ... |

**Card/panel shape** — the surface: which card, which panel view, which
buttons/rows, what renders from the state.

**Failure modes** — every way it can fail and what each does:
- host service absent (feature-detect, degrade loudly)
- callback deadline / invalid ACK
- stale card / late callback
- mid-turn arrival (working-state gate)
- permission denied / unknown chat
- truncation / platform limits

**Acceptance checklist** — how the reviewer confirms it works, mirroring the
SKILL's checklist.

### Reference

Studied source (botmux / DSH web / installed dsh types) and what behavior was
taken from it. Their comments encode real failure modes — cite them.
