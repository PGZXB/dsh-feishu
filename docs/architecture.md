# Architecture

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

## Modules (iteration 1)

| Module | Responsibility |
|---|---|
| `src/feishu/types.ts` | Transport seam types: normalized `FeishuMessage`, `FeishuTransport`, card JSON. |
| `src/transport.ts` | lark-oapi implementation: `WSClient` long connection + `Client` API calls; pure `normalizeMessageEvent`; `FeishuApiError`. |
| `src/memory-transport.ts` | File-channel in-memory transport (`FEISHU_TRANSPORT=memory`): the integration-test / debugging seam — `inbox/` delivers messages, `outbox/` records every send. |
| `src/message-dedup.ts` | Bounded in-memory message-id dedup (platform redelivery). |
| `src/session-map.ts` | Durable chat ↔ session mapping (atomic JSON writes), reverse lookup for events. |
| `src/cards/render.ts` | Pure rendering: session events → card JSON (schema 2.0), markdown escaping, tail truncation. |
| `src/cards/streaming.ts` | One card per turn: POST on open, throttled/coalesced `message.patch` updates, terminal finalize. |
| `src/bridge.ts` | Orchestrator: message → session → `agent.followup`; `session/event` → card patches; turn end → final message. Agent resolution ladder: live → resume mapped session → create → rebind fresh id on collision. |
| `src/index.ts` | Plugin entry: config, credential resolution, agent options (config or `agentDefaultModel`), wiring, `feishu-status` command. |

## Key behaviors

- **Configurable group mention gate.** `groupMentionMode` (botmux
  semantics): `always` requires an @-mention (relaxed in 1-person-1-bot solo
  groups via cached chat member counts); `never` answers every group message;
  `ambient` yields when a message redirects to another member; `topic`
  behaves like `always` until threads land. `allowedChats` restricts which
  chats are served at all.
- **A chat is a session.** One Feishu chat maps to one dsh session id
  (`feishu-*`), persisted so a restart resumes every chat.
- **Restart-safe session resolution.** For a chat with a mapped session and
  no live agent, the bridge resumes the persisted session; if nothing is
  persisted it creates fresh; if the mapped id collides with an on-disk log
  it rebinds a fresh id. History survives daemon restarts.
- **One card per turn.** The card is posted when a message arrives and
  patched as chunks/tools stream in. Patches are silent (no unread), so the
  **final answer is delivered as a fresh message** (Feishu `message.patch`
  cannot notify).
- **Text fallback.** If posting the streaming card fails, the turn still
  runs and the final answer arrives as text.
- **Dedup.** A redelivered message id is ignored within the process lifetime
  (durable dedup is deferred).

## Testing

- **Unit tests** (`tests/`): every module, via fake contexts and recording
  fakes — 67 tests.
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

See [PLAN.md](../PLAN.md) for the full roadmap.
