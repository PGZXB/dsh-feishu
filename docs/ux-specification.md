# UX Specification

English | [中文](ux-specification.zh.md)

This document specifies the user-facing behavior of dsh-feishu precisely
enough that a developer can implement each part without inventing details,
and a user can predict what the bot will do. Every part is derived from a
reference implementation — the DSH web chat (packages `ui-conversation`,
`ui-tool` in deepseek-harness) or botmux (`card-builder.ts`,
`card-handler.ts`, `event-dispatcher.ts`) — and the derivation is cited.

**Rule (user directive): no truncation without asking.** Any feature that
would cut user-visible content (card size, list length, output length) must
first confirm the approach with the user. This spec lists the physical
limits that exist; every one of them is a question, not a silent default.

---

## 1. The streaming turn card

### 1.1 Layout (top → bottom)

Reference: DSH web message flow (think rows → tool rows → answer), plus
user feedback rounds 2–5.

1. **Row sequence** — a chronological list of one-line rows. Two kinds:
   - **Think row**: `☁️ Think · Thinking` while the reasoning block streams;
     the line never changes after settle (a live latest-line would flicker
     through throttled patches for little value — user decision).
   - **Tool row**: `<status> <Title> · <summary>` where status is `🔧`
     (running), `✅` (done), `❌` (error); Title and summary come from
     Section 2.
2. **The complete answer** — the turn's final output, markdown-rendered
   (Section 4), at the bottom.
3. **Execution status** — while working, a markdown line `**… working**` /
   `**⏹ Stopping…**` (visible progress); in a terminal state, a quiet
   `note` (`✅ Done` / `⏹ Stopped` / `⚠️ Turn ended with an error`) — the
   header template color already carries the semantic (see 1.4).
4. **Button area** — two rows (Section 3.1): state actions, then the row
   view toggle.

The card is **collapsed by default**: the row sequence is replaced by one
line `think → bash → read → …` (full sequence, never truncated — user
directive), and the button area gains `▸ Expand`.

### 1.2 Card state machine (single authoritative state)

