# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Working-directory cards carry an agent Mode dropdown (agent preset
  selection).** Each working-directory choice that creates a fresh session
  (`/repo` pick or `/cd`) can select the agent preset that session is composed
  from. The repo picker card and the `/cd` input card render a **Mode**
  `select_static` (loaded from the host `agentPresets` roster) whose change
  stores the chat's chosen preset; an untouched Mode omits the preset
  (deployment default). A chosen preset is **recorded** as `meta.agentPreset`
  AND **composed** by calling `AgentPresets.mount(agentCtx, id)` in the
  agent-factory `setup` (create and resume alike — the runtime records the id
  on the session header but does not apply it, so the surface mounts it).
  `/cd <path> --preset <id>` also binds a preset. The preset binds ONLY to the
  NEW session (created on remint) — existing/resumed sessions keep their
  durable preset. When the roster service is absent, no Mode dropdown renders
  and the flow is unchanged. See `docs/ux-specification.md` →
  "Part: agent-preset-selection".

### Fixed

- **Message-queue: queued non-steer messages open their streaming card.** A
  message arriving while a turn runs was appended to the agent inbox's
  `nextTurn` list, which the agent loop auto-claims at its own step boundary —
  bypassing `deliverTurn`, so the user saw the "Sent" marker on the queue card
  but no streaming card with the agent's work. Queued non-steer messages now
  live in the SURFACE's own in-memory queue (never `inbox.nextTurn`); after the
  owning turn ends (`turn/end`) the surface drains it, delivering each queued
  message as its own turn (`beginTurn` → `followup`), which opens its streaming
  card exactly like a freshly arrived message, and marks the item card `sent`.
  Steer still routes via `agent.steer` (the next-step boundary, never the
  `nextTurn` list). Trade-off: the in-memory queue is not persisted, so a
  restart drops queued messages (the inbox no longer holds non-steer queued
  messages). See `docs/ux-specification.md` → "Part: message-queue".
- **`/model` shows the session-switched model immediately (not the stale static
  one).** After a `/model` pick/typed switch, the model picker's current
  preselection and the no-catalog `/model` text display read the live agent's
  static `options` (never mutated by the switch) instead of the session-switched
  selection, so they showed the pre-switch model. Both now prefer the
  session-switched `ref.current` (dsh web parity), falling back to `agent.options`
  then the deployment default. See `docs/ux-specification.md` →
  "Part: model-switch-current".
- **Panel: each typed command opens a fresh, independent card (never reuses an
  earlier one), and a standalone card shows no Back / stays on its result.** A
  typed slash command used to "pilot" the chat's latest panel card (push onto
  its stack), so a second `/model` refreshed the first card and `/repo`
  `/resume` turned the same card into a different view; panel sub-views always
  rendered `⬅ Back`; and a completed pick/command always jumped back to the
  panel menu. Now a typed command opens its OWN fresh card (independent state
  machine); the `⬅ Back` button is appended centrally only when the card's
  stack can return (a typed-command card — depth one — shows none); a completed
  action on a standalone card stays on its result (no jump to the menu); and a
  bare `/cd` opens the same text-input card as the panel's "Change dir" button.
  See `docs/ux-specification.md` → "Part: surface panel".

### Added

- **Session stats line + context occupancy on the terminal streaming card.**
  After a turn ends, the card renders a compact `|`-separated line of exact
  counted session figures — turns · steps · tools, input/output tokens +
  cache-hit % — plus a context-occupancy percent (used tokens vs the model's
  context window). Mirror of the DSH web `StatsLine` for the exact-counted
  fields (no timing: the host cannot see the web's `node.timing`, so duration/
  TTFT/tok/s are intentionally omitted). The controller folds
  `turn/start`/`assistant/message`/`tool/call` events into a session-scoped
  accumulator (survives per-turn card re-creation) and renders the line only
  on the terminal card.
- **Message queue: turn messages no longer interrupt a running turn.** When a
  user message arrives while a turn is running, it is appended to the agent
  inbox's next-turn queue (never `deliverTurn`) and surfaced on its OWN
  dedicated card — one card per queued message, one lifecycle state machine
  per card (`queued / editing / steering / steered / sent / removed`). The
  shared "N queued" card and its recall/re-post single-card invariant are gone:
  each card is updated in place (`updateCard`) as its state changes, terminal
  cards (steered/sent/removed) are retained showing their status marker, and
  nothing is ever recalled. A steered message marks its card "💬 Steering…",
  then the next `user/message` event flips it to "✅ Steered"; the streaming
  trace adds a `steer` row (collapsed = "steer", expanded = the full steered
  text) so the user sees where their steered message was injected. The edit
  form uses the verified no-`default_value` input shape (the prior per-item
  `default_value` form produced a Feishu 400). When the agent has no inbox the
  message degrades to a normal turn. See `docs/ux-specification.md` →
  "Part: message-queue".

- **`dsh-version-track` infra: a structured A/B source of truth + a
  diagnosis/adaptation skill.** `dsh-version.json` (repo root) records the
  dsh versions the repo tracks — `dsh.stable` (A) = the dsh `@latest` the
  stable release tracks, `dsh.next` (B) = the dsh `@next` `main` tracks —
  plus `dshFeishu.npmLatest` and `lastAdapted` provenance. The README Notes
  are regenerated from it (`scripts/render-version-note.mjs`) and `pnpm run
  check` (`checkVersionTrack()`) fails if they drift. The `dsh-version-track`
  skill (`.dsh/skills/dsh-version-track/`) diagnoses the canary /
  release-compat runs, adapts the code on a red run or refreshes a label on a
  green one, and lands as a worktree PR (merge and npm publish stay
  human-gated). See `docs/development.md` → "Version tracks".

