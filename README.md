# The Feishu UI for DeepSeek Harness (dsh)

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/PGZXB/dsh-feishu/ci.yml?branch=main)](.github/workflows/ci.yml)

The Feishu UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a dsh-native plugin, installable via `dsh plugin add`; live streaming cards, in-card questions & approvals, one-QR setup.

dsh is an open-source agent harness. It ships a browser UI and a terminal
surface; this plugin provides the **Feishu UI** — a Feishu chat maps to a
dsh session, and the bot's replies stream back as live cards. It is a bundle
like the web UI, driving the same in-process services: `/permission`,
`/plan`, `/model` run against the same `ctx.permissionPresets` /
`ctx.planMode` / `ctx.agentDefaultModel` the web UI uses.

## Quickstart

```sh
# 1. install the plugin
dsh plugin --profile feishu add @dsh-feishu/dsh-feishu@latest
# (pre-1.0: `... add link:<path-to-checkout>`)

# 2. one QR scan — creates the app, grants permissions, subscribes events,
#    publishes, and writes the credentials into the profile
pnpm run setup:feishu -- --new

# 3. run the surface
dsh --profile feishu

# 4. message the bot — the answer streams back as a live card
```

No web-console work and no manual credentials: the setup wizard handles the
Feishu app end to end. Already have an app (or skip the wizard)? Set
`FEISHU_APP_ID` / `FEISHU_APP_SECRET` in the environment or the profile
config instead — see [docs/feishu-setup.md](docs/feishu-setup.md).

Requires Node.js ≥ 22.13, dsh, and pnpm.

> 393 tests — 346 unit plus 47 real-process integration tests. CI runs the
> integration suite with `FEISHU_INT_REQUIRED=1`, so it can never be skipped.

## Features

- **Live streaming cards** — one card per turn; the answer finalizes green
  in place, with no second message bubble.
- **In-card approvals & questions** — a permission escalation posts an
  approval card (tap **Allow once** to continue); the agent's questions
  render as cards with one-tap answers.
- **Session lifecycle** — `/sessions` (list + resume), `/resume`, `/clear`;
  sessions survive daemon restarts.
- **Groups & mentions** — @-mention the bot; error notices, approvals, and
  questions @ the requester back.
- **Reactions, allowlists, reminders, export, diagnostics** — `GoGoGo` →
  `DONE` reaction ack, `allowedChats`/`allowedUsers`, chat-configured
  reminders (`⏰ Reminder` cards), `/export` session log files, and the
  `/feishu-status` diagnostic card. See
  [docs/ux-specification.md](docs/ux-specification.md) for the full command
  surface.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Development setup, tests, and the release process:
[docs/development.md](docs/development.md).

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
