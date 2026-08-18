# AGENTS.md

Guidance for AI agents (and humans) working in this repository. Read this
before making changes; more specific instructions take precedence.

## Project

dsh-feishu is a native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh) plugin that turns Feishu (Lark) into dsh's own surface: one Feishu chat
maps to one dsh session, the chat bot is the agent's avatar, and output
streams back as live Feishu cards.

**Core identity: DSH-native — born for dsh, not bridged to it.** The surface
targets exactly one agent (dsh) and integrates in-process; it does not bridge
external CLIs and does not reimplement agent capabilities. Three promises
follow (see README):
no bridge/capture (no CLI adapters, no tmux/screen/ANSI), full transparency
(every token/tool/question/approval streams out; the agent never does
anything to be seen), and everything-is-a-card (every dsh surface element
maps to a Feishu card).

It is built as a dsh **bundle** (an npm package whose manifest declares
`dsh.bundle.patch`) that rides on `@deepseek-ai/dsh-base`.

Work proceeds in **iterations**: each iteration ships a coherent slice of
functionality with unit tests and docs, and lands on `main`.

## Non-negotiable conventions

- **English only in code and shipped docs.** All code comments, identifiers,
  README, `docs/`, `AGENTS.md`, and the CHANGELOG are written in English.
  Chinese documentation is provided later as separate files (e.g.
  `README.zh-CN.md`); never mix languages in one file.
- **No machine-specific details in tracked docs.** Everything git tracks
  becomes public once the repository is open-sourced. Never commit absolute
  developer-machine paths (`/home/<user>/…`), ambient environment values
  observed on one machine (e.g. a harness-exported `DSH_HOME`), or other
  local-only state into README, `docs/`, `AGENTS.md`, or the CHANGELOG.
  Path examples are `$(pwd)`-anchored (`_dev/…` is git-ignored local state)
  or generic placeholders; environment anecdotes are phrased so any
  contributor's machine applies.
- **Git-tracked docs are public — no internal pointers.** Everything under
  `README`, `docs/`, `AGENTS.md`, the CHANGELOG is visible to anyone once
  pushed. Never reference internal-only artifacts (git-ignored `_dev/`
  files, local analyses, private reports, ambient environment values) or
  point readers at them ("see the internal report" is a dead link to
  everyone else). Every tracked doc must stand alone and be self-explanatory
  to an outside reader.
- **Every feature module ships unit tests.** A new module in `src/` must come
  with a co-located test in `tests/` covering its behavior. Fixing a bug
  first adds a failing test. No untested feature lands.
- **Write docs promptly after a feature.** Completing a feature updates the
  relevant `docs/` page(s) and the CHANGELOG in the same change. No feature
  lands without its documentation.
- **Docs move with their feature — never in a later PR.** Every change that
  touches behavior, commands, UX, setup, or architecture updates the
  corresponding doc in the SAME PR (map: `docs/development.md` →
  "Documentation map"). A PR that changes behavior without touching its
  mapped doc is incomplete; call out "no docs change needed" explicitly in
  the PR body.
- **README.md / README.zh.md are maintainer-gated.** They are the public
  face of the project: never commit ANY README edit — wording, badges,
  structure, links — without explicit maintainer review first. Other docs
  may be committed directly; README always needs review, so put README
  edits in their own commit that can be reviewed/dropped independently.
- **Feishu permissions manifest, kept in sync in the same change.** Any
  feature that needs a new Feishu scope, event, or card callback updates
  `src/setup/feishu-manifest.json` — the single source of truth for the
  quick-setup automation (`pnpm run setup:feishu`), its manual fallback, and
  `docs/feishu-setup.md` — IN THE SAME change. The setup tool grants exactly
  what that file lists; an unlisted scope is a bot that silently cannot do
  the feature. Example: `/export` (file messages) added `im:resource`.
- **Registrations are effects.** Every contribution goes through `ctx.on()` /
  `ctx.effect()`; a registry's `register()` returns a disposer, and tests
  verify disposal where a registry is involved.
