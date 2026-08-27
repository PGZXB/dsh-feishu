# Development Pitfalls

English | [中文](pitfalls.zh.md)

Field notes from building this plugin — the traps that cost real hours.
Each entry states the symptom, the root cause, and the fix. Keep this page
updated when you hit something new.

## Feishu card layout constraints

The interactive-card wire format is the least forgiving part of this
integration. The rules below were verified on real devices (a Feishu app in
the sandbox) and are the reason several card designs were reworked.

- **Use the v1 layout: root-level `elements`, no `schema` field.** A
  `schema: '2.0'` card rejects the interactive `action` tag with
  `ErrCode 200861` ("unknown property `elements`" when the body shape is
  wrong). Only the v1 root-`elements` layout accepts `action` buttons. All
  control cards (status buttons, panel, repo picker) use it. botmux's
  control cards use the same layout.
- **`form`, `select_static`, and `input` are silently dropped inside a
  `form` container** in this layout — the card renders without them and
  without an error, which makes the bug invisible. `select_static` **does**
  work when placed directly inside an `action` container: choosing an
  option fires a card callback whose `option` field carries the selected
  value, and the select's own `value` field carries the action marker
  (botmux pattern: `value: { key: 'repo_switch' }`). The repo picker uses
  this for its dropdown.
- **Card callbacks are a separate receive mode from events.** The bot must
  switch both "events" and "card callbacks" to the long-connection receive
  mode in the Feishu console; otherwise buttons return
  "该应用尚未配置卡片回调". See `docs/feishu-setup.md`.
- **`message.patch` is silent** (no unread indicator), which is exactly
  right for a live streaming card. One card per turn: posted when the turn
  starts (that send notifies), patched as output arrives, and **finalized in
  place** — a completed or stopped turn sends no second bubble.
- **Card size cap ≈ 109 KB** — long outputs are tail-truncated before
  render (`MAX_CARD_CHARS`).
- **`lark_md` has no reliable escape syntax** — `**` is collapsed to `*`
  in untrusted text rather than escaped.

## Environment and proxy quirks (sandbox)

