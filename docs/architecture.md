# Architecture

English | [中文](architecture.zh.md)

How dsh-feishu works, iteration by iteration.

## Core identity

**DSH-native — born for dsh, not bridged to it.** The surface targets
exactly one agent (dsh) and integrates in-process; it does not bridge
external CLIs and does not reimplement agent capabilities. Three promises
follow:

1. **No bridge, no capture.** No CLI adapters, no tmux/PTY, no screen
   capture, no ANSI parsing — the surface drives the dsh agent/session layer
   directly.
2. **Full transparency.** Every token, tool call, question, and approval
   streams natively into the chat; the agent never does anything to be seen.
3. **Everything is a card.** Every dsh surface element maps to a Feishu card.

## Runtime shape

The plugin is a dsh **bundle** (`dsh.bundle.patch` → `cordis.patch.yml`)
riding on `@deepseek-ai/dsh-base`. It mounts as the `feishu` row of a
profile; credentials come from config or `FEISHU_APP_ID` /
`FEISHU_APP_SECRET`.

```
Feishu user ──message──> Feishu platform ──WS long connection──> transport (lark-oapi)
                                                                    │ receive events / send & patch cards
                                                                    ▼
                                                              bridge (orchestrator)
                                                    ┌──────────────┼───────────────┐
                                                    ▼              ▼               ▼
                                             dedup         session-map      streaming cards
                                             (message id)   chat ↔ session    (1 card/turn,
                                                              durable map       throttled patch)
                                                    │              │               │
                                                    ▼              ▼               ▼
                                             agent.followup   ctx.agents      sendText (final
                                                              create/resume   answer, notifies)
                                                                    │
                                                                    ▼
                                                              dsh session/event stream
```

## Modules

| Module | Responsibility |
|---|---|
| `src/feishu/types.ts` | Transport seam types: normalized `FeishuMessage`, `FeishuTransport`, card JSON. |
| `src/transport.ts` | lark-oapi implementation: `WSClient` long connection + `Client` API calls; pure `normalizeMessageEvent`; `FeishuApiError`. |
| `src/memory-transport.ts` | File-channel in-memory transport (`FEISHU_TRANSPORT=memory`): the integration-test / debugging seam — `inbox/` delivers messages, `outbox/` records every send. |
| `src/message-dedup.ts` | Bounded in-memory message-id dedup (platform redelivery). |
| `src/session-map.ts` | Durable chat ↔ session mapping (atomic JSON writes), reverse lookup for events. |
| `src/directory.ts` | Working-directory resolution for user-supplied paths (`/cd`, `/repo`). |
| `src/model-args.ts` | `/model` argument parsing (`<provider>/<model>`). |
| `src/cards/render.ts` | Pure rendering: session events → card JSON (v1 layout), markdown escaping, tail truncation, the control-panel palette (grouped, paginated, category blocks), the permission/model picker cards (dropdown with `initial_option`), and the pure-information **result cards** (`✅ Done` / `⚠️ Action failed`). |
| `src/cards/session-list.ts` | The `/sessions` picker card: a **dropdown** of saved sessions (capped at `SESSION_SELECT_MAX = 50`, with a Find filter), and the session detail sub-view card (Resume / Rename / Archive / Export / Back) — pure rendering. |
| `src/cards/streaming.ts` | One card per turn: POST on open, throttled/coalesced `message.patch` updates, terminal finalize. |
| `src/cards/StreamingCardController.ts` | The streaming-card **state machine**: per-chat `ChatCardState`, one `syncCard` render path, the session-event → card pipeline (`handleEvent`, incl. the compaction lifecycle and agent-initiated cards), `beginTurn` (ack + working state), and the streaming card actions (stop/copy/retry/row-details/toggle-rows). Depends only on the `StreamingCardHost` seam. |
| `src/cards/interactions.ts` | Pending-interaction registry shared by approvals and questions: resolve-once, timeout, stale-callback rejection, abort, disposal. |
| `src/cards/InteractionCardController.ts` | The approval/question **card flows**: `handleApprovalRequest` / `askQuestions` (single-select, multi-select toggles, free-text via the next chat message), the interaction card actions, and `answerFreeText` — behind the `InteractionCardHost` seam. |
| `src/panel/types.ts` | Panel view union (`PanelView`) and the input/confirm sub-view copy (`PANEL_INPUT_SPEC`, `PANEL_CONFIRM_SPEC`). |
| `src/panel/PanelController.ts` | The panel **state machine**: one authoritative view stack per chat, one `showPanel` render path (Loading placeholder first for async views, failure-proof menu reset), and `runPanelOperation` — THE single async-operation wrapper (busy placeholder → work → result → exit) behind the `PanelHost` seam. |
| `src/panel/actions/` | Panel card actions as **Strategy objects**: `PanelAction` base class (Template Method — transition → gate → busy → work → result → exit order) + `PanelActionRegistry` (kind → action) + one class per action family (navigators, pickers, session ops, commands). |
| `src/panel/views/` | Panel view **Strategy objects**: one `PanelViewState` per view (declaring its own `asyncData`) + `PanelViewRegistry`; the pickers are separate states (`picker:repo` / `picker:model` / `picker:permission`). |
| `src/commands/surface.ts` | The surface command set: full registration of the plugin-owned slash commands (and their panel buttons) + `runHarnessCommand`, behind the `SurfaceCommandHost` seam. |
| `src/bridge.ts` | **Facade + orchestration**: message routing (dedup, mention gate, slash dispatch), agent resolution ladder (live → resume mapped session → create → rebind fresh id on collision), the working-state and working-directory gates, the session lifecycle (`/sessions /resume /clear`), proactive mentions, and the four host seams (`StreamingCardHost` / `PanelHost` / `InteractionCardHost` / `SurfaceCommandHost`). All card surfaces live in the modules above. |
| `src/index.ts` | Plugin entry: config, credential resolution, agent options (config or `agentDefaultModel`), wiring, `feishu-status` command. |