- **Optional services use `ctx.get(name)`.** Reserve `ctx.<name>` for
  declared injections; feature-detect and degrade loudly when a service is
  absent (the dsh runtime is `0.1.0-rc` and its surfaces can move).
- **Type-only imports for `@deepseek-ai/*`.** Runtime dependencies are kept
  minimal; harness packages are peer/dev dependencies used for types only.
  Empty type imports carry Context merges (e.g. `import type {} from
  '@deepseek-ai/dsh-commands'`).
- **Misconfiguration fails loud.** Never silently skip a missing referent;
  log what is missing and why.
- **No truncation without user confirmation.** Never cut user-visible
  content (card size, list length, output length, collapsed sequences,
  details views) as a silent default. Physical platform limits (the Feishu
  ~109 KB card cap) are the only exception, and even those must be raised
  with the user before relying on them. Content integrity is a product
  decision, not an implementation shortcut.
- **Stateful UI is a state machine, not patches.** One authoritative state
  object per surface (see `ChatCardState` in `src/bridge.ts`) and one
  render path (`syncCard`) that draws from it. When the same bug resurfaces
  in different actions, refactor the state into a single source of truth —
  do not add another per-case reassert. Card actions mutate the state (or
  not) and always end with the single render path.
- **Every panel interaction carries an immediate panel patch.** Lark
  restores the pre-click card whenever a callback carries no panel update —
  any await inside a panel action reverts the panel to its previous state
  unless a patch lands first. Two structures guarantee this: async panel
  VIEWS (`sessions`/`session-detail`/`picker`) post a `⏳ Loading…`
  placeholder before rendering (in `showPanel`), and async panel
  OPERATIONS (rename/archive/export/resume/picks/command handlers) go
  through the single wrapper `runPanelOperation`, which posts an
  `⏳ Operating…` placeholder before the work. NEVER add a new async panel
  action that awaits before patching — route it through `runPanelOperation`.
  See `docs/ux-specification.md` §8.6.
- **Card-callback ACK contract (Feishu).** `card.action.trigger` is a
  synchronous callback with a 3 s deadline and no re-push. Always ACK with
  a valid response — never `undefined`, which the client rejects as an
  invalid ACK and can then re-render the card to a stale state. Card
  patches issued from inside a callback must be deferred out of it (a
  macrotask) so the ACK lands first; Lark can otherwise restore the
  pre-click card. See `docs/ux-specification.md` §3.4 and
  `docs/pitfalls.md`.

## Commands

```sh
pnpm install          # install dependencies
pnpm run build        # tsc emit to lib/ (tsconfig.build.json)
pnpm run typecheck    # tsc --noEmit (src + tests)
pnpm run lint         # biome check src tests
pnpm run lint:fix     # biome check --write src tests
pnpm run test         # vitest run
pnpm run test:watch   # vitest watch
pnpm run check        # convention checks (tracked docs public-clean, mirror leaks, doc pairs, commit messages)
pnpm run gates        # lint + typecheck + build + test(FEISHU_INT_REQUIRED=1), exit codes checked
pnpm run verify       # check + gates
```

All gates must pass locally before committing: `lint`, `typecheck`, `test`,
`build`. `pnpm run verify` runs the convention checks plus every gate with
exit codes checked — use it before any PR. CI runs the same gates.

## Repository layout

```
src/                  # plugin source (ESM, TypeScript, NodeNext)
  index.ts            # cordis entry: name / Config / apply
tests/                # unit + integration tests (vitest)
docs/                 # English documentation (development, setup, architecture)
examples/             # runnable examples (profiles, configs)
scripts/              # repo tooling (release, verification)
```

- `src/` modules are small and single-purpose; each owns its behavior and
  its tests.
- Tests live under `tests/`, never under `src/`.
- `lib/`, `node_modules/`, `_tmp/`, and `_dev/` are git-ignored build/local
  state, never committed.

## Style

- Biome: 2-space indent, single quotes, semicolons, trailing commas, 100-col
  line width (`pnpm run lint`).
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- Every module and exported function has concise JSDoc with `@param` /
  `@returns` where non-obvious.
