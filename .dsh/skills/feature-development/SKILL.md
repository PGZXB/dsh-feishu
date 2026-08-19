---
name: feature-development
description: End-to-end workflow for shipping a feature in this repository — spec first, state machine first, integration tests first (brainstormed to cover every scenario), unit tests with high coverage, docs in the same change, and the worktree+PR merge pattern. Use for any new feature, command, card, panel view, or behavior change.
when-to-use: A feature, command, card, panel view, or behavior change is being planned or implemented.
---

# Feature Development

The delivery order is fixed: **scaffold → spec → state machine → integration
tests (brainstormed) → implementation → unit tests (high coverage) →
re-brainstormed integration tests → docs → PR**. Each step gates the next;
nothing ships without its tests and its docs.

## Principles

- **Spec first.** No code before the intended behavior is written down. The
  spec is the contract between intent and implementation; it doubles as the
  ux-specification entry.
- **State machine first.** Every interactive surface is one authoritative
  state object and one render path (`syncCard`). Design the state transitions
  before the renderers; a state machine-shaped design is the antidote to
  per-case patches.
- **Tests before code.** The integration tests are written from a brainstormed
  scenario list BEFORE the implementation, then executed against the real
  composition. Unit tests follow the implementation and push coverage up.
- **Docs move with the feature.** The same change ships code, tests, docs, and
  the CHANGELOG entry. Never a later PR.
- **Everything goes through the existing patterns.** Commands register in the
  command registry, panel views in the view registry, card surfaces as state
  machines. No new paradigms.

## Skill resources

- [Spec template](references/spec-template.md) — the ux-specification part
  skeleton (states table, failure modes, acceptance).
- [Scenario matrix](references/scenario-matrix.md) — the brainstormed
  integration-test matrix categories and form.
- `scripts/new-feature.mjs` — scaffolds the worktree, branch, spec skeleton,
  scenario-matrix test file, and the features.md planned row.
- `scripts/check-acceptance.mjs` — mechanical acceptance check against the
  branch diff (run before the PR).

## Workflow

### 0. Scaffold

From a clean main worktree, scaffold the feature:

```sh
node .dsh/skills/feature-development/scripts/new-feature.mjs <kebab-name> "<short description>"
```

This creates the worktree `_dev/dsh-feishu-<name>` on `feat/<name>`, appends
the spec skeleton, the scenario-matrix test skeleton, and the 📋 features.md
row. All further work happens inside that worktree.

### 1. Spec

1. Study the reference implementation first — the botmux and DSH web checkouts
   the repository maintains (see AGENTS.md → "Iterating"), and the installed
   dsh types — then write the spec using [the template](references/spec-template.md).
2. Record the intended behavior in `docs/ux-specification.md` (a new part,
   referencing the studied source) and the relevant `docs/` page. The spec
   states: the trigger, the states and transitions, the card/panel shape, the
   failure modes, and the acceptance checklist.
3. Read the installed `.d.ts` of every host seam the feature touches (getters
   vs methods matter — wrong shapes typecheck fine and blow up at runtime).

### 2. State machine

1. Design ONE authoritative state object for the surface (see `ChatCardState`
   in `src/bridge.ts` for the model) and ONE render path.
2. Enumerate every transition and every edge: what each card action does to
   the state, what each session event does, and how the surface renders from
   the state alone.
3. Route async panel operations through `runPanelOperation` and async panel
   views through the loading-placeholder pattern — never a new async action
   that awaits before patching.

### 3. Integration tests first (brainstormed)

1. **Brainstorm the scenario matrix** using [the matrix template](references/scenario-matrix.md)
   — deliberately exhaustive, adversarial: happy path, each error path, each
   edge (empty input, wrong chat, stale card, mid-turn arrival, permission
   denied, host service absent, concurrent turns, restart during the
   action…). Write every scenario down before writing any test.
2. Write the integration tests from that matrix in `tests/integration/` (real
   dsh process, memory transport, mock LLM) — they will fail until the
   implementation exists. This is expected.
3. Keep the scenarios real: unique message ids, filter waits by `chatId`,
   assert card contents not completion counts, restore test-written settings.
4. **Read callback values FROM the rendered card, never construct them by
   hand.** A real click submits exactly what the renderer put in the card —
   the rename regression (a submit that "silently did nothing") existed
   because tests built the action directly with the session id and bypassed
   the render. Find the button in `readOutbox()`, read its `value`, and
   submit THAT. If the render is wrong, the test must fail.

### 4. Implement

1. Build against the spec, through the state machine, with the surface-native
   patterns the reference sources encode.
2. Wire through the command registry / view registry / card controller as the
   feature demands. Feature-detect optional services with `ctx.get(name)`;
   fail loud when a required referent is missing.
3. **Lazily resolve async-initialized host services.** A service that
   initializes asynchronously after `apply` (e.g. `workspaceRegistry`) returns
   `undefined` from `ctx.get` at startup FOREVER if snapshotted once — pass a
   getter (`getWorkspaceRegistry: () => ctx.get('workspaceRegistry')`) and
   resolve at use time, never at construction.
4. **Verify the seam mounts in the REAL composition, not just the fakes.** The
   rename/archive buttons were invisible in production because the code
   feature-detected `apiProxy` — a gateway service dsh-base does NOT mount —
   while the unit tests injected a fake. Assert in the integration test that
   the feature's surface actually appears (buttons render, actions reach the
   host), so a wrong seam fails the suite instead of silently degrading.