## Key behaviors

- **Slash commands with button parity.** All surface commands
  (`/help /status /cancel /cd /repo /group /sessions /resume /clear /new
  /export /model /feishu-status /schedule` plus the five dsh web wrappers
  `/plan /goal /compact /feedback /permission`, and `/panel` — slash-only,
  its palette button is hidden) share one handler between the slash line
  and the panel palette button. `ctx.commands.execute` passthrough handles
  anything else. `/export` ships the session log as a file message and
  `/model` is surface-native (the web `/model` is a client popup with no
  host command).
- **Session lifecycle.** `/sessions` opens a **dropdown picker** of the
  persisted corpus (`ctx.sessionQuery.listSessions()` + batch
  `readTitleSnapshots()`, degraded bound-sessions fallback when the service
  is absent); selecting an option pushes the **session detail sub-view** on
  the panel state-machine stack. `/resume <id>` and the detail's Resume
  button rebind the chat (`SessionMap.set` — 1:1 model) and `agents.resume`
  when no live agent exists; a running target is refused; resume resets the
  card state (no history replay). Rename/Archive go through the host
  `apiProxy` seam (`sessions.rename`, `workspace.archiveSession` —
  reversible). `/clear`/`/new` remint a fresh session non-destructively (the
  old session stays saved and resumable).
- **Panel state machine.** The control panel is one authoritative view stack
  per chat (`PanelView[]`, menu root at the bottom) with a single render
  path: buttons PUSH sub-views (input form, confirm, sessions, session
  detail, pickers), Back POPS, completion pops to the menu. Intermediate
  steps update the SAME panel card in place; a final outcome posts a NEW
  pure-information result card (the panel principle — user requirement).
- **Working-state gate.** While a turn runs, only read-only commands run
  (`/help /status /feishu-status /schedule /sessions /cancel /group /model /panel`);
  mutating commands refuse with
  an explanation, keeping the state machine coherent (see ux-spec §8.4).