- Comments state contracts and context, not reasoning transcripts.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `chore:`. The CHANGELOG (Keep a Changelog format) is updated per change.
- **PR titles follow Conventional Commits too** (`fix: …`, `chore(ci): …`;
  multi-type PRs pick the dominant type).
- **Squash-merge every PR** into one `main` commit titled
  `<PR title> (#<number>)`; PR bodies use the What / Why / Verification
  template (`docs/development.md` → "Pull requests and CI").

## Iterating

1. Pick the next item to work on (open issues, or as assigned by the
   maintainer).
2. **Spec first, then implement.** Before building a UX feature, study the
   reference implementation — botmux (clone it under `_tmp/botmux`:
   `im/lark/card-builder.ts`, `card-handler.ts`, `event-dispatcher.ts`,
   `services/project-scanner.ts`) and
   DSH web (deepseek-harness `packages/client/ui-tool`,
   `packages/client/ui-conversation`) — and record the intended behavior in
   `docs/ux-specification.md` (per part, with the reference cited) plus the
   relevant `docs/` page. The spec doubles as developer guidance and
   user-facing documentation. Their comments encode real failure modes (ACK
   deadlines, invalid-ACK card re-renders, pre-click card restore, silent
   `form` drops); reading the source beats guessing behavior.
3. Implement against the spec with a state-machine-shaped design (one
   authoritative state, one render path — not per-case patches).
4. **Test at both layers.** Interactive/stateful behavior gets (a) unit tests
   with fakes for fast iteration AND (b) a real-composition integration test
   (`tests/integration/real-composition.spec.ts`: real dsh process, memory
   transport, mock LLM) — fakes prove our logic, the real process proves the
   agent's actual state transitions. **Every user-reported issue fix adds a
   regression test** (at the layer that exposed it — unit, integration, or
   both) before the fix is committed; a fix without a new test is incomplete.
5. **Verify before asking the user to verify.** Run the full matrix yourself;
   hand the user a checklist of what to confirm, not a debugging session. The
   developer absorbs the iteration cost, not the user.
6. Update the relevant `docs/` page and the CHANGELOG.
7. **Run all gates exactly as CI does and check every exit code.**
   `pnpm run lint` IS `biome check src tests` — the CI command — not
   `biome check --write`; `--write` only applies safe fixes and silently
   leaves unsafe ones (useTemplate, useIndexOf, …) as CI errors. Piping
   output or reading only the tail can mask a non-zero exit: run
   `pnpm run lint`, `pnpm run typecheck`, `pnpm run test`,
   `pnpm run build` and confirm each returns 0 before committing with a
   Conventional Commit message.

## Adapting to a new dsh release

dsh is pre-release (`0.1.0-rc.x`) and can break between releases. The canary
workflow (`.github/workflows/canary.yml`) runs the suite against
`@deepseek-ai/*@next` daily — red canary means a compatibility fix is due.
When adapting:

- Bump versions: `devDependencies.@deepseek-ai/dsh` pinned EXACT, other
  `@deepseek-ai/*` caret (`^0.1.0-rc.7`); CLI bundles all sub-packages, so
  lockfile and CLI bumps land together.
- Read upstream release notes first; grep our code for renamed modes/commands
  (rc.7: Code mode → PTC mode) in card labels, snapshots, tests.
- Check surface shapes against the INSTALLED `.d.ts` (getters vs methods) —
  compiling against new types is no guarantee of a working runtime.
- Confirm the session-log reader still parses new logs (zstd frames, `seq`
  continuity).
- Refresh the lockfile against the official registry (npmmirror misses
  `@deepseek-ai/dsh-bash-env`).
- Re-verify all gates (`FEISHU_INT_REQUIRED=1`) with a profile installed from
  the NEW CLI; never touch `~/.dsh` — only `_dev/` test homes.
- Update the compat badge + Note in `README.md` / `README.zh.md`.

## Worktree + PR workflow

The main working tree is shared: a human or another agent may be editing it at
any moment. Never commit or run stateful work there. Do feature work in a git
**worktree under `_dev/`** (git-ignored, so it never pollutes commits):

