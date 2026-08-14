# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Env-configurable routing options.** `FEISHU_GROUP_MENTION_MODE`,
  `FEISHU_ALLOWED_CHATS`, and `FEISHU_UNKNOWN_COMMAND` extend the
  config-wins/env-falls-back seam (`FEISHU_ALLOWED_USERS` already existed),
  so deployments can set routing policy without profile files; the
  test-only `FEISHU_MOCK_CHAT_STATS` (`'2u,1b'`) feeds member counts to the
  memory transport (solo-group relaxation path).
- **Scenario integration suite** (`tests/integration/scenarios.spec.ts`,
  20 real-process tests): daemon-restart session durability, group mention
  modes never/ambient/topic, chat allowlist, `/group` + `/repo`, every
  question-card variant (multi-select, free-text, cancel),
  group approval/question cards carrying the requester @-mention, message
  dedup, unknown-command passthrough, the stopped-turn reaction swap, and
  `/export` transcripts with tool rows. The suite uses its own dsh home
  (`_dev/dsh-home-scenarios`) so parallel test files never race the shared
  session map; CI prepares both profiles.
- **Two-stage reaction ack (Iteration 4).** An accepted turn message gets a
  received reaction (`GoGoGo` by default, botmux code) that is removed and
  swapped for `DONE` / `WARN` / `WARN` when the turn settles — configurable
  via `reactions.received/done/error/stopped` (set `received` to `''` to
  disable). `FeishuTransport` gains `addReaction`/`removeReaction`; the
  memory transport records `kind: 'reaction'` outbox entries. Best-effort:
  a failed reaction logs and never blocks the turn. (New scope
  `im:message.reaction` — see the permissions manifest below.)
- **`/history` — session log replay (Iteration 4).** The card sibling of
  `/export`: replays the chat's session log as in-chat cards from
  `ctx.sessionQuery.readSession` — a lark_md-safe transcript (headings →
  bold, quotes → italic) split across cards on line boundaries when long,
  so nothing is ever cut. `/history last <n>` replays an explicit subset.
  Read-only, allowed while a turn is running.
- **`allowedUsers` user allowlist (Iteration 4).** Restricts the surface to
  listed sender open ids (messages AND card buttons); unlisted users are
  ignored entirely. Config key `allowedUsers`, with a `FEISHU_ALLOWED_USERS`
  comma-separated env fallback for deployments/tests.
- **Proactive @-mentions in groups (Iteration 4).** The bridge remembers the
  last accepted sender per chat; group error notices, approval cards, and
  question cards carry an @-mention of that requester (`<at user_id>` in
  text, `<at id>` in card markdown). p2p chats and unknown requesters get
  no mention.
- **`/feishu-status` diagnostic card.** The status command is upgraded
  from a text reply to a diagnostic **card** (`📊 dsh-feishu status`): app
  id, live long-connection state (`✅ ready` / `⚠️ reconnecting` / `❌ error`
  tracked by the transport; `🧪 memory` for the test transport), session
  count, and last inbound activity. Read-only, allowed while a turn runs.

- **Scheduled reminders (dsh-schedule).** The bundle mounts
  `@deepseek-ai/dsh-schedule` (a cordis row, like tool-ask-user): the agent
  gains `schedule_create` / `schedule_delete` / `schedule_list` tools, so
  the user configures reminders in chat ("remind me in 5 minutes"). A fired
  reminder wakes the agent, whose turn the bridge now renders as a fresh
  `⏰ Reminder` card (agent-initiated turn: the surface opens a card when a
  card-less chat receives a plugin-sourced user message; resume never
  replays). `/schedule` (read-only) lists active reminders by folding the
  session log. Integration test covers the full loop: agent-created every +
  after reminders, the after firing to a Reminder card, and /schedule
  listing the active every.

- **Chinese documentation (`*.zh.md`, harness pattern).** Every user-facing
  doc now has a separate Chinese version — `README.zh.md`, and
  `docs/{ux-specification,feishu-setup,development,architecture,pitfalls}.zh.md`
  — following the DeepSeek Harness convention: the English files stay the
  canonical source and gain a top-of-file language link
  (`English | [中文](…zh.md)`); no UI/i18n work (per decision).
- **Release pipeline.** `scripts/release.mjs` (version bump → CI gates →
  tag) and `.github/workflows/release.yml` (tag-triggered npm publish via
  `NODE_AUTH_TOKEN` + GitHub Release), plus `examples/feishu-profile/` (a
  complete, copy-pasteable profile with the common options documented),
  `publishConfig.access: public` + npm `files` whitelist, and a `SECURITY.md`
  refresh (allowlists now real; rotate the app secret before any public
  release).