- **Working-directory gate.** A chat with no explicitly pinned cwd (/repo
  or /cd) refuses turns with guidance — no session/card is created and the
  message is not remembered; `defaultCwd` is never an implicit choice
  (`requireWorkingDir`, default true). `/clear` keeps the pin; `/resume`
  adopts the resumed session's cwd (picker button value, or session-list
  lookup) so the resumed chat stays usable (see ux-spec §8.3).
- **Interactive approvals.** `ctx.on('approval/request')` posts an approval
  card (tool + reason, Allow once / Reject) and settles through the shared
  `InteractionRegistry` — `'allowed-once'` / `'rejected'` from the card
  callback, `'cancelled'` on signal abort or timeout, fail-closed
  `'unavailable'` when the chat is unknown or the card fails. The decided
  card is a static no-button card.
- **Interactive questions.** `ctx.userQuestions.registerProvider` answers
  questions via question cards: single-select answers on tap, multi-select
  toggles + Submit, free-text captures the next chat message. Feature
  detection: absent approval/question services are logged loudly and
  nothing is mounted (see ux-spec §9).
- **Configurable group mention gate.** `groupMentionMode` (botmux
  semantics): `always` requires an @-mention (relaxed in 1-person-1-bot solo
  groups via cached chat member counts); `never` answers every group message;
  `ambient` yields when a message redirects to another member; `topic`
  behaves like `always` until threads land. `allowedChats` restricts which
  chats are served at all; `allowedUsers` restricts which sender open ids
  are served (messages and card buttons from unlisted users are ignored).
- **Two-stage reaction ack.** An accepted turn message gets a received
  reaction (`GoGoGo` by default), swapped for `DONE` / `WARN` / `WARN` at
  turn end (config-overridable via `reactions`); failures only log.
- **Proactive @-mentions.** The last accepted sender per chat is remembered;
  group error notices, approval cards, and question cards carry an @-mention
  of that requester so the right human is drawn in.
- **Session replay.** `/history` renders the chat's session log as in-chat
  cards (lark_md-safe transcript, split across cards without loss;
  `/history last <n>` replays a subset); `/export` ships the same transcript
  as a file message.
- **A chat is a session.** One Feishu chat maps to one dsh session id
  (`feishu-*`), persisted so a restart resumes every chat.
- **Restart-safe session resolution.** For a chat with a mapped session and
  no live agent, the bridge resumes the persisted session; if nothing is
  persisted it creates fresh; if the mapped id collides with an on-disk log
  it rebinds a fresh id. History survives daemon restarts.
- **One card per turn.** The card is posted when a message arrives and
  patched as chunks/tools stream in. The **final answer stays in the card**
  (it finalizes green in place — no second bubble); failures add a ⚠️
  notice so a broken turn never goes unnoticed. Patches are silent (no
  unread), which is why the first card send is the notification.
- **Text fallback.** If posting the streaming card fails, the turn still
  runs and the final answer arrives as text.
- **Dedup.** A redelivered message id is ignored within the process lifetime
  (durable dedup is deferred).

## Testing

- **Unit tests** (`tests/`): every module, via fake contexts and recording
  fakes — including the full card state-machine matrix (state × action,
  extended with the command/resume-session actions), the panel palette
  pagination, the session-list builder, the extracted controllers
  (`StreamingCardController`, `InteractionCardController`, the surface
  command set) against fake hosts, and the `executeDshCommand` result
  mapping.
- **Real-composition integration** (`tests/integration/`): a real dsh
  process booted from a real profile runs a real agent turn against a mock
  LLM server, with Feishu swapped for the memory transport. Asserts the
  whole loop end to end (card posted/patched, final message delivered).
  Self-skips when prerequisites are missing; see
  [development.md](development.md) → Integration test.

## Later iterations

- Iteration 2: group-chat mention routing, slash commands (surface-owned +
  dsh passthrough), `/repo` cwd selection, resume.
- Iteration 3: interactive cards — approvals (`ctx.approval`), questions
  (`ctx.userQuestions`) — via card button callbacks over the same WS
  connection.
- Iteration 4: robustness — folding, permissions, reconnect, observability.
- Iteration 5: scheduled tasks/webhooks, multi-bot, `/relay`.