### Changed

- **`/model` now switches the current session's model immediately (and sets
  the default).** Previously `/model` only wrote the deployment default via
  `agentDefaultModel.saveSelection`, so a model chosen in a chat applied only
  to NEW sessions — the current chat kept its old model until restarted. Now,
  after saving the default, the surface couples a mutable model selection to
  the live agent's scoped context (`installModelSelection`, the same mechanism
  dsh-host-apiproxy uses for dsh web) so the NEXT turn in the current session
  uses the picked provider/model. Both the typed `/model` and the picker pick
  do this. The reply now reads "Model set to … (this session + default)". This
  is a deliberate runtime import from `@deepseek-ai/dsh-agent` (an exception to
  the repo's "type-only `@deepseek-ai/*` imports" convention), with the package
  moved to `dependencies`. Includes `src/model-switch.ts` (per-session
  selection coupling + caching) and a unit test.

- **dsh family bumped to `0.1.1-rc.2`.** `@deepseek-ai/dsh` is pinned exactly in
  devDependencies; the rest of the `@deepseek-ai/*` surface moves to
  `^0.1.1-rc.2` (dev, peer, AND runtime deps), and the new harness peer
  packages `@deepseek-ai/dsh-invariants`, `dsh-scope`, and `dsh-timeout` are
  declared. This resolves the `sessionPersistence.prepare` undefined break that
  was reddening the Canary (main vs dsh@next): `@next` is now `0.1.1-rc.2`,
  which both the `main` track (B, adapted) and the stable release track (A, via
  the green release-compat run) are verified against. `dsh-version.json` A/B
  and the README Notes are refreshed to `0.1.1-rc.2`, and the version-track
  README-sync helper now handles wrapped (multi-line) blockquote Notes.

- **More E2E smoke scenarios for the real-client suite.** The E2E suite
  now covers the local-resolving surface commands (no LLM round-trip), each
  in its own backend group that is disbanded afterwards: `/status`,
  `/feishu-status` (the real long-connection check), `/schedule` (no-session
  notice), `/panel` (control-panel card + a button that resolves to the
  stop-turn command), `/repo` (project picker card) and bare `/model` (model
  picker card). Added shared scenario scaffolding (`e2e/helpers/scenario.ts`)
  and helpers `waitForCardContaining` / `clickCardButton`. See
  `docs/e2e-testing.md` → "Scenarios".

- **dsh family bumped to `0.1.0-rc.8`.** `@deepseek-ai/dsh` is pinned
  exactly in devDependencies; the rest of the `@deepseek-ai/*` surface
  moves to `^0.1.0-rc.8` (dev, peer, AND runtime deps — the runtime
  dsh-llm/storage/workspace were missed in the earlier bump, leaving a
  mixed rc.7/rc.8 tree that broke tool execution). Compatible with dsh
  `0.1.0-rc.8` (`@next`); the stable `0.2.1` release line tracks dsh
  `0.1.0-rc.7` (`@latest`). `commands.execute` gained an `images`
  parameter in rc.8; the surface passes an empty array.

- **`send_file` now announces with a short text line instead of a receipt
  card.** The tool posts the `description` verbatim (or `Sending <name>:` when
  no description is given) immediately before the native image/file message,
  and no longer posts a `📤 Sent` receipt card — the intro line is the
  affordance. The intro is UI text, so it is English (no i18n); the
  `description` is shown as-is.
- **Produced-file send and `send_file` accept an absolute path.** The fs
  write/edit tools report an ABSOLUTE path in `tool/result` `meta.diffs[].path`;
  previously `send-produced` re-joined it onto the pinned cwd and double-prefixed
  it (ENOENT). Both now use an absolute path as-is and only `join` a relative
  path onto the cwd. (The produced-file chip is the #31 feature; this is a
  regression fix.)

### Added

- **Real-client E2E UI suite** (`e2e/`, `e2e/scripts/e2e-ui.mjs`): drives the
  actual feishu.cn web client headless (Playwright + docker image
  `e2e/Dockerfile`) against a real dsh process running the bot app with the
  mock LLM — the only layer where the Feishu wire and the browser client are
  both real. Rule-based DOM assertions only (no paid vision in tests);
  `pnpm run e2e:setup` performs the one-time environment prep (bot app,
  browser session, chat) and later runs are hands-free; configurable
  screenshot/video (mp4 default) + HTML report + `manifest.json`. First
  scenario: `/help` → slash-command descriptions. See `docs/e2e-testing.md`.
- **E2E run diagnostics.** The dsh child process's stdout/stderr is now
  forwarded to the terminal (its logs were previously consumed by the
  readiness gate and invisible), so `FEISHU_DEBUG=1` shows the plugin's own
  tracing during a run. `E2E_DEBUG=1` adds fine-grained harness diagnostics
  (state-file resolution, group create/delete, WS lifecycle, QR cycles,
  report collection).
- **E2E setup is idempotent and group-based.** Re-running `e2e:setup`
  never re-scans an already-exported login (`creds.json`,
  `web-session.json`, `user.json` in `e2e/.state/`); the bot app is created
  with a **unique name** (`DSH-E2E-TESTBOT-<YYYYMMDDHHmmss>`, persisted in
  `e2e/.state/bot-name`) so the setup's search-for-bot step never matches a
  stale app from an earlier run (open-platform QR). The test user's open_id
  is resolved once by listening on a WSClient long connection (the same SDK
  the plugin's transport uses) while the browser sends the bot a private
  message — the `im.message.receive_v1` event's `sender.sender_id.open_id`
  is the test user's id, no extra API scope. A create+delete probe verifies
  the app can manage groups.
  Each test case now runs in its own group chat named `<caseId>-<runId>`
  (unique per run), created through the backend — the same
  `im.v1.chat.create` call the plugin's `/group` wraps — so cases never
  share a chat page. The bot stays the group owner, so each case disbands
  its group in `finally` (runs do not accumulate chats). The run report has
  a single entry point: `summary.html` in the Playwright HTML report's
  visual style, linking into `cases/<caseId>/report.html`; screenshots are
  numbered in capture order (`1_`, `2_`, …); the separate Playwright
  `html/` output is no longer generated.
- **Inbound attachments.** `image` and `file` messages are no longer
  ignored. Every attachment (image or file) is downloaded through the
  message-resource endpoint (`im.v1.messageResource.get` — `im.v1.image.get`
  can only fetch bot-uploaded images; `type=file` covers files and video)
  and saved under the chat's working directory at
  `<cwd>/.dsh_feishu/attachments/<appId>/<chatId>/<name>.<ext>` (a hidden,
  per-app+chat-bucketed subdirectory) — the agent receives the REAL path
  and reads the file with its workspace tools. A `📎 File received` receipt
  card posts; download/save failures notice loudly and never wedge the
  chat. Reuses the existing `im:resource` scope. (Feishu images are plain
  files to the agent — there is no image content block / visual-input path.)
- **Outbound files/images (`send_file` tool).** The agent can deliver a
  workspace file or image to the Feishu chat by calling a `send_file` tool
  it invokes itself — dsh has no host-level "agent produced a file" event,
  so instead of guessing from `tool/result`/fs observation the surface
  registers a first-class tool (`path` required + optional `description`).
  It resolves the path against the chat's pinned cwd, reads the bytes,
  classifies image vs file by extension + magic bytes, uploads via
  `im.v1.image.create` / `im.v1.file.create`, posts a native Feishu
  image/file message, and shows a `📤 Sent` receipt card. Feature-detects
  the `tools` service (absent → loud log, tool not registered). Depends on
  `@deepseek-ai/dsh-tools` (new runtime dep).
- **Turn produced files (`turn-produced-files` chips).** After a turn ends,
  the streaming card lists the files the agent produced (write/edit
  mutations) as clickable `📎 Produced` chips (label = basename) under the
  last tool/message row; tapping a chip sends that file to the chat via
  `sendImage` (image extension) or `sendFile` (other) — no separate receipt
  card. Path-level parity with the DSH web "Turn produced files" row: the
  host derives the mutation path from `tool/result` `meta.diffs` (the fs
  write/edit tools' presentation payload, present even as an empty array for
  a new-file CREATE), falling back to the correlated `tool/call` arguments'
  `file_path` when `diffs` is empty. Reads (no `diffs` key), deletes and
  terminals are excluded. Paths are turn-scoped, deduped, and resolved
  against the chat's pinned cwd.
- **Bare attachment messages wait for the user's instruction
  (inbound-wait-instruction).** A file/image message without text no longer
  starts a turn by itself: the bytes land in the workspace, a NEW receipt
  card posts for each file (kept in chat history, showing the running count
  `📎 已收到 N 个文件`), and the agent waits. The next text message drains
  the pending list into its turn — every pending file's saved path is
  injected before the text, in arrival order, then the list clears. In
  groups, bare attachment messages bypass the mention gate (Feishu sends
  them without an input box, so an @ is physically impossible), but the
  follow-up TEXT instruction still requires an @ — the agent never acts
  without an accepted instruction.
- **Rich-text (`post`) and `video` messages are no longer dropped
  (inbound-rich-text).** A `post` message is normalized into a serialized
  markdown-ish string that PRESERVES the inline element order (text / image
  / video / file in one bubble — the intra-bubble order is information),
  with inline `<image N>` / `<video N>` placeholders and an ordered
  attachment list; the client-authored `md` field is preferred when present.
  A rich-text post with text starts a turn immediately; an attachment-only
  post and a bare `video` message register as pending like any file
  (`type=file` on the resource API serves video — no new download path).
- **Inbound files stream to disk and keep their original name.** The
  message-resource download previously read `response.file`, but the SDK
  interceptor already unwraps `resp.data`, so every inbound file failed to
  persist (`code -1`). The file download now uses the botmux pattern —
  `responseType: 'stream'` + `$return_headers`, JSON error-envelope
  detection, and `pipeline()` streaming to disk (no buffering; the
  resource API serves files up to ~100 MB). The on-disk name is the
  user's original `file_name` (sanitized for path safety; Unicode kept;
  200-byte cap) with WeChat-style dedupe — a same-named file re-sent in
  the same chat lands as `name(1).ext`, `name(2).ext`, … never an
  overwrite (bucket per chat, not per message, so the dedupe fires);
  without a usable `file_name` the sanitized resource key is used.
- **Canary workflow** (`.github/workflows/canary.yml`): runs the full suite
  daily (UTC 02:00) and on demand against the newest `@deepseek-ai/*`
  release (`@next` dist-tag), surfacing upstream breaking changes before
  users hit them.
- **Session rename/archive actually work.** The session-detail Rename and
  Archive buttons previously never rendered in real deployments because
  they depended on the `apiProxy` gateway service, which dsh-base does not
  mount. The bundle now adds the durable storage domain (`storage` ×3 +
  `workspace`) and the actions go through `ctx.sessionTitle.rename` and
  `ctx.workspaceRegistry.archiveSession` — visible on Feishu AND in the dsh
  web UI sharing the same DSH_HOME. The integration test now asserts the
  buttons exist and the actions work in the real dsh process (it used to
  degrade silently).

## [0.2.1] - 2026-08-20

_Compatibility: dsh `0.1.0-rc.7` (npm `@latest`). This release ships the
stable-rc.7 line; newer dsh releases (`@next`) are tracked on `main`.

### Changed

- **dsh family bumped to `0.1.0-rc.7`.** `@deepseek-ai/dsh` is pinned
  exactly in devDependencies; the rest of the `@deepseek-ai/*` surface
  moves to `^0.1.0-rc.7`. Compatible with dsh `0.1.0-rc.7` (badge + Note in
  `README.md`, `README.zh.md`).
- **Panel cards each own an independent state machine.** The panel view
  stack moved from per-chat to per-(chat, card): tapping an old panel card
  updates THAT card, never a different one ("tap this card, another card
  reacts" user report). Slash commands open a fresh card
  (`openPanel`/`openPanelView`); card callbacks always update their own
  card; unknown cards (left on screen before a daemon restart) start at the
  menu root. `FEISHU_DEBUG=1` now traces panel transitions (`panel action
  <kind> on card <id>` → `panel update card <id>`).
- **Full-surface debug tracing under `FEISHU_DEBUG=1`.** The console
  exporter gates `logger.debug` on the env var (production stays quiet),
  and every module now traces its pipeline with real ids: message routing
  and the agent ladder (`bridge`), session-map bindings/remints/cwd
  changes, transport sends/updates and WS state, streaming card
  open/patch/finalize and tool activity, panel actions, approval/question
  lifecycle, and startup config + host-service availability. All logger
  seams (`StreamingLogger`, `InteractionLogger`, `TransportLogger`, panel
  context) expose `debug`; see `docs/development.md` → "Debug logging"
  for the line map.

### Added

- **Canary workflow** (`.github/workflows/canary.yml`): runs the full suite
  daily (UTC 02:00) and on demand against the newest `@deepseek-ai/*`
  release (`@next` dist-tag), surfacing upstream breaking changes before
  users hit them.
- **Session rename/archive actually work.** The session-detail Rename and
  Archive buttons previously never rendered in real deployments because
  they depended on the `apiProxy` gateway service, which dsh-base does not
  mount. The bundle now adds the durable storage domain (`storage` ×3 +
  `workspace`) and the actions go through `ctx.sessionTitle.rename` and
  `ctx.workspaceRegistry.archiveSession` — visible on Feishu AND in the dsh
  web UI sharing the same DSH_HOME. The integration test now asserts the
  buttons exist and the actions work in the real dsh process (it used to
  degrade silently).

## [0.2.0] - 2026-08-17

### Added

- **Guided bot branding in the quick-setup tool.** Creating an app now
  prompts interactively for the bot's **name**, **avatar image** (PNG path;
  empty = the bundled serif "dsh" wordmark at
  `docs/assets/default-avatar.png`) and **description** — empty input keeps
  the default, and non-TTY runs (CI/scripts) skip the prompts. The
  `--app-name` / `--avatar` / `--description` flags override the prompts for
  scripted runs.

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

- **README usage guide is now panel-card-driven.** The walkthrough opens
  with `/panel` (the control-panel card, whose buttons each map to a slash
  command), then drives the setup steps through the card with the
  equivalent slash commands noted per step; the Features list gains a
  "One-tap control panel" entry (`README.md`, `README.zh.md`).
- **README embeds real-bot screenshots and a demo video.** The usage guide
  shows every step with a capture of the real bot (step-numbered assets
  under `docs/assets/snapshots/`) and a hero demo video embedded via a
  GitHub attachment link (`README.md`, `README.zh.md`).
- **Architecture refactor: the card surfaces become state machines behind
  seams (no behavior change).** `Bridge`'s monolithic switch/if sprawl (the
  source of every "panel reverted mid-action" / "card went dead" bug class)
  is decomposed into small, single-purpose controllers, each owning one
  surface and depending only on a host interface the Bridge implements:
  - `cards/StreamingCardController.ts` — the streaming-card state machine
    (per-chat `ChatCardState`, one `syncCard` render path, the session-event
    pipeline incl. compaction, and the stop/copy/retry/row-details/
    toggle-rows actions).
  - `cards/InteractionCardController.ts` — the approval/question card flows
    (single-select, multi-select toggles, free-text via the next message,
    `answerFreeText`, and the interaction card actions).
  - `panel/PanelController.ts` + `panel/actions/` + `panel/views/` — the
    panel state machine; card actions are **Strategy objects** over a
    `PanelAction` Template-Method base (transition → gate → busy → work →
    result → exit, so no action can forget the patch-first rule), and views
    are **Strategy objects** declaring their own `asyncData` (the former
    `panelViewIsAsync` kind list is gone; pickers are separate
    `picker:repo|model|permission` states).
  - `commands/surface.ts` — the surface command set (all slash commands and
    their panel buttons) behind `SurfaceCommandHost`.
  - `Bridge` shrinks to facade + orchestration: message routing, agent
    resolution, gates, and the four host seams. All 452 behavior tests (incl.
    real-composition integration) pass unchanged; new unit tests cover each
    controller directly (484 total).
