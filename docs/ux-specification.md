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
(`{kind:'image'|'file'; key: string; name?: string}`). Unknown types stay
ignored. A mixed message is not a Feishu concept — each message is one type.

**Image path (agent sees the image)** — the transport downloads the image
bytes through the message-resource endpoint (`im.v1.messageResource.get` —
`/messages/{message_id}/resources/{image_key}?type=image`; `im.v1.image.get`
can only fetch bot-uploaded images, so user-sent images MUST use the
message-resource API; needs the existing `im:resource` scope), then the
bridge saves them through the host's attachment store (`ctx.attachments`
— `dsh-attachment-local` is part of the dsh-base bundle, so the seam is
REALLY mounted, unlike `apiProxy`) and injects
`{type:'image', attachment}` as a content block of the agent's user message
(the reference is `packages/host/apiproxy/src/api-proxy.ts` →
`durablePromptContent`: `saveImages(bytes) → refs → {type:'image'}` blocks).
The turn then runs normally; the model can describe/read the image.

**Image capability gate** — the DeepSeek chat-completions adapter REJECTS
image content (`UNSUPPORTED_CONTENT` → the whole turn ends in error), while
pi-ai accepts it. The bridge therefore injects an `image` block ONLY when
the chat's current model advertises `image` in its input modalities
(`ctx.llm.listModels` → `inputModalities`, via the same model directory the
`/model` picker reads). Unknown model capability → conservative: treat the
image as a file (receipt + name note). A turn must never error because of
an attachment.

**File path (save to the workspace, agent reads by path)** — the agent
cannot ingest arbitrary file bytes as a content block (the attachment
domain is image-only), but it CAN read files under its working directory
(its bash/read tools run under the fs sandbox, which permits
`workspace-write` inside the workspace root). The bridge therefore:
1. downloads the file bytes through the message-resource endpoint
   (`im.v1.messageResource.get` — `/messages/{message_id}/resources/{file_key}?type=file`;
   `im.v1.file.get` can only fetch bot-uploaded files, so user-sent files
   MUST use the message-resource API);
2. saves them under the chat's working directory at
   `<cwd>/.dsh_feishu/attachments/<appId>/<messageId>/<key>.<ext>` — a
   hidden subdirectory so uploads never pollute the workspace root,
   bucketed per app + message (botmux's `attachment-path.ts` layout) so
   concurrent chats and apps never collide. The name is derived from the
   resource key + a content sniff for the extension (Feishu file events do
   NOT carry the original file name, so the surface cannot preserve it).
   Files are kept permanently — the agent can re-read them any time, and
   they are visible to the same tools that see the rest of the workspace;
3. posts a small `📎 File received` receipt card (name/extension + path);
4. injects a text note with the REAL path:
   `[user sent a file: <key>.<ext> — saved at <cwd>/.dsh_feishu/attachments/<appId>/<messageId>/<file>]`
   so the model can read it (e.g. `read` the file, grep it, run a script
   over it).

There is no downloadable URL for a Feishu `file_key` — the workspace file IS
the deliverable. A file whose download/save fails still posts the receipt
with a loud log and runs the turn text-only (an attachment never wedges the
chat).

**States & transitions** — this feature has NO new state machine: it feeds
the existing turn pipeline. The only new branch is inside
`deliverTurn` (build the content blocks before `createUserMessage`):

| Step | Image (model supports) | Image (not) / File |
|---|---|---|
| Download | message-resource (image) → bytes + mediaType | message-resource (file) → bytes + name |
| Save | `ctx.attachments.saveImage` → ref | write `cwd/.dsh_feishu/attachments/<appId>/<messageId>/<key>.<ext>` (host seam) |
| Content | `[text, {type:'image', attachment}]` | `[text note with the saved path]` |
| Card | none (streaming card already opens) | `📎 File received` receipt card |
| Failure | card + text notice, turn still runs text-only | same |

**Card/panel shape** — no new panel views. The receipt card is a plain
markdown card (like the approval/question notices), posted before
`beginTurn` so it never interferes with the streaming card.

**Failure modes**:
- message-resource download fails (scope missing, key expired):
  log loudly, post a `⚠️ Could not download` text notice, and run the turn
  text-only — a broken attachment must never wedge the chat.
- `ctx.attachments` absent (attachment-local not mounted): feature-detect
  and degrade — images fall back to the file path (receipt + text note)
  with a loud log, matching the "hide the row, don't fail" seam rule.
- `saveImage` rejects bytes (unsupported format, over limits): loud log +
  text notice; turn continues without the image block.
- File save to the workspace fails (cwd unwritable, path collision): loud
  log, receipt card still posted, turn continues with the name-only note.
- Group message without mention: the existing mention gate drops it before
  any download — no attachment handling for ignored messages.
- Stale/unknown `image_key` at download time: same as download failure.

**Acceptance checklist**:
- [ ] `image` message + image-capable model → agent's user message carries an
      `image` content block (unit-tested via a fake image-capable llm)
- [ ] `image` message + text-only model → degrades to a `📎 File received`
      receipt + name note; turn completes (no UNSUPPORTED_CONTENT error)
      (unit + integration tested)
- [ ] `file` message → bytes saved under `cwd/.dsh_feishu/attachments/<appId>/<messageId>/`, receipt card
      posted, agent's message carries the REAL saved path (unit + integration
      tested)
- [ ] The saved file is readable by the agent's tools (integration test
      asserts the file exists on disk at the noted path)
- [ ] Group messages still gated by the mention gate (no attachment handling
      for ignored messages)
- [ ] Download failure → loud notice, turn continues text-only (unit-tested)
- [ ] `attachments` service absent → image degrades to the file path, loud log
      (unit-tested)
- [ ] `im:resource` scope reused — manifest unchanged, feishu-setup.md
      description updated
