# dsh-feishu 飞书接入与配置指南

[English](feishu-setup.md) | 中文

本指南说明如何创建该 surface 所连接的飞书（Lark）自建应用，以及如何配置其
凭证。有两种方式：**快速配置**（扫描一次二维码，开放平台会自动完成配置——
推荐）和**手动配置**（粘贴凭证，按照一份简短清单操作）。

## 快速配置（推荐）

`pnpm run setup:feishu` 通过一个可复用的 Web 会话自动操作飞书开放平台控制台
（与 botmux 的 `setup` 向导一致）。唯一的人工步骤是扫描一次二维码：

```sh
pnpm run build                       # 配置 CLI 位于 lib/setup
pnpm run setup:feishu -- --new       # 创建新应用并完成配置
```

之后向导会（无需再在 Web 控制台做任何操作）：

1. 创建一个**企业自建应用**（默认名称为 "DSH Agent (dsh-feishu)"，可用
   `--app-name` 修改），并读回其 `app_id` / `app_secret`。
2. 启用**机器人**能力。
3. 将**事件与卡片回调切换为长连接**，并订阅 `im.message.receive_v1`（事件）+
   `card.action.trigger`（卡片回调）——两者均为必需项，且会通过读回进行校验
   （失败即关闭，fail-closed）。
4. 授予 `im:message`、`im:message:send_as_bot`、`im:chat` 这些权限（scope）。
5. 以**"仅自己可见"**的可见范围发布一个应用版本——自动通过审批，无需等待
   管理员。
6. 将 `appId` / `appSecret` 写入 profile 的 `cordis.patch.yml`（会保留一份
   `.bak` 备份），或使用 `--print-env` 打印导出行。
7. **引导 surface 配置**——三个提示（直接回车 = 使用显示的默认值）：
   `repoRoots`（`/repo` 的扫描根目录，默认你的主目录）、
   `groupMentionMode`（默认 `always`）、`requireWorkingDir`（默认 `y`）。
   默认值优先取 profile 里已有的配置；非交互运行（CI、脚本）跳过提示，
   静默使用默认值。

如需重新配置现有应用而非新建：

```sh
pnpm run setup:feishu -- --app-id cli_xxx
```

其他选项：`--list`（列出会话可见的应用）、`--force-login`（即使有缓存的会话
也重新生成二维码）、`--lark`（Lark 国际版控制台）、`--verify-boot`（之后启动
`dsh --profile <name>` 并等待 `[feishu] bridge ready`）、`--help`（完整用法）。
会话文件位于 `~/.dsh-feishu/feishu-session.json`（可用 `DSH_FEISHU_SESSION`
覆盖），并在多次运行之间复用——只有第一次运行需要扫描二维码。

### 仍需手动完成的部分

创建应用、授予权限、订阅事件以及发布版本都是仅限控制台的操作——它们没有
公开 API。该自动化把控制台操作减少到**扫描一个二维码**；当它无法运行时
（终端无法显示二维码、企业登录策略限制），请使用手动路径。

## 手动配置（`--no-open-platform-auto`）

粘贴凭证，即可写入配置并得到一份简短清单：

```sh
pnpm run setup:feishu -- --no-open-platform-auto
```

该工具会针对飞书 API 校验凭证，将其写入 profile（或使用 `--print-env`），
并打印剩余的控制台步骤。手动步骤（供参考）：

### 1. 创建应用与机器人

