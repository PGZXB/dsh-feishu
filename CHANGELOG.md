# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
