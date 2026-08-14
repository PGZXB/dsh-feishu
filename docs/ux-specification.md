# UX Specification

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
3. **Execution status line** — `**… working**` / `**✅ Done**` /
   `**⏹ Stopped**` (user-interrupted) / `**⚠️ Turn ended with an error**`.
4. **Button area** — Section 3.

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

### 1.4 Turn lifecycle

| Event | Card behavior |
| --- | --- |
| `turn/start` (via message) | open card, status working |
| `assistant/chunk` text-delta | append to answer, patch |
| `assistant/chunk` reasoning-delta | append to open think row, patch |
| `tool/call` | settle open think row; add tool row (running) |
| `tool/result` | mark the matching tool row done/error, store result |
| `assistant/message` | replace answer with assembled text |
| `turn/end` | settle think row; status done/error; finalize card; keep snapshot + rows for re-assertion and the ⋯ buttons |

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

- **working**: `⏹ Stop`.
- **done**: `📋 Copy`, `🔁 Retry`, `⚙️ Panel`, and the rows toggle
  (`▾ Collapse` / `▸ Expand` when rows exist).
- **error**: `🔁 Retry`, `⚙️ Panel`, rows toggle.

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