- **README overhaul.** Rebuilt around the positioning — *The Feishu UI for
  DeepSeek Harness (dsh)* — as a complete, zero-context onboarding: a
  from-blank-machine quickstart (Node.js → pnpm → plugin →
  one-QR setup → run), commands in the official npx style, and two equal install paths under Quickstart —
  from npm and from source — both starting from installing Node.js,
  mirroring the dsh README, a "Usage"
  walkthrough (a concrete end-to-end scenario: /group or DM → /cd → ask →
  streaming card → in-chat approval/question → session management), the full slash-command
  table, a compact feature list, license/Node/CI badges, and
  Contributing/security links. `package.json` gains a description and
  keywords; `README.zh.md` is kept in sync. Screenshots are deferred —
  `docs/screenshot-checklist.md` + `docs/assets/` stage eleven planned
  captures for a gallery added once real shots exist.
- **`docs/pitfalls.md` (+ zh) covers the setup/transport failures.** New
  entries for the pnpm 11 `minimumReleaseAge` default, the `--` run-argument
  separator, the QR-init `x-locale` / `x-terminal-type` headers, the SDK's
  proxy-honoring default axios instance, and the custom-`httpInstance`
  response-unwrap contract.
- **Open-source hygiene pass.** Developer-machine absolute paths in
  `docs/development.md` / `docs/pitfalls.md` (+ zh) are now relative
  (`$(pwd)/_dev/…`) or generic; the `docs/development.md` Release-workflow
  link is fixed (`../.github/…`); README (+ zh) gains an npm version badge;
  `AGENTS.md` adds a "no machine-specific details in tracked docs"
  convention so absolute paths and ambient env values never land in
  committed docs again.