### Changed

- **README overhaul.** Rebuilt around the finalized positioning — *The Feishu
  UI for DeepSeek Harness (dsh)*: a "Why DSH-native" narrative (no bridge/no
  capture, full transparency, everything-is-a-card), a Mermaid surface-model
  diagram (dsh-base ← patch layer → browser surface (web) / Feishu surface
  (this)) with web-parity evidence (the same `ctx.permissionPresets` /
  `ctx.planMode` services), a verified section (installable via `dsh plugin
  add`, 346 unit + 47 real-process integration tests, CI never skips
  integration), a "See it work" wall with concrete selling points (the
  answer finalizes in place on the card — no second bubble; tap Allow once
  to continue; one QR scan creates + configures + publishes the app), a
  5-minute quickstart, a feature table, and Contributing/security links.
  Screenshot slots are placeholders awaiting real user-captured Feishu
  client screenshots (see `_dev/readme-briefing.md`); no test-rendered
  mockups and no broken image links.

### Removed

- **`/history` card replay (user decision).** The command duplicated
  `/export` (both ship the same session-log transcript), and printing a full
  history into cards was ugly. Session replay now has exactly one surface —
  the `/export` file message. The `buildHistoryCard` renderer,
  `toLarkCardMarkdown` / `splitTranscriptParts` helpers, and their tests are
  deleted; the restart-durability integration test now proves continuity via
  `/export` after the restart.

### Fixed

- **Question cards disable after answering** (user report): the card is
  replaced in place by a static `Answer: …` confirmation (no buttons —
  further taps do nothing), like the approval card's decided state.
- **`/export` surfaces the missing upload scope**: the Feishu upload fails
  with HTTP 400 when the app lacks `im:resource:upload` — the error now
  appends the exact scope hint (developer console → Permissions), and
  `docs/feishu-setup.md` documents the requirement.
- **Panel pagination never splits a category** (user report): `panelPages`
  packs whole category blocks — a category larger than the page size keeps
  its own page, and the boundary falls between categories. The system group
  (9 buttons) stays together on page 2 (the palette is 2 pages again).
- **`allowedUsers` with a defaulted-empty config served everyone**
  (regression found in the real process): schemastery materializes absent
  optional arrays as `[]`, which passed the "not undefined" gate and
  silently disabled the allowlist. The resolvers normalize `[]` to
  unrestricted; unit-tested in `tests/index.spec.ts`.


- **`/export` sends the session log as a file message.** The Feishu
  equivalent of the web's browser-download `/export` (whose command is a
  web-only download observer): the surface uploads a markdown transcript
  (`session-<id>.md`) built from `ctx.sessionQuery.readSession` via
  `im.v1.file.create` → `msg_type: 'file'`. `FeishuTransport` gains
  `sendFile`; the memory transport records `kind: 'file'` outbox entries.
  No truncation — the file is not bound by the card cap. (New scope
  `im:resource` — see the permissions manifest below.)
- **`ask_user_question` tool mounted (web parity).** The web surface
  exposes the standard `@deepseek-ai/dsh-tool-ask-user` tool through its
  standard/code agent presets; this bundle now inserts the same tool row
  into the profile composition, so the Feishu agent can ask the user
  questions — rendered as question cards by the surface's
  `userQuestions` provider (option buttons / multi-select / free-text).
- Real-process integration: `/export` produces a file outbox record whose
  transcript carries the turn's user message and assistant answer;
  `ask_user_question` posts a question card and an option tap feeds the
  answer back into the turn. Tests: 308 (was 299).

- **Feishu quick setup (botmux-style Open Platform automation).** One QR scan
  now creates/configures the app end to end: `pnpm run setup:feishu` drives
  the console over a reusable Web session (`src/setup/*`, entry
  `scripts/setup-feishu.mjs` + `dsh-feishu-setup` bin) — creates a
  企业自建应用, enables the bot, subscribes `im.message.receive_v1` +
  `card.action.trigger` in long-connection mode (read-back verified,
  fail-closed), grants the scopes listed in
  `src/setup/feishu-manifest.json` (currently `im:message`,
  `im:message:send_as_bot`, `im:chat`, `im:resource` — the single source of
  truth for the automation, the manual fallback, and the setup docs),
  publishes a "visible to me only" version (instant approval), and writes
  `appId`/`appSecret` into the profile's `cordis.patch.yml` (backed up).
  `--no-open-platform-auto` keeps the manual paste-credentials path; the
  credentials are validated against the Feishu API first. 34 unit tests cover
  the cookie jar, session file, QR helpers, payload builders, response
  extractors, the fail-closed verification, the profile writer, and the
  configure flow driven through a fake fetcher.

