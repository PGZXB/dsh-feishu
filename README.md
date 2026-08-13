# dsh-feishu

Feishu (Lark) as a native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) surface.

A Feishu chat maps to a dsh session. The chat bot is the agent's avatar:
message it to drive an agent that runs on the host where dsh is deployed, and
watch the answer stream back as live Feishu cards. Slash commands operate
either the bridge itself (repo selection, resume, session listing) or pass
through to dsh's own command registry.

> **Status: work in progress — iteration 0 scaffold.** The bundle mounts into a
> dsh profile and idles in "not configured" mode. The Feishu transport,
> session bridge, streaming cards, and command routing land in later
> iterations; see [`PLAN.md`](PLAN.md) for the roadmap.

## Why DSH-native

Unlike bridges that attach a terminal TUI to a chat client, dsh-feishu is a
dsh plugin that drives the dsh agent/session layer directly (`ctx.agents`,
`ctx.commands`, `session/event`). The agent's output streams out natively —
there is no screen capture and no requirement for the agent to explicitly
"send" anything to the user.

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