Reference: user feedback rounds 4–6 (collapsed default, details click must
not collapse, streaming must continue while collapsed, "card reverted to
working after panel" — the design that replaced ad-hoc per-action patches).

One `ChatCardState` per chat is the **single authoritative source** for the
streaming card: `title`, `content`, `rows`, `openThinkId`, `status`
(working/done/stopped/error), `collapsed`. The streaming-card controller renders the card from this state and
nothing else.

```
(none)  --message/retry-->  working  --turn/end(aborted)-->  stopped
working --stop------------>  (unchanged until turn/end aborts it)
working --turn/end-------->  done | error
working --compaction/end-->  done | error   (compaction is NOT a turn)
done|stopped|error --any action--->  same (state unchanged; card re-synced)
```

- **Entering working**: message or retry sets a fresh state (collapsed by
  default) and opens a new card.
- **Streaming**: session events mutate the working state and call
  `syncCard` (through the streaming manager).
- **turn/end**: `completed` → done, `aborted` (user Stop) → **stopped**,
  `error` → error. An aborted turn must read **Stopped**, never Done (DSH
  web `message.stopped`; user report). `finalize` flushes the terminal
  render. The state stays in the map (rows/content survive for the ⋯
  buttons and later re-sync).
- **Card actions** mutate the state (toggle flips `collapsed`) or not, then
  **always** call `syncCard` — the single render path. A finished card is
  re-patched in place, deferred via a macrotask so the callback ACK lands
  first (botmux rule: Lark can otherwise restore the pre-click card — the
  root of the "reverts to working" bugs).
- **Collapsed**: `collapsed` is part of the state; `▸ Expand`/`▾ Collapse`
  flips it. While collapsed, the sequence line streams (recomputed from
  rows on every sync). A new turn resets to collapsed.
- **Compaction is not a turn** (user report): `/compact` runs a
  `compaction/start → summary → end` transaction with no `turn/end`, so the
  the streaming-card controller handles the compaction card lifecycle — `compaction/start`
  opens a 🧹 Compacting card (immediate button feedback, not a silent
  wait), `compaction/summary` renders the summary, and `compaction/end`
  finalizes it (done, or error with a failure notice when the transaction
  failed), releasing the working-state gate. A checkpoint `user/message`
  with plugin source `compact` opens a Compacting card as a fallback.
- **No action can leave the card in a stale state**: panel, stop, retry,
  copy, row-details all end with `syncCard`, so the on-screen card always
  reflects the authoritative state.

### 1.3 Streaming mechanics

Reference: botmux streaming card; our `StreamingCardManager`.

- One interactive card per turn, posted at turn start.
- Chunks patch the same message (`im.v1.message.patch`), throttled and
  coalesced (at most one patch in flight; newest snapshot wins).
- Patches are **silent** (no unread) — fine for progress.
- The final answer lives **in the card** (it finalizes green in place); a
  completed turn sends no second bubble. An error turn sends a notice
  text (`⚠️ Turn failed — see the card for details`).
- Card body cap: Feishu ~109 KB. Our `MAX_CARD_CHARS = 60_000` truncation
  is **pending user confirmation** per the no-truncation rule.

### 1.4 Visual language

- Header template per status: `wathet` (soft blue) working, `green` done,
  `red` error, `orange` stopped.
- Terminal status is a quiet `note` (not a bold line); in-progress stays a
  markdown line.

### 1.5 Turn lifecycle

| Event | Card behavior |
| --- | --- |
| `turn/start` (via message) | open card, status working |
| `assistant/chunk` text-delta | append to answer, patch |
| `assistant/chunk` reasoning-delta | append to open think row, patch |
| `tool/call` | settle open think row; add tool row (running) |
| `tool/result` | mark the matching tool row done/error, store result |
| `assistant/message` | replace answer with assembled text |
| `turn/end` | settle think row; status done/error; finalize card; keep snapshot + rows for re-assertion and the ⋯ buttons |
| `compaction/start` | open a 🧹 Compacting card, status working (a compaction transaction is not a turn) |
| `compaction/summary` | replace the card answer with the compaction summary |
| `compaction/end` | status done (or error, with a failure notice, when the transaction failed); finalize the card — releases the working-state gate |

---

## 2. Tool row model (Title · summary)

Reference: DSH web `tool-call-model.ts` (`toolRowModel`, `classifyTool`,
`VARIANT_TITLES`, `TOOL_TITLES`, `SUMMARY_KEYS`) — ported verbatim in
`src/cards/tool-summary.ts`.

### 2.1 Classification

| Tool name(s) | Variant | Title |
| --- | --- | --- |
| `bash`, `pwsh` | bash | Bash / Pwsh |
| `read`, `web_fetch`, `cordis_package_inspect`, `cordis_runtime_inspect` | read | Read / Inspect |
| `web_search`, `grep`, `glob` | search | Search |
| `write` | write | Write |
| `edit` | edit | Edit |
| `run_code` | code | Code |
| `job_output`, `job_list`, `job_kill` | read | Read Job / List Jobs / Kill Job |
| unknown | others | Tool call |

### 2.2 Summary derivation

Prefer, in order:
1. the variant's preferred arg key — bash: `description`, `command`;
   read: `path`, `file_path`, `url`, `job_id`; search: `query`, `pattern`,
   `url`; write/edit: `path`, `file_path`; code: `description` — first line
   only;
2. the first string arg value (first line);
3. the raw args string (first line).

Unknown (`others`) tools show `name · <base>`. Workspace-rooted paths are
relativized to the session cwd.

**Key invariant (bug fix `bff5180`):** the summary is derived from the
**full** arguments at `tool/call` time and stored on the row. Truncating
the stored args for card size must never degrade the visible summary.

---

## 3. Buttons

Reference: user feedback rounds 1–5; botmux control cards.

### 3.1 Status button area (bottom of streaming card)

Two action rows keep each short on mobile:

- **Row 1 — state actions**
  - **working**: `⏹ Stop turn`.
  - **done**: `📋 Copy`, `🔁 Retry`, `⚙️ Panel`.
  - **error**: `🔁 Retry`, `⚙️ Panel`.
- **Row 2 — view toggle** (only when rows exist): `▾ Collapse` /
  `▸ Expand`.

### 3.2 Row ⋯ buttons

Each row (think and tool) has a trailing `⋯` button that opens that exact
row's **details card** (Section 5). The button value carries the stable row
id (`think-N` or the tool `callId`), never an index.

### 3.3 Action → behavior

| Action | Behavior |
| --- | --- |
| `stop` | `agent.cancel({kind:'user'}, {keepInbox:true})` (the DSH web Stop) + `⏹ Stopping…` text. No live agent → explanatory text. |
| `copy` | resend last output as text |
| `retry` | re-deliver last prompt on a fresh turn/card |
| `panel` | open the panel card (stop/retry/copy) |
| `toggle-rows` | flip collapsed bit; re-render (deferred patch) |
| `row-details` | open the row's details card; re-assert streaming card |
| `repo-pick` / `repo-page` | repo picker (Section 6) |

### 3.4 Card-callback ACK (critical, botmux rule)

`card.action.trigger` is a synchronous callback with a **3 s deadline and
no re-push**. The handler must ACK with a valid response:
- return `{}` (valid ACK, no UI update) — **never `undefined`**, which the
  client rejects as invalid and can then re-render the card to a stale
  state (the "card reverted to Stop after opening details" bug);
- card-changing work must be **deferred out of the callback** (macrotask)
  so the ACK lands before the patch.

---

## 4. Markdown rendering

Reference: botmux `md-card.ts` (markdown-it), our `cards/markdown.ts`.

Feishu lark_md supports a subset of CommonMark. Our converter:

- `#`/`##`/… headings → **bold** (`lark_md` has no heading syntax; raw `#`
  would leak as text);
- fenced code blocks → preserved (blank-line normalized);
- `---` → `hr` element;
- GFM tables → native Feishu `table` element (botmux
  `buildTableFromTokens`; the v1 root-elements layout supports `table` —
  root-level only, matching our card shape; lark_md cells keep inline code
  and bold). Raw `| … |` source text never leaks;
- HTML → stripped (`html: false`).

This is why final answers render (feedback round 1: raw `###` text on the
card was the bug; round 8: tables showed raw pipe text).

---

## 5. Details cards

Reference: user feedback rounds 1, 3, 5.

- **Think details**: the full reasoning text in a code block.
- **Tool details**:
  - header `✅ **<Title>** — <tool name>`;
  - `IN` — the **full** args, pretty-printed JSON in a `json` code block
    (raw text when unparseable);
  - `OUT` — the **full** result in a code block.
- **No truncation** (user directive): the 2000-char details cut and the
  300-char store cut were both removed. Physical card cap is the only
  remaining limit and is a pending question.

---

## 6. Repo picker

Reference: botmux `buildRepoSelectCard` / `project-scanner.ts`, feedback
rounds 1–5.

- `/repo` scans `repoRoots` recursively (depth 3, skip dot/dependency
  dirs, git-common-dir dedup, budgets) and posts a picker card.
- ≤ 50 projects: a `select_static` dropdown **directly inside an `action`
  container** (a `form` placement is silently dropped by Feishu). Option
  label = **repoRoot-relative path** + `(branch)` — never the bare
  basename (generic names like `source` are meaningless alone).
- \> 50: numbered buttons with prev/next pagination.
- **Picker lifecycle**: a pick patches the picker card to a static
  confirmation (no actions) and records the message id; callbacks from a
  superseded picker are rejected (stale-picker guard).
- `repo-pick` reads the chosen path from `action.option` (dropdown) or
  `value.path` (button).

---

## 7. Acceptance checklist (run before declaring a UX part done)

1. Cards start collapsed; the sequence streams while collapsed.
2. Opening row details never collapses or re-renders the streaming card to
   a stale state (toggle bit untouched; re-assertion deferred).
3. Card actions ACK `{}` (never `undefined`); card patches are deferred out
   of the callback.
4. Tool summaries never show raw JSON envelopes for long commands.
5. Details cards show full args/result.
6. Repo dropdown shows relative paths; picker is consumed after a pick;
   stale picker callbacks are ignored.
7. Every step has a unit test; state-machine transitions are covered as
   explicit tests (see `tests/bridge.spec.ts` UX state machine block).

## 8. Command surface

### 8.1 Command set (20 commands: 15 surface + 5 web wrappers)

Every command is a `SurfaceCommand`: one handler shared by the slash line
and the panel button (button = command, botmux `/list-slash-command`
palette idea). `category` groups the panel palette.

| Command | Category | Behavior |
|---|---|---|
| `/help` | system | list all surface commands + passthrough note |
| `/status` | system | chat/session/agent/last-output/mention line |
| `/cancel` | session | stop the current turn |
| `/cd <path>` | session | set the chat's working directory, rebind a fresh session |
| `/repo [<path>]` | session | project picker card (dropdown ≤ 50, buttons + pages above) |
| `/group [<name>]` | chat | create a group with the bot and sender |
| `/sessions` | session | sessions picker card: a **dropdown** of saved sessions (title · id, ★ current / ● live badges); picking opens the session detail sub-view (Resume / Rename / Archive / Export) |
| `/feishu-status` | system | **surface diagnostic card**: app id, live long-connection state (`✅ ready` / `⚠️ reconnecting` / `❌ error`, `🧪 memory` for the test transport), session count, last inbound activity. Read-only (allowed while a turn runs) |
| `/schedule` | system | list this chat's **active reminders** (folding the session log with the dsh-schedule pure functions; degraded to a hint when the package is absent). Reminders are created in chat by the agent through its `schedule_create`/`schedule_delete`/`schedule_list` tools — no surface command needed |
| `/model` | system | **model picker card** (catalog from `ctx.llm` `listProviders` × `listModels`, current preselected); a pick sets the default for new sessions. `/model <provider>/<model>` sets it directly. Surface-native — the web `/model` is a client popup with no host command |
| `/export` | system | send this chat's session log as a **file message** (`session-<id>.md` markdown transcript from `ctx.sessionQuery.readSession`) — the Feishu equivalent of the web's browser-download `/export` |
| `/panel` | system | open the control panel card from any chat (slash line only — its palette button is hidden, since a palette button that opens the panel would be the panel launching itself) |
| `/resume [<id>]` | session | resume a saved session; no id opens the `/sessions` picker |
| `/clear` | session | start a fresh conversation — **non-destructive**: the previous session stays saved and resumable (content-integrity rule) |
| `/new` | session | alias of `/clear` (web/cc-tui "new chat" parity) |
| `/plan` `/goal` `/compact` `/feedback` `/permission` | system | **dsh web wrappers**: ensure a session/agent, then execute the harness command through `ctx.commands.execute` (dsh-base mounts all five); error kinds surface as ⚠️. Two are state-aware (below): a bare `/plan` toggles plan mode, and `/permission` opens a preset picker. |

The web's `/export` command itself is a browser-download observer
(`dsh-session-log-export` — "Register the Web-only `/export` command that
the browser download plugin observes"), so Feishu implements its own
surface-native `/export` that uploads the transcript as a file message
(`im.v1.file.create` → `msg_type: 'file'`). Likewise the web `/model`
popup is a client-side contribution (`commandUi.popupSelect`) with no host
command — Feishu gets a surface-native `/model` picker instead. Unknown
slash lines keep the passthrough/fallback path.

### 8.2 Stateful web wrappers (/plan toggle, /permission picker)

The bare harness forms of `/plan` and `/permission` cannot *choose* or
*toggle*: `/plan` with no args only enters plan mode, `/permission` with no
args only reports the current preset. A button press must be able to switch
(user report) — so the two wrappers are state-aware:

- **`/model` (no args, or the panel button)** opens a **model picker card**:
  the catalog comes from `ctx.llm` (`listProviders` × `listModels` — the
  deepseek adapter ships a static default catalog, so no network), a
  `select_static` dropdown with the current model preselected via
  `initial_option` (paginated buttons beyond the option cap), and a note
  spelling out `★ current`. A pick sets the default for new sessions
  through `ctx.agentDefaultModel.saveSelection`. Stale picks rejected;
  picks refused while a turn runs. Without `ctx.llm` a bare `/model`
  degrades to the text display (loud log).
- **`/permission` (no args, or the panel button)** opens a **preset picker
  card** built from the real `ctx.permissionPresets` service (mounted by
  dsh-base): a `select_static` **dropdown** (repo-picker pattern — inside an
  `action` container, never a `form`) listing every switchable preset
  (`names` + `optionOf` labels), with `initial_option` preselecting the
  current preset (omitted when the effective state is `custom` — no table
  option). A quiet note spells out the current preset (`★ current: …`).
  Choosing applies through `service.set(agent.session, preset)` — the
  callback's `option` field carries the preset — and replies
  "switched to …". Stale picks from a superseded picker card are rejected;
  picks while a turn runs are refused (working-state gate). Typed
  `/permission <preset>` passes through to the harness command. Without the
  service the wrapper degrades to the harness report text (loud log).
- **`/plan` (no args, or the panel button)** **toggles** plan mode through
  `ctx.planMode`: reads `get(agent)` and `set(agent, !active)`, mirroring
  the harness outcome wording ("Plan mode on…" / "Plan mode off.",
  queued/cancelled variants). Pressing again leaves plan mode. `/plan off`
  and `/plan <message>` pass through unchanged. Without the controller the
  bare form falls back to the harness behavior (loud log).

### 8.3 Working-directory gate (DSH unavailable until a repo is chosen)

A chat with no **explicitly pinned** working directory (/repo pick or
`/cd`) is unavailable: every turn is refused with guidance ("No working
directory chosen yet — send /repo or /cd"), no session/card is created and
the message is not remembered. The deployment `defaultCwd` fallback is
never an implicit choice — a fresh chat or a brand-new group must pick a
repo before DSH works there (user requirement). `requireWorkingDir`
(default true) disables the gate for deployments that want the fallback.

- Read-only commands (`/help /status /sessions /panel` and the
  pickers) stay usable unpinned; the panel surfaces "No working directory —
  pick one with /repo or /cd first".
- `/clear` keeps the pinned directory (only the session rebinds).
- **Resume adopts the session's working directory**: the /sessions Resume
  button carries the session's cwd in its value, and a typed `/resume`
  looks it up from the session list — so a resumed session stays usable in
  the new chat (otherwise the gate would refuse every follow-up).

### 8.4 Working-state gate (state-machine rule)

While a turn is running (`cardStates[chatId].status === 'working'`), only
read-only commands may run: `/help`, `/status`, `/feishu-status`, `/schedule`, `/sessions`
(read state), `/cancel` (the stop itself), `/group` (separate chat),
`/model` (picker — picks are refused mid-turn, but opening it is fine),
`/panel` (the panel carries Stop). Every other command —
`/cd /repo /clear /new /resume` and the five web wrappers — is refused with
"a turn is running — stop it first." The gate lives in `handleCommand` and
the panel `command` action (one rule, two entry points), so a mid-turn
session rebind/remint can never corrupt the live card.

### 8.5 Session lifecycle commands

- `/sessions` is a **dropdown picker** (mobile-friendly, user requirement —
  no long list, no pagination): a `select_static` whose options are the
  sessions (`title ★ ● · id`), capped at `SESSION_SELECT_MAX = 50` (Feishu's
  real select_static option cap) with a `note` explaining the remainder.
  A **🔎 Find session** button opens an input sub-view: typing an id or
  title fragment filters the list, so ANY session is reachable past the cap.
  Selecting an option opens the **session detail sub-view** inside the panel
  card (stack push); the choice arrives in the callback's `option` field.
- `/sessions` + `/resume` data: `ctx.sessionQuery` (mounted by dsh-base's
  `session-query-sqlite`), `listSessions()` newest-first + batch
  `readTitleSnapshots()` for titles. When the service is absent the surface
  degrades to a bound-sessions-only listing (loud log).
- Session detail sub-view (`🗂️ Session`): the session's info (title, id,
  cwd, created age, message count, last answer) plus **Resume** (hidden for
  the current session), **Rename**, **Archive** (or **Restore** when
  archived — `ctx.workspaceRegistry.archiveSession` is reversible), **Export**,
  and **Back** (stack pop). Rename/Archive exist only when the host
  `sessionTitle` / `workspaceRegistry` seams are mounted (the bundle's
  storage×3 + workspace rows; they degrade loudly if absent).
- Resume flow (shared by `/resume <id>` and the detail's Resume button):
  the chat must be idle; the target session must not be running in another
  chat ("has an active turn — stop it in its chat first"); resuming the
  chat's own session reads "already active". Then `SessionMap.set` rebinds
  (the previous binding detaches — 1:1 chat↔session model) and
  `agents.resume` loads a persisted agent when none is live. A failed
  resume (no persisted log) reports ⚠️ and leaves the map untouched.
  Resume does **not** change the chat's pinned cwd (`/cd` owns that), and it
  resets the card state so history is never replayed into a card.
- `/clear`/`/new`: `SessionMap.remint` + full card-state reset (no live
  card, no copy/retry targets). The old session stays persisted → still
  listed by `/sessions` and resumable.

### 8.6 Panel palette and the panel state machine

The panel is a **state machine**, not a stateless re-post — and the
authoritative view stack is **PER CARD, not per chat**: `PanelController`
keeps `Map<chatId, Map<messageId, PanelView[]>>` (menu root at the bottom)
with one render path (`renderPanelView`). Each panel card owns its own stack,
so a button on a card PUSHES / POPs / REPLACEs THAT card's stack and renders
THAT card in place — tapping an old card updates that card, never a different
one (user report: "tap this card, another card reacts"). A card left on
screen from before a daemon restart starts at the menu root when first tapped.
A button PUSHES a sub-view (`input` form, `confirm`, `sessions`,
`session-detail`, `picker`); Back POPS; completion/refusal pops to the menu
root (or back to the detail after a rename). Every transition updates the
same card in place (patch); when an update fails the card is reposted and the
new id recorded. `/panel` and slash commands that open a view
(`openPanel` / `openPanelView`) post a FRESH card with a reset stack — earlier
panel cards stay on screen and keep working independently, the chat never
"swaps" one card for another. Slash-line commands update the chat's most
recently posted panel card (`latestPanelCardId`); card callbacks always
update their OWN card.
Async-data views (`sessions`, `session-detail`, `picker`) post a **⏳
Loading… placeholder** (Back only) FIRST, then the real card — the callback
must carry a panel patch immediately, or Lark restores the pre-click (menu)
card while the data loads and the panel visibly reverts mid-transition (user
report: sessions/detail "退回菜单"). A render failure resets the stack to the
menu root and reposts the menu card, so page flips and Back never go dead
(user report: after a render failure "换页按钮不再有反应").

- Menu (`⚙️ dsh-feishu panel`): `buildPanelCard(statusLine, running,
  commands, page)` — the core row (Stop while running / Retry / Copy) stays
  first; below it the full command palette, grouped by category with emoji
  headers (`🧩 Session` / `💬 Chat` / `⚙️ System`), `PANEL_PAGE_SIZE = 8`
  buttons per page, a quiet `note` page indicator (`Commands · page 1/2`),
  and ◀️/▶️ nav hidden at the bounds. Each button stamps `{kind:'command',
  name}` and executes the same handler as the slash line. The status line
  carries the chat's session context (`session `id` · `cwd``).
- **Input sub-view** (`📁 Change working directory`, `👥 Create group`,
  `🎯 Goal`, `💬 Feedback`, `✏️ Rename session`): a root-level `form` with
  one `input` and a `form_submit` button that carries a `name` (Feishu
  rejects nameless form buttons — ErrCode 200530). The label lives outside
  the form; submitting runs the command with the typed value and pops to
  the menu.
- **Confirm sub-view** (`✨ New chat`, `🧹 Compact`): the destructive action
  states its consequence; confirming runs the command and pops to the menu.
- **Result cards (the panel principle, user requirement).** Panel actions
  whose outcome is FINAL leave the panel as a NEW pure-information card
  (`✅ Done` / `⚠️ Action failed`, no buttons/inputs): repo/model/permission
  picks, rename, archive, input/confirm submissions, resume, export — and
  every palette command without a sub-view (help, status, plan, surface
  status, …). Intermediate steps (input forms, confirm prompts, pickers)
  stay inside the panel card and update in place — a button that needs more
  interaction jumps the panel, a button that needs none notifies with an
  inert card. ALL completions share one exit (`replyResultCard` +
  `popToMenu`): the exit PATCHES the panel card back to the menu root,
  which is what keeps Lark from restoring the pre-click (page-1) card when
  the callback carried no panel update (user report: a direct-result button
  on page 2 jumped back to page 1).
- **Every panel interaction carries an immediate panel patch (the
  callback-patch guarantee).** Lark restores the pre-click card whenever a
  callback carries no panel update, so ANY await inside a panel action must
  be preceded by a patch. Two structures enforce this — never write a new
  async panel action that awaits before patching:
  - async panel VIEWS (`sessions` / `session-detail` / `picker`) post a
    `⏳ Loading…` placeholder (Back only) FIRST in `showPanel`, then the
    real card;
  - async panel OPERATIONS (rename, archive, export, resume, the pickers'
    apply step, input/confirm/command handlers) go through the single
    wrapper `runPanelOperation`, which posts an `⏳ Operating…` placeholder
    (no buttons — blocks mis-taps) before the work, then the result card,
    then the completion exit. This was the root of every "panel reverts
    mid-action" bug (user report: sessions-internal operations showed no
    placeholder).

### 8.7 State-machine matrix for the new actions

| Action \ Status | none | working | done | stopped | error |
|---|---|---|---|---|---|
| command (read-only) | allowed | **allowed** | allowed | allowed | allowed |
| command (mutating) | allowed | **refused** "stop first" | allowed | allowed | allowed |
| resume-session | allowed* | **refused** | allowed* | allowed* | allowed* |
| panel-page | stateless page re-send (no card-state transition) | | | | |

\* plus target-running → refused; target == current → already-active.
All cells ACK `{}` and end in a consistent state through `syncCard`
(existing rule); the matrix is unit-tested in `tests/bridge.spec.ts`
"state machine matrix extension".

## 9. Interactive cards: approvals and questions (Iteration 3)

Reference: `@deepseek-ai/dsh-user-approval` (`approval/request` waterfall,
`ApprovalOutcome`) and `@deepseek-ai/dsh-user-questions`
(`registerProvider`). One shared mechanism — `src/cards/interactions.ts`
(`InteractionRegistry`): a request posts a card, the surface waits for the
card callback (or timeout / abort), and settles exactly once. Late or stale
callbacks (wrong chat/card, already settled, superseded card) are ignored.

### 9.1 Approval card

`approval/request` → the surface maps the agent to its chat
(`sessionMap.chatFor(agent.session.id)`), posts an **approval card**
(`🔐 Approval needed`, orange): the tool name + the asker's reason, with
`✅ Allow once` (primary) and `❌ Reject` (danger) buttons. The card
callback settles `'allowed-once'` / `'rejected'`; the request `signal`
abort or a 5-minute timeout settles `'cancelled'`. After a decision the
card is replaced in place by a static decided card (no buttons — further
taps do nothing), deferred out of the callback ACK. Failure modes are
fail-closed `'unavailable'` with a loud log: unknown chat, card send
failure, or bridge disposal (every pending entry settles `'cancelled'`).

### 9.2 Question card

`ctx.userQuestions.registerProvider` — each `AskUserQuestionItem` becomes a
**question card** (`❓ Question`, wathet):

- **Single-select** (default): one button per option; the first tap is the
  answer.
- **Multi-select**: toggle buttons (the card re-posts with `✅` checkmarks
  on the selected options — the newest card becomes the interaction
  target) plus a `✅ Submit` button that settles with the collected labels.
- **Free-text** (no options): the card asks the user to reply with a
  message; the next plain chat message is captured as the answer (it
  bypasses the working-directory gate and is not a turn). A `✖ Cancel`
  button aborts.

The model reaches questions through the standard `ask_user_question` tool
(`@deepseek-ai/dsh-tool-ask-user`), which the web surface mounts via its
standard/code agent presets; this bundle inserts the same tool row into the
profile composition so the Feishu agent has web-parity question capability.

The agent's `signal` abort settles unanswered questions as empty answers.
The answer card becomes a static confirmation.

## 10. Iteration 4: reaction ack, allowlists, proactive mentions

Reference: botmux (`im/lark/client.ts` reactions, `RECEIVED_REACTION_EMOJI_TYPE`
/ `DONE`), DSH web (`/export` file download), and the harness config surface.

### 10.1 Two-stage reaction ack

Every accepted turn message gets a **received** reaction immediately (default
`GoGoGo`, the botmux code), tracking `{messageId, reactionId}` per chat. When
the turn settles, the received reaction is **removed and swapped** for the
terminal emoji:

| Turn outcome | Emoji (config `reactions`) | Default |
|---|---|---|
| completed | `done` | `DONE` |
| error | `error` | `WARN` |
| stopped (user Stop) | `stopped` | `WARN` |

Configurable via `reactions.received/done/error/stopped`; `received: ''`
disables the ack entirely. Reaction calls are best-effort: a failure logs and
never blocks the turn. Slash commands and gate-refused messages get no
reaction. `/clear`/`/resume` drop the pending-tracking entry.

### 10.2 Session replay is `/export` only

The session log has exactly one surface: `/export` ships the transcript as a
**file message** (see §8.1). A card-replay command (`/history`) was built and
then **removed by decision**: it duplicated `/export`'s content, and printing
a full history into cards was ugly — the file message is the review surface.

### 10.3 `allowedUsers` allowlist

`allowedUsers` (config; `FEISHU_ALLOWED_USERS` env fallback, comma-separated)
restricts which **sender open ids** the surface serves — the user-level
counterpart of `allowedChats`. When non-empty, messages from unlisted senders
are ignored entirely (logged, no reaction/card/turn), including inside an
allowed chat; card buttons (which are commands) are gated the same way by
`operatorOpenId`. Note `ou_` open ids are app-scoped — the list is per-app.

### 10.4 Proactive @-mentions in groups

The bridge remembers the **last accepted sender** per chat (and its chat
type). When a group needs a specific human — a failed turn's `⚠️ Turn
failed` notice, an approval card, or a question card — the post carries an
`@`-mention of that requester: `<at user_id="…"></at>` in text messages,
`<at id="…"></at>` in card markdown (botmux-proven syntaxes). p2p chats get
no mention (single-user; noise). Unknown requester → no mention, gracefully.

## 11. Scheduled reminders (dsh-schedule)

Reference: `@deepseek-ai/dsh-schedule` (agent-scoped durable reminders over
the session event log). dsh-base does not mount it — the bundle adds the
`schedule` cordis row, so the agent gets the `schedule_create` /
`schedule_delete` / `schedule_list` tools.

### 11.1 Chat-native configuration

"Remind me in 5 minutes" / "remind me at 9:00 daily" — the user asks in
chat and the agent calls the schedule tools; no surface command is needed.
`every` reminders have a 5-minute floor; `after`/`at` are one-shot. Tools
are installed for root agents created after the plugin loads, so existing
chats gain them on a fresh session (/clear or a new chat).

### 11.2 Agent-initiated turns render as cards

A fired reminder wakes the agent, which injects a `user/message` whose
`source.kind` is `'plugin'` (`plugin: 'schedule'`). The streaming-card controller keys on
that marker: a card-less chat receiving a plugin-sourced user message is
an **agent-initiated turn** — the surface opens a fresh `⏰ Reminder` card
and renders the response to completion (green). User-initiated turns are
untouched (their working card state exists before any event); a resume
never replays history (historical user messages carry `source.kind:
'user'`). `/schedule` lists active reminders by folding the session log.

## Part: session-rename-archive

> Session rename/archive via dsh `sessionTitle` + `workspaceRegistry` — the
> host services the dsh web surface uses, so a rename/archive on Feishu is
> visible in the web UI and vice versa (shared durable state, same DSH_HOME).

### Intended behavior

**Trigger** — the session-detail card's ✏️ Rename and 🗂️ Archive buttons,
reachable via `/sessions` → pick a session. Previously these buttons were
hidden in real deployments because the `apiProxy` gateway service is not
mounted by dsh-base; this part replaces that seam with two base/plugin
services that ARE present after this change.

**States & transitions** — the panel view stack is unchanged
(menu → sessions → session-detail → input/confirm → back). What changes is
the mutation seam behind the two actions:

| Action | Old seam (absent in practice) | New seam (present) |
|---|---|---|
| Rename | `apiProxy.sessions.rename` | `ctx.sessionTitle.rename(session, title)` (dsh-base) |
| Archive | `apiProxy.workspace.archiveSession` | `ctx.workspaceRegistry.archiveSession(sessionId)` (new row) |
| Archived list | `apiProxy.workspace.list()` | `ctx.workspaceRegistry.archivedSessionIds` |
| Restore | archive toggle | workspace registry has no unarchive verb → restore = remove from the archived set via the same durable domain |

**Card/panel shape** — unchanged cards; the buttons now render in real
deployments. `canMutateSessions` flips from `apiProxy !== undefined` to
`sessionTitle !== undefined || workspaceRegistry !== undefined`.

**Failure modes**:
- `sessionTitle` absent → rename action reports unavailable (degrade loudly)
- `workspaceRegistry` absent → archive action reports unavailable
- session not live (daemon restarted, no agent) → rename needs a live
  Session; degrade with a clear message (resume first)
- archive of an unknown session → workspace throws
  `WorkspaceUnknownSessionError` → surface the message
- callback deadline / invalid ACK → existing panel rules apply
  (`runPanelOperation`, patch-first)

**Acceptance**:
- With the new bundle rows, the detail card shows Rename + Archive
- Rename persists (`session/title` event) and shows in the sessions list
- Archive moves the session to the archived list; restore brings it back
- Integration test asserts the buttons exist AND the actions work against
  the real dsh process (the old test degraded silently — this must not)
- Feishu and web observe each other's rename/archive (same storage domain)

### Reference

- `@deepseek-ai/dsh-session-title` — `rename(session, title)` appends
  `session/title` (harness `packages/session/session-title`).
- `@deepseek-ai/dsh-workspace` — `archiveSession` + `archivedSessionIds`,
  persisted through `storageDomain` (harness `packages/workspace/workspace`).
- `@deepseek-ai/dsh-storage-domain` — durable KV domain backing the
  workspace registry; web-app bundle mounts storage ×3 + workspace
  (`packages/bundle/web-app/cordis.patch.yml`).**


## Part: inbound-attachments

> Inbound images/files from Feishu are no longer ignored: images are injected
> into the agent's user message (the model sees them), files surface as a
> receipt card with the agent informed by name.

### Intended behavior

**Trigger** — an `im.message.receive_v1` event whose `message_type` is
`image` or `file` (the surface today only accepts `text`). The message may
arrive in a p2p chat or a group (mention gate applies exactly as for text).

**Message normalization** — `normalizeMessageEvent` learns two more types:

| message_type | content JSON | Normalized |
|---|---|---|
| `image` | `{"image_key": "img_v2_…"}` | `text: ''`, one image attachment |
| `file` | `{"file_key": "file_v2_…"}` | `text: ''`, one file attachment |

`FeishuMessage` gains an optional `attachments` array
(`{kind:'image'|'file'; key: string; name?: string}`). A message whose
`message_type` is a KNOWN but unhandled Feishu type (folder, sticker,
share_chat, share_user, system, media, merge, interactive) normalizes with
`unsupportedType` set, and the bridge replies with a loud notice instead of
dropping it silently — a user sending a folder must learn the bot cannot
process it (folder contents are not downloadable via the API). Unknown
types (not in the platform's vocabulary) stay ignored. A mixed message is
not a Feishu concept — each message is one type.

**Unified attachment path (every attachment is a file)** — a Feishu image
is a plain file to the agent: it is downloaded through the message-resource
endpoint (`im.v1.messageResource.get` — `/messages/{message_id}/resources/{image_key}?type=image`;
`im.v1.image.get` can only fetch bot-uploaded images, so user-sent images
MUST use the message-resource API; needs the existing `im:resource` scope),
then saved into the same attachment bucket as files and read by path with
the agent's workspace tools. There is NO image content block / visual-input
path — a bare image message registers as pending like a bare file
(inbound-wait-instruction part), and the agent reads the saved file. This
mirrors the decision that the DSH web paste-image-into-inputbox capability
has no meaningful Feishu equivalent.

**File path (save to the workspace, agent reads by path)** — the agent
cannot ingest arbitrary file bytes as a content block (the attachment
domain is image-only), but it CAN read files under its working directory
(its bash/read tools run under the fs sandbox, which permits
`workspace-write` inside the workspace root). The bridge therefore:
1. streams the file body through the message-resource endpoint
   (`im.v1.messageResource.get` — `/messages/{message_id}/resources/{file_key}?type=file`;
   `im.v1.file.get` can only fetch bot-uploaded files, so user-sent files
   MUST use the message-resource API). Streamed, not buffered — the
   resource API serves files up to ~100 MB; the leading bytes are peeked
   for extension sniffing and pushed back, so the full body pipes straight
   to disk (`pipeline()`; botmux's `downloadWithAppToken` lesson);
2. saves them under the chat's working directory at
   `<cwd>/.dsh_feishu/attachments/<appId>/<chatId>/<name>.<ext>` — a
   hidden subdirectory so uploads never pollute the workspace root,
   bucketed per app + chat. The name is the user's ORIGINAL `file_name`
   (Feishu file events carry it; parsed into `attachment.name`),
   sanitized for path safety (separators, traversal segments, control and
   Windows-reserved characters replaced; Unicode kept; 200-byte cap), and
   deduped WeChat-style — a same-named file re-sent in the same chat lands
   as `name(1).ext`, `name(2).ext`, … never an overwrite. Bucketing per
   chat (not per message) is what makes the dedupe fire; when no
   `file_name` survives sanitization the resource key is used (sanitized,
   same dedupe). Files are kept permanently — the agent can re-read them
   any time, and they are visible to the same tools that see the rest of
   the workspace;
3. posts a small `📎 File received` receipt card (name/extension + path);
4. injects a text note with the REAL path:
   `[user sent a file: <name>.<ext> — saved at <cwd>/.dsh_feishu/attachments/<appId>/<chatId>/<file>]`
   so the model can read it (e.g. `read` the file, grep it, run a script
   over it).

There is no downloadable URL for a Feishu `file_key` — the workspace file IS
the deliverable. A file whose download/save fails still posts the receipt
with a loud log and runs the turn text-only (an attachment never wedges the
chat).

**States & transitions** — this feature has NO new state machine: it feeds
the existing turn pipeline. The only new branch is inside
`deliverTurn` (build the content blocks before `createUserMessage`):

| Step | Attachment (image / file unified) |
|---|---|
| Download | image → message-resource (image) → bytes; file → message-resource (file) → stream + head (sniff) |
| Save | unified stream/bytes to `cwd/.dsh_feishu/attachments/<appId>/<chatId>/<name>.<ext>` (host seam, WeChat dedupe) |
| Content | `[text note with the saved path]` (no image content block) |
| Card | `📎 File received` receipt card |
| Failure | degraded receipt + loud log; turn / follow-up unaffected |

**Card/panel shape** — no new panel views. The receipt card is a plain
markdown card (like the approval/question notices), posted before
`beginTurn` so it never interferes with the streaming card.

**Failure modes**:
- message-resource download fails (scope missing, key expired):
  log loudly, post a degraded receipt (no path), and — for a bare attachment
  message — nothing registers (the follow-up text still works normally); a
  broken attachment never wedges the chat.
- File save to the workspace fails (cwd unwritable, path collision): loud
  log, receipt card still posted, pending entry is name-only.
- Group bare attachment without mention: bypasses the gate (registers
  pending — see the inbound-wait-instruction part); group TEXT still gated.
- Stale/unknown `image_key`/`file_key` at download time: same as download
  failure.

**Acceptance checklist**:
- [ ] `image` message → bytes saved under
      `cwd/.dsh_feishu/attachments/<appId>/<chatId>/`, receipt card posted,
      agent's message carries the REAL saved path (unit + integration tested)
- [ ] `file` message → bytes saved under
      `cwd/.dsh_feishu/attachments/<appId>/<chatId>/`, receipt card posted,
      agent's message carries the REAL saved path (unit + integration tested)
- [ ] A same-named file re-sent in the same chat saves as `name(1).ext`
      (WeChat-style dedupe, integration tested)
- [ ] The saved file is readable by the agent's tools (integration test
      asserts the file exists on disk at the noted path)
- [ ] No image content block is ever injected (a Feishu image is a plain
      file to the agent) — regression
- [ ] Download failure → degraded receipt, nothing registers, no wedge
      (unit-tested)
- [ ] `im:resource` scope reused — manifest unchanged, feishu-setup.md
      description updated

## Part: inbound-wait-instruction

> Bare attachment messages (file OR image — every attachment is a plain
> file to the agent) no longer start a turn by themselves: the bytes land in
> the workspace, a receipt card posts, and the agent waits for the user's
> follow-up instruction (text, or a mention in a group) before it does any
> work. The follow-up message carries every pending attachment into the
> SAME turn, in order.

### Intended behavior

**Trigger** — an inbound message whose `text` is empty AND that carries at
least one attachment (a bare `file` or `image` message; `video` and
rich-text `post` support land in the sibling inbound-rich-text feature and
reuse this pending path). Such a message is *registered* (pending) instead
of delivered: the attachment is downloaded and saved to the workspace
exactly as today, a NEW receipt card posts (the previous ones are kept —
each file gets its own card, traceable in chat history), and NO turn starts.

The pending set is a per-chat list, not a single slot: consecutive bare
attachment messages APPEND (`📎 已收到 N 个文件` on each new card), so the
user can send several files and then one instruction to analyze them all.

**How the follow-up works** — the NEXT inbound message in the same chat that
carries text drains the pending list: the saved-path notes are injected into
that turn's user content BEFORE the text, the list is cleared, and the turn
runs normally. Only the first text message after pending files fires —
later messages see an empty list. A new bare attachment message arriving
while a turn is already running simply appends to the list (the running turn
is unaffected).

**Group mention gate** — attachment messages cannot carry a mention (Feishu
sends a file/image without an input box, so `@bot` is physically
impossible), so the mention gate would otherwise dead-lock group usage: an
un-@ file would be dropped before it could ever become pending. Bare
attachment messages therefore BYPASS the mention gate and always register
(pending only — no work happens, so the gate's safety purpose is preserved:
the agent still never does anything until a gated text instruction follows).
The follow-up TEXT message still passes the normal gate (group text must
@ the bot, or solo-group
relaxation applies) — pending files are only drained by an instruction the
gate would have accepted anyway. p2p chats are unaffected (no gate).

**Feishu message model — one bubble, one message_type** — Feishu messages
are single-type: `text`, `image`, `file`, `video`, or `post` (rich text).
There is no "text + file in one bubble" — a user pasting text and attaching
a file sends two separate messages (which this feature handles naturally:
the file registers, the text drains). The `post` type is the one multi-
element bubble: its content is a 2-D array of inline elements
(`[[{tag:'text'},{tag:'img'},...],[...]]`) that CAN mix text and
attachments (image / media-video / file) in ONE message with an ORDER
that matters ("look at the picture, then read this" vs the reverse). post
support is the sibling inbound-rich-text feature (PR-A); this part's pending
path is what a text-less post's attachments will drain into.

**States & transitions** — one authoritative per-chat object,
`pendingInbound`:

| From | Event | To | Side effects |
|---|---|---|---|
| — | bare attachment message (p2p / solo / any group) | pending list non-empty | download+save each attachment; NEW receipt card (`📎 已收到 N 个文件`); NO turn |
| pending non-empty | text message, gate passed | pending drained, turn runs | inject saved paths in order before text; clear list; normal turn |
| pending non-empty | another bare attachment message | pending grows | append; another NEW card (count N+1); still no turn |
| pending non-empty | slash command | unchanged (command handles it; list stays) | command runs normally |
| pending empty | text message | (no change) | normal turn, no injection |
| — | message fails download/save | not registered | loud log + degraded receipt (existing behavior); never wedges |
| — | working-directory gate refuses the follow-up text | pending stays | existing refusal notice; user re-sends instruction after /cd |

The pending object is NOT persisted across restarts — a restart drops it
(the files remain on disk; the user re-sends an instruction and, because
the list is empty, the files are not re-attached — acceptable: the paths
are visible in the kept receipt cards, and the agent can be pointed at
them by path).

**Concurrency** — the message channel delivers a burst without awaiting
(`drainInbox` calls the handler back-to-back), so `registerPending` appends
its placeholders to the chat's pending list SYNCHRONOUSLY before any await,
and later mutates them in place. Two concurrent bare-attachment messages
each see the other's entries — a read-then-set around an await would
silently drop one of them.

**Card/panel shape** — the existing `buildInboundFileCard` gains a count:
the markdown body shows `📎 已收到 N 个文件` when more than one file is
pending (count 1 for a single file), listing the just-added file + its
path. The card still shows the saved path and the "send an instruction"
hint. NO action buttons (a button was considered and rejected: it makes
the interaction ambiguous — "do I type or tap?"; the single mental model
is "type the instruction"). Each file posts its OWN card — the previous
cards stay in chat history. No panel views.

**Failure modes**:
- Download/save fails for a bare attachment: existing loud-degrade path
  (receipt posts with a notice, nothing registers, no turn) — a broken
  attachment never wedges the chat.
- Follow-up text refused by the working-directory gate: pending list is
  kept (the user fixes /cd and re-sends); the refusal notice explains.
- Group follow-up text not @-ing the bot: existing gate drops it, pending
  stays — the user must @ the bot to trigger.
- Mid-turn new bare attachment message: appends to pending; the running
  turn is unaffected (no double delivery).
- (PR-A, inbound-rich-text) post parse fails: falls back to a text-only
  notice; `md` absent: element-array serialization is the fallback.

**Acceptance checklist**:
- [ ] Bare file message → file on disk, NEW receipt card, NO turn (mock LLM
      receives nothing) — unit + integration
- [ ] Bare image message → image on disk (sniffed extension), NEW receipt
      card, NO turn — unit + integration
- [ ] Two bare attachment messages → two files on disk, two cards
      (count 1, 2), still no turn — integration
- [ ] Follow-up text message → ONE turn whose user content carries BOTH
      saved paths in order, then the list clears — integration
- [ ] Follow-up in a group must @ the bot; un-@ text keeps the list —
      integration
- [ ] Bare attachment in a group WITHOUT @ registers (bypasses the gate) —
      integration
- [ ] Slash command while pending → command runs, list untouched — unit
- [ ] Failed download → degraded receipt, nothing registers, no wedge — unit
- [ ] No image content block is ever injected (a Feishu image is a plain
      file to the agent) — regression

### Reference

- botmux has NO wait-for-instruction mechanism (files immediately trigger
  processing) — this part is dsh-feishu's own UX, added because a file
  message otherwise starts a turn before the user can say what to do with
  it (user-reported F1.5 issue 1).
- The mention-gate bypass mirrors the reality that Feishu file messages
  cannot carry a mention (no input box) — the gate still protects the
  actual work (gated text instruction required).
- `im.v1.messageResource.get`: `type=file` covers files, audio, AND video —
  the pending download path reuses the existing file seam for all of them.
- post / video support is the sibling PR-A (inbound-rich-text), which drains
  into this pending path.

## Part: inbound-rich-text

> Feishu rich-text (`post`) and `video` messages are no longer silently
> dropped. A `post` message is normalized into a serialized markdown-ish
> string that PRESERVES the inline element order (text / image / media /
> file in one bubble — "look at the picture, then read this" vs the
> reverse), plus an ordered attachment list; a `video` message is a file
> like any other. Rich-text-with-text posts start a turn immediately (the
> existing mixed path); attachment-only posts and bare videos register as
> pending (the sibling inbound-wait-instruction path).

### Intended behavior

**Trigger** — an inbound message whose `message_type` is `post` (rich text)
or `video` (or `audio` — voice bubbles; the same `type=file` download
path serves them). These were silently ignored: the user's formatted
message (bold / lists / quotes / links / code blocks), video, or voice
vanishes with no receipt, no save, no turn. This feature makes them
first-class.

**Feishu `post` content model** — a rich-text message's `content` is a
2-D JSON array of inline element groups:

```json
{
  "title": "…",
  "content": [
    [ {"tag":"text","text":"First line:","style":["bold"]}, {"tag":"a","href":"…","text":"link"}, {"tag":"at","user_id":"…","user_name":"…"} ],
    [ {"tag":"img","image_key":"img_…"} ],
    [ {"tag":"text","text":"Second line:"}, {"tag":"code_block","language":"PYTHON","text":"print(1)"} ],
    [ {"tag":"media","file_key":"file_…","image_key":"img_…"} ],
    [ {"tag":"hr"} ]
  ]
}
```

Each outer array element is a paragraph; the inner elements are inline and
ORDERED — the order between text and attachments is information. The
official element tags: `text` (with `style`: `bold` / `underline` /
`lineThrough` / `italic`), `a` (link), `at`, `img` (image), `media` (video),
`emotion` (emoji), `hr`, `code_block` (with `language` + `text`), `file`.
The client also authors an `md` field (the markdown source) that already
carries formatting and `![img](image_key)` tokens.

**Normalization — `post` → serialized rich-text + ordered attachments** —
a `post` message normalizes into:

1. a `text` string — the linearized markdown-ish rendering of the inline
   elements, in order, with attachment placeholders inline:

```
First line: **bold** [link](https://…) @User
<image 1>

Second line: ```python
print(1)
```

<video 2>
---
```

   Mapping: `text` styles → `**`/`*`/`~~`/`<u>…</u>`; `a` → `[text](href)`;
   `at` → `@name`; `code_block` → fenced block (language + text); `hr` →
   `---`; `emotion` → its emoji text; `img` → `<image N>`, `media` → `<video
   N>`, `file` → `<file N>`. The `md` field, when present, is the preferred
   source (it already carries formatting + `![img](image_key)` tokens —
   rewritten to `<image N>` placeholders); the element array is the fallback
   when `md` is absent. Each element group is separated by a newline; the
   group order is preserved exactly.

2. an `attachments` array, in placeholder order — each `img`/`media`/`file`
   becomes an attachment (`{kind:'image'|'file', key, name?}`), numbered by
   its placeholder position (1-based). The agent correlates `<image N>` with
   the saved path via the ordered note list (the existing
   `[user sent a file: … — saved at …]` notes).

**`video` / `audio` messages** — `message_type: 'video'` (with `file_key` +
`image_key` cover) and `message_type: 'audio'` (voice bubble, `file_key` +
`duration`) normalize to a single `file`-kind attachment (the media body),
exactly like a bare file message — they register as pending and the
follow-up text drains them. `im.v1.messageResource.get?type=file` serves
files, audio, AND video, so no new download path is needed.

**Routing (reuses the sibling parts)** — after normalization:

- `post` with non-empty text → the existing mixed path: immediate turn, the
  serialized text as the `text` block and the attachments injected in
  placeholder order (the inbound-attachments part's unified path).
- `post` with text empty (attachments only) / bare `video` / bare `audio` →
  the inbound-wait-instruction pending path (receipt card, no turn, drained
  by the follow-up text).
- `post` with neither text nor attachments → ignored with a loud log (no
  usable content).

**Card/panel shape** — none new. Rich-text posts with text use the streaming
card like any text message; attachment-only posts / videos use the existing
`📎 File received` pending receipt cards. No buttons, no panel views.

**Failure modes**:
- `post` content JSON malformed (not parseable): the message degrades to a
  text-only notice with a loud log — the raw content string is NOT delivered
  as agent text (it is machine JSON, useless to the model).
- `md` field absent: element-array serialization is the fallback — never an
  empty agent message when elements exist.
- Unknown element tag: skipped with a debug log (forward-compat — new Feishu
  tags degrade gracefully rather than breaking the parse).
- Attachment download/save fails inside a rich-text post: the sibling
  degraded-receipt path (loud log, name-only note, never wedges).
- `video` / `audio` message with a stale key: same download-failure path.

**Acceptance checklist**:
- [ ] `post` with text + bold/link/code/at → agent's user message carries the
      serialized markdown-ish text with formatting preserved (unit)
- [ ] `post` mixing text + image + video → placeholders `<image 1>` /
      `<video 2>` in order, attachments array in the same order, and the
      saved paths correlate (unit + integration)
- [ ] `post` with text → immediate turn (unit + integration)
- [ ] `post` attachments-only → pending (receipt card, no turn; follow-up
      drains) (integration)
- [ ] `video` message → pending like a bare file, drained by follow-up text
      (unit + integration)
- [ ] `audio` (voice) message → pending like a bare file, drained by
      follow-up text (unit)
- [ ] `post` with `md` field → `md`-based serialization preferred (unit)
- [ ] `post` malformed content → loud log, no crash, message not delivered
      as raw JSON (unit)
- [ ] Unknown tag → skipped with debug log, rest of the post intact (unit)

### Reference

- Feishu message content spec (`open.feishu.cn … message-content-description`):
  `post` content is the 2-D element array with `text`/`a`/`at`/`img`/`media`/
  `emotion`/`hr`/`code_block`/`file` tags and the client-authored `md` field;
  styles are `bold`/`underline`/`lineThrough`/`italic`.
- `im.v1.messageResource.get`: `type=image` covers images AND rich-text
  images; `type=file` covers files, audio, AND video — the existing download
  seams serve every post element and the `video` message, no new endpoint.
- lark-cli's `lark-event-im` reference confirms `post` / `video` are distinct
  `message_type` values alongside `text`/`image`/`file`/`audio`/`sticker`.
- botmux's rich-text handling flattens post content to text only (no
  attachment ordering) — dsh-feishu's ordered-placeholder serialization is
  our own design, preserving the intra-bubble order the user asked for.
- The pending routing reuses the sibling inbound-wait-instruction part
  (drained by the follow-up text; attachment messages bypass the group
  mention gate because Feishu cannot @ from an attachment).

## Part: outbound-files-images

> The agent can send a file or image to the Feishu chat by calling an
> explicit `send_file` tool: it names a workspace path (and optionally a
> description), the surface uploads the bytes through the message-resource
> API and posts a native Feishu image/file message, then reports the send
> back to the agent and shows a small receipt card.

### Intended behavior

**Why active, not passive** — dsh has no host-level "agent produced a file"
event (the web UI's "Turn produced files" is a client-side derivation from
tool cards' `locations`, invisible to a plugin; see the sibling feature
`turn-produced-files`). Rather than guess from `tool/result` or fs
observation, the surface injects a first-class **`send_file` tool** that the
agent calls deliberately when it wants to deliver a file/image to the user.
Active tool invocation is deterministic and self-describing — the agent
knows what it produced and why it sends it, so no heuristics or false
positives.

**Trigger** — an agent calls the `send_file` tool during a turn:
`send_file(path, description?)`.

- `path` (string, required): the file/image to send — an absolute path or a
  workspace-relative path. An absolute path is used as-is; a relative path is
  resolved against the chat's pinned working directory (`cwd`).
- `description` (string, optional): a short, human, English explanation of
  what is being sent; it is shown verbatim as the text line that precedes the
  file (the intro IS this description). Returned to the agent as the tool's
  result context.

**Tool registration** — via dsh's tool runtime: `ctx.get('tools')?.register(defineTool({...}))`
(the feature-detect pattern, mirroring `ctx.commands` / `ctx.watch`). The
registration is in the GLOBAL scope, so every agent can call it. The tool
definition follows the reference `tool-fs` `write` tool:
`ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`.
`@deepseek-ai/dsh-tools` is added as a runtime dependency (it exports the
`defineTool` helper — a runtime function, not a type-only import).

**Execution** — `execute(args, exec: ToolRunContext)` runs in the host
process (the same one running the surface):

1. resolve `cwd = exec.agent.session.header.cwd` (the chat's pinned working
   directory) and `chatId = sessionMap.chatFor(exec.agent.session.id)`.
2. resolve the send target: an absolute `path` is used as-is, a relative one
   is joined onto `cwd` (`resolveSendPath`) — never re-join an absolute path
   (double-prefix bug). read the bytes; a missing/unreadable file is a tool
   error (loud, no upload).
3. **classify** the type by extension + magic bytes (reuse `sniffExtension`):
   a known image container (png / jpg / gif / webp) → an image message via
   `im.v1.image.create`; any other type → a file message via
   `im.v1.file.create` (already supports binary). Upload the bytes, then
   `createMessage(chatId, 'image'|'file', ...)`.
4. on success, post a short text line: the `description` verbatim when given,
   else `Sending <name>:` FIRST, then the file — no
   receipt card; the intro line IS the affordance. A text-post failure is
   logged and does not fail the tool.
5. return a structured value to the agent (the sent file name + the message
   the user sees), so the agent can acknowledge.

**No chips / auto-collection** — this part is the *transport + tool*
foundation only. The "show each turn's produced files as clickable chips"
UX is the sibling feature `turn-produced-files` and is deliberately out of
scope here.

**Card/panel shape** — no receipt card. The tool posts a short text line
(the `description` verbatim, else `Sending <name>:`) followed by the native
image/file message at the moment the upload succeeds, independent of the
streaming card (which keeps
rendering the turn's tokens). No new panel views, no buttons.

**Failure modes**:
- `tools` service absent (host did not mount it): feature-detect — the
  surface logs loudly and does not register `send_file`, so the agent never
  sees it (never a broken tool). The turn still runs normally.
- Path missing / unreadable / outside cwd: tool error — `{ isError: true }`,
  a loud log, and a clear message to the agent (no partial upload).
- Upload fails (`im.v1.image.create` / `im.v1.file.create` error, auth): tool
  error with the API message; the agent is told it did not send.
- Unsupported file type (no known classifier): falls back to a `file` message
  (the resource API serves arbitrary file bytes); `type=file` covers audio
  and video too.
- Oversized file: the platform's limit is surfaced as a tool error.

**Acceptance checklist**:
- [ ] `send_file` is registered and visible to the agent's tool schema
      (integration: the agent's request body carries the `send_file` tool).
- [ ] Agent calls `send_file({ path, description })` → a native image message
      posts for an image path (png/jpg/gif/webp) and the bytes match
      (unit + integration).
- [ ] Agent calls `send_file` with a non-image path → a native file message
      posts and the bytes match (unit + integration).
- [ ] A short text line (the `description` verbatim, else `Sending <name>:`)
      posts before the file; NO receipt card posts (unit).
- [ ] An absolute `path` is used as-is (not re-joined onto the cwd) and a
      relative one resolves against the cwd (unit).
- [ ] The tool returns a structured value to the agent (name + confirmation)
      (unit).
- [ ] Missing/unreadable path → tool error, no upload, no text line (unit).
- [ ] `tools` service absent → `send_file` not registered, loud log, turn
      still runs (unit).
- [ ] No chips / auto-collection in this part (deferred to
      `turn-produced-files`) — regression guard.

### Reference

- dsh tool runtime `ctx.tools` (`@deepseek-ai/dsh-tools`): `register(defineTool({...}))`
  — `ToolDefinition` = `ToolSchema` + `output { schema, render }` +
  `execute(args, exec)`; `exec.agent.session.header.cwd` gives the chat's
  working directory, `exec.agent.session.id` the session. Reference
  `packages/fs/tool-fs/src/write.ts` (`ctx.tools.register(defineTool(...))`
  + `execute`).
- Feishu message-resource API: `im.v1.image.create` uploads an image
  (`image_type` + bytes) → `createMessage('image')`; `im.v1.file.create`
  uploads a file (`file_type: 'stream'` + `file_name` + bytes) →
  `createMessage('file')`. `type=file` on the resource API serves files,
  audio, AND video. Existing scope `im:resource` is reused (no new scope).
- botmux's `uploadImage`/`uploadFile` (`src/im/lark/client.ts`) are the
  transport reference for the upload paths; botmux only forwards user-pasted
  attachments (create-session banner), not agent-produced ones — there is no
  agent-produce signal to copy (see sidecar research).
- The surface's existing `transport.sendFile(chatId, fileName, content)`
  (`src/transport.ts`) already uploads + posts a file; `send_file` extends it
  to images and to reading real workspace bytes (not just a string).

## Part: turn-produced-files

> After a turn ends, the streaming card lists the files the agent produced
> (write/edit mutations) as clickable chips; tapping a chip sends that file
> to the chat as a native Feishu image/file message. Mirrors the DSH web
> "Turn produced files" row (same paths, path-level parity).

### Intended behavior

**Why path-level parity, not render-intent parity** — the DSH web UI derives
produced files from the tool-result card's render intent
(`card === 'diff'` or `generic + edit` → `locations[].path`), built by the
browser-only `client-runtime` from each tool's `presentCall`/`presentResult`.
That render-intent data is NOT in the host session event stream — the
surface (a plugin) cannot see `card`/`locations`. The host CAN see
`tool/result`'s `meta` (the tool's private presentation payload) and the
correlated `tool/call` row. So the surface reproduces the SAME *set of
produced paths* (write/edit mutations) by combining both host-visible
sources — path-level parity, same paths the web row lists.

**Host-visible mutation signal** — the fs write/edit mutation tools persist a
`meta.diffs` KEY on `tool/result`: a non-empty `{path, oldText, newText}[]`
for an update/overwrite, an empty list for a new-file CREATE (there is no
before-image to diff). Reads carry a window/snippet meta (NO `diffs` key),
deletes and plain terminal tools carry none — so the presence of a `meta.diffs`
KEY (even an empty array) is the mutation signal, exactly the web's
render-intent rule ("a read looked, a delete removed, a terminal ran").

**Trigger** — a `tool/result` session event whose `meta` has a `diffs` array
key. For a non-empty `diffs`, the FIRST entry's `path` is taken (a mutation
tool touches one file; the row is the file). For an empty `diffs` (a create),
the path is not in meta, so it is derived from the correlated `tool/call`
arguments' `file_path` (the fs write/edit tools name the target there,
matching the web's `presentCall.locations`). No correlated `tool/call` row
and an empty `diffs` → nothing added (never a broken chip).

**State** — `ChatCardState` gains `producedPaths: string[]` (the authoritative
turn-scoped produced-file paths, deduped, in arrival order). It is reset when
a new turn starts (`turn/start`) and filled as `tool/result` events arrive.
`CardSnapshot`/the one render path (`syncCard`) carry it.

**Card/panel shape** — the streaming card's FINAL state (done / stopped /
error) renders a `📎 Produced` row under the last tool/message row: one
button per produced path (label = basename). Tapping a chip sends that file
to the chat via the existing outbound transport (`sendImage` for image
extensions, `sendFile` otherwise — the #29 `send_file` foundation). The chip
is a card action (`value.kind: 'send-produced'`, `value.path`); it does NOT
mutate card state (only sends + a debug log), and the card stays in its
terminal state. Sends a file message only — no extra receipt card (the chips
row IS the affordance).

**Ordering/cleanup** — `producedPaths` is turn-scoped: `turn/start` resets it,
`turn/end` freezes the chip row (the card finalizes with it). A subsequent
turn's mutations replace the previous list. The tools' `meta.diffs[].path` are
ABSOLUTE (the fs write/edit tools report the resolved path), so `send-produced`
accepts an absolute path as-is and only joins a relative one onto the pinned
`cwd` — never re-join an absolute path (the double-prefix bug).

**Failure modes**:
- `meta` absent / `diffs` empty: nothing added (reads, deletes, terminals —
  correct exclusion).
- `meta.diffs` present but malformed (no path): skipped with a debug log
  (never a broken chip).
- Chip click while the file is gone (deleted between turn and click): the
  send fails loudly (tool error surfaced), no partial send, card unchanged.
- Chip click on an unsupported type: `sendFile` handles it (the resource API
  serves arbitrary bytes incl. audio/video).
- No produced paths: no `📎 Produced` row renders (the card looks as today).

**Acceptance checklist**:
- [ ] A `tool/result` with a non-empty `meta.diffs` adds the first path to
      `ChatCardState.producedPaths` (unit).
- [ ] A `tool/result` with an EMPTY `meta.diffs` (a new-file create) adds the
      path from the correlated `tool/call` arguments' `file_path` (unit).
- [ ] A `tool/result` from a read (meta without a `diffs` key) does NOT add a
      path (unit).
- [ ] `turn/start` resets `producedPaths`; `turn/end` keeps the accumulated
      list for the final chip row (unit).
- [ ] The final card renders one `📎 Produced` chip per produced path
      (label = basename) (unit + integration).
- [ ] Tapping a chip sends the file to the chat (image path → image message,
      other → file message) (integration).
- [ ] A chip click never mutates card state (the card stays terminal) (unit).
- [ ] No produced paths → no `📎 Produced` row (unit).
- [ ] Malformed `meta.diffs` / an empty `meta.diffs` without a correlating
      `file_path` skips with a debug log (unit).

### Reference

- DSH web `packages/client/ui-deliverables/src/client/turn-deliverables.ts`:
  `producedPaths(view)` returns `locations[].path` only for
  `card === 'diff'` or `generic + edit` — the render-intent rule this part
  mirrors at path level (client-only per its header, so the host replicates
  the path set from `meta.diffs`).
- dsh agent-loop `packages/core/agent-loop/src/tool-calls.ts`:
  `session.append('tool/result', { ..., meta })` — `meta` is the tool's
  private presentation payload persisted on the session event, carrying the
  fs mutation diffs (write/edit) the surface reads.
- fs tools `packages/fs/tool-fs/src/write.ts` / `edit.ts`: presentCall /
  presentResult return `{ card:'diff', locations:[{path}] }`; `result.meta`
  carries `diffs` (write/edit). read.ts persists a window/snippet meta (NOT
  diffs) — the exclusion signal.
- Surface `src/cards/StreamingCardController.ts` (ChatCardState, `snapshot`,
  `syncCard`) — the single authoritative state + render path this feature
  extends; the `#29` outbound `sendImage`/`sendFile` transport is reused.

## Part: session-stats-context

> On the terminal streaming card, a compact stats line shows the session's
> cumulative turn/step/tool/token usage (exact fields only) plus a context
> occupancy percentage, mirroring the DSH web `StatsLine`/context meter as a
> path-level parity surface. No timing/throughput (TTFT/tok/s/duration) — the
> host cannot see the web's `node.timing`; only exact counted fields.

### Intended behavior

**Why exact fields, not timing** — the DSH web `StatsLine` (`turn-metrics.ts`,
`StatsLine.tsx`) derives TTFT/tok/s/duration from per-node `node.timing`
(`stepStartTime`/`firstTokenTime`/`completedTime`) and a `sessionStats`
whole-log projection — both browser-side. The host plugin sees only the
session event stream, and the events carry `usage: TokenUsage` (input/output/
cacheRead/cacheWrite) but NOT timing. So the surface reproduces the counted
fields exactly (turns/steps/tool calls/tokens/cache-hit) and the context
occupancy (used tokens vs the model's `contextWindow`), and omits any
timing-derived figure (duration, TTFT, tok/s) that would require estimating
from event timestamps.

**Trigger** — a terminal streaming card for a chat that has any session
activity. The line renders on the card's FINAL state (done / stopped / error),
bundled with the other terminal rows (e.g. `📎 Produced` chips). It is NOT
shown while working.

**State** — `ChatCardState` gains a session-scoped accumulator (NOT reset per
turn — it is cumulative for the whole session, mirroring the web's whole-log
`sessionStats`):

- `turnCount` — number of recorded turns (`turn/start` increments).
- `stepCount` — number of assistant steps (`assistant/message` increments).
- `toolCount` — number of tool calls (`tool/call` increments).
- `tokenUsage` — accumulated `TokenUsage` (`assistant/message.usage` summed
  across steps; absent usage contributes nothing).
- `contextWindow` — the chat's current model `contextWindow` (from `ctx.llm`
  resolution) when known; `undefined` until resolved.

`CardSnapshot`/the one render path (`syncCard`) carry it.

**Card/panel shape** — on the terminal card, after the content and alongside
any `📎 Produced` chips, render a single line of `|`-separated groups
(mirroring the web `StatsLine` groups, but only the exact fields):

1. counts — `N turns · M steps` (omitted when no activity).
2. tokens — `input A · output B` (`formatTokens`: 517 / 12.2K / 517K / 1.2M),
   plus `cache X%` when there is billed input.
3. context occupancy — `context P%` when both `usedTokens` and `contextWindow`
   are known (rounded integer, upper-clamped at 100).

Tool-call count is folded into the counts group in parentheses only when a
tool ran (`M steps · T tools`). No timing group is ever shown.

**Failure modes**:
- No session activity yet: no stats line renders (the card looks as today).
- `assistant/message` without `usage`: contributes no tokens (never a zero
  token group on a session whose steps all failed to bill).
- `contextWindow` unknown (model resolution absent/failed): the context
  occupancy group is omitted (only the counts/tokens groups show).
- Chat with no pinned cwd: unaffected (this is a read-only card line, no
  sending, no path resolution).

**Acceptance checklist**:
- [ ] `assistant/message.usage` accumulates into the token totals; a step
      without usage contributes nothing (unit).
- [ ] `turn/start` / `assistant/message` / `tool/call` increment the counts
      correctly; counts are SESSION-scoped (not reset at `turn/start`) (unit).
- [ ] The terminal card renders the counts + tokens (+ cache %) groups only
      for exact fields; never a timing group (unit + integration).
- [ ] Context occupancy group renders when `contextWindow` and usedTokens are
      known, and is omitted otherwise (unit).
- [ ] No activity → no stats line (unit).
- [ ] The stats line is terminal-only (not while working) and does not mutate
      card state (unit).

### Reference

- DSH web `packages/client/ui-conversation/src/client/chat/turn-metrics.ts`
  and `StatsLine.tsx`: `deriveTurnMetrics`/`deriveStats` read `node.timing`
  (TTFT/decode) and `sessionStats`/`tokenUsage` projections — the browser-only
  source of timing+token figures. `formatTokens` / `formatDuration` /
  `cacheHitPercent` / `contextOccupancy` give the exact display rules this part
  mirrors for the count/token/context groups (timing groups deliberately
  excluded).
- Installed dsh types: `dsh-session` `SessionEventMap['assistant/message']`
  carries `usage?: TokenUsage`; `dsh-llm` `TokenUsage`
  (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`) and
  `LlmResolvedModelInfo.context.contextWindow` — the host-visible data.
## Part: message-queue

> Messages received while a turn runs no longer interrupt it — they queue
> on their OWN dedicated card, one card per queued message with one lifecycle
> state machine per card (no shared "N queued" card and no recall/re-post
> single-card invariant). Each queued item is steered (injected into the
> running turn), edited, or removed; terminal-item cards are RETAINED showing
> their status marker. Mirrors the DSH web `QueueDock`.

### Intended behavior

**Why one card per queued message, not rows on the streaming card** — the
DSH web surfaces queued input in a `QueueDock` (a fixed element), and the
production concern (user report): a message sent while a turn runs must be
*visibly accepted*, otherwise the streaming card looks "dead" (no bubble under
the user's message). Posting a dedicated card that confirms "queued" makes
acceptance unambiguous. Each queued message is ONE card with its OWN lifecycle
state, so the user can follow a single item from `queued` → `editing` →
`steering` → `steered`/`sent`/`removed` without recalling and re-posting a
shared card. A single shared card was fragile (built with a per-item `form`
+ `input.default_value` — a Feishu 400 — and hard to maintain).

**Trigger** — a user message arriving while the chat's turn is running
(`streaming.isWorking(chatId)`). Such a message is NOT delivered as a new
turn immediately; it is kept in the surface's OWN in-memory queue and posted
as its OWN `buildQueueItemCard` (status `queued`).

**Queue data / state** — the queue is the SURFACE-OWNED, in-memory
`Map<chatId, QueueItem[]>` (never the agent inbox's `nextTurn` list, which the
agent loop auto-claims at its own step boundary and would bypass
`deliverTurn` — the user sees the "Sent" marker but no streaming card). It is
surface-owned (not session-owned), so a card re-render never loses it; not
persisted, so a restart drops queued messages (accepted trade-off). Each item
carries the resolved `UserMessage` (re-deliver / steer), `text`, `status`, and
the original inbound message. Alongside it, the bridge keeps a per-item card
registry `Map<chatId, Map<itemId, { cardMessageId, status, text, message,
feishu }>>` so each item's dedicated card is updated IN PLACE (`updateCard`)
as its lifecycle state changes — even after the item leaves the active queue
(a retained marker card still needs its preview text).

**Item lifecycle states (one state machine per card)**:
`queued | editing | steering | steered | sent | removed`
- **queued** — waiting in the queue. Header `⏳ <preview>` + the message
  preview + actions: `➡️ Steer` (ONLY while a turn runs; when idle omit Steer
  and show a disabled hint), `✏️ Edit` (opens the inline edit form), `🗑️
  Remove` (delete).
- **editing** — the inline edit form is open on THIS card: a single `form`
  with one `input` + a `form_submit` Submit and a Cancel button. Submitting
  returns to `queued` with the new text; Cancel returns to `queued` unchanged.
  NO `input.default_value` (the verified `buildInputCard` shape — a
  `default_value` on the input produced the Feishu 400).
- **steering** — Steer was clicked; waiting for the agent to consume it at its
  step boundary. Shows "💬 Steering…", no buttons.
- **steered** — the agent consumed the steering. Shows "✅ Steered", no
  buttons.
- **sent** — the queued message was delivered as its own turn after the owning
  turn ended (non-steer path). Shows "📤 Sent", no buttons.
- **removed** — the user removed it. Shows "🗑️ Removed", no buttons.

After a terminal state (`steered` / `sent` / `removed`) the card is RETAINED
showing its status marker — never auto-recalled. There is no single shared
card.

**Card/panel shape** — one `buildQueueItemCard(item, running)` per queued
message:
- Header: `⏳ <preview>` (queued) or `⏳ <state label>` (editing/steering/
  steered/sent/removed).
- Body: the message preview, then the status marker (steering/steered/sent/
  removed) or the actions (queued) or the edit form (editing).
- The per-item actions (driving the SURFACE-owned queue, mirroring the web
  `updateQueue`):
  - `queue-steer`: only when a turn runs; take the item out of the surface
    queue then `agent.steer(message)` (the driver consumes it at its NEXT STEP
    boundary — never the `nextTurn` list). Mirrors the web
    `steer-unavailable` guard. Sets the card `steering`; the next
    `user/message` event for that message flips it to `steered`.
  - `queue-edit`: opens the inline edit form (`editing`).
  - `queue-edit-submit`: rewrite the queued content in the surface queue
    (keeping the SAME identity) → `queued`.
  - `queue-edit-cancel`: → `queued` unchanged.
  - `queue-remove`: take the item out of the surface queue → `removed`.

**Queue consumption** — after a turn ends (`turn/end`), the surface drains its
OWN queue: each queued non-steer message is delivered as its own turn
(`beginTurn` → `followup`), which opens a streaming card exactly like a
freshly arrived message. One item is delivered per `turn/end` — delivering the
next immediately would put it in the agent inbox where the loop auto-claims it
without a streaming card — so the chain continues on the next `turn/end`. Each
delivered item is marked `sent` and its retained card updated. A steered
message flows into the running turn via `agent.steer` and is NOT transferred to
a new card; the streaming trace adds a `steering` row where it was injected
(Fix 1), so the user sees exactly the message they steered.

**Streaming trace (steering row)** — when the streaming card receives the
steered message's `user/message` event (source kind `user`, injected mid-turn
by `agent.steer`), the controller adds a `{ kind: 'steering', id, text }` row
to the trace. Collapsed shows just `steer`; expanded shows the full steered
message text — the user always sees where their steered message was inserted.

**Failure modes**:
- No inbox (agent absent / `agent.inbox` unavailable): the message is
  delivered as a normal turn (degrade to today's behavior), logged — never a
  broken queue.
- Steer while idle (`streaming.isWorking(chatId)` false): the button is
  omitted and a disabled hint ("steer unavailable — no turn running") is
  shown; no card action fires.
- Queue item already consumed (turn boundary raced the click): the action
  reports "no longer pending" (a text notice) and, if still `queued`/`editing`,
  marks the item `sent`.
- Card update/post failure: logged; the registry state is unchanged — the next
  mutation re-renders.
- A chat with no pinned cwd: the working-directory gate still refuses the
  FIRST turn; a queued message that reaches a turn picks up the cwd as today.

**Acceptance checklist**:
- [ ] A message sent while a turn runs is queued in the SURFACE queue (not the
      agent inbox `nextTurn`), not delivered as an interrupting turn; it posts
      its OWN item card, and after `turn/end` it is delivered as its own turn
      opening a streaming card (unit + integration).
- [ ] Each queued message gets its own card (one per item); mutations update it
      in place (`updateCard`), never delete+send; no card is ever recalled
      (unit + integration).
- [ ] Every lifecycle state renders the right buttons/marker: queued
      (Steer/Edit/Remove, Steer only while a turn runs), editing (edit form),
      steering ("💬 Steering…"), steered ("✅ Steered"), sent ("📤 Sent"),
      removed ("🗑️ Removed") — the terminal cards have no buttons (unit).
- [ ] Steer while running sets the card `steering`; a later `user/message`
      flips it to `steered`, and the streaming trace shows a `steer` row
      (expanded = the full steered text) (unit).
- [ ] Edit opens the form; submit replaces the text and returns to `queued`;
      cancel returns unchanged; no `input.default_value` (unit).
- [ ] Remove marks the card `removed` and retains it (unit).
- [ ] Agent inbox absent → degrade to a normal turn, logged loudly (unit).
- [ ] The queue item card does not interfere with the streaming card /
      produced chips / stats line (integration).

### Reference

- DSH web `packages/client/ui-conversation/src/client/queue/QueueDock.tsx`:
  renders the queue as a dock, `{ kind: 'edit' | 'remove' | 'steer' }` actions
  via `updateQueue`, a collapsible count header (single item renders directly),
  and a `queueMutable` gate when a subagent owns the session.
- DSH web `packages/client/runtime/src/client/sessions/session.ts`
  (`updateQueue`) + `packages/host/apiproxy/src/api-proxy.ts`: the queue
  action mapping — `edit` → `inbox.replace`, else `inbox.remove` then
  `agent.steer(message)` for `steer`; steer requires `target === 'next-turn'`
  AND `agent.status === 'running'` (else `steer-unavailable`). The dsh-feishu
  surface maps these to its OWN queue (the agent inbox is NOT used for
  non-steer queued messages); only `agent.steer` is delegated.
- dsh `@deepseek-ai/dsh-agent` `Inbox` (`inbox.d.ts`): `nextTurn` list,
  `append`/`prepend`/`replace`/`remove`/`clear`, and `Agent.steer` (`runtime-types.ts`):
  a running driver consumes steering at its NEXT STEP boundary, never
  mid-step. dsh-feishu uses `agent.steer` only; it never appends non-steer
  queued messages to the inbox.


## Part: model-switch-current

Switch the current session's model immediately when /model picks one (also set the default).

Reference: dsh web's `/model` (client `dsh-client-ui-model-selection` →
`session.selectModel` RPC; host `dsh-host-apiproxy` → `selectionFor(agent)` +
`installModelSelection`, plus `saveDefaultModelSelection`).

### Intended behavior

`/model` (typed `<provider>/<model>` or a picker pick) now does **both** (the
maintainer's "B"):

1. Saves the selection as the **deployment default** (`agentDefaultModel.saveSelection`)
   so future sessions default to it.
2. Couples a mutable `ModelSelection` to the **current session's live agent**
   (`installModelSelection(agent.ctx, ref)` once, then `ref.current = selection`),
   so the NEXT turn in that chat assembles with the picked provider/model.

The reply text is `Model set to <provider> · <model> (this session + default).`

The **read** side (`currentModelSelection`, used by the model picker's current
preselection and the no-catalog `/model` text display) prefers the
session-switched `ref.current` over the live agent's static `options` — a
switch writes the ref but never mutates `agent.options`, so reading `options`
would show the pre-switch model (the `#40 display bug`). It falls back to
`agent.options`, then the deployment default.

### Seam

- `ctx.agentDefaultModel.saveSelection` — default (existing).
- `installModelSelection(agent.ctx, ref)` — per-session switch (runtime import
  from `@deepseek-ai/dsh-agent`; a deliberate exception to the repo's
  "type-only `@deepseek-ai/*` imports" convention, maintainer decision).
  `@deepseek-ai/dsh-agent` moves to `dependencies`.

### Failure modes

- Live agent absent (no session yet): the switch is a no-op (`applySessionModelSwitch(undefined)`
  returns early); the default is still saved. Reply still reports the model is set.
- `agentDefaultModel` not mounted: `/model` errors (unchanged).
- Future dsh without `installModelSelection`: the import would fail at load;
  documented as version-coupled to the dsh family bump.
4d2ba302 (feat: /model switches the current session's model immediately (and sets the default))