- **Agent workflow documentation.** `AGENTS.md` gains a "Worktree + PR
  workflow" section (work in a git worktree under `_dev/`, verify gates with
  `FEISHU_INT_REQUIRED=1`, rebase onto latest `origin/main`, merge only via a
  green PR); `docs/development.md` gains "Local toolchain" (the pnpm
  PATH/store/cache env block for this machine) and "Pull requests and CI"
  (the GitHub API calls for PR creation, CI monitoring, and merge using the
  PAT at `_dev/gh-token`).

- **Interactive approvals (Iteration 3).** `ctx.on('approval/request')`
  answers every approval with a Feishu card (tool + reason, ✅ Allow once /
  ❌ Reject) through the new shared `InteractionRegistry`
  (`src/cards/interactions.ts`): card callbacks settle
  `'allowed-once'` / `'rejected'`, signal abort or a 5-minute timeout
  settles `'cancelled'`, unknown-chat / card-send failure fails closed to
  `'unavailable'` (loud log). The decided card becomes a static no-button
  card, deferred out of the callback ACK. Feature-detected: absent service
  logs loudly.
- **Interactive questions (Iteration 3).**
  `ctx.userQuestions.registerProvider` answers questions with question
  cards: single-select answers on tap, multi-select toggles (card re-posts
  with checkmarks) + Submit, free-text (no options) captures the next chat
  message as the answer. Agent abort settles unanswered questions empty.
- **Real-approval integration tests.** A scripted sandbox-escalation bash
  call (`sandbox_permissions` + `justification`) raises a real
  `approval/request` in the real process; Allow grants the escalation and
  the turn completes, Reject fails the escalation and the turn still
  completes — both with the static decided card. Tests: 299 (was 275).


- **Integration-test expansion (19 real-composition tests).** New coverage:
  error turn → red card + ⚠️ notice and error→retry recovery; copy resends
  the answer and retry starts a fresh turn; the group mention gate on the
  real process (un-@ ignored, @-mention answered, via
  `FEISHU_MOCK_BOT_OPEN_ID`); two chats running turns concurrently without
  interference; the 5-native-table cap with fenced overflow (ErrCode 11310
  regression); very long output truncated to the newest tail with a marker;
  a slash-command surface batch (/help, /status, unknown fallback, typed
  /model, real harness /goal); panel palette pagination. The mock LLM
  server gains an `error` script chunk (HTTP 500, decided before the 200
  headers) and consumes each script exactly once.
- **Development-reflection docs.** `AGENTS.md` gains a "Lessons learned"
  section (structural service seams that mirror getters-vs-methods,
  web-only commands, state-aware buttons, the working-directory gate,
  test-side state hygiene); `docs/pitfalls.md` gains entries for the same
  plus the title-generation completion, message-id collisions, waitFor
  chatId filtering, and mock header-ordering traps. README status, the
  architecture command inventory, the development guide's integration
  description, and PLAN.md's status line are refreshed to the current
  surface (17 commands, card-carried final answer, working-directory gate).


- **Working-directory gate (user requirement).** A chat with no explicitly
  pinned working directory (/repo pick or /cd) is unavailable: turns are
  refused with guidance, no session/card is created, and the message is not
  remembered as a retry target. The deployment `defaultCwd` fallback is
  never an implicit choice — a fresh chat or new group must pick a repo
  before DSH works there (`requireWorkingDir`, default true). Read-only
  commands and the pickers stay usable; the panel surfaces the unpinned
  state. `/clear` keeps the pinned directory. `/resume` adopts the resumed
  session's cwd (the /sessions Resume button carries it; typed `/resume`
  looks it up from the session list) so a resumed session stays usable in
  the new chat.


- **`/model` now opens a model picker card** (user report: the button only
  passed through). The catalog comes from `ctx.llm` (`listProviders` ×
  `listModels`; the deepseek adapter ships a static default catalog, so no
  network), rendered as a `select_static` dropdown with the current model
  preselected (`initial_option`, paginated buttons beyond the option cap)
  and a `★ current` note. A pick sets the default for new sessions through
  `ctx.agentDefaultModel.saveSelection`; typed `/model <provider>/<model>`
  still sets directly. Without `ctx.llm` a bare `/model` degrades to the
  text display.
