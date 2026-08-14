# dsh-feishu

[English](README.md) | 中文

把飞书（Feishu / Lark）变成原生 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）surface 的插件。

> **DSH-native —— 只为 DSH 而生，不做桥接。**
>
> dsh-feishu 不桥接外部 CLI，也不重实现任何 agent 能力。它是 dsh 自己的飞书 surface——与 web、终端并列的一等 UI。一个飞书聊天对应一个 dsh 会话；群里的机器人就是 agent 的化身。与多 CLI 桥接器不同，dsh-feishu 只针对一个 agent——dsh——并在进程内与它集成。

一个飞书聊天映射到一个 dsh 会话。给机器人发消息，即可驱动部署在 dsh 主机上的 agent，回答以实时飞书卡片流式返回。Slash 命令既操作 surface 本身（工作目录、会话、模型、预设），也透传给 dsh 自己的命令注册表。

> **状态：Iteration 1–4 与 Iteration 5 核心已完成。** 私聊/群聊、流式卡片（工具行、推理、markdown、原生表格）、带完整命令面板按钮的控制卡、会话生命周期（`/sessions /resume /clear`）、工作目录门禁（未选 repo 前拒绝工作）、审批卡与提问卡、聊天内 dsh web 命令面（`/plan /goal /compact /feedback /permission`，外加 surface 原生 `/model` 与各类选择器）、两阶段表情回执、`allowedUsers` 用户白名单、群内主动 @ 提醒、`/feishu-status` 诊断卡，以及定时提醒（dsh-schedule：聊天内配置，到期提醒以 `⏰ Reminder` 卡片渲染；`/schedule` 列出）。每个特性都配有单元 + 真实组合集成测试（共 393 个；其中 46 个跑真实 dsh 进程）。剩余见 [`PLAN.md`](PLAN.md)（文档中文版、v1 发布收尾）。

## 为什么是 DSH-native

在进程内构建 surface、而不是桥接终端，随之而来三条承诺：

1. **无桥接、无捕获。** 没有 CLI 适配器、没有 tmux/PTY、没有屏幕捕获、没有 ANSI 解析。surface 直接驱动 dsh 的 agent/session 层（`ctx.agents`、`ctx.commands`、`session/event`）。
2. **完全透明。** 每个 token、工具调用、提问和审批都原生流入聊天——agent 不需要做任何事就能被看见（没有显式的"发送"契约）。
3. **一切皆卡片。** dsh 的每个 surface 元素都映射为一张飞书卡片：流式输出、工具调用、会话列表、审批、提问、选择器。

## 环境要求

- Node.js >= 22.13
- dsh 安装（`npm install -g @deepseek-ai/dsh`）与 pnpm（`dsh plugin` 使用）
- 一个带机器人的飞书自建应用（见 [docs/feishu-setup.md](docs/feishu-setup.md)）

## 安装进 dsh profile

```sh
dsh plugin --profile feishu add @dsh-feishu/dsh-feishu@latest
dsh --profile feishu
```

> 尚未发布：包处于 pre-1.0。在此之前，用 `dsh plugin --profile feishu add link:<path-to-checkout>` 安装本地检出。

bundle 基于 `@deepseek-ai/dsh-base`；凭据从 `appId`/`appSecret` 配置键或 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 环境变量读取。

## 开发

构建、测试、lint 命令与本地 profile 挂载方法见 [docs/development.md](docs/development.md)。

## 致谢

- **[botmux](https://github.com/deepcoldy/botmux)** —— 群聊交互模式的参考：流式卡片、审批，以及扫码驱动的开放平台快速接入流程。dsh-feishu 借鉴的是 botmux 的*交互与接入模式*，而非其架构——botmux 桥接外部 CLI，而本 surface 是 dsh 原生、进程内的。
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —— 本 surface 所服务的平台；其 web surface（`packages/client/ui-*`）是聊天内命令、审批、提问的对齐参考。
- **[Lark Open Platform SDK](https://github.com/larksuite/node-sdk)** —— transport 所依赖的 WebSocket 长连接与卡片 API。

## License

MIT —— 见 [LICENSE](LICENSE)。
