# 示例：运行飞书 surface 的 dsh profile

一个完整、可直接复制的 `@dsh-feishu/dsh-feishu` dsh profile 示例。它预先配置了常用选项，开箱即用。

## 安装

```sh
# 从 dsh-feishu 检出（pre-1.0），或发布后使用 @latest：
DSH_HOME="$HOME/.dsh" dsh plugin --profile feishu add link:/path/to/dsh-feishu
DSH_HOME="$HOME/.dsh" dsh --profile feishu
```

然后给机器人发私聊消息即可；所有特性（流式卡片、审批、提问、表情回执、定时提醒、`/feishu-status`）开箱即用。

## 示例配置了什么

- `repoRoots` —— `/repo` 的扫描根目录（一层深度）。
- `allowedUsers` —— 可选用户白名单（`ou_` open id 是 app 级作用域；留空即不限制）。
- `groupMentionMode` —— `always` | `never` | `ambient` | `topic`。
- `requireWorkingDir` —— 门禁默认开启；只有想用 `defaultCwd` 兜底的部署才设 `false`。
- `reactions` —— 两阶段回执表情（received/done/error/stopped）。
- bundle 还会自动挂载 `@deepseek-ai/dsh-schedule`（聊天内配置的提醒，以 `⏰ Reminder` 卡片渲染）与 `ask_user_question` 工具（提问卡片）。

凭据来自下面的 `appId`/`appSecret` 或 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 环境变量；飞书应用与权限（含 `/export` 所需的 `im:resource`）见 `docs/feishu-setup.md`。
