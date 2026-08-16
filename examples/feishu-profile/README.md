# Example dsh profile running the Feishu surface

A complete, copy-pasteable dsh profile for `@dsh-feishu/dsh-feishu`. It mounts
the surface with the common options configured up front, so a fresh chat works
without further setup.

## Install

```sh
# From the dsh-feishu checkout (pre-1.0), or @latest once published:
DSH_HOME="$HOME/.dsh" dsh plugin --profile feishu add link:/path/to/dsh-feishu
DSH_HOME="$HOME/.dsh" dsh --profile feishu
```

Then DM the bot; every feature (streaming cards, approvals, questions,
reactions, reminders, `/feishu-status`) works out of the box.

## What the example configures

- `repoRoots` — where `/repo` scans for projects (one level deep).
- `allowedUsers` — optional user allowlist (`ou_` open ids are app-scoped;
  leave empty for no restriction).
- `groupMentionMode` — `always` | `never` | `ambient` | `topic`.
- `requireWorkingDir` — the gate is ON by default; set `false` only for
  deployments that want the `defaultCwd` fallback.
- `reactions` — the two-stage ack emojis (received/done/error/stopped).
- The bundle also mounts `@deepseek-ai/dsh-schedule` (chat-configured
  reminders, rendered as `⏰ Reminder` cards) and the `ask_user_question`
  tool (question cards) automatically.

Credentials come from `appId`/`appSecret` below or the
`FEISHU_APP_ID` / `FEISHU_APP_SECRET` environment variables; see
`docs/feishu-setup.md` for the Feishu app + permissions (including
`im:resource` for `/export`).
