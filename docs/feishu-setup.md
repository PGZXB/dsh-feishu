# Feishu App Setup

How to create the Feishu (Lark) custom app the surface connects as, and how
to configure its credentials.

## 1. Create the app and bot

1. Open the [Feishu Open Platform](https://open.feishu.cn/app) (Lark:
   [larksuite.com](https://open.larksuite.com/app)) and create a **custom
   app** (企业自建应用).
2. In **App Features → Bot** (应用功能 → 机器人), enable the bot.
3. Publish the app **version** (创建版本并发布) and let an administrator
   approve it — events and API access only work after the version is
   released.
4. In **Credentials & Basic Info** (凭证与基础信息), note the **App ID**
   (`cli_...`) and **App Secret** (`...`).

## 2. Enable the long connection

The surface receives events over the Feishu **WebSocket long connection** —
no callback URL, no public endpoint, no public IP on the host (all traffic is
outbound). Enable it in **Events & Callbacks** (事件与回调):

- Choose **Long connection** (长连接) mode.
- Subscribe to the **Receive messages** event
  (`im.message.receive_v1`, 接收消息), category **Message** (消息).
- Card action callbacks (`card.action.trigger`) arrive over the same
  connection (used from iteration 3 onward).

## 3. Grant permissions

Add the following **scopes** (权限) to the app version:

| Scope | Purpose |
|---|---|
| `im:message` | Receive messages (`im.message.receive_v1`) |
| `im:message:send_as_bot` | Send messages and cards as the bot |
| `im:chat` | Read chat metadata (later iterations) |

Publish a new version after adding scopes.

## 4. Configure the surface

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

## 5. Verify

With credentials configured, the boot log prints:

```
[feishu] starting surface for app cli_xxx
feishu long connection ready
[feishu] bridge ready
```

Then direct-message the bot from a test account; the reply streams back as a
live card.

## Network requirements

Only outbound access is needed: Feishu Open Platform HTTPS + WSS
(`open.feishu.cn` / `open.larksuite.com`), the DeepSeek API, and npm (for
installs). No inbound ports, no public IP.
