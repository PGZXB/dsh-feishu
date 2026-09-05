# The Feishu UI for DeepSeek Harness (dsh)

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](package.json)
[![npm](https://img.shields.io/npm/v/@dsh-feishu/dsh-feishu)](https://www.npmjs.com/package/@dsh-feishu/dsh-feishu)
[![CI](https://img.shields.io/github/actions/workflow/status/PGZXB/dsh-feishu/ci.yml?branch=main)](.github/workflows/ci.yml)

The Feishu UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a dsh-native plugin with a **panel-driven control console**: every slash command is a button on the ⚙️ control-panel card, approvals and questions resolve inside the chat, and one QR scan sets the whole app up.

> **Note:** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is
> still pre-release (`0.1.0-rc.x`) and may break between releases. dsh-feishu
> tracks **two** dsh versions:
> - the `main` branch (installed from git) tracks **dsh `@next`** — currently
>   **`0.1.2-rc.1`**;
> - the npm `@latest` release tracks **dsh `@latest`** — currently
>   **`0.1.2-rc.1`**.

https://github.com/user-attachments/assets/e9163793-52f2-4e2c-a08a-22b27372be61

*2.5-min demo: control panel, streaming card, approval and question.*

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
#    (pnpm ≥ 11 blocks the protobufjs build script by default, so
#     --allow-build=protobufjs lets pnpm run it)
npx @deepseek-ai/dsh plugin --profile feishu add @dsh-feishu/dsh-feishu@latest --allow-build=protobufjs

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

<p align="center"><img src="docs/assets/snapshots/1_chat.png" width="640" alt="Chat with the bot"></p>

2. **Open the control panel.** Send `/panel` to pop up the panel card.

<p align="center"><img src="docs/assets/snapshots/2_panel.png" width="640" alt="Control panel"></p>

3. **Pick a working directory.** The bot refuses work until the chat has
   one: tap **📚 Pick project** to choose from a list (the `/repo`
   equivalent), or **📁 Change dir** to type a path (the `/cd <path>`
   equivalent).

<p align="center"><img src="docs/assets/snapshots/3_repo.png" width="640" alt="Project picker"></p>

4. **Ask.** Send a message — the agent runs and its output streams into a
   live card (tool calls, reasoning, markdown, tables). The card ends green
   with the full answer inside; Stop, copy, retry, and the ⚙️ panel button
   sit on it.

   | Mid-stream | Finalized |
   |---|---|
   | ![Card mid-stream](docs/assets/snapshots/4.1_streaming-mid.png) | ![Card finalized](docs/assets/snapshots/4.2_streaming-done.png) |

5. **Approve or answer when asked.** A permission escalation posts an
   approval card — tap **Allow once** (or **Reject**). A question posts a
   card you answer with a tap (or a reply).

   | Approval | Question |
   |---|---|
   | ![Approval card](docs/assets/snapshots/5.1_approval.png) | ![Question card](docs/assets/snapshots/5.2_question.png) |

6. **Manage sessions.** Tap **🗂️ Sessions** to list saved sessions and
   resume any of them from the card (the `/sessions` equivalent; `/resume
   <id>` moves one into this chat), and tap **➕ New chat** (the `/clear`
   equivalent) to start fresh without deleting the old one.

<p align="center"><img src="docs/assets/snapshots/6_sessions.png" width="640" alt="Sessions picker"></p>

Every button on the panel card maps to a slash command — pick whichever
feels faster; `/help` lists them all.

## Commands

| Command | What it does |
|---|---|
| `/help` | list all commands |
| `/panel` | open the control-panel card (all commands as buttons) |
| `/group <name>` | create a group with the bot (bare opens a name-input card) |
| `/cancel` | stop the running turn |
| `/cd <path>` | set this chat's working directory (bare opens a path-input card) |
| `/repo [path]` | pick a project directory (bare scans the default roots; `/repo <path>` scans that path) |
| `/status` | show this chat's session status |
| `/feishu-status` | show the surface diagnostic card |
| `/schedule` | list active reminders |
| `/model <provider/model>` | switch this session's model (bare opens the picker) |
| `/export` | send this chat's session log as a file |
| `/log` | send the dsh-feishu log file to this chat (handy for debugging — please attach the key log lines when you file an issue) |
| `/sessions` | list saved sessions (resume any of them from the card) |
| `/resume <id>` | resume a saved session (bare opens the session list) |
| `/clear` `/new` | start a fresh conversation (the old session stays saved) |
| `/goal <text>` | set the task goal (bare opens a text-input card) |
| `/compact` | compact older conversation history |
| `/feedback <text>` | send feedback (bare opens a text-input card) |
| `/permission <preset>` | switch the permission preset (bare opens the picker) |
| `/plan [on\|off]` | enter or leave plan mode (bare toggles) |

## Features

- **Live streaming cards** — tool calls, reasoning, markdown, and tables stream in as the agent works.
- **One-tap control panel** — `/panel` renders the full command palette as buttons; no command syntax to remember, and each button is the exact equivalent of typing the command.
- **In-card approvals & questions** — approve a permission escalation or answer the agent's questions in the chat.
- **Sessions survive restarts** — a chat's session (and its working directory) is persisted across daemon restarts.
- **Groups & mentions** — @-mention the bot; error notices, approvals, and questions @ the requester.
- **Reactions, allowlists, reminders, export, diagnostics** — reaction ack, `allowedChats` / `allowedUsers`, scheduled reminders, session-log files, and a status card.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Development, tests, and release: [docs/development.md](docs/development.md).

## Community

Join the dsh-feishu community group on Feishu:

<img src="docs/assets/feishu-group-qr-code.png" alt="dsh-feishu community group QR code" width="220">

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
