# The Feishu UI for DeepSeek Harness (dsh)

[English](README.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/PGZXB/dsh-feishu/ci.yml?branch=main)](.github/workflows/ci.yml)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）做的飞书 UI——一个 dsh 原生插件。`dsh plugin add` 装上、扫一次二维码，就能在飞书里跑你的 agent。

## 快速上手

### 从 npm 安装

```sh
# 1. 安装 Node.js ≥ 22.13
#    macOS / Linux：nvm（https://github.com/nvm-sh/nvm）→ nvm install 22
#    Windows：https://nodejs.org（或 winget install OpenJS.NodeJS.LTS）
node --version

# 2. 安装 pnpm
npm install -g pnpm

# 3. 安装插件
npx @deepseek-ai/dsh plugin --profile feishu add @dsh-feishu/dsh-feishu@latest

# 4. 扫一次二维码：创建并配置飞书应用
npx --yes --package @dsh-feishu/dsh-feishu dsh-feishu-setup --new --profile feishu

# 5. 启动
npx @deepseek-ai/dsh --profile feishu
```

### 从源码安装

```sh
# 1. 安装 Node.js ≥ 22.13
#    macOS / Linux：nvm（https://github.com/nvm-sh/nvm）→ nvm install 22
#    Windows：https://nodejs.org（或 winget install OpenJS.NodeJS.LTS）
node --version

# 2. 安装 pnpm
npm install -g pnpm

# 3. 克隆并构建
git clone https://github.com/PGZXB/dsh-feishu.git
cd dsh-feishu
pnpm install
pnpm run build

# 4. 装进 profile
npx @deepseek-ai/dsh plugin --profile feishu add link:.

# 5. 扫一次二维码：创建并配置飞书应用
pnpm run setup:feishu -- --new --profile feishu

# 6. 启动
npx @deepseek-ai/dsh --profile feishu
```

然后到飞书里给机器人发消息即可。配置向导会把飞书应用整套搞定，全程不用开网页控制台，也不用手填凭据。如果你已经有应用，改成设置 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（环境变量或 profile 配置），详见 [docs/feishu-setup.md](docs/feishu-setup.md)。

### 卸载

```sh
# 从 profile 移除插件
npx @deepseek-ai/dsh plugin --profile feishu remove @dsh-feishu/dsh-feishu

# 可选——彻底清理：删除 profile 及其 surface 数据
#（路径按默认 dsh home，~/.dsh）
rm -rf ~/.dsh/profiles/feishu ~/.dsh/feishu
```

## 怎么用

一个飞书聊天对应一个 dsh 会话，机器人就是 agent 的化身。一次典型的使用是这样：

1. **开个聊天。** 直接私聊机器人；也可以发 `/group <名字>` 建个群。群里一般要 @ 机器人（默认策略）；如果群里只有你和机器人，不 @ 直接说也行；@ 策略本身可配置。
2. **先定工作目录。** 没定目录之前机器人不会开工：发 `/cd /路径/到/项目`，或 `/repo` 从列表里挑一个。
3. **直接问。** 发消息，agent 跑起来，工具调用、思考过程、markdown、表格一行行流进一张卡片。跑完卡片变绿，答案完整留在里面；停止、复制、重试和 ⚙️ 面板按钮就贴在卡片上。
4. **要审批就批，要回答就答。** agent 需要提权时会弹一张审批卡，点 **Allow once** 放行（或 **Reject** 拒绝）；它有问题会弹提问卡，点选项或直接回一句。
5. **管会话。** `/sessions` 列出所有已保存的会话（卡片上就能恢复），`/resume <id>` 把某个会话搬进当前聊天，`/clear` 开新对话、旧的照留。
6. **不想敲命令就点按钮。** `/panel` 打开一张把所有命令做成按钮的卡片；`/help` 会把它们全列一遍。

## 命令

| 命令 | 作用 |
|---|---|
| `/cd <路径>` | 设置本聊天的工作目录 |
| `/repo` | 列出候选项目目录供挑选 |
| `/sessions` | 列出已保存会话（卡片上可恢复） |
| `/resume [id]` | 在本聊天恢复一个已保存会话 |
| `/clear` `/new` | 开新对话（旧会话仍保留） |
| `/cancel` | 停下正在跑的回合 |
| `/status` | 查看本聊天的会话状态 |
| `/model` | 选模型或设置默认模型 |
| `/export` | 把会话日志作为文件发出来 |
| `/schedule` | 列出活跃的提醒 |
| `/feishu-status` | 显示运行状态诊断卡 |
| `/group` | 和机器人建群 |
| `/panel` | 打开控制面板卡（所有命令的按钮版） |
| `/help` | 列出所有命令 |
| `/plan` `/permission` `/goal` `/compact` `/feedback` | dsh 自带命令，和 web UI 一致 |

## 能做什么

- **实时流式卡片**——工具调用、思考、markdown、表格，边跑边流出来。
- **卡内审批 / 提问**——提权审批、回答问题都在聊天里完成。
- **会话不丢**——重启守护进程，聊天对应的会话和工作目录都还在。
- **群聊 + @ 提醒**——群里 @ 机器人即可；出错、审批、提问都会 @ 回发起人。
- **回执、白名单、提醒、导出、诊断**——表情回执、`allowedChats` / `allowedUsers` 白名单、定时提醒、会话日志文件、状态卡。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。开发、测试与发布：[docs/development.md](docs/development.md)。

## 致谢

- **[botmux](https://github.com/deepcoldy/botmux)** —— 群聊交互模式的参考：流式卡片、审批，以及扫码驱动的开放平台快速接入流程。dsh-feishu 借鉴的是 botmux 的*交互与接入模式*，而非其架构——botmux 桥接外部 CLI，本插件则是 dsh 原生、进程内的。
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —— 本插件所服务的平台。
- **[Lark Open Platform SDK](https://github.com/larksuite/node-sdk)** —— 底层所用的 WebSocket 长连接与卡片 API。

## License

MIT——见 [LICENSE](LICENSE)。
