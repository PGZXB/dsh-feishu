# The Feishu UI for DeepSeek Harness (dsh)

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/PGZXB/dsh-feishu/ci.yml?branch=main)](.github/workflows/ci.yml)

The Feishu UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a dsh-native plugin. Install it with `dsh plugin add`, scan one QR code, and run your agents from Feishu.

## Quickstart

### Install from npm

```sh
# 1. install Node.js ≥ 22.13
#    macOS / Linux: nvm (https://github.com/nvm-sh/nvm) → nvm install 22
#    Windows: https://nodejs.org  (or: winget install OpenJS.NodeJS.LTS)
node --version

# 2. install pnpm
npm install -g pnpm

# 3. install the plugin
npx @deepseek-ai/dsh plugin --profile feishu add @dsh-feishu/dsh-feishu@latest

# 4. one QR scan — create + configure the Feishu app
npx --yes --package @dsh-feishu/dsh-feishu dsh-feishu-setup --new --profile feishu

# 5. run
npx @deepseek-ai/dsh --profile feishu
```

### Install from source

```sh
# 1. install Node.js ≥ 22.13
#    macOS / Linux: nvm (https://github.com/nvm-sh/nvm) → nvm install 22
#    Windows: https://nodejs.org  (or: winget install OpenJS.NodeJS.LTS)
node --version

# 2. install pnpm
npm install -g pnpm

# 3. clone and build
git clone https://github.com/PGZXB/dsh-feishu.git
cd dsh-feishu
pnpm install
pnpm run build

# 4. install into a profile
npx @deepseek-ai/dsh plugin --profile feishu add link:.

# 5. one QR scan — create + configure the Feishu app
pnpm run setup:feishu -- --new --profile feishu

# 6. run
npx @deepseek-ai/dsh --profile feishu
```

Then message the bot in Feishu. The setup wizard handles the Feishu app end
to end — no web-console work and no manual credentials. Already have an app?
Set `FEISHU_APP_ID` / `FEISHU_APP_SECRET` (environment or profile config)
instead — see [docs/feishu-setup.md](docs/feishu-setup.md).

### Uninstall

```sh
# remove the plugin from the profile
npx @deepseek-ai/dsh plugin --profile feishu remove @dsh-feishu/dsh-feishu

# optional — full clean slate: delete the profile and its surface data
# (paths shown for the default dsh home, ~/.dsh)
rm -rf ~/.dsh/profiles/feishu ~/.dsh/feishu
```

## Usage

A Feishu chat is a dsh session — the bot is the agent's avatar. A typical
session goes like this:

1. **Start a chat.** Direct-message the bot, or run `/group <name>` to
   create a group the bot joins. In a group, @-mention the bot (the
   default policy; a group with just you and the bot also answers plain
   messages, and the policy is configurable).
2. **Pick a working directory.** The bot refuses work until the chat has
   one: send `/cd /path/to/project`, or `/repo` to pick from a list.
3. **Ask.** Send a message — the agent runs and its output streams into a
   live card (tool calls, reasoning, markdown, tables). The card ends green
   with the full answer inside; Stop, copy, retry, and the ⚙️ panel button
   sit on it.
4. **Approve or answer when asked.** A permission escalation posts an
   approval card — tap **Allow once** (or **Reject**). A question posts a
   card you answer with a tap (or a reply).
5. **Manage sessions.** `/sessions` lists saved sessions (resume from the
   card), `/resume <id>` moves one into this chat, and `/clear` starts fresh
   without deleting the old one.
6. **Everything is also a button.** `/panel` opens a card with every command
   as a button; `/help` lists them all.

## Commands

| Command | What it does |
|---|---|
| `/cd <path>` | set this chat's working directory |
| `/repo` | list candidate project directories to pick from |
| `/sessions` | list saved sessions (resume any of them from the card) |
| `/resume [id]` | resume a saved session in this chat |
| `/clear` `/new` | start a fresh conversation (the old session stays saved) |
| `/cancel` | stop the running turn |
| `/status` | show this chat's session status |
| `/model` | pick or set the model |
| `/export` | send this chat's session log as a file |
| `/schedule` | list active reminders |
| `/feishu-status` | show the surface diagnostic card |
| `/group` | create a group with the bot |
| `/panel` | open the control-panel card (all commands as buttons) |
| `/help` | list all commands |
| `/plan` `/permission` `/goal` `/compact` `/feedback` | dsh's own commands, same as the web UI |

## Features

- **Live streaming cards** — tool calls, reasoning, markdown, and tables stream in as the agent works.
- **In-card approvals & questions** — approve a permission escalation or answer the agent's questions in the chat.
- **Sessions survive restarts** — a chat's session (and its working directory) is persisted across daemon restarts.
- **Groups & mentions** — @-mention the bot; error notices, approvals, and questions @ the requester.
- **Reactions, allowlists, reminders, export, diagnostics** — reaction ack, `allowedChats` / `allowedUsers`, scheduled reminders, session-log files, and a status card.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Development, tests, and release: [docs/development.md](docs/development.md).

## Credits

- **[botmux](https://github.com/deepcoldy/botmux)** — the reference for the
  group-chat interaction patterns: streaming cards, approvals, and the
  QR-driven Open Platform quick-setup flow. dsh-feishu borrows botmux's
  *interaction and onboarding patterns*, not its architecture — botmux
  bridges external CLIs, while this surface is dsh-native and in-process.
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —
  the platform this surface is built for.
- **[Lark Open Platform SDK](https://github.com/larksuite/node-sdk)** — the
  WebSocket long connection and card APIs the transport builds on.

## License

MIT — see [LICENSE](LICENSE).
