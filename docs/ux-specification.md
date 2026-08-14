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
line `think -> bash -> read -> …` (full sequence, never truncated — user
directive), and the button area gains `▸ Expand`.

### 1.2 Card state machine (single authoritative state)

Reference: user feedback rounds 4–6 (collapsed default, details click must
not collapse, streaming must continue while collapsed, "card reverted to
working after panel" — the design that replaced ad-hoc per-action patches).

One `ChatCardState` per chat is the **single authoritative source** for the
streaming card: `title`, `content`, `rows`, `openThinkId`, `status`
(working/done/stopped/error), `collapsed`. The bridge renders the card from
this state and nothing else.

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
  bridge owns the compaction card lifecycle itself — `compaction/start`
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
  - **working**: `⏹ Stop`.
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
| `/sessions` | session | session list card (title/id/cwd/age/live/saved), paginated, per-row Resume buttons |
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

- `/sessions` rows are two lines: line 1 = `**title** · age · badges`
  (the ★ current marker inline), line 2 = `` `id` · cwd `` (quiet identity);
  page indicator is a `note`.
- `/sessions` + `/resume` data: `ctx.sessionQuery` (mounted by dsh-base's
  `session-query-sqlite`), `listSessions()` newest-first + batch
  `readTitleSnapshots()` for titles. When the service is absent the surface
  degrades to a bound-sessions-only listing (loud log).
- Resume flow (shared by `/resume <id>` and the picker's Resume button):
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

### 8.6 Panel palette

`buildPanelCard(statusLine, running, commands, page)`: the core row
(Stop while running / Retry / Copy) stays first; below it the full command
palette — all 16 commands as buttons, grouped by category with emoji
headers (`🧩 Session` / `💬 Chat` / `⚙️ System`), `PANEL_PAGE_SIZE = 8`
buttons per page, a quiet `note` page indicator (`Commands · page 1/2`),
and ◀️/▶️ nav hidden at the bounds. Each category renders as its own block
— the header line followed by THAT category's button row (headers never
stack before all buttons). Each button stamps `{kind:'command',
name}` and executes the same handler as the slash line. The status line
carries the chat's session context (`session `id` · `cwd``) so a tap
always shows what the buttons act on. The panel is stateless: every
open/pager posts a fresh card built from the current authoritative state
(no stale-guard needed).

### 8.7 State-machine matrix for the new actions

| Action \ Status | none | working | done | stopped | error |
|---|---|---|---|---|---|
| command (read-only) | allowed | **allowed** | allowed | allowed | allowed |
| command (mutating) | allowed | **refused** "stop first" | allowed | allowed | allowed |
| resume-session | allowed* | **refused** | allowed* | allowed* | allowed* |
| panel-page / sessions-page | stateless page re-send (no card-state transition) | | | | |

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
`source.kind` is `'plugin'` (`plugin: 'schedule'`). The bridge keys on
that marker: a card-less chat receiving a plugin-sourced user message is
an **agent-initiated turn** — the surface opens a fresh `⏰ Reminder` card
and renders the response to completion (green). User-initiated turns are
untouched (their working card state exists before any event); a resume
never replays history (historical user messages carry `source.kind:
'user'`). `/schedule` lists active reminders by folding the session log.