- **`/panel` command** (user report: the panel was unreachable before the
  first message). `/panel` opens the control panel card from any chat and
  is allowed while a turn runs. Its palette button is hidden — a palette
  button that opens the panel would be the panel launching itself
  (`SurfaceCommand.hiddenFromPanel`).


- **Panel palette grouping fix.** Category headers now render as their own
  blocks — `🧩 Session` header, then the session buttons, then `💬 Chat`,
  then the chat buttons — instead of all headers stacking before all
  buttons (user report: "two lines with nothing between them").
- **`/model` command (surface-native).** The web `/model` is a client-side
  popup contribution with no host command, so Feishu implements its own:
  `/model` shows the chat's model (`provider · model`, live agent options
  first, deployment default otherwise); `/model <provider>/<model>` sets
  the default for new sessions through `ctx.agentDefaultModel`. Read is
  allowed while a turn runs (the set never touches the running turn).


- **UX polish pass (visual + control language).** Streaming card: working
  header template `blue` → `wathet` (soft default blue), terminal status
  moved from a bold markdown line to a quiet `note` (header color already
  carries the semantic), and the button area split into two rows — state
  actions (Stop / Copy·Retry·Panel) then the row view toggle — so mobile
  never shows a wrapped 4-button row. Panel: the status line now carries
  the session context (`session `id` · `cwd``), the page indicator is a
  `note`, category headers get icons (`🧩 Session` / `💬 Chat` /
  `⚙️ System`), and the icon set is deduplicated (Resume ↩️, Fresh start ✨
  — 🔁 and 🧹 are no longer reused). `/sessions` rows are two lines (title
  · age · badges over `id` · cwd) with a note page indicator.
- **Permission picker is now a dropdown.** `/permission` renders a
  `select_static` (repo-picker pattern) listing every preset, with
  `initial_option` preselecting the current preset (omitted for a `custom`
  effective state) and a note spelling out `★ current`. Choosing applies
  through the callback's `option` field; the legacy button path still
  works. `SelectAction` gains the optional `initial_option` field.


- **Full command surface (Iteration 2 completion).** Fifteen surface
  commands, each sharing one handler between the slash line and the control
  panel palette button: `/help /status /cancel /cd /repo /group /sessions
  /resume /clear /new` plus the five dsh web command wrappers
  `/plan /goal /compact /feedback /permission` (thin handlers that ensure a
  session/agent and execute the harness command through `ctx.commands.execute`).
- **Panel command palette.** `buildPanelCard` now renders the full command
  set as buttons — grouped by category (session → chat → system), paginated
  (`PANEL_PAGE_SIZE = 8`) with page nav, command payload
  `{kind:'command', name}` — behind the unchanged core row (Stop/Retry/Copy).
- **Session lifecycle.** `/sessions` lists the persisted session corpus
  (`ctx.sessionQuery.listSessions()` + batch title folds) as a paginated
  picker card with per-row Resume buttons and a stale-callback guard;
  `/resume [<id>]` rebinds the chat to a saved session (refuses a running
  target, reports "already active", never replays history into the card);
  `/clear` and `/new` start a fresh conversation non-destructively — the
  previous session stays saved and resumable.
- **Working-state gate.** While a turn runs, only read-only commands run
  (`/help /status /sessions /cancel /group`); every mutating command is
  refused with an explanation (state-machine matrix rule, one place).
- **Stateful web wrappers.** A bare `/plan` (or its button) now **toggles**
  plan mode through `ctx.planMode` — pressing again leaves plan mode (user
  report: it only ever entered). `/permission` (or its button) opens a
  **preset picker card** from the real `ctx.permissionPresets` service —
  one Select button per preset, current marked — and a pick applies through
  `service.set` (user report: the button could not choose a preset). Typed
  forms (`/plan off`, `/plan <msg>`, `/permission <preset>`) still pass
  through; both degrade loudly to the harness behavior without the service.
- `executeDshCommand` now maps harness `success`/`error` kinds to surface
  `CommandResult` (error kinds surface as ⚠️) instead of swallowing errors.

### Changed

- The PR-merge snippet in `docs/development.md` now uses
  `merge_method: "rebase"` to keep `main` linear — a `"merge"` merge commit
  adds a second commit per PR even when the branch is fast-forwardable.
