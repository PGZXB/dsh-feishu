# Integration Scenario Matrix

Brainstorm this matrix BEFORE writing any integration test, and AGAIN after
the implementation (fresh eyes). Every row becomes at least one test. The
matrix is deliberately adversarial — happy path is one row, not the whole
story.

## Categories to sweep

- **Happy path** — the straightforward success flow.
- **Empty / missing input** — no args, blank text, no selection.
- **Wrong target** — wrong chat, wrong session, wrong card, expired id.
- **Stale state** — card callback after the card changed, late reaction, old
  message id (dedup), copy/retry after a fresh turn.
- **Mid-turn arrival** — a second message while a turn runs (working-state
  gate), a stop during streaming, retry while stopped.
- **Permission & policy** — denied escalation, reject, unknown user (allowlist),
  unknown chat (allowlist), custom permission state.
- **Host absent / degraded** — service seam missing (feature-detect, degrade
  loudly), projection absent (hide the row, don't fail), session unusable
  (remint), dsh CLI missing.
- **Concurrency & restart** — two chats concurrently, daemon restart mid-flow,
  session map rebind, resume while the target runs elsewhere.
- **Platform limits** — card size cap, table count cap, truncation markers,
  select-option limits, callback deadline.
- **Idempotency & recovery** — retry after failure, error turn → notice,
  question answered twice (settle once), late/duplicate callbacks ignored.

## Matrix form

| Scenario | Setup | Action | Expected | Layer (unit/integration) |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

## After-implementation re-brainstorm

With the real behavior visible, ask again: what did the first pass miss?
New scenarios go into the same matrix and become tests. Then run
`pnpm run check` + `pnpm run gates` (exit codes checked).
