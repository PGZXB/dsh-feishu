# Development Guide

Setup, build, test, and local-verification workflow for dsh-feishu.

## Prerequisites

- Node.js >= 22.13 (ESM, NodeNext)
- pnpm (the dsh profile tooling forwards to pnpm)
- A dsh installation: `npm install -g @deepseek-ai/dsh` (the npx cache of
  `@deepseek-ai/dsh` also works for local verification)

## Install dependencies

```sh
pnpm install
```

> Local-environment note: pnpm 10+ reads settings from `pnpm-workspace.yaml`
> and the user config directory; the default store location may be unwritable
> on some hosts (e.g. a read-only home mount). In that case point the store at
> a writable path once, using a redirected HOME:
>
> ```sh
> mkdir -p _dev/home && export HOME="$(pwd)/_dev/home"
> pnpm config set store-dir "$(pwd)/_dev/pnpm-store"
> pnpm config set cache-dir "$(pwd)/_dev/pnpm-cache"
> # keep HOME exported for every pnpm invocation in this shell
> ```

## Gates

```sh
pnpm run lint        # Biome: lint + format check on src/ and tests/
pnpm run typecheck   # tsc --noEmit over src/ and tests/
pnpm run test        # Vitest unit + integration tests
pnpm run build       # tsc emit to lib/ (declaration + source maps)
```

All four must pass before committing; CI runs the same four.

## Layout

```
src/                  # plugin source; one module per concern, each with tests
tests/                # vitest suites (never under src/)
docs/                 # English documentation
examples/             # runnable examples (profiles, configs)
scripts/              # repo tooling
```

Tests use the "fake context" pattern for plugin-level coverage: hand-built
stubs of the cordis services the module touches (see `tests/index.spec.ts`),
plus pure-function tests for the module's logic.

### Integration test

`tests/integration/real-composition.spec.ts` boots a **real dsh process** from
a real profile and runs a real agent turn, mocking only the two external
services:

- **Feishu** — `FEISHU_TRANSPORT=memory` swaps the wire for the file-channel
  memory transport (`src/memory-transport.ts`): the test drops a message into
  `inbox/`, the surface processes it, and every send/update lands in
  `outbox/`.
- **LLM API** — `DEEPSEEK_BASE_URL` points the real DeepSeek adapter at a
  local mock server (`tests/integration/mock-llm-server.ts`).

The test asserts the full private-chat loop: message → session → agent turn →
card posted and patched → final answer delivered as a fresh message. It
self-skips unless the prerequisites are met:

- The dsh CLI is resolvable (`$DSH_BIN`, or `dsh` on `PATH`).
- A prepared profile exists at `$FEISHU_INT_DSH_HOME/profiles/feishu-dev`
  (default `_dev/dsh-home/profiles/feishu-dev` — create it with
  `dsh plugin --profile feishu-dev add link:<checkout>`, see the "Verifying
  the bundle" section above). Deliberately independent of the ambient
  `DSH_HOME` so the test never touches another dsh home.
- The checkout is built (`pnpm run build`).

```sh
pnpm run build        # ensure lib/ is current (the profile links the checkout)
pnpm run test         # unit + integration (integration self-skips as needed)
DSH_BIN=/path/to/dsh pnpm run test -- tests/integration/real-composition.spec.ts
```

The `FEISHU_TRANSPORT=memory` seam is also handy for manual debugging:
inject a fake message by writing a JSON file into
`$FEISHU_MEMORY_DIR/inbox/` while the surface runs.

## Verifying the bundle in a real dsh profile

The bundle must mount into a real dsh profile. Use an isolated `DSH_HOME` so
the verification never touches a production profile:

```sh
# From the checkout root:
export DSH_HOME="$(pwd)/_dev/dsh-home"   # git-ignored
dsh plugin --profile feishu-dev add "link:$(pwd)"
dsh --profile feishu-dev --dump-config   # confirm the feishu row is composed
timeout 30 dsh --profile feishu-dev       # boot; expect the "[feishu]" log lines
```

- The first `dsh plugin` call initializes the profile (bundles =
  `['@deepseek-ai/dsh-base']`), runs `pnpm add link:<checkout>` inside it, and
  appends `@dsh-feishu/dsh-feishu` to `dsh.profile.bundles` because the
  manifest declares `dsh.bundle.patch`. If the profile's pnpm store is
  unwritable, add `storeDir` / `cacheDir` to the profile's
  `pnpm-workspace.yaml` (that file is the pnpm 10+ settings home).
- Booting without credentials logs the not-configured notice and registers
  `feishu-status`; credentials come from the `appId`/`appSecret` config keys
  or the `FEISHU_APP_ID` / `FEISHU_APP_SECRET` environment variables.
- Teardown: `rm -rf _dev/dsh-home` (or drop the `feishu-dev` profile).

## Adding a feature module

1. Create `src/<module>.ts` with JSDoc on the module and its exported
   functions.
2. Create `tests/<module>.spec.ts` covering its behavior (and disposal where
   it registers into a registry).
3. Wire it through `src/index.ts` (feature-detect optional services with
   `ctx.get`).
4. Update the relevant `docs/` page and `CHANGELOG.md`.
5. Run all gates; commit with a Conventional Commit message.

## Publishing (planned)

Publication uses OIDC trusted publishing from a GitHub release workflow,
mirroring the reference plugin repos (see `PLAN.md`). Details land with the
release iteration; until then the package is private to the repository.
