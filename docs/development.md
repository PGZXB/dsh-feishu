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

If `pnpm` is not on your `PATH`, use a local install and point every pnpm
invocation — including the profile's spawned `pnpm`, since `dsh plugin`
forwards to it — at writable store/cache paths under the repo's `_dev/`:

```sh
export PATH="$(pwd)/_dev/pnpm/node_modules/.bin:$PATH"
export npm_config_store_dir="$(pwd)/_dev/pnpm-store"
export npm_config_cache_dir="$(pwd)/_dev/pnpm-cache"
export XDG_CACHE_HOME="$(pwd)/_dev/xdg-cache"  # node-gyp builds
```

`npm_config_*` env vars override project config, so `dsh plugin`'s inner
`pnpm add` uses the same store without editing the profile. `XDG_CACHE_HOME`
redirects node-gyp's header cache (the default `~/.cache/node-gyp` may sit on
a read-only mount) — without it native modules such as node-pty fail to
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
docs/                 # documentation (EN + .zh.md)
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
- A prepared profile exists at `$FEISHU_INT_*_DSH_HOME/profiles/feishu-dev`
  (default `_dev/dsh-home-<suite>/profiles/feishu-dev` — create it with
  `dsh plugin --profile feishu-dev add link:<checkout>`, see the "Verifying
  the bundle" section below). Deliberately independent of the ambient
  `DSH_HOME` so the test never touches another dsh home. **Each integration
  suite uses its OWN home** (`dsh-home-attachments`, `dsh-home-rich-text`,
  `dsh-home-wait-instruction`, `dsh-home-real`, `dsh-home-scenarios`):
  vitest runs the suites in parallel, and sharing one
  `_dev/dsh-home/feishu/session-map.json` made concurrent dsh processes
  race their writes and silently drop one suite's chat→session binding
  (CI-only flakes, e.g. the session-lifecycle test reading the file and
  finding its chat missing).
- The checkout is built (`pnpm run build`).

CI runs the suite on every push (both node-version legs): the workflow
builds the checkout, prepares the profile, and runs the tests with
`FEISHU_INT_REQUIRED=1` so a missing prerequisite fails the job loudly
instead of silently skipping. The dsh CLI is a devDependency
(`@deepseek-ai/dsh`) and native build scripts (node-pty and friends) are
allowed in `pnpm-workspace.yaml` — no credentials are involved; the Feishu
and LLM mocks above are what make the suite runnable without secrets.

A separate **canary workflow** (`.github/workflows/canary.yml`) runs the
same suite daily (UTC 02:00) and on demand against the NEWEST
`@deepseek-ai/*` release via the `@next` dist-tag (not the lockfile-pinned
version, and not `@latest` — for most harness packages npm `latest` still
points at the old `0.0.1-rc.x` line). A red canary means an upstream
breaking change reached our code; see AGENTS.md → "Adapting to a new dsh
release".

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
in parallel, the two suites must not share a dsh home (both persist the
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


### Real-client E2E (feishu.cn web)

The E2E suite drives the **actual feishu.cn web client** in a headless
browser and exercises the bot like a user: open a group chat, send a slash
command, click card buttons, assert what renders. It runs the real dsh
process (dedicated bot app, mock LLM) plus a real browser — the only layer
where the Feishu wire and the client are both real. Run
`pnpm run e2e:setup` once (dedicated test account; the QR scans are the
only human steps, and the setup is idempotent — re-running never re-scans
an already-exported login) — afterwards `pnpm run e2e:ui` is hands-free.
Each test case creates its own group chat (`<caseId>-<runId>`) through the
backend (the same `im.v1.chat.create` call `/group` wraps), so cases never
share a chat page. It is **not** part of CI: it needs a real bot app and a
browser session. Design, constraints, runbook, and the captured web
selectors live in `docs/e2e-testing.md`.

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

## Running the live test bot

For end-to-end verification against the REAL Feishu platform (a card that
only misbehaves on device, a timing issue, a panel interaction), boot the
bot with the repository's test-app credentials instead of the integration
mocks. The checkout keeps a git-ignored test-bot environment:

```sh
source _dev/bot-env.sh        # sets DSH_HOME=_dev/dsh-home + sources _dev/secrets.env
```

`_dev/secrets.env` holds `FEISHU_APP_ID` / `FEISHU_APP_SECRET` /
`DEEPSEEK_API_KEY` for the test app; `bot-env.sh` also unsets the proxy vars
(the Feishu long connection must NOT go through the sandbox proxy).

- **Debug tracing**: set `FEISHU_DEBUG=1` to print debug lines across the
  whole surface (see "Debug logging" below for the full line map). The
  panel logs show exactly which card each action updates — the tool for
  "which card reacted" questions.
- **Exactly ONE bot process**: before/after every start or restart, verify
  only one process is attached to the test app (see `docs/pitfalls.md` →
  "Environment and proxy quirks" — a stray second bot makes cards update
  chaotically because each process owns its own panel state).
- **Start detached** so the bash job does not reap it:

  ```sh
  source _dev/bot-env.sh && export FEISHU_DEBUG=1
  nohup ./node_modules/.bin/dsh --profile feishu-dev > _dev/bot.log 2>&1 < /dev/null & disown
  sleep 15 && grep "bridge ready" _dev/bot.log
  ```

  Stop with `pkill -f "bin.js --profile feishu-d[e]v"` and verify zero
  processes remain.

## Debug logging

`FEISHU_DEBUG=1` enables `logger.debug(...)` tracing across the whole
surface (the console exporter gates it; without the env var production
stays quiet — see `docs/pitfalls.md` → "Debug tracing needs
`FEISHU_DEBUG=1` AND the exporter's `levels`"). Every log line follows
`<module> <action> <entities>` with the real ids, so you can trace one
message, card, session, or chat through the pipeline:

| Module | Lines you will see | Answers |
|---|---|---|
| `index` | `[feishu] starting surface`, `routing: …`, `host services: …` | What config won; which host services mounted (rename/archive/permission/plan/llm) |
| `session-map` | `session map: minted/remint/chat X now Y/cwd …` | Why a chat got a new session; cwd pin changes |
| `bridge` | `message <id> -> slash/turn`, `command /x -> <kind>`, `agent resolve … live/resume/create/rebind`, `session event <type>`, `card action <kind> on card <id>` | Message routing; command outcomes; the agent ladder; every inbound event |
| `transport` | `transport ws state -> …`, `sendText/sendCard/updateCard/…` | Long-connection health; every outbound message/card with ids |
| `streaming` | `streaming open/patch/finalize`, `streaming event <type> -> chat`, `tool/call`/`tool/result` | Turn lifecycle; which card was patched and when; tool activity |
| `panel` | `panel action <kind> on card <id>`, `panel OPEN/PUSH/POP/…`, `panel update card <id>` | Which card each tap updates (per-card state machine) |
| `interactions` | `approval request <id>`, `approval <id> settled`, `question <id> settled` | Approval/question lifecycle |
| `actions` | `panel action <kind>: transition/refused/operation` | Panel gate and lifecycle decisions |

A full turn reads top to bottom like: `inbound message m1 -> turn` →
`streaming beginTurn` → `streaming event assistant/chunk` →
`streaming tool/call` → `transport updateCard <card-id>` →
`streaming event turn/end` → `streaming finalize <status>`. When
something misbehaves, grep for the message/card/session id and the
discontinuity in the chain marks where the surface lost it.

## Adding a feature module

1. Create `src/<module>.ts` with JSDoc on the module and its exported
   functions.
2. Create `tests/<module>.spec.ts` covering its behavior (and disposal where
   it registers into a registry).
3. Wire it through `src/index.ts` (feature-detect optional services with
   `ctx.get`).
4. Update the relevant `docs/` page and `CHANGELOG.md`.
5. Run all gates; commit with a Conventional Commit message.

## Documentation map

Every doc below has an owner change type; a PR that touches that surface
updates the doc IN THE SAME PR (see AGENTS.md → "Docs move with their
feature"). `*` marks docs whose changes require maintainer review before
they land.

| Doc | Updated when |
| --- | --- |
| `README.md` / `README.zh.md` `*` | user-facing surface: install, quickstart, features, compatibility, badges — ANY edit requires maintainer review before it lands |
| `CHANGELOG.md` | every user-visible change (Keep a Changelog) |
| `docs/architecture.md` (+ `.zh.md`) | structure, state machines, surfaces, data flow |
| `docs/ux-specification.md` (+ `.zh.md`) | interactive behavior: cards, panels, actions, approvals, questions |
| `docs/feishu-setup.md` (+ `.zh.md`) | Feishu setup, permissions, events, callbacks (kept in sync with `src/setup/feishu-manifest.json`) |
| `docs/development.md` (+ `.zh.md`) | dev workflow, commands, gates, toolchain, PR/CI process |
| `docs/e2e-testing.md` (+ `.zh.md`) | E2E UI suite: scenarios, runbook, constraints, captured web selectors |
| `docs/features.md` (+ `.zh.md`) | feature list / TODO tracker — every shipped or planned feature updates its row |
| `docs/pitfalls.md` (+ `.zh.md`) | field-proven failure modes; every entry ships with its regression test |
| `AGENTS.md` | agent guidance, conventions, workflow (this file) |
| `CONTRIBUTING.md` / `SECURITY.md` | contribution guidance / security posture (rare, deliberate) |

A behavior change with no doc impact is possible but must be stated: the PR
body's `## Docs` line says which docs changed, or "none — no doc surface
affected". README edits always sit in their own commit so the maintainer can
review or drop them independently.

## Pull requests and CI

_Maintainer-only automation — contributors open PRs through the GitHub UI._

Merge only through a PR with green CI — never push to main. GitHub API access
uses the repo-scoped fine-grained PAT at `_dev/gh-token` (chmod 600, owned by
the developer, never committed). Read it into a variable per call and never
echo it:

```sh
TOKEN=$(cat _dev/gh-token)
```

Open a PR (head = your pushed branch, base = `main`). The PR title must be a
Conventional Commit (`feat: …`, `fix: …`, `docs: …`, `chore: …`, optionally
scoped like `chore(ci): …`) — it is what lands on `main` as the merge title,
and history stays uniform when every PR reads as one commit:

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' \
  https://api.github.com/repos/PGZXB/dsh-feishu/pulls \
  --data '{"title":"...","head":"<branch>","base":"main","body":"..."}'
```

The PR body follows a fixed template — what changed, why, which docs
moved with it, and how it was verified (a reviewer reads the body, not the
commits; the merge only keeps the title):

```md
## What

<one line per change, concrete>

## Why

<context: the problem this solves, references to issues/PRs if any>

## Docs

<docs updated by this PR per the Documentation map, or "none — no doc
surface affected". README changes: held for maintainer review.>

## Verification

<gates run + how the behavior was confirmed (manual steps, test names)>
```

Watch CI until it concludes — the workflow runs the full gate matrix,
including the real-composition integration suite:

```sh
SHA=$(git rev-parse HEAD)
curl -s -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/PGZXB/dsh-feishu/actions/runs?head_sha=$SHA"
```

Merge once the PR's `mergeable_state` is `clean` (checks green). Always
**squash-merge** (`merge_method: "squash"`) with
`commit_title: "<PR title> (#<number>)"` — one Conventional Commit per PR on
`main`, each traceable to its PR:

```sh
curl -s -X PUT -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' \
  https://api.github.com/repos/PGZXB/dsh-feishu/pulls/<number>/merge \
  --data '{"commit_title":"<PR title> (#<number>)","merge_method":"squash"}'
```

Do NOT use "merge" (adds a merge commit) or "rebase" (replays a multi-commit
PR as several `main` commits with no PR trace).

Before opening the PR, rebase onto the latest `origin/main` and re-run the
gates: the main tree moves under concurrent work, and conflicts are cheapest
to fix before the PR exists. If CI is red, fix in the worktree and re-push —
GitHub re-runs checks on the new head. See AGENTS.md → "Worktree + PR
workflow" for the end-to-end practice.

## Publishing

Releases are **tag-driven from a frozen `release/*` branch**, never from
`main` — main is a development branch and may carry unreleased work (e.g.
the next dsh compat pass), so a release must be cut from the exact commit
that should ship.

### Version tracks

dsh-feishu tracks two DSH versions, one per consumer track (they differ —
never assume they match):

| dsh-feishu track | Ships | Adapted for DSH | How users install (README sections) |
|---|---|---|---|
| `main` branch | next release's work | **dsh `@next`** (latest pre-release) | "Install from source" |
| npm `@latest` (GitHub latest release) | the current stable release | **dsh `@latest`** | "Install from npm" |

We publish only the `@latest` npm tag — there is no npm `@next` for
dsh-feishu; users who want the newest code install from `main`. README
carries both compatibility badges (`main` → dsh `@next`, latest release →
dsh `@latest`), and the two tracks are verified separately:
- `ci.yml` and the `Canary (main vs dsh@next)` workflow exercise `main`
  against dsh `@next` (main's lockfile pins it; canary lifts to the newest
  @next when upstream publishes faster);
- the `Release compat (npm latest vs dsh@latest)` workflow lifts the repo
  to dsh `@latest` — the combination the next release must ship against.

### Releasing

```sh
git checkout -b release/vX.Y.Z <commit>   # cut from the exact commit to ship
# update CHANGELOG.md: move the [Unreleased] items into [X.Y.Z] with the
# date + a compatibility note (which dsh version this release tracks)
node scripts/release.mjs <major|minor|patch>
```

`scripts/release.mjs` refuses to run outside a `release/*` branch, bumps
`package.json`, runs the CI gates (through `scripts/run-gates.mjs` — direct
binaries, no pnpm store dependency), commits `chore: release vX.Y.Z`, then
pushes **the release branch and the `v*` tag** to origin. The
[Release workflow](../.github/workflows/release.yml) then publishes to npm
(`NODE_AUTH_TOKEN` — the same registry-token pattern the DeepSeek Harness
release workflow uses) and creates a GitHub Release. Before the first
public release, rotate the Feishu app secret (see `SECURITY.md`).