- **CI runs the real-composition integration suite.** The workflow builds
  the checkout before testing, prepares the `feishu-dev` profile with
  `dsh plugin ... add link:$GITHUB_WORKSPACE`, and runs tests with
  `FEISHU_INT_REQUIRED=1` so a missing prerequisite (dsh CLI, profile,
  build) fails the job loudly instead of silently skipping. The dsh CLI is
  now a devDependency (`@deepseek-ai/dsh`, lockfile-pinned) and the native
  build scripts it needs (node-pty, koffi, …) are allowed in
  `pnpm-workspace.yaml`. The suite needs no credentials: Feishu runs over
  the memory transport and the LLM is a local mock server.
- The full card state-machine matrix in `tests/bridge.spec.ts` is extended
  with the command and resume-session action classes; new unit suites cover
  the panel palette, the `/sessions` picker builder, and the
  `executeDshCommand` mapping.
- Real-composition integration now covers the session lifecycle chain
  (`/sessions` → resume by button → continue → `/clear`, with a no-replay
  check), the panel palette button end-to-end, and the real harness
  `/permission` through the wrapper.

### Removed

- `/export` is intentionally not surfaced: `dsh-session-log-export`
  registers a Web-only command observed by a browser download plugin; a
  native Feishu log export is a later iteration.


- Repository scaffold: bundle manifest (`dsh.bundle.patch`), `cordis.patch.yml`,
  strict TypeScript build, Biome lint/format, Vitest unit tests, CI workflow,
  English documentation set (README, AGENTS.md, CONTRIBUTING, SECURITY,
  docs/development.md), MIT license.