- **Integration suite expansion (pre-release hardening).** New
  real-composition tests: mutating commands and the compact button are
  refused while a turn runs; hostile markdown, blank, and very long
  messages all complete safely; consecutive messages to one chat are each
  answered (burst messages merge into one step by agent inbox semantics).
  New scenario test: a stop button on a pre-restart card explains there is
  no live session and the chat stays usable. New unit edge cases cover
  blank messages and malformed/unknown card actions.
- **Edge-case coverage pass (pre-release).** New unit tests: an @-only
  group message is answered; `/compact` with no compactable history
  replies without wedging the chat; `/repo` with an empty root list or no
  roots posts an empty picker; a multi-select question submitted empty
  settles an empty answer; a bare `/model` with an empty provider catalog
  still posts the picker; retry after a stopped turn starts a fresh turn;
  `panel-page` clamps out-of-range pages and ignores non-numeric ones;
  `/cd` resolves relative paths and keeps spaces; `/export` of an empty
  session ships a no-content file. New real-composition tests: compact
  with no history leaves the chat servable, panel navigation clamps
  garbage pages, copy after a stopped turn resends the held output, and an
  empty question submit continues the turn.

### Fixed

- **Inbound videos saved with a `.bin` extension.** `sniffExtension` did not
  recognize video containers (MP4/MOV `ftyp`, WebM/MKV EBML, AVI `RIFF`), so
  a `video` message — whose content carries no `file_name`, falling back to
  the resource key — landed as `<key>.bin`. The sniffer now maps those magic
  bytes to `mp4` / `webm` / `avi` (and this also fixed the WebP branch, whose
  `RIFF`+`WEBP` check read an 8-byte head and never matched).