```sh
git worktree add -b <topic-branch> _dev/dsh-feishu-<topic> main
```

A fresh worktree has no `node_modules/`, `lib/`, or `_dev/` state. Before
running the gates there: `pnpm install`, `pnpm run build`, and prepare the
integration profile (`DSH_HOME="$(pwd)/_dev/dsh-home" dsh plugin --profile
feishu-dev add "link:$(pwd)"`). If pnpm is not on your `PATH`, use
the local install under `_dev/pnpm` and point store/cache at `_dev/` (env
block in `docs/development.md` → "Local toolchain").

Verify every gate exactly as CI does — including `FEISHU_INT_REQUIRED=1` so
the integration suite must actually run, never silently skip — then:

```sh
git fetch origin && git rebase origin/main   # resolve conflicts, re-verify
git push -u origin <topic-branch>            # open a PR; never push to main
```

Merge only through a PR with green CI. Maintainers may automate GitHub API
access (PR creation, CI monitoring, merge) with a repo-scoped PAT kept in
the git-ignored `_dev/gh-token` (chmod 600); the concrete API calls live in
`docs/development.md` → "Pull requests and CI". Keep the main tree
untouched throughout: the
integration suite writes `_dev/` state (dsh home, memory transport), so run it
in the worktree, never in the main tree.

## Lessons learned (field-proven on real devices)

These rules came from real bugs; each has a regression test and a
`docs/pitfalls.md` entry. Follow them in new code.

- **Service seams are structural and match the REAL service shape.** We do
  not depend on harness packages at runtime (`ctx.get(name)`), but the seam
  must mirror the actual surface — getters vs methods matter
  (`ctx.permissionPresets.names` is a GETTER, not `names()`; `current`
  takes `events`, `set` takes `session`). Wrong shapes typecheck fine and
  blow up at runtime ("events is not iterable", "names is not a function").
  Read the installed `.d.ts` before writing the seam.
- **Some web commands have no host implementation.** `/export` and `/model`
  are client-side contributions (a browser download observer, a
  `commandUi.popupSelect`). Check the harness source for "Web-only" before
  promising a command; implement a surface-native equivalent instead
  (`/model` with a picker card from `ctx.llm.listModels`).
- **A button that only passes through is a broken button.** Commands with a
  choice or toggle dimension must be state-aware: `/permission` opens a
  preset picker (dropdown, `initial_option` preselected), bare `/plan`
  toggles through `ctx.planMode`, `/model` opens a model picker. Empty
  rawInput must never be the only behavior a button offers.
- **Working-directory availability is an explicit product state.** A chat
  with no pinned cwd (/repo or /cd) refuses turns with guidance —
  `defaultCwd` is a fallback, never an implicit choice. New features that
  change chat state (resume!) must adopt the working directory or they get
  stuck behind the gate.
- **One gate, not patches.** If a guard is unreachable through the surface,
  don't duplicate it (`retry` cannot fire unpinned — the deliverTurn gate
  is the single source of truth).
- **Test-side state is part of the test.** Integration tests share the
  real profile; a test that writes settings (`/model` save, /permission)
  must restore them. Message-id collisions (`Date.now()` as an id) and
  waitFor predicates that match ANY chat's reply are real bugs that
  produce flaky, confusing failures — unique ids, filter by chatId.
- **Every new session fires a title-generation completion.** Don't assert
  exact LLM completion counts per turn; assert card contents instead.
- **A local "green" is not CI green.** `biome check --write` auto-fixes
  only safe diagnostics; unsafe ones (template literals, `indexOf` over
  `findIndex`) remain and fail plain `biome check` — which is exactly what
  `pnpm run lint` and CI run. Always run the exact CI commands and verify
  their exit codes, not the output tail (a real CI failure shipped because
  the last local gate only looked at the last output line).

When in doubt about a dsh API, read the installed package's `lib/types/*.d.ts`
in the dsh installation, or the upstream source under a checkout of
`deepseek-ai/deepseek-harness` (clone referenced upstreams under `_tmp/`).