The harness sandbox (and this checkout's environment) has specific rules:

- **`HTTPS_PROXY`/`HTTP_PROXY` break axios**, which lark-oapi uses: TLS
  handshakes fail (`ERR_TLS_CERT_ALTNAME_INVALID` or connect failures)
  because axios does not honor the env vars without an agent. Unset them
  when running the bot (`unset https_proxy HTTPS_PROXY http_proxy HTTP_PROXY
  ALL_PROXY all_proxy`).
- **Node's built-in fetch honors the proxy only with `NODE_USE_ENV_PROXY=1`;**
  undici-based clients (modlens's bundled undici) ignore env proxy entirely
  and fail with `fetch failed`. The preload shim
  `_dev/proxy-preload.cjs` installs `EnvHttpProxyAgent` as the global
  dispatcher; load it via `NODE_OPTIONS='-r …/proxy-preload.cjs'`.
- **Direct egress to some LLM providers is blocked** — the proxy is
  required for them; the preload above is what makes those providers work.
- **`~/.dsh`, `~/.npm` (and other tools' own state dirs) are read-only
  mounts** unless the shell has `danger-full-access`. All dev state lives under the repo's
  `_dev/` (home dir, bin, corepack, dsh-home).
- **An ambient `DSH_HOME` exported by the harness points at its own home** —
  integration tests must point at their own `FEISHU_INT_DSH_HOME` (or
  `_dev/dsh-home`), never the ambient value.
- **`kill $!` kills the bash wrapper, not the child** — `nohup` children
  survive and pile up concurrent dsh processes (a corrupt-session
  incident, and a "cards update chaotically" incident: N bot processes all
  connected to the same Feishu app, each with its own in-memory panel
  state, overwriting each other's cards). The actual process is
  `node …/dsh/lib/bin.js --profile <name>` — `pkill -f "dsh --profile …"`
  does NOT match it (the `node` prefix). Kill by the real command line and
  VERIFY exactly one process remains:

  ```sh
  pkill -f "bin.js --profile feishu-d[e]v"   # the [e] guards against self-match
  sleep 2
  ps aux | grep "bin.js --profile" | grep -v grep   # expect exactly one (or zero)
  ```

  Before/after any restart, always count the bot processes — a stray
  second bot is the first suspect when cards misbehave.
- **Debug tracing needs `FEISHU_DEBUG=1` AND the exporter's `levels`.** The
  console exporter filters debug records unless `process.env.FEISHU_DEBUG`
  is `1`, and cordis further skips records above the exporter's `levels`
  threshold — set `levels: { default: 3 }` on the exporter so debug
  (level 3) reaches it. Debug lines then trace a message/card/session
  through the whole pipeline (see `docs/development.md` → "Debug
  logging"): panel lines show exactly which card each action targets
  (`panel action <kind> on card <messageId>` → `panel update card
  <messageId>`), the tool for diagnosing "which card updated" questions.
  The logger interfaces every module receives (`StreamingLogger`,
  `InteractionLogger`, `TransportLogger`, the panel context logger) all
  expose `debug`; a NEW module that logs must accept a logger with
  `debug` and use it for tracing — production stays quiet without the env
  var.

## Feishu SDK (lark-oapi) and Open Platform API

- **The SDK's default axios instance honors `http(s)_proxy` env vars.**
  Behind a proxy, WS endpoint discovery and REST calls crash with
  follow-redirects `Protocol "https:" not supported. Expected "http:"`.
  Inject a shared `proxy: false` axios instance into both `Client` and
  `WSClient` (the `FEISHU_HTTP` instance).
- **A custom `httpInstance` must mirror the SDK default's response
  interceptor.** The default unwraps `resp.data`; without it, `request()`
  resolves to the AxiosResponse wrapper and the SDK's `{code, data:{URL},
  msg}` destructure comes back undefined (`code: undefined`). Mirror the
  unwrap and the `$return_headers` passthrough.
- **QR login init requires `x-locale` and `x-terminal-type` headers.**
  `POST accounts.feishu.cn/accounts/qrlogin/init` without them fails with
  4401 "请求无效" — a body like `{"unit":"eu_nc"}` is a red herring. Send
  `x-locale: zh-CN` + `x-terminal-type: 2`.

## Gemini / modlens

- New keys use the new API-key format (`AQ.…`). Older model names can be
  gated for new users (404) or 503 under load — treat the concrete model
  name as environment-dependent; modlens keeps its provider config under
  its own state directory and needs the undici proxy preload (above) to
  reach providers that require a proxy.

## pnpm

- pnpm ≥ 10 reads settings from `pnpm-workspace.yaml`, **not** `.npmrc`.
  `minimumReleaseAge` can quarantine a freshly released harness package and
  silently install an older one — the workspace keeps an
  `minimumReleaseAgeExclude` list (currently `@deepseek-ai/*` + schemastery);
  add a package there when a new release is needed immediately.
- **pnpm ≥ 11 blocks dependency build scripts by default.** A profile
  `dsh plugin add @dsh-feishu/dsh-feishu` fails with
  `ERR_PNPM_IGNORED_BUILDS` (the lark SDK's `protobufjs` postinstall) unless
  the build is approved. pnpm 11 ignores `pnpm.*` fields in package.json
  entirely — the only fixes are `pnpm add --allow-build=protobufjs` (dsh
  forwards the flag) or an `allowBuilds` entry in the profile's
  `pnpm-workspace.yaml`.
- The default store directory sits on a read-only fs — pin `store-dir`
  under the repo (`_dev/pnpm-store`).
- **pnpm ≥ 11 defaults `minimumReleaseAge` to 1440 minutes (24 h).** A
  freshly generated lockfile can contain transitive deps published within
  the last day; pnpm ≥ 11 then refuses the whole install with
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`. Set `minimumReleaseAge: 0`
  explicitly in `pnpm-workspace.yaml` (the `allowBuilds` allowlist — the
  supply-chain control — stays).
- **`pnpm run <script> -- <args>` forwards the `--` verbatim on pnpm ≥ 11.**
  The script receives `-- --new …` and rejects `--` as an unknown option.
  CLI arg parsers must skip a leading `--` run-argument separator.
- **Harness `@deepseek-ai/*` packages must be `peerDependencies`, never
  `dependencies`.** Listing a harness core package (e.g. `dsh-tools`,
  `dsh-llm`, `dsh-storage` ×3, `dsh-workspace`) in `dependencies` makes pnpm
  place a REAL physical copy in the profile's `node_modules`, shadowing the
  dsh host's flat symlink fallback — the same package loads twice in one
  process. Module-identity state keyed by a module-local Symbol (the
  `dsh-tools` tool-runtime scheduler) mismatches between the two copies, so a
  tool call crashes with
  `Cannot read properties of undefined (reading 'prepare')`, and the
  interrupted turn leaves a dangling `tool_calls` that the provider rejects as
  `INVALID_REQUEST` on the next request. Text-only replies work; any reply
  that calls a tool fails. Fix: move the harness package to
  `peerDependencies` so the host supplies one instance (the dsh-TUI surface
  keeps every `@deepseek-ai/*` package out of `dependencies`, including
  `@deepseek-ai/schemastery`). Guarded by the `check-conventions.mjs`
  "@deepseek-ai packages are peerDependencies" check.

## Mention gate

- The mention gate is **bot-side**: Feishu delivers group messages to the
  bot regardless of mentions; the bot decides whether to respond.
  `groupMentionMode: always` (default) is botmux-compatible
  (always/never/ambient/topic). In 1-person-1-bot solo groups the `@`
  requirement is relaxed (`isSoloGroup`).
- `allowedChats` is an allowlist; chats outside it are ignored entirely.
- **`bot/v3/info` nests the bot's own open id under `bot.open_id`, not
  `data.open_id`.** The mention gate compares each inbound group message's
  mention list against `transport.getBotOpenId()`; if that id is never
  resolved, `mentioned` is always false and every group message (even a
  real `@`) reads as "not mentioned" under `always`/`topic` — the bot
  silently ignores all group traffic. Symptom: "ignoring group message: bot
  not mentioned" while the user did `@` the bot, with no error anywhere.
  Fix: parse both shapes (`parseBotOpenId`), and warn loudly at boot when
  the response carries no open id instead of failing silently. Verify the
  live shape with the real app — the SDK's `request` returns the raw body
  with `bot` at the top level.

## Git discovery vs. scan roots

- A `.git` marker that is fake or partial (a directory without a real
  object store, or a gitfile pointing nowhere) makes git **walk up the
  tree** looking for the nearest real repository. When the scan root is
  inside a real repo (e.g. `_dev` under the plugin repo, or `~` under a
  repo), `git rev-parse --git-common-dir` from a candidate dir can resolve
  to an *ancestor* repo, silently collapsing the whole scan into one bogus
  project. Fix: pass `GIT_CEILING_DIRECTORIES=<scan root>` on every git
  subprocess so discovery cannot escape the root (see
  `src/projects.ts`). botmux has this latent bug; its scan roots are real
  repos so it never trips it.

## Reference

- Card/layout patterns: botmux `src/im/lark/card-builder.ts` (select-in-
  action), `card-handler.ts` (callback normalization), `project-scanner.ts`
  (recursive scan semantics). Future slash-command UI/UX should be checked
  against botmux first — it has already solved most Feishu card UX problems.

## Web-only harness commands

- Some dsh commands exist only on the web client, not in the host command
  registry. `/export` (`dsh-session-log-export`) is a browser-download
  observer ("Register the Web-only `/export` command that the browser
  download plugin observes") — nothing downloads on a non-web surface.
  `/model` (`ui-model-selection`) registers on `commandUi` as a
  `popupSelect` client contribution with no host command. Check the harness
  source for "Web-only" before promising a command; implement a
  surface-native equivalent (`/model` reads `ctx.llm.listProviders` ×
  `listModels` and `ctx.agentDefaultModel`).

## Compaction is not a turn

- `/compact` runs a durable transaction — `compaction/start → summary →
  end` — and emits NO `turn/end`. A surface that only finalizes its card on
  `turn/end` leaves the chat "working" forever: every later command is
  refused with "a turn is running — stop it first." (user report). Own the
  compaction card lifecycle instead: open on `compaction/start` (immediate
  button feedback), render `compaction/summary`, and finalize on
  `compaction/end` — which the seam emits on success AND failure (a failed
  close carries `error`). The checkpoint `user/message` (plugin source
  `compact`) is a surface-replacement marker, not a turn start.

## Service seams: getters vs methods

- A structural `ctx.get(name)` seam must mirror the REAL service shape.
  `ctx.permissionPresets.names` is a **property getter** (write `names`,
  not `names()`); `current(events)` folds the session's events and
  `set(session, name)` writes the session's knobs — passing the Agent
  instead of `agent.session.events` fails at runtime with
  "events is not iterable". `ctx.planMode.get(agent)` / `set(agent,
  active)` take the Agent. Read the installed `.d.ts` before writing the
  seam; wrong shapes typecheck cleanly.

## Buttons must be state-aware, not pass-throughs

- A panel button whose handler runs the bare command is broken for commands
  with a choice/toggle dimension: `/permission` with no args only REPORTS
  the current preset, `/plan` with no args only ENTERS plan mode, `/model`
  with no args only displays. Fix: `/permission` and `/model` open picker
  cards (a `select_static` dropdown inside an `action` container, with
  `initial_option` preselecting the current value — supported by the SDK;
  omit it when the effective state is `custom`/unknown); bare `/plan`
  toggles through `ctx.planMode` (read `get`, write `set(!active)`).
- A palette button that opens the panel itself is the panel launching
  itself — hide it (`SurfaceCommand.hiddenFromPanel`).

## Working-directory gate

- The surface refuses turns in a chat with no pinned working directory
  (/repo or /cd); `defaultCwd` is a fallback, never an implicit choice.
  New chat-state flows must respect it: `/resume` adopts the resumed
  session's cwd (the session detail's Resume button carries it in its
  value; a typed `/resume` looks it up from the session list), or the
  resumed chat
  is stuck behind the gate.

## Integration-test traps

- The integration suite shares the real profile (`_dev/dsh-home`). A test
  that writes state through the surface (`/model` → `saveSelection` writes
  `settings.yaml`) must restore the original value, or later runs and the
  real bot inherit the change.
- Every new session fires a **title-generation completion** ("Create a
  concise title for an AI coding…"). Never assert an exact LLM completion
  count; assert card contents.
- **After `holdNextResponse()`, await `waitForHold()` before driving a
  stop/panel action.** The working card appears as soon as the turn starts,
  but the agent's LLM request is established asynchronously (buildRequest →
  resolveApiKey → fetch). A stop issued before the request reaches the mock
  (and its abort signal binds to the in-flight body) cancels nothing and the
  turn completes normally — no stopped card / ERROR reaction, a timeout on
  slow or loaded CI runners. `waitForHold()` resolves when the held request
  is actually in flight, making the abort deterministic.
- Message ids built from `Date.now()` collide when two messages are written
  in the same millisecond (and the surface's dedup silently drops the
  second). Append a random suffix. waitFor predicates that match ANY chat's
  reply pass early on a prior chat's text — filter by `r.chatId`.
- A mock that answers a scripted error must decide the status BEFORE
  writing the 200 headers — `writeHead(500)` after `writeHead(200)` throws
  "headers already sent" and hangs the adapter on an open body.
- Each mock completion request must consume the script exactly once —
  consuming in both the error check and the stream writer doubles
  consumption and silently shifts every subsequent scripted response.
- **The integration suites run the BUILT `lib/`, not `src/`.** A change to
  `src/` does not reach the spawned process until `pnpm run build`; a
  "works locally, fails in integration" symptom is usually a stale lib
  (the real-process `/model` case: the command was "Unknown" until the
  rebuild landed).
- **Two real-process suites must not share a dsh home.** vitest runs test
  files in parallel; both suites boot dsh children that persist the session
  map + logs, and concurrent writes race (a pinned `/cd` is lost, turns get
  refused). The scenario suite uses its own `_dev/dsh-home-scenarios`
  (`FEISHU_INT_SCENARIOS_DSH_HOME`), and CI prepares both profiles.
- **Schemastery materializes absent optional arrays as `[]`.** A config
  key declared `z.array(z.string()).required(false)` reads as `[]`, not
  `undefined` — gate logic that checks `config.x !== undefined` then treats
  an empty list as "no restriction" is silently ALWAYS off. The
  allowlist resolvers (`resolveAllowedUsers` & friends) normalize
  `[]` → `undefined`; regression-tested in `tests/index.spec.ts`.
- **Assert card-markdown content, not `JSON.stringify`d cards.** A mention
  in a card renders as `<at id="ou_x"></at>`; `JSON.stringify(card.elements)`
  escapes the quotes to `\"`, so `.includes('<at id="ou_x"></at>')` never
  matches. Read the `markdown` element's `content` field instead.
- **The `ask_user_question` tool schema is snake_case.** The wire argument
  is `multi_select` (not `multiSelect`); camelCase is silently dropped by
  the tool schema and the question arrives single-select.
- **Toggle re-posts retarget the interaction to the newest card.** After a
  multi-select toggle, the Submit action must carry the NEWEST question
  card's message id — the original card id is stale and the registry
  rejects it (the turn then hangs on an unanswered question).

## Commit hygiene: local "green" vs CI green

- `pnpm run lint` runs `biome check src tests` — the exact CI command.
  `biome check --write` (the local convenience) applies only SAFE fixes;
  unsafe diagnostics (`lint/style/useTemplate`, `lint/complexity/useIndexOf`)
  stay in the tree and make plain `check` fail. If local work used
  `--write`, still run `pnpm run lint` and check the exit code before
  committing — a CI failure shipped here because the final gate only read
  the last output line (`Found 3 infos.`) instead of the exit status.
- Rule: before every commit, run `pnpm run lint`, `pnpm run typecheck`,
  `pnpm run test`, `pnpm run build` and confirm each exits 0 — never trust
  an output tail or a `--write` run as the lint verdict.