5. If a new Feishu scope, event, or card callback is needed, update
   `src/setup/feishu-manifest.json` and `docs/feishu-setup.md` IN THE SAME
   change.

### 5. Unit tests (high coverage)

1. Add co-located unit tests in `tests/` covering the module's behavior (and
   disposal where it registers).
2. **Push coverage up** — chase the uncovered branches of the state machine,
   the renderer, and the command handlers, not just the happy path. The
   integration suite proves the composition; the unit suite proves the logic
   exhaustively.

### 6. Re-brainstorm the integration tests

1. After implementation, brainstorm AGAIN with fresh eyes: what scenarios did
   the first pass miss now that the real behavior is visible? Add them to the
   integration suite.
2. Run the hardened gates: `pnpm run check` (convention checks) then
   `pnpm run gates` (lint, typecheck, build, test with
   `FEISHU_INT_REQUIRED=1`, every exit code checked — no pipes that can
   swallow a failure).

### 7. Docs

1. Update the mapped doc (see `docs/development.md` → "Documentation map"):
   the feature's `docs/` page, `docs/features.md` row → ✅, and the CHANGELOG
   `[Unreleased]` entry — all in this change.
2. `README.md` / `README.zh.md` are maintainer-gated: any README edit requires
   maintainer review before commit. Put README edits in their own commit;
   hold the PR for review.

### 8. Worktree + PR

1. Run the mechanical acceptance check (from the feature worktree):

```sh
node .dsh/skills/feature-development/scripts/check-acceptance.mjs
```

2. Rebase onto the latest `origin/main`, re-run the gates, then push and open
   a PR.
3. Before auto-merging, run the mergeability gate:

```sh
pnpm run check:mergeable            # local (gates assumed green)
pnpm run check:mergeable --ci=github  # also check the live PR checks
```

4. **Merge policy**: a PR touching README is held for maintainer review unless
   the branch carries a review marker (a `review:` commit or a `*-reviewed`
   branch name). Any other PR may be squash-merged automatically once CI is
   green (`merge_method: "squash"`, commit title `<PR title> (#<number>)`).

## Platform and toolchain pitfalls (from real fixes)

- **Feishu drops form/select controls in cards** — use buttons/pickers, never
  form elements, for card interactions (button-based repo picker).
- **Card schema compatibility** — validate the card JSON against the Feishu
  schema version in use (schema-2.0 / v1 layout fixes shipped for this).
- **Card size caps** — native tables ≤ 5/card, content truncation at the card
  cap, always with a visible marker (never silent).
- **pnpm 11 minimumReleaseAge** — the repo pins `minimumReleaseAge: 0` in
  `pnpm-workspace.yaml`; a freshly published dep otherwise breaks installs.
  `pnpm run check` guards this.
- **Integration-test hygiene** — wait for the dsh child to exit before
  resetting state; unique message ids; filter waits by chatId.
- **Local "green" is not CI green** — run `pnpm run gates`, not
  `biome check --write` + output tails (see AGENTS.md).

## Parallel features

Multiple features may be developed in parallel (the orchestrator dispatches
subagents). Each feature owns its own worktree and branch; shared seams
(transport, session map, panel registry) are touched by one feature at a time
— coordinate through the state of the repository, never through shared
working trees.

**Parallel execution is headless — no real-bot verification step.** The
integration suite (real dsh process, memory transport, mock LLM) IS the
composition proof for interactive features; it runs unattended in CI.
Driving a real Feishu bot requires a human in the loop (credentials,
on-device taps, chat traffic), which cannot be parallelized — so the SKILL
has no real-device step. A maintainer may still run the runbook in
`docs/development.md` → "Running the live test bot" (with `FEISHU_DEBUG=1`)
as a manual acceptance pass; treat that as maintainer-side verification,
never as a subagent deliverable.

## Acceptance checklist (before any PR)

- [ ] Scaffolded via `scripts/new-feature.mjs` (worktree + branch + spec skeleton)
- [ ] Spec recorded in `docs/ux-specification.md` (part, per the template) + mapped doc page
- [ ] One authoritative state object + one render path
- [ ] Integration tests written first from the brainstormed matrix; scenarios cover errors and edges, not just the happy path
- [ ] Integration tests read callback values FROM the rendered card (never hand-constructed actions)
- [ ] Host seams feature-detected against what actually mounts; async-init services lazily resolved; integration test proves the surface renders
- [ ] Unit tests co-located; coverage pushed on the state machine and handlers
- [ ] Integration tests re-brainstormed after implementation; new scenarios added
- [ ] `pnpm run check` passes (tracked docs public-clean, no mirror leaks, doc pairs, conventional commits)
- [ ] All gates green via `pnpm run gates` (lint, typecheck, build, test with `FEISHU_INT_REQUIRED=1` — exit codes checked, no output tails)
- [ ] `scripts/check-acceptance.mjs` passes (mechanical items: tests, features.md, CHANGELOG, spec, manifest sync, README gate, clean tree)
- [ ] `pnpm run check:mergeable` passes (CI assumed green locally; `--ci=github` checks the live PR)
- [ ] `docs/features.md` row updated; CHANGELOG `[Unreleased]` entry added; manifest/feishu-setup synced if scopes changed
- [ ] README edits (if any) in their own commit, held for maintainer review
- [ ] Squash-merged through a PR with green CI (or held for review when README is touched)
