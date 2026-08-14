# The Feishu UI for DeepSeek Harness (dsh)

English | [中文](README.zh.md)

The Feishu UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a dsh-native plugin, installable via `dsh plugin add`; live streaming cards, in-card questions & approvals, one-QR setup.

dsh officially ships a **browser surface** (its web UI, which calls itself the "browser-surface bundle") and a terminal surface; the **Feishu UI** is provided by this plugin. A Feishu chat maps to a dsh session — the chat bot is the agent's avatar, and every reply streams back as a live card.

```
dsh (the harness core)
 │  agent / session / event services
 │  ctx.permissionPresets · ctx.planMode · ctx.userQuestions · …
 │
 ├─ browser surface (web) — the official "browser-surface bundle"
 │     · /permission · /plan · /export · …
 │
 └─ Feishu surface (this) — @dsh-feishu/dsh-feishu
       · the same dsh services, rendered as Feishu cards
       · /permission opens the same preset picker, /plan toggles the same
         plan-mode controller, questions and approvals arrive as cards
```

The two surfaces sit at the same layer: both are bundles riding on
`@deepseek-ai/dsh-base`, both drive the same in-process services. Nothing is
bridged and nothing is reimplemented — a Feishu chat is dsh itself.

<!-- docs/assets/demo.gif — user-recorded demo (real bot, real Feishu client). -->

## Why you can trust it

- **Installs like any dsh plugin.** `dsh plugin --profile feishu add
  @dsh-feishu/dsh-feishu` — no separate daemon, no external CLI, no bridge.
- **Real-process tests, never skipped.** 393 tests — 346 unit plus 47
  real-process integration tests that boot a real dsh process with the
  Feishu wire and the LLM API mocked. CI runs the integration suite with
  `FEISHU_INT_REQUIRED=1`, so it can never silently skip.
- **One QR scan to go live.** `pnpm run setup:feishu -- --new` creates the
  Feishu app, grants the permissions, subscribes the events, publishes, and
  writes the config — the only human step is scanning the QR code.

## See it work

The answer **finalizes in place on the card — there is no second message
bubble**. The card you watch stream in is the card that ends up green.

<!-- docs/assets/streaming-mid.png — user screenshot: the card streaming mid-turn -->
<!-- docs/assets/streaming-done.png — user screenshot: the same card finalized green in place -->

**Approvals and questions happen inside the chat.** When the agent needs a
permission escalation or an answer, a card appears — tap **Allow once** and
the tool call continues, no console, no hopping to another page.

<!-- docs/assets/approval.png — user screenshot: approval card with Allow once / Reject -->
<!-- docs/assets/approval-decided.png — user screenshot: the static decided card -->
<!-- docs/assets/question.png — user screenshot: a question card with option buttons -->
<!-- docs/assets/question-answered.png — user screenshot: the static answer confirmation -->

Everything else is a card too: the control panel, the session list, the
session-log export.

<!-- docs/assets/panel.png — user screenshot: the control panel card -->
<!-- docs/assets/sessions.png — user screenshot: the /sessions list with Resume buttons -->
<!-- docs/assets/export.png — user screenshot: the exported session log file message -->
<!-- docs/assets/group.png — user screenshot: a group chat with an @-mention answer -->

## 5-minute quickstart

```sh
# 1. install the plugin into a dsh profile
dsh plugin --profile feishu add @dsh-feishu/dsh-feishu@latest
# (pre-1.0: install a local checkout with `... add link:<path-to-checkout>`)

# 2. one QR scan — create + configure the Feishu app
pnpm run setup:feishu -- --new

# 3. run the surface
dsh --profile feishu

# 4. message the bot — the answer streams back as a live card
```

Requirements: Node.js ≥ 22.13, a dsh installation and pnpm. Credentials can
also be supplied via the `FEISHU_APP_ID` / `FEISHU_APP_SECRET` environment
variables or the profile config. Full setup detail:
[docs/feishu-setup.md](docs/feishu-setup.md).

## Features

| What | How it works |
|---|---|
| **Live streaming cards** | one card per turn: tool rows, reasoning, markdown, native tables; the answer finalizes green in place — no second bubble |
| **In-card approvals** | a permission escalation posts an approval card; tap **Allow once** to continue or **Reject** to stop |
| **In-card questions** | the agent's `ask_user_question` renders as a card — single-select, multi-select, or free-text |
| **Session lifecycle** | `/sessions` (list + resume), `/resume` (move a session between chats), `/clear` (fresh, non-destructive); sessions survive daemon restarts |
| **Working-directory gating** | dsh refuses work until the chat pins a directory via `/repo` or `/cd` |
| **Reaction ack** | accepted messages get `GoGoGo`, swapped to `DONE` / `WARN` when the turn settles |
| **Allowlists** | `allowedChats` and `allowedUsers` restrict who the bot serves (messages and card buttons) |
| **Proactive @-mentions** | error notices, approval cards, and question cards @ the requester in groups |
| **Scheduled reminders** | tell the agent "remind me in 5 minutes" — it fires later as a `⏰ Reminder` card; `/schedule` lists them |
| **Session log export** | `/export` ships the transcript as a file message |
| **Diagnostics** | `/feishu-status` posts a card with connection state, session count, and last activity |
| **One-QR setup** | `pnpm run setup:feishu -- --new` — app, permissions, events, publish, config |

Web parity where it counts: `/permission`, `/plan`, `/model` and the other
dsh web wrappers run against the **same** `ctx.permissionPresets` /
`ctx.planMode` / `ctx.agentDefaultModel` services the web UI uses.

## Credits

- **[botmux](https://github.com/deepcoldy/botmux)** — the reference for the
  group-chat interaction patterns: streaming cards, approvals, and the
  QR-driven Open Platform quick-setup flow. dsh-feishu borrows botmux's
  *interaction and onboarding patterns*, not its architecture — botmux
  bridges external CLIs, while this surface is dsh-native and in-process.
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —
  the platform this surface is built for; its web surface
  (`packages/client/ui-*`) is the parity reference for in-chat commands,
  approvals, and questions.
- **[Lark Open Platform SDK](https://github.com/larksuite/node-sdk)** — the
  WebSocket long connection and card APIs the transport builds on.

## Development

Build, test, and lint commands, plus the local-profile mount recipe:
[docs/development.md](docs/development.md). The UX contract is specified in
[docs/ux-specification.md](docs/ux-specification.md).

## License

MIT — see [LICENSE](LICENSE).
