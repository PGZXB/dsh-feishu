# Feishu App Setup

English | [中文](feishu-setup.zh.md)

How to create the Feishu (Lark) custom app the surface connects as, and how
to configure its credentials. Two paths: the **quick setup** (one QR scan,
the Open Platform is configured automatically — recommended) and the
**manual path** (paste credentials, follow a short checklist).

## Quick setup (recommended)

`pnpm run setup:feishu` drives the Feishu Open Platform console automatically
over a reusable Web session (mirroring botmux's `setup` wizard). One QR scan
is the only human step:

```sh
pnpm run build                       # the setup CLI lives in lib/setup
pnpm run setup:feishu -- --new       # create a new app + configure it
```

The wizard then, with no further web-console work:

1. Creates a **企业自建应用** (default name "DSH Agent (dsh-feishu)",
   `--app-name` to change; `--description` sets the app description) and
   reads back its `app_id` / `app_secret`. The app avatar is the bundled
   dsh wordmark by default; `--avatar <path>` uploads a custom image
   (PNG).
2. Enables the **bot** capability.
3. Switches **events and card callbacks to the long connection** and
   subscribes `im.message.receive_v1` (event) + `card.action.trigger`
   (card callback) — both required, verified by read-back (fail-closed).
4. Grants the manifest's scopes — see the permissions table in step 3.
5. Publishes an app version with **"visible to me only"** visibility —
   auto-approved, no administrator wait.
6. Writes `appId` / `appSecret` into the profile's `cordis.patch.yml`
   (a `.bak` backup is kept), or prints export lines with `--print-env`.
7. **Guides the surface options** with three prompts (empty input = the
   shown default): `repoRoots` for `/repo` (default: your home directory),
   `groupMentionMode` (default `always`), and `requireWorkingDir`
   (default `y`). The defaults are the profile's existing values when it
   was already configured. Non-interactive runs (CI, scripts) skip the
   prompts and use the defaults silently.

Reconfigure an existing app instead of creating one:

```sh
pnpm run setup:feishu -- --app-id cli_xxx
```

Brand the new app (name, avatar, description):

```sh
pnpm run setup:feishu -- --new --app-name "Team Agent" \
  --avatar ./team-agent.png --description "The team's dsh agent on Feishu."
```

Other options: `--list` (list apps the session can see), `--force-login`
(fresh QR even with a cached session), `--lark` (Lark international console),
`--verify-boot` (boots `dsh --profile <name>` afterwards and waits for
`[feishu] bridge ready`), `--help` (full usage). The session file lives at
`~/.dsh-feishu/feishu-session.json` (`DSH_FEISHU_SESSION` to override) and is
reused across runs — only the first run needs a QR scan.

### What stays manual

Creating the app, granting scopes, subscribing events, and publishing
versions are console-only actions — there is no public API for them. The
automation reduces the console work to **scanning one QR code**; when it
cannot run (no terminal QR, corporate login policies), use the manual path.

## Manual path (`--no-open-platform-auto`)

Paste the credentials and get the config written plus a short checklist:

```sh
pnpm run setup:feishu -- --no-open-platform-auto
```

The tool validates the credentials against the Feishu API, writes them into
the profile (or `--print-env`), and prints the remaining console steps.
Manual steps, for reference:

### 1. Create the app and bot

1. Open the [Feishu Open Platform](https://open.feishu.cn/app) (Lark:
   [larksuite.com](https://open.larksuite.com/app)) and create a **custom
   app** (企业自建应用).
2. In **App Features → Bot** (应用功能 → 机器人), enable the bot.
3. In **Credentials & Basic Info** (凭证与基础信息), note the **App ID**
   (`cli_...`) and **App Secret** (`...`).

### 2. Enable the long connection

The surface receives events over the Feishu **WebSocket long connection** —
no callback URL, no public endpoint, no public IP on the host (all traffic is
outbound). In **Events & Callbacks** (事件与回调):

- **Events** (事件订阅方式): choose **Long connection** (长连接) and
  subscribe to **Receive messages** (`im.message.receive_v1`, 接收消息).
- **Card callbacks** (卡片回调): card button presses are **callbacks, not
  events** — their receive mode is configured **separately**. Switch the
  card callback receive mode to **Long connection** as well (长连接), or
  button presses fail with "该应用尚未配置卡片回调" (the app has no card
  callback configured).

### 3. Grant permissions

The canonical list lives in `src/setup/feishu-manifest.json` (the setup
automation grants exactly that list — keep it in sync when adding features).
Current scopes (权限):

| Scope | Purpose |
|---|---|
| `im:message` | Receive messages (`im.message.receive_v1`) |
| `im:message.group_at_msg:readonly` | Receive group messages that @-mention the bot |
| `im:message.group_msg` | Receive **all** group messages, @-mentioned or not (required for the 1-user-1-bot solo-group relaxation under `groupMentionMode: always`) |
| `im:message.group_msg.include_bot:read` | Include messages from **other bots** in the group (keeps solo-relaxation working when another bot joins) |
| `im:message:send_as_bot` | Send messages and cards as the bot |
| `im:chat` | Read chat metadata |
| `im:chat.members:read` | Read group members (multi-bot / roster awareness) |
| `im:chat.members:write_only` | Invite members into groups (botmux parity for group flows) |
| `im:resource` | Upload file messages (`/export`) |

### 4. Publish

Create a version and publish it. Choose **"visible to me only"** (仅自己可见)
so the version is approved instantly — no administrator wait.

## Configure the surface

Credentials are read from the `appId` / `appSecret` config keys or the
`FEISHU_APP_ID` / `FEISHU_APP_SECRET` environment variables:

```sh
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=yyy
dsh --profile feishu
```

or in the profile's `cordis.patch.yml`:

```yaml
- id: feishu
  name: '@dsh-feishu/dsh-feishu'
  config:
    appId: cli_xxx
    appSecret: yyy
```

Every other config option follows the same shape in `cordis.patch.yml`
(`groupMentionMode`, `allowedChats`, `allowedUsers`, `unknownCommand`,
`repoRoots`, `requireWorkingDir`, `reactions`, …). The surface options that
affect routing also have environment fallbacks (config wins, env falls
back):

| Environment variable | Values | Meaning |
|---|---|---|
| `FEISHU_ALLOWED_USERS` | comma-separated `ou_` open ids | user allowlist (messages and card buttons) |
| `FEISHU_ALLOWED_CHATS` | comma-separated chat ids | chat allowlist |
| `FEISHU_GROUP_MENTION_MODE` | `always` \| `never` \| `ambient` \| `topic` | group mention policy |
| `FEISHU_UNKNOWN_COMMAND` | `error` \| `passthrough` | unknown slash-line policy |

## Verify

With credentials configured, the boot log prints:

```
[feishu] starting surface for app cli_xxx
feishu long connection ready
[feishu] bridge ready
```

Then direct-message the bot from a test account; the reply streams back as a
live card. `--verify-boot` automates this check after setup.

## Network requirements

Only outbound access is needed: Feishu Open Platform HTTPS + WSS
(`open.feishu.cn` / `open.larksuite.com`), the DeepSeek API, and npm (for
installs). No inbound ports, no public IP.

## Permissions

- Sending file messages (`/export`) requires the **`im:resource:upload`**
  (or `im:resource`) scope in the developer console (app →
  Permissions). Without it the upload fails with HTTP 400 / "Access denied …
  im:resource:upload" — the surface surfaces this hint in the `/export`
  error text.

- The two-stage reaction ack needs **no extra scope** — `im.v1.messageReaction`
  works on the base message permission (verified against the live API); a
  reaction failure only logs and degrades to no emojis, never a broken turn.
- **`allowedUsers`** (config, or the `FEISHU_ALLOWED_USERS` env var —
  comma-separated) restricts the surface to the listed sender open ids; the
  default (unset/empty) serves everyone. `ou_` open ids are app-scoped: a
  list from one app does not transfer to another.