1. 打开[飞书开放平台](https://open.feishu.cn/app)（Lark：
   [larksuite.com](https://open.larksuite.com/app)），创建一个**自建应用**
   （企业自建应用）。
2. 在 **App Features → Bot**（应用功能 → 机器人）中启用机器人。
3. 在 **Credentials & Basic Info**（凭证与基础信息）中记下 **App ID**
   （`cli_...`）和 **App Secret**（`...`）。

### 2. 启用长连接

surface 通过飞书 **WebSocket 长连接**接收事件——无需回调 URL、无需公网
endpoint、宿主机无需公网 IP（所有流量均为出站）。在 **Events & Callbacks**
（事件与回调）中：

- **Events**（事件订阅方式）：选择 **Long connection**（长连接），并订阅
  **Receive messages**（`im.message.receive_v1`，接收消息）。
- **Card callbacks**（卡片回调）：卡片按钮点击是**回调，而非事件**——其接收
  方式是**单独**配置的。请同样将卡片回调的接收方式切换为 **Long connection**
  （长连接），否则按钮点击会失败并提示"该应用尚未配置卡片回调"。

### 3. 授予权限

权威清单位于 `src/setup/feishu-manifest.json`（配置自动化授予的正是这份清单
——新增功能时请保持同步）。当前权限（Permissions，权限）：

| Scope | Purpose |
|---|---|
| `im:message` | Receive messages (`im.message.receive_v1`) |
| `im:message:send_as_bot` | Send messages and cards as the bot |
| `im:chat` | Read chat metadata |
| `im:resource` | Upload file messages (`/export`) |
| `im:message.reaction` | Two-stage reaction ack (received/done/error emojis) |

### 4. 发布

创建一个版本并发布。选择**"仅自己可见"**（仅自己可见），这样版本会立即
通过审批——无需等待管理员。

## 配置 surface

凭证从 `appId` / `appSecret` 配置键或 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
环境变量读取：

```sh
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=yyy
dsh --profile feishu
```

或在 profile 的 `cordis.patch.yml` 中配置：

```yaml
- id: feishu
  name: '@dsh-feishu/dsh-feishu'
  config:
    appId: cli_xxx
    appSecret: yyy
```

其他所有配置选项在 `cordis.patch.yml` 中使用相同的结构（`groupMentionMode`、
`allowedChats`、`allowedUsers`、`unknownCommand`、`repoRoots`、
`requireWorkingDir`、`reactions` 等）。影响路由的 surface 选项也提供环境变量
作为回退（配置优先，环境变量回退）：

| Environment variable | Values | Meaning |
|---|---|---|
| `FEISHU_ALLOWED_USERS` | comma-separated `ou_` open ids | user allowlist (messages and card buttons) |
| `FEISHU_ALLOWED_CHATS` | comma-separated chat ids | chat allowlist |
| `FEISHU_GROUP_MENTION_MODE` | `always` \| `never` \| `ambient` \| `topic` | group mention policy |
| `FEISHU_UNKNOWN_COMMAND` | `error` \| `passthrough` | unknown slash-line policy |

## 验证

凭证配置完成后，启动日志会打印：

```
[feishu] starting surface for app cli_xxx
feishu long connection ready
[feishu] bridge ready
```

然后用测试账号给机器人发私聊消息；回复会以实时卡片的形式流式返回。
`--verify-boot` 可在配置完成后自动完成此检查。

## 网络要求

只需要出站访问：飞书开放平台 HTTPS + WSS（`open.feishu.cn` /
`open.larksuite.com`）、DeepSeek API，以及 npm（用于安装）。无需入站端口，
无需公网 IP。

## 权限（Permissions）

- 发送文件消息（`/export`）需要开发者控制台中的 **`im:resource:upload`**
  （或 `im:resource`）权限（scope）（应用 → Permissions，权限）。缺少该权限
  时上传会以 HTTP 400 / "Access denied … im:resource:upload" 失败——surface
  会在 `/export` 的错误文本中提示这一点。

- 两阶段 reaction 确认需要 **`im:message.reaction`** 权限（也在上面的 manifest
  中）。reaction 失败只会记录日志——缺少该权限会退化为无表情，而绝不会破坏
  一次对话轮次。
- **`allowedUsers`**（配置项，或 `FEISHU_ALLOWED_USERS` 环境变量——以逗号
  分隔）将 surface 限制为仅服务于列出的发送者 open id；默认值（未设置/为空）
  则服务所有人。`ou_` 形式的 open id 是按应用隔离的：某个应用的列表不能
  转移到另一个应用。
