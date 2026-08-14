# The Feishu UI for DeepSeek Harness (dsh)

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/PGZXB/dsh-feishu/ci.yml?branch=main)](.github/workflows/ci.yml)

The Feishu UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a dsh-native plugin, installable via `dsh plugin add`; live streaming cards, in-card questions & approvals, one-QR setup.

dsh is an open-source agent harness built on an everything-is-a-plugin
architecture. It officially ships a **browser surface** (its web UI, which
calls itself the "browser-surface bundle") and a terminal surface; the
**Feishu UI** is provided by this plugin. A Feishu chat maps to a dsh
session — the chat bot is the agent's avatar, and every reply streams back
as a live card.

## Contents

- [Why DSH-native](#why-dsh-native)
- [One surface next to the web](#one-surface-next-to-the-web)
- [Verified](#verified)
- [See it work](#see-it-work)
- [5-minute quickstart](#5-minute-quickstart)
- [Features](#features)
- [Contributing](#contributing)
- [Credits](#credits)

## Why DSH-native

The surface is built in-process — it is dsh itself, not a wrapper around it:

1. **No bridge, no capture.** No CLI adapters, no PTY/screen capture, no
   ANSI parsing. The surface drives the dsh agent/session layer directly
   (`ctx.agents`, `ctx.commands`, `session/event`).
2. **Full transparency.** Every token, tool call, question, and approval
   streams natively into the chat — the agent never has to do anything to be
   seen (there is no explicit "send" contract).
3. **Everything is a card.** Every dsh surface element maps to a Feishu
   card: streaming output, tool calls, session lists, approvals, questions,
   pickers.

## One surface next to the web

Both surfaces sit at the same layer: bundles riding on `@deepseek-ai/dsh-base`,
driving the same in-process services.

```mermaid
graph LR
    BASE[dsh-base<br/>the harness core] -->|"patch layer<br/>(dsh.bundle.patch)"| WEB[Browser surface (web)<br/>official "browser-surface bundle"]
    BASE -->|"patch layer<br/>(dsh.bundle.patch)"| FEISHU[Feishu surface (this)<br/>@dsh-feishu/dsh-feishu]
```

Web parity where it counts: `/permission`, `/plan`, `/model` and the other
dsh web wrappers run against the **same** `ctx.permissionPresets` /
`ctx.planMode` / `ctx.agentDefaultModel` services the web UI uses — a preset
picked on Feishu is the preset the web UI would read.

## Verified

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

Every interaction is a card, and the card you watch stream in is the card
that ends up green — the answer **finalizes in place, with no second message
bubble**.

**A turn, in one card.** Message the bot and a card opens immediately, with
a ⏹ Stop button while the agent is running. Tool calls and reasoning stream
in as expandable rows; when the turn settles the card turns green with the
full answer inside. Copy and Retry sit on the card.

<!-- docs/assets/streaming-mid.png — user screenshot: the card streaming mid-turn -->
<!-- docs/assets/streaming-done.png — user screenshot: the same card finalized green in place -->

**Approvals, in the chat.** When a tool asks for a permission escalation,
an orange card posts the tool name and the reason with **✅ Allow once** and
**❌ Reject**. Tap Allow once and the tool call continues right there —
nothing to do anywhere else. The card settles into a static confirmation.

<!-- docs/assets/approval.png — user screenshot: approval card with Allow once / Reject -->
<!-- docs/assets/approval-decided.png — user screenshot: the static decided card -->

**Questions, in the chat.** When the agent needs an answer, a question card
posts the options as buttons: one tap answers, multi-select toggles with a
Submit button, and free-text questions accept a reply in the chat.

<!-- docs/assets/question.png — user screenshot: a question card with option buttons -->
<!-- docs/assets/question-answered.png — user screenshot: the static answer confirmation -->

**Control panel.** One card carries the full command palette as buttons —
Stop / Retry / Copy plus every slash command, grouped and paginated.

<!-- docs/assets/panel.png — user screenshot: the control panel card -->

**Sessions.** `/sessions` lists every saved session (title, id, working
directory, age) with Resume buttons; a tap moves the session into the
current chat. Sessions survive daemon restarts.

<!-- docs/assets/sessions.png — user screenshot: the /sessions list with Resume buttons -->

**Export.** `/export` uploads the chat's session log as a downloadable file
message.

<!-- docs/assets/export.png — user screenshot: the exported session log file message -->

**Groups.** @-mention the bot in a group chat; when a turn fails or an
approval or question is needed, the bot @s the requester.

<!-- docs/assets/group.png — user screenshot: a group chat with an @-mention answer -->

<!-- docs/assets/demo.gif — user-recorded demo (real bot, real Feishu client). -->

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
[docs/feishu-setup.md](docs/feishu-setup.md). A copy-pasteable profile with
every option documented: [examples/feishu-profile](examples/feishu-profile).

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report issues and submit
changes, and [SECURITY.md](SECURITY.md) for the security policy. Build,
test, and lint commands plus the local-profile mount recipe:
[docs/development.md](docs/development.md). The UX contract is specified in
[docs/ux-specification.md](docs/ux-specification.md).

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

## License

MIT — see [LICENSE](LICENSE).