- **Flaky stop/panel integration tests (CI-only timeouts).** Tests that
  `holdNextResponse()` then drove a stop/panel action waited only for the
  working card — which appears as soon as the turn starts, BEFORE the agent's
  LLM request is established (buildRequest → resolveApiKey → fetch). A stop
  issued in that window cancelled nothing and the turn completed normally
  (no stopped card / ERROR reaction), timing out on slow or loaded CI
  runners. The mock server now exposes `waitForHold()`, and every
  hold-based test awaits it before acting — the abort is deterministic.
- **Flaky session-lifecycle test (shared dsh home).** The integration suites
  run in parallel (vitest file parallelism), each spawning a real dsh
  process — but four of them shared `_dev/dsh-home`, so concurrent processes
  raced their writes to `_dev/dsh-home/feishu/session-map.json` and silently
  dropped another suite's chat→session binding (the session-lifecycle test
  read the file and found its chat missing → `expected undefined to be
  defined`, CI-only). Each suite now uses its own home
  (`dsh-home-attachments` / `dsh-home-rich-text` / `dsh-home-wait-instruction`
  / `dsh-home-real` / `dsh-home-scenarios`), isolating the session map and
  every other durable file; CI prepares one profile per suite.
- **Turn-termination reaction ack 400s.** The terminal emoji for an error or
  stopped turn defaulted to `WARN`, which is NOT a valid Feishu `emoji_type`
  (the platform's reaction table has no WARN) — the swap always failed with
  a 400 (logged, non-blocking). The defaults are now `ERROR` / `ERROR`
  (valid), so stopped/error turns ack cleanly.
- **Inbound audio (voice) messages are now handled.** Feishu voice bubbles
  arrive as `message_type: 'audio'`, which the surface silently dropped; the
  type now joins the supported set and routes through the file path like a
  video (its `file_key` downloads via `type=file`).
- **Known-but-unhandled message types reply loudly instead of vanishing.**
  A `folder` (or sticker / share_chat / share_user / system / media /
  merge / interactive) message is no longer silently dropped: the bridge
  replies `⚠️ I can't process messages of type '…' yet.` (folders get the
  extra note that folder contents cannot be downloaded via the API — send
  files or a zip instead). Unknown types stay ignored.
- **Group messages without an @ are silently dropped on fresh apps** (user
  report: a 1-user-1-bot group stopped answering un-@ messages after the
  app was recreated). Two compounding setup bugs meant **no scopes were
  ever granted** by `setup:feishu`, so the Open Platform only pushed
  @-mentioned group messages and the in-code `groupMentionMode`
  solo-group relaxation never saw the un-@ message:
  - The console scope-catalog parser only recursed into a fixed field set
    and only accepted the `name` key — real catalogs use other shapes
    (`scope_name`/`key`/nested buckets), so every manifest scope was
    reported "not in the catalog" and skipped. It now mirrors botmux's
    open-platform automation (recurse any object field, accept every key
    spelling, match by name with bucket fallback).
  - `mapManifestScopesToOpenPlatformIds` judged `missing` by comparing the
    manifest NAME against the resolved catalog ID (an opaque hash) — every
    scope was misreported missing even when it had been granted.
  - `--new` swallowed the configure step's warnings, so the silent scope
    loss was invisible; warnings now surface in both branches, and an
    unreadable app visibility degrades to a "publish manually" warning
    instead of failing the whole configure.
  The manifest now also grants the full message-reception set aligned with
  botmux (`im:message.group_at_msg:readonly`, `im:message.group_msg`,
  `im:message.group_msg.include_bot:read`, `im:chat.members:read`,
  `im:chat.members:write_only`); `im:message.reaction` was dropped because
  the live API verified reactions work without it (docs/feishu-setup.md
  updated).
- **An @-mentioned command ("@bot /help") fell into the working-directory
  gate instead of dispatching.** Feishu renders group mentions inline as
  `@_user_<n>` / `@<label>` (the transport only strips the `<at>`
  placeholder), so the leading `@` made `parseSlash` miss the command and
  the message was treated as a plain turn. `handleMessage` now strips all
  inline mention tokens before dispatch; the agent receives the cleaned
  text too (regression tests cover leading, punctuated, and mid-text
  mentions, and plain @-mentioned messages still gate normally).
- **`/group` left the bot as the new group's owner.** `createGroup` now
  passes `owner_id` (the requesting user) to `im.v1.chat.create`, so the
  created group is owned by the user who ran `/group` (verified against
  the real API; unit test asserts the payload).
- **The collapsed trace chain on cards now uses `→`** instead of the ASCII
  `->`, matching the expanded rows (regression tests updated).
- **The streaming card's ⚙️ Panel button now opens a FRESH panel card**
  (user report: the button "did nothing" once the previous panel card went
  off-screen) — the panel action reposts instead of updating in place.
- **Panel state machine made complete and failure-proof** (user testing):
  - ALL pickers now render INSIDE the panel card — `/repo`, `/model`,
    `/permission` (and their panel buttons and slash commands) open their
    picker as a panel sub-view instead of posting a separate card.
  - Every sub-view has a Back button (sessions list, all pickers); Back
    pops to the parent view (stack semantics).
  - `showPanel` never silently fails: a failed in-place update falls back
    to posting a fresh card (re-recording its id), a failed post surfaces
    as a text notice, and a render error is logged and reported — the
    "buttons do nothing" state/card divergence is gone.
  - Panel action guards no longer compare the callback's OPEN message id
    against the stored message id (they can never match); the panel view
    is the guard instead.
  - `resume-session` now requires the session detail view and the working
    gate, and returns to the menu after resuming.

- **Answered multi-select question cards kept their buttons** (user
  report): a toggle re-posts the card and retargets the interaction, but
  the finalize update used the INITIAL card's message id, so the card the
  user actually saw was never replaced by the static answer. The
  `questionState` now tracks the latest card and the finalize update lands
  on it (regression test).
- **Pagination posted a new card instead of updating in place** (user
  report): panel, sessions, and repo page flips now `updateCard` the
  current card (no card stacking on mobile; the panel tracks its message
  id).
- **Panel button semantics** (user report): Stop reads "⏹ Stop turn" /
  "⏹ Stop current turn" (it stops the running turn, not the session);
  `/clear` (Fresh start) is the same action as `/new` so only ➕ New chat
  appears in the panel (`/clear` stays a slash alias); the Plan mode button
  label flips to "🗺️ Leave plan mode" while active.
- **`dsh-feishu-setup` exited silently through its npm bin link** (user
  report): the direct-execution entry check compared `process.argv[1]` —
  the bin SYMLINK path when invoked via `node_modules/.bin` — against the
  real module URL, so `main()` never ran and the CLI produced no output.
  The entry check now `realpathSync`s the argv path first. Verified end to
  end through a packed tarball's bin link.

### Changed

- **Panel Back follows stack semantics** (state machine): a session detail
  pops to the session list, a rename input pops to its detail, everything
  else pops to the menu root.
- **Test coverage for the panel state machine.** New unit tests: the
  panel-view transition matrix (Back pops to the parent, page flips are
  ignored outside the menu root), empty input submits, archive failure
  notification, archive/active list filtering by the host archive set,
  unknown-session details, and export failure. New real-composition test:
  the full session detail flow (list → detail → rename → archive) through
  the real `ctx.apiProxy` host seam — proving the seam is present in the
  dsh process.
- **Session detail view (dsh web parity).** The Sessions button opens a
  **dropdown** picker (up to `SESSION_SELECT_MAX = 20` sessions, ★ current /
  ● live badges; a note explains the remainder — no list, no pagination,
  mobile-friendly) with an archive/active toggle; picking an option opens a
  session detail card (title, cwd, age, message count, last answer) with
  **Resume**, **Rename** (input form → host `apiProxy.sessions.rename`),
  **Archive** (→ `apiProxy.workspace.archiveSession`, reversible), and
  **Export** actions. The standalone Resume panel button is gone (the
  Sessions flow owns it). Rename/Archive hide when the host seam is absent.
- **Panel is now a state machine (single card, in-place updates).** The
  panel card keeps one authoritative view **stack** per chat (menu root at
  the bottom; sub-views push, Back pops) rendered through a single path and
  updated IN PLACE — no card stacking (mobile UX, user report). Commands
  with a text dimension (`/cd`, `/group`, `/goal`, `/feedback`,
  `/rename-session`) open a root-level v1 `form`+`input` sub-view (botmux
  v1 schema: the form holds only `input` + a `form_submit` button that
  carries a `name` — Feishu rejects nameless form buttons with ErrCode
  200530; the submit callback delivers `form_value`). Destructive commands
  (`/clear`, `/compact`) confirm first.
- **Panel results notify as pure-information cards (the panel principle,
  user requirement).** A panel action whose outcome is FINAL posts a NEW
  inert card (`✅ Done` / `⚠️ Action failed`, no buttons/inputs) — repo/
  model/permission picks, rename, archive, input/confirm submissions,
  resume, export, and every palette command without a sub-view (help,
  status, plan, surface status, …). Intermediate steps (input forms,
  confirm prompts, pickers) stay inside the panel card and update in place:
  a button that needs more interaction jumps the panel, a button that needs
  none notifies with a new card. ALL completions share one exit
  (`replyResultCard` + `popToMenu`) — the exit PATCHES the panel card back
  to the menu root, which keeps Lark from restoring the pre-click (page-1)
  card when a direct-result button click carried no panel update (user
  report: clicking help on page 2 jumped back to page 1; regression test).
- **Streaming card throttle default raised 150 → 400 ms** (user report:
  cards refreshed too fast on the Feishu mobile client). Patch coalescing
  (latest-wins) is unchanged; `cardThrottleMs` still overrides.

- **`dsh plugin add` failed under pnpm ≥ 11** (user report): pnpm 11
  blocks dependency build scripts by default, so installing the plugin
  into a profile failed with `ERR_PNPM_IGNORED_BUILDS` (the lark SDK's
  `protobufjs` postinstall). pnpm 11 also ignores `pnpm.*` fields in
  package.json entirely. Documented the fix in the README quickstart and
  pitfalls: append `--allow-build=protobufjs` to the `dsh plugin add`
  command (dsh forwards pnpm args verbatim), or add an `allowBuilds` entry
  to the profile's `pnpm-workspace.yaml`.

- **`ensureAgent` wedged on a persisted session (user report).** The dsh web
  wrappers (`/permission` picker, `/plan`) called `ensureAgent`, which
  CREATED the session outright — a session the persisted state already owns
  throws ("persisted state already owns this identity"). The panel render
  failed ("⚠️ The panel view could not be rendered"), the panel reverted to
  page 1, and every later page flip went dead. `ensureAgent` now follows the
  same ladder as `resolveAgent`: live → resume → create → remint a fresh id.
  A render failure also resets the panel stack to the menu root and reposts
  the menu card, so flips/Back never die (regression tests).
- **Async panel views reverted to the menu while loading (user report).**
  `sessions`, `session-detail`, and the pickers render from async data;
  while the data loaded, the callback carried no panel patch, so Lark
  restored the pre-click (menu) card — the panel visibly "退回菜单"
  mid-transition. `showPanel` now posts a **⏳ Loading… placeholder** (Back
  only) FIRST, then the real card; the loading placeholder blocks mis-taps.
- **Sessions dropdown could not reach every session (user report).** Feishu
  caps `select_static` options, so the dropdown only ever showed a window of
  the corpus. `SESSION_SELECT_MAX` raised 20 → 50 (Feishu's real cap) and a
  **🔎 Find session** input filters by id/title fragment, making ANY session
  reachable (regression test).
- **Async panel operations awaited without an immediate patch — the panel
  reverted mid-action (user report).** Lark restores the pre-click card
  whenever a callback carries no panel update, so sessions-internal
  operations (rename/archive/export/resume and the pickers' apply step)
  silently reverted the panel while their work awaited. Root-caused as a
  STRUCTURE gap, not a one-off: async panel operations had no shared
  wrapper, so "patch before await" was remembered per case. Introduced
  `runPanelOperation`, the single wrapper for ALL async panel operations —
  it posts an `⏳ Operating…` placeholder (no buttons, blocks mis-taps)
  before the work, then the result card, then the completion exit. The
  callback-patch guarantee is now structural (documented in AGENTS.md and
  ux-spec §8.6): async VIEWS load via `showPanel`'s loading placeholder,
  async OPERATIONS via `runPanelOperation`. Regression test asserts the
  placeholder lands while archive work is pending.

- **Integration-test teardown raced the next test's state reset (CI flake
  under Node 22).** `afterEach` sent `SIGTERM` to the dsh child but did not
  wait for it to exit, so the child's lingering outbox writes could make
  the next test's `rmSync(MEMORY_DIR)` fail with `ENOTEMPTY`. Both
  integration suites now `stopChild()` (SIGTERM, SIGKILL after a 5 s
  grace, then wait for exit) in `beforeEach`/`afterEach`, and the reset
  uses `rmSync` with `maxRetries`/`retryDelay` as a second guard.

- **`pnpm install` failed under pnpm 11** (user report): pnpm 11 defaults
  `minimumReleaseAge` to 1440 minutes (24 h), rejecting any lockfile entry
  published within the last day — freshly released transitive deps (koffi,
  @smithy, @hono, content-type, …) blocked installs on pnpm ≥ 11. Set
  `minimumReleaseAge: 0` explicitly in `pnpm-workspace.yaml` so installs
  work on every pnpm version; the `allowBuilds` allowlist (the build-script
  supply-chain control) is unchanged.
- **`pnpm run setup:feishu -- --new` failed under pnpm 11** (user report):
  pnpm ≥ 11 forwards the `--` run-argument separator verbatim, so the CLI
  received `-- --new …` and rejected `--` as an unknown option. The setup
  CLI now skips a leading `--` (regression-tested); the documented command
  works on every pnpm version.
- **Feishu QR login failed with 4401 "请求无效"** (user report): the
  `accounts.qrlogin/init` request was missing the mandatory `x-locale`
  and `x-terminal-type` headers (botmux's reference carries them; ours was
  copied without). Added both; the QR init now returns a token live
  (regression test pins the required headers).

- **Long-connection / REST calls failed behind a proxy** (user report:
  `Protocol "https:" not supported. Expected "http:"` from
  follow-redirects). The lark SDK's default axios instance honors
  `http(s)_proxy` env vars, which breaks WS endpoint discovery and REST
  calls when a proxy is set. The transport now injects a shared
  `proxy: false` axios instance (`FEISHU_HTTP`) into both the `Client` and
  the `WSClient` (regression test pins `defaults.proxy === false`).

- **WS endpoint discovery failed with `code: undefined` after the proxy
  fix** (user report): the injected axios instance lacked the SDK default's
  response interceptor that unwraps `resp.data`, so `request()` resolved to
  the AxiosResponse wrapper and the SDK's `{code, data:{URL}, msg}`
  destructure came back undefined. `FEISHU_HTTP` now mirrors the SDK
  default instance: `proxy: false` plus the response-unwrap and
  `$return_headers` interceptors (regression tests pin both).

- **Setup wizard did not configure `repoRoots`** (user report): the profile
  it writes only carried appId/appSecret, so `/repo` had nothing to list out
  of the box. Creating the feishu row now includes a `repoRoots` default of
  the user's home directory (mirrors the dev profile); existing rows are
  never touched. Regression test pins the created row's shape.

- **Setup wizard now guides the surface options.** `pnpm run setup:feishu`
  prompts for `repoRoots` (default: the user's home directory),
  `groupMentionMode` (default `always`), and `requireWorkingDir`
  (default `y`) — empty input accepts the shown default, which is the
  profile's existing value when already configured. Non-TTY runs (CI,
  scripts, `--print-env`) skip the prompts and use the defaults silently.
  The writer merges the guided options on both create and update without
  touching unrelated keys. `FEISHU_ALLOWED_USERS`-style env overrides are
  unaffected.

- **`/compact` wedged the chat in "working"** (user report): the harness
  compaction transaction emits `compaction/start → summary → end` plus a
  checkpoint `user/message` with plugin source `compact` — and no
  `turn/end`. The bridge rendered the checkpoint as a card that nothing
  ever finalized: the chat stayed "working" forever and every later
  command was refused with "a turn is running — stop it first." The bridge
  now owns the compaction card lifecycle — `compaction/start` opens a
  🧹 Compacting card immediately (button feedback, not a silent wait),
  `compaction/summary` renders the summary, and `compaction/end` finalizes
  it (green, or red with a failure notice when the transaction failed),
  releasing the working-state gate. Regression tests at both layers
  (`tests/bridge.spec.ts` compaction lifecycle + a real-composition test
  that taps the compact button end to end).

- **README gains an Uninstall section** (user request): the proper
  `dsh plugin --profile feishu remove @dsh-feishu/dsh-feishu` plus the
  full clean-slate `rm -rf ~/.dsh/profiles/feishu ~/.dsh/feishu`, verified
  against a scratch profile before documenting.

### Removed

- **`/history` card replay (user decision).** The command duplicated
  `/export` (both ship the same session-log transcript), and printing a full
  history into cards was ugly. Session replay now has exactly one surface —
  the `/export` file message. The `buildHistoryCard` renderer,
  `toLarkCardMarkdown` / `splitTranscriptParts` helpers, and their tests are
  deleted; the restart-durability integration test now proves continuity via
  `/export` after the restart.
- **`PLAN.md` (the bilingual planning artifact).** Retired — every planned
  iteration has shipped, and the design content lives on in
  `docs/architecture.md` / `docs/ux-specification.md`. References rewired
  (`AGENTS.md`, the `src/index.ts` header comment, the architecture guides);
  `docs/development.zh.md`'s publishing section is synced with the English
  tag-driven release flow.

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
