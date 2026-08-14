# Development Guide

English | [中文](development.zh.md)

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

### Local toolchain

On this machine `pnpm` is not on `PATH`. Use the local install and point every
pnpm invocation — including the profile's spawned `pnpm`, since `dsh plugin`
forwards to it — at writable store/cache paths under `_dev/`:

```sh
export PATH="/home/zhangmm23/dsh-feishu/_dev/pnpm/node_modules/.bin:$PATH"
export npm_config_store_dir="/home/zhangmm23/dsh-feishu/_dev/pnpm-store"
export npm_config_cache_dir="/home/zhangmm23/dsh-feishu/_dev/pnpm-cache"
export XDG_CACHE_HOME="/home/zhangmm23/dsh-feishu/_dev/xdg-cache"  # node-gyp builds
```

`npm_config_*` env vars override project config, so `dsh plugin`'s inner
`pnpm add` uses the same store without editing the profile. `XDG_CACHE_HOME`
redirects node-gyp's header cache (the default `~/.cache/node-gyp` sits on a
read-only mount here) — without it native modules such as node-pty fail to
build.

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

The suite asserts the full surface: message → session → agent turn → card
posted and patched → **final answer carried by the card** (it finalizes
green in place), plus the card actions, the session lifecycle, the web
command wrappers, and the working-directory gate. A scripted mock LLM
(`setScripts`, `holdNextResponse`, and an `error` chunk that answers HTTP
500) drives tool calls, reasoning, error turns, and retries. It self-skips
unless the prerequisites are met:

- The dsh CLI is resolvable (`$DSH_BIN`, or `dsh` on `PATH`).
- A prepared profile exists at `$FEISHU_INT_DSH_HOME/profiles/feishu-dev`
  (default `_dev/dsh-home/profiles/feishu-dev` — create it with
  `dsh plugin --profile feishu-dev add link:<checkout>`, see the "Verifying
  the bundle" section above). Deliberately independent of the ambient
  `DSH_HOME` so the test never touches another dsh home.
- The checkout is built (`pnpm run build`).

CI runs the suite on every push (both node-version legs): the workflow
builds the checkout, prepares the profile, and runs the tests with
`FEISHU_INT_REQUIRED=1` so a missing prerequisite fails the job loudly
instead of silently skipping. The dsh CLI is a devDependency
(`@deepseek-ai/dsh`) and native build scripts (node-pty and friends) are
allowed in `pnpm-workspace.yaml` — no credentials are involved; the Feishu
and LLM mocks above are what make the suite runnable without secrets.

```sh
pnpm run build        # ensure lib/ is current (the profile links the checkout)
pnpm run test         # unit + integration (integration self-skips as needed)
DSH_BIN=/path/to/dsh pnpm run test -- tests/integration/real-composition.spec.ts
FEISHU_INT_REQUIRED=1 pnpm run test   # fail (not skip) when a prerequisite is missing
```

Turn-running tests pin a working directory first (`/cd`, required by the
working-directory gate) and the group tests inject the bot's open id via
`FEISHU_MOCK_BOT_OPEN_ID`. New sessions fire an extra title-generation LLM
completion — assert card contents, never exact completion counts.

The `FEISHU_TRANSPORT=memory` seam is also handy for manual debugging:
inject a fake message by writing a JSON file into
`$FEISHU_MEMORY_DIR/inbox/` while the surface runs.

#### Scenario suite (two real-process suites, two dsh homes)

`tests/integration/scenarios.spec.ts` is a second real-process suite for
edge scenarios: daemon-restart durability, group mention modes and
allowlists (via the `FEISHU_*` env seams), `/group` + `/repo`, every
question-card variant, proactive mentions, dedup, passthrough, and the
stopped-turn reaction swap. (Session replay has one surface — `/export`;
`/history` was removed by decision as redundant and ugly.) Because vitest runs test **files** in
parallel, the two suites must not share a dsh home (both persist the
session map + logs): the scenario suite defaults to
`_dev/dsh-home-scenarios` (`FEISHU_INT_SCENARIOS_DSH_HOME` overrides),
prepared with the same `dsh plugin --profile feishu-dev add link:<checkout>`
recipe. CI prepares both profiles.

##### Scenario coverage matrix

| Scenario | Test |
|---|---|
| Daemon restart resumes the same session; `/export` after restart ships a transcript spanning both sides | `restart resumes the same session` |
| `/status` read-only while a turn runs | `/status is read-only` |
| Bare `/repo` posts the picker card | `bare /repo posts the project picker card` |
| `/group` creates a group; @-turn works there | `/group creates a group chat` |
| Mention modes `never` / `ambient` / `topic` | three `groupMentionMode=` tests |
| `allowedChats` (env) gates whole chats | `allowedChats env` |
| Solo-group relaxation (`1u,1b`) accepts un-@ | `solo-group relaxation` |
| Multi-select toggles + Submit (retargeted cards) | `multi-select question` |
| Free-text question answered by a chat message | `free-text question` |
| Question Cancel settles empty answers | `question Cancel` |
| Group approval/question cards @ the requester; p2p cards don't | two mention tests |
| Redelivered message id is deduped | `message dedup` |
| `unknownCommand=passthrough` routes unknown slashes to the model | `unknownCommand=passthrough` |
| Stop mid-turn swaps the reaction to the stopped emoji | `stop mid-turn swaps the received reaction` |
| `/export` transcript includes tool rows | `/export after a tool-calling turn` |

## Verifying the bundle in a real dsh profile

The bundle must mount into a real dsh profile. Use an isolated `DSH_HOME` so
the verification never touches a production profile:

> For creating/configuring the Feishu app itself — one QR scan, no
> web-console work — see `docs/feishu-setup.md` → "Quick setup"
> (`pnpm run setup:feishu`).

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

## Pull requests and CI

Merge only through a PR with green CI — never push to main. GitHub API access
uses the repo-scoped fine-grained PAT at `_dev/gh-token` (chmod 600, owned by
the developer, never committed). Read it into a variable per call and never
echo it:

```sh
TOKEN=$(cat _dev/gh-token)
```

Open a PR (head = your pushed branch, base = `main`):

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' \
  https://api.github.com/repos/PGZXB/dsh-feishu/pulls \
  --data '{"title":"...","head":"<branch>","base":"main","body":"..."}'
```

Watch CI until it concludes — the workflow runs the full gate matrix,
including the real-composition integration suite:

```sh
SHA=$(git rev-parse HEAD)
curl -s -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/PGZXB/dsh-feishu/actions/runs?head_sha=$SHA"
```

Merge once the PR's `mergeable_state` is `clean` (checks green). Use
`merge_method: "rebase"` to keep `main` linear — "merge" always adds a merge
commit even when a fast-forward is possible, leaving two commits per PR:

```sh
curl -s -X PUT -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' \
  https://api.github.com/repos/PGZXB/dsh-feishu/pulls/<number>/merge \
  --data '{"commit_title":"...","merge_method":"rebase"}'
```

Before opening the PR, rebase onto the latest `origin/main` and re-run the
gates: the main tree moves under concurrent work, and conflicts are cheapest
to fix before the PR exists. If CI is red, fix in the worktree and re-push —
GitHub re-runs checks on the new head. See AGENTS.md → "Worktree + PR
workflow" for the end-to-end practice.

## Publishing

Publishing is tag-driven: `node scripts/release.mjs <major|minor|patch>`
bumps `package.json`, runs the CI gates, commits and tags `v*`; the
[Release workflow](.github/workflows/release.yml) then publishes to npm
(`NODE_AUTH_TOKEN` — the same registry-token pattern the DeepSeek Harness
release workflow uses) and creates a GitHub Release. Before the first
public release, rotate the Feishu app secret (see `SECURITY.md`).
