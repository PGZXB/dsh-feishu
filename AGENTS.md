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

The development roadmap lives in `PLAN.md` (currently the bilingual planning
artifact; shipped docs are English only). Work proceeds in **iterations**:
each iteration ships a coherent slice of functionality with unit tests and
docs, and lands on `main`.

## Non-negotiable conventions

- **English only in code and shipped docs.** All code comments, identifiers,
  README, `docs/`, `AGENTS.md`, and the CHANGELOG are written in English.
  Chinese documentation is provided later as separate files (e.g.
  `README.zh-CN.md`); never mix languages in one file.
- **Every feature module ships unit tests.** A new module in `src/` must come
  with a co-located test in `tests/` covering its behavior. Fixing a bug
  first adds a failing test. No untested feature lands.
- **Write docs promptly after a feature.** Completing a feature updates the
  relevant `docs/` page(s) and the CHANGELOG in the same change. No feature
  lands without its documentation.
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
```

All gates must pass locally before committing: `lint`, `typecheck`, `test`,
`build`. CI runs the same gates.

## Repository layout

```
src/                  # plugin source (ESM, TypeScript, NodeNext)
  index.ts            # cordis entry: name / Config / apply
tests/                # unit + integration tests (vitest)
docs/                 # English documentation (development, setup, architecture)
examples/             # runnable examples (profiles, configs)
scripts/              # repo tooling (release, verification)
PLAN.md               # the development plan (bilingual planning artifact)
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

## Iterating

1. Pick the next item from `PLAN.md` (current iteration).
2. **Spec first, then implement.** Before building a UX feature, study the
   reference implementation — botmux (`_tmp/botmux`: `im/lark/card-builder.ts`,
   `card-handler.ts`, `event-dispatcher.ts`, `services/project-scanner.ts`) and
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
   agent's actual state transitions. Fixing a bug first adds a failing test at
   the layer that exposed it.
5. **Verify before asking the user to verify.** Run the full matrix yourself;
   hand the user a checklist of what to confirm, not a debugging session. The
   developer absorbs the iteration cost, not the user.
6. Update the relevant `docs/` page and the CHANGELOG.
7. Run all gates; commit with a Conventional Commit message.

When in doubt about a dsh API, read the installed package's `lib/types/*.d.ts`
in the dsh installation, or the upstream source under a checkout of
`deepseek-ai/deepseek-harness` (referenced clones live in `_tmp/`).