- Iteration-0 plugin entry (`src/index.ts`): mounts into a dsh profile,
  idles in not-configured mode until `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
  are supplied, and registers the `feishu-status` diagnostic slash command.
- Console log exporter (`src/console-exporter.ts`): routes structured
  `ctx.logger` records to the console, since dsh surfaces mount no console
  exporter by default (bridge operators need visible logs).
- **Core identity: DSH-native — born for dsh, not bridged to it** (README,
  AGENTS.md, docs/architecture.md).
- Iteration-1 private-chat loop:
  - `src/feishu/types.ts` — transport seam types (normalized message,
    transport contract, card JSON).
  - `src/transport.ts` — lark-oapi implementation: WS long connection
    (`WSClient` + `EventDispatcher`) receive, `message.create` / `message.patch`
    send/update, pure `normalizeMessageEvent`, `FeishuApiError`.
  - `src/message-dedup.ts` — bounded in-memory message-id dedup.
  - `src/session-map.ts` — durable chat ↔ session mapping (atomic writes).
  - `src/cards/render.ts` — pure session-event → card rendering, markdown
    escaping, tail truncation.
  - `src/cards/streaming.ts` — one card per turn: open, throttled/coalesced
    patches, terminal finalize.
  - `src/bridge.ts` — orchestrator: message → session → `agent.followup`;
    `session/event` → card patches; turn end → final answer as a fresh
    message (Feishu patches are silent and cannot notify).
  - `src/index.ts` — config (cwd, data dir, provider/model, card throttle),
    credential resolution, wiring, transport factory injection for tests.
  - docs/feishu-setup.md (app creation, scopes, long connection) and
    docs/architecture.md.
  - 59 unit tests across all modules.
- Iteration-1 hardening:
  - `src/memory-transport.ts` — file-channel in-memory transport behind the
    `FEISHU_TRANSPORT=memory` seam (integration tests and manual debugging:
    `inbox/` delivers messages, `outbox/` records every send/update).
  - Restart-safe session resolution in `src/bridge.ts`: live agent → resume
    the mapped persisted session → create fresh → rebind a fresh id when the
    mapped id collides with an on-disk log; agents always receive
    provider/model (config overrides or the deployment default selection).
  - Turn-failure logging: `turn/end` errors are logged with code + message.
  - **Real-composition integration test**
    (`tests/integration/real-composition.spec.ts`): a real dsh process
    booted from a real profile runs a real agent turn against a mock LLM
    server (`tests/integration/mock-llm-server.ts`), with Feishu swapped for
    the memory transport; asserts the full private-chat loop (card posted +
    patched, completion notice as a fresh message). Self-skips when
    prerequisites are missing.
  - 68 tests total (67 unit + 1 real-composition integration).
- Iteration-2 slice — streaming-card controls + minimal completion notice:
  - Card button callbacks (`card.action.trigger`) over the WS long
    connection: `normalizeCardAction` in the transport, routed by the bridge.
  - Streaming card carries a status button row: ⏹ Stop while working;
    📋 Copy / 🔁 Retry / ⚙️ Panel when done (Retry/Panel on error).
  - Control-panel card (`buildPanelCard`): a standing operation surface so
    actions do not require typing slash messages.
  - The final answer is kept in the finalized card; the fresh message is now
    a minimal completion notice (`✅ Done` / failure notice), removing the
    duplicate full-text bubble.
  - 81 tests total.
- Iteration-2 UX refinements:
  - Card layout switched to the v1 root-`elements` form (no `schema` field):
    schema-2.0 cards reject the interactive `action` tag (ErrCode 200861),
    so the button-capable v1 layout is used (the layout botmux uses).
  - A completed turn sends **no second bubble** — the card finalizes green in
    place and the initial card send already notified. Failure turns keep a
    `⚠️` notice.
  - docs/feishu-setup.md: card callbacks must be switched to long connection
    separately from events (card actions are callbacks, not events).
- Iteration-2 slice — configurable group mention gate:
  - `groupMentionMode` (`always` default / `never` / `ambient` / `topic`),
    botmux-compatible: `always` requires an @-mention but relaxes in
    1-person-1-bot solo groups (chat member counts via `im.v1.chat.get`,
    cached); `never` answers every message; `ambient` yields when a message
    redirects to another member; `topic` behaves like `always` until threads.
  - `allowedChats` chat allowlist (empty = serve all).
  - Transport resolves the bot's own open id (`bot/v3/info`) for mention
    matching; inbound messages carry mention open ids.
  - 90 tests total.
- Iteration-2 slice — surface command system:
  - Slash-line parsing + `CommandRegistry` (src/commands.ts): every command
    declares a panel category/button label, so the control panel can render
    the full command set as buttons (everything-is-a-card).
  - Built-in commands: `/help` (list), `/group <name>` (create a group with
    the sender via `im.v1.chat.create`), `/cancel` (stop the turn),
    `/status` (session info).
  - DSH passthrough: unknown slash lines execute against the dsh command
    registry when the chat has a live agent (`executeCommand` wired to
    `ctx.commands`); `unknownCommand` config (`error` default /
    `passthrough` to the model).
  - Commands never open a streaming card or consume a model turn.
  - 101 tests total.
- Iteration-2 slice — per-chat working directories:
  - Session map v2 persists a working directory per chat; sessions are
    created in the chat's pinned cwd (falling back to the deployment
    default) — p2p chats and groups can each target their own project.
  - `/cd <path>` validates and pins a chat's working directory (session
    rebinds so the next message starts fresh in the new dir, mirroring
    botmux /cd); `/repo` lists candidate projects under `repoRoots`.
  - `repoRoots` config; 105 tests total.
- Iteration-2 slice — botmux-style `/repo` (dropdown + recursive scan):
  - `buildRepoPickerCard` leads with a `select_static` dropdown placed
    directly inside an `action` container (botmux `repo_switch` pattern —
    Feishu silently drops form controls inside a `form`, but a select in an
    `action` renders and fires a callback with the chosen option in
    `action.option`); numbered buttons with pagination remain as fallback
    beyond the 50-option cap.
  - New `src/projects.ts` recursive scanner (botmux `project-scanner`
    semantics, async): depth-3 walk skipping dot-dirs and
    `node_modules`/`vendor`/`dist`, valid `.git` marker (dir with `HEAD` or
    gitfile), dedup by git common-dir and path, dir-count + wall-clock
    budgets with an `onBudgetExceeded` hook, linked-worktree listing.
    `GIT_CEILING_DIRECTORIES` bounds git discovery so a fake/partial `.git`
    inside the root cannot resolve to an ancestor repo (botmux latent bug).
  - `repo-pick` card action accepts the dropdown `option` (or the button
    `value.path` fallback); `CardAction` gains an optional `option` field.
  - Tests: `tests/projects.spec.ts` (depth cap, skips, gitfile marker,
    empty-`.git` rejection, multi-root dedup, budget trip) + updated
    render/bridge specs; 118 tests total.
- docs/pitfalls.md: field notes on Feishu card layout constraints (v1 vs
  schema 2.0, select-in-action, silent form drop, card-callback receive
  mode), sandbox env/proxy quirks, Gemini model gating, pnpm ≥ 10 settings,
  and the git-discovery scan-root trap.
- UX feedback round (real-device):
  - Final output renders markdown: `src/cards/markdown.ts` parses with
    markdown-it (botmux semantics) — headings become bold (lark_md has no
    heading syntax), fenced code stays fenced, `hr` becomes an `hr` element,
    tables fall back to source lines. Replaces the old `**`-collapsing
    escape that left raw markdown on the card.
  - Tool display rework: structured `ToolRecord` (name/status/args/result)
    replaces raw tool lines; card order is thinking → tools → final output
    at the bottom (process then result, feedback); reasoning deltas stream
    into a dimmed `💭` thinking block; a new `🔧 Tools` button opens a
    per-turn tool-details card (args + results kept per chat).
  - Repo picker consumed on pick: a successful selection patches the picker
    to a static confirmation (no actions) and a message-id guard rejects
    callbacks from superseded pickers (botmux stale-picker rule).
  - Dropdown labels disambiguate duplicate basenames with a path suffix
    relative to the common scan prefix (`repoOptionLabel`).
  - Adds `markdown-it` dependency; 131 tests total.
- UX feedback round 2 — DSH-web row layout + relative repo labels:
  - Live card renders a chronological sequence of one-line rows (think /
    tool, DSH web style: `Think · …`, `✅ Bash · ls -la`), no truncation,
    then the complete output at the bottom, then status + buttons.
  - `src/cards/tool-summary.ts` ports the harness's tool-call-model: per-
    variant titles and arg-derived summaries (bash → description/command,
    read → path, search → query, …), paths relativized to the session cwd.
  - Think rows show `Thinking…` while streaming, the first line once
    settled; every row has a ⋯ button opening a details card (think →
    full reasoning; tool → IN/OUT). The separate 🔧 Tools button is
    removed until the command palette is decided.
  - Rows render as v1 `column_set` rows (div lark_md + button) — the
    layout botmux proves in v1 cards; `CardElement` gains column_set /
    column / div.
  - Repo picker labels always show the repoRoot-relative path (not the
    bare basename — generic names like `source` need their parent path).
  - 133 tests total.
- UX feedback round 3 — think icon, code-block details, rows collapse:
  - Think rows lead with a cloud emoji (`☁️ Think · Thinking`) like the
    tool rows and always read `Thinking` (no first-line swap on settle).
  - Tool details: IN shows pretty-printed JSON in a `json` code block, OUT
    in a code block; think details render the full reasoning in a code
    block (`fencedCode` auto-lengthens the fence past embedded backticks).
  - Persistent rows toggle button (like Stop) on every card with rows:
    `▾ Collapse` → one minimal line (`think -> bash -> read -> …`),
    `▸ Expand` restores; works on live turns and finished cards (in-place
    re-render of the stored final snapshot via lastMessageId).
  - 138 tests total.
- UX feedback round 4 — collapsed default, untruncated details, card ACK:
  - Cards start collapsed (`think -> tool -> …` sequence line); ▸ Expand
    reveals full rows, per-chat explicit expansion is remembered.
  - The collapsed sequence streams: new think/tool rows append to the line
    as they arrive.
  - Details cards show the full args (pretty JSON) and result — the
    2000-char details truncation and the 300-char store truncation are
    both removed (a details view must not truncate).
  - `card.action.trigger` returns `{}` (valid ACK, no UI update) instead
    of `undefined` — botmux's lesson: undefined yields a code-only ACK
    the Feishu client rejects as invalid, letting it re-render the card
    to a stale state (the 'card reverted to Stop after opening details'
    bug).
  - 142 tests total.
- UX feedback round 5 — no truncation, card state machine, spec + automation:
  - Collapsed sequence shows the full `think -> bash -> …` chain — the
    12-entry cap and ellipsis are removed (no truncation without user
    confirmation, per directive).
  - Card state machine fixed (botmux rule): toggle-rows defers its card
    patch out of the callback; row-details re-asserts the streaming card
    so Lark's callback-completion restore cannot collapse or stale it.
    Explicit unit tests cover expand → details → still expanded → collapse.
  - docs/ux-specification.md: per-part UX specification derived from DSH
    web and botmux, incl. the no-truncation rule, the card-action ACK
    contract (never return `undefined` — the invalid-ACK bug), and an
    acceptance checklist.
  - Automation: memory transport `actions/` channel + scripted mock LLM
    (reasoning + tool-call SSE) + a real-composition integration test that
    drives the full UX state machine against a real spawned dsh process —
    no Feishu app, no manual screenshots.
  - 145 tests total.
- UX audit round — state-aware controls + full interaction matrix:
  - Stop is now state-aware: running → cancel + `⏹ Stopping…`; idle →
    `No active turn to stop — the last turn already finished.` (the
    user-reported hang: done → panel → Stop current → "Stopping…" then
    nothing — agent.cancel on an idle agent is a documented no-op);
    no session → restart hint.
  - Panel shows the Stop button only while a turn is running; the status
    line reflects Running / Ready / Idle.
  - Copy/retry with nothing to act on explain instead of silently no-op.
  - Unknown card actions are logged and ignored without crashing.
  - Lifecycle: a second message during a running turn opens a fresh card;
    stop mid-turn then a new message recovers.
  - Tests: card-action interaction matrix (idle stop, empty copy/retry,
    running vs idle panel, unknown kind, no-session panel, mid-turn
    second message, stop-then-recover) + integration assertion that a
    stop on a finished real turn yields the explanation and never
    "Stopping…". 155 unit + 2 real-composition integration tests.
- Integration coverage for the card-action interaction matrix (user
  directive: abnormal operations belong in integration tests, not just
  unit tests with a fake agent):
  - mock LLM server supports holdNextResponse()/release() to keep the
    real agent running while the test drives card actions.
  - real-composition test asserts against the real dsh process: running
    panel shows Stop; running stop cancels + '⏹ Stopping…'; idle stop
    explains and never emits a second 'Stopping…'; empty copy / empty
    retry explain.
  - 156 tests total (unit + 3 real-composition integration).
- State-machine refactor (replaces ad-hoc per-action card patches — the
  user's directive: design the machine once, not patch with if/else):
  - One authoritative `ChatCardState` per chat (title/content/rows/
    openThinkId/status/collapsed); the bridge renders the card from it and
    nothing else. Five parallel maps (`turns`, `lastRows`,
    `lastSnapshots`, `collapsedRows`, …) consolidated into one.
  - `syncCard` is the single render path: live cards patch through the
    streaming manager; finished cards re-patch in place, deferred out of
    the callback (botmux rule) so Lark cannot restore the pre-click card.
    Every card action (panel/stop/retry/copy/row-details/toggle) ends with
    it — no more per-case reasserts, so "done → panel → card reverts to
    working" cannot recur.
  - docs/ux-specification.md §1.2 documents the machine (states,
    transitions, collapsed, syncCard contract).
  - Regression tests at both layers: unit (panel after done keeps the
    green card, no Stop) and real-composition integration (same scenario
    against the real dsh process). 158 tests total.
- Full card state machine matrix (user directive: exhaustively test the
  machine, not spot-check): every (state, action) cell of
  none/working/done/error × stop/copy/retry/panel/toggle-rows/row-details,
  plus cross-turn integrity (done → new message → working → second done)
  and error → retry → working → done recovery. The single syncCard render
  path is the invariant under test. 170 tests total (unit + 4 real-
  composition integration).
- GFM tables render as native Feishu `table` elements (botmux
  `buildTableFromTokens` port): the converter no longer falls back to raw
  pipe source lines. Root-level `table` is supported by the v1 card
  layout; lark_md cells keep inline code and bold. Regression tests at
  both layers (unit with the reported table shape; real-composition with
  a scripted table response). AGENTS.md makes "every user-reported fix
  adds a regression test" explicit. 172 tests total.
- '目标回调服务未在线' during streaming fixed: the log pinned ErrCode
  11310 'card table number over limit' — Feishu caps native table
  elements at five per card, so a patch with more was rejected with a
  400. Native tables are now capped at 5 per card; any table beyond that
  degrades to a fenced code block (content preserved, patch never fails).
  StreamingCardManager.flush also logs a failed patch and continues with
  the newest snapshot instead of killing the stream. Regression tests at
  both layers. 174 tests total.
- Stopped status for aborted turns: `turn/end` reason `aborted` (user
  Stop) now finalizes the card as **stopped** (orange, `**⏹ Stopped**`),
  distinct from done — a stopped turn never reads Done (DSH web
  message.stopped). Panel reflects the stopped state. Unit regression
  test; the aborted→stopped mapping is unit-proven. 175 tests total.
- The standalone '⏹ Stopping…' text bubble under the streaming card is
  removed (user report: unnecessary — the card is the feedback surface).
  Stop now marks the card's stopRequested state: the card shows
  '**⏹ Stopping…**' while the abort converges, then settles to the
  orange '**⏹ Stopped**' terminal state on turn/end(aborted). Also fixed
  a latent bug: turn/end now stages the terminal snapshot before
  finalize (finalize only renders when a pending snapshot exists, so a
  flushed working card kept its stale render). 175 tests total.
