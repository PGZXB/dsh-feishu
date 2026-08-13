# dsh-feishu

Feishu (Lark) as a native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) surface.

> **DSH-native — born for dsh, not bridged to it.**
>
> dsh-feishu does not bridge an external CLI, nor does it reimplement any
> agent capability. It is dsh's own Feishu surface — a first-class UI next to
> the web and terminal surfaces. A Feishu chat is a dsh session; the chat bot
> is the agent's avatar. Unlike multi-CLI bridges, dsh-feishu targets exactly
> one agent — dsh — and integrates with it in-process.

A Feishu chat maps to a dsh session. The chat bot is the agent's avatar:
message it to drive an agent that runs on the host where dsh is deployed, and
watch the answer stream back as live Feishu cards. Slash commands operate
either the surface itself (repo selection, resume, session listing) or pass
through to dsh's own command registry.

> **Status: iteration 0 scaffold.** The bundle mounts into a dsh profile and
> idles in "not configured" mode; the private-chat loop, streaming cards, and
> command routing land in later iterations (see [`PLAN.md`](PLAN.md)).

## Why DSH-native

Three promises follow from building the surface in-process instead of
bridging a terminal:

1. **No bridge, no capture.** No CLI adapters, no tmux/PTY, no screen
   capture, no ANSI parsing. The surface drives the dsh agent/session layer
   directly (`ctx.agents`, `ctx.commands`, `session/event`).
2. **Full transparency.** Every token, tool call, question, and approval
   streams natively into the chat — the agent never has to do anything to be
   seen (no explicit "send" contract).
3. **Everything is a card.** Every dsh surface element maps to a Feishu
   card: streaming output, tool calls, session lists, approvals, questions,
   pickers.

## Requirements

- Node.js >= 22.13
- A dsh installation (`npm install -g @deepseek-ai/dsh`) and pnpm (used by
  `dsh plugin`)
- A Feishu custom app with a bot (credentials only needed once the transport
  lands; see [docs/feishu-setup.md](docs/feishu-setup.md) — coming with
  iteration 1)

## Install into a dsh profile

```sh
dsh plugin --profile feishu add @dsh-feishu/dsh-feishu@latest
dsh --profile feishu
```

> Not yet published: the package is pre-1.0. Until then, install a local
> checkout with `dsh plugin --profile feishu add link:<path-to-checkout>`.

The bundle rides on `@deepseek-ai/dsh-base`; credentials are read from the
`appId`/`appSecret` config keys or the `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
environment variables.

## Development

See [docs/development.md](docs/development.md) for setup, build, test, and
lint commands, plus the local-profile mount recipe.

## License

MIT — see [LICENSE](LICENSE).
