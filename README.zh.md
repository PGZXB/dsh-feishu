# The Feishu UI for DeepSeek Harness (dsh)

[English](README.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](package.json)
[![npm](https://img.shields.io/npm/v/@dsh-feishu/dsh-feishu)](https://www.npmjs.com/package/@dsh-feishu/dsh-feishu)
[![CI](https://img.shields.io/github/actions/workflow/status/PGZXB/dsh-feishu/ci.yml?branch=main)](.github/workflows/ci.yml)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）做的飞书 UI——一个 dsh 原生插件，带**面板驱动的控制台**：每个 slash 命令都是 ⚙️ 控制面板卡片上的一个按钮，审批和提问都在聊天卡片内完成，扫一次二维码就把整个应用配好。

> **注意：** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
> 目前仍是预发布版本（`0.1.0-rc.x`），版本之间可能有破坏性变更。dsh-feishu
> 跟踪**两个** dsh 版本：
> - `main` 分支（git 安装）跟踪 **dsh `@next`**——当前为 **`0.1.2-rc.1`**；
> - npm `@latest` release 跟踪 **dsh `@latest`**——当前为 **`0.1.2-rc.1`**。

https://github.com/user-attachments/assets/e9163793-52f2-4e2c-a08a-22b27372be61

*2 分半的演示（控制面板、流式卡片、审批与提问）。*

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
#    （pnpm ≥ 11 默认拦截 protobufjs 的构建脚本，所以加上
#     --allow-build=protobufjs 让它执行）
npx @deepseek-ai/dsh plugin --profile feishu add @dsh-feishu/dsh-feishu@latest --allow-build=protobufjs

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

<p align="center"><img src="docs/assets/snapshots/1_chat.png" width="640" alt="与机器人的聊天"></p>

2. **打开控制面板。** 发 `/panel` 会唤出一张面板卡片。

<p align="center"><img src="docs/assets/snapshots/2_panel.png" width="640" alt="控制面板"></p>

3. **先定工作目录。** 没定目录之前机器人不会开工：点 **📚 Pick project** 从列表里挑（等价于 `/repo`），或点 **📁 Change dir** 直接输入路径（等价于 `/cd <路径>`）。

<p align="center"><img src="docs/assets/snapshots/3_repo.png" width="640" alt="项目选择"></p>

4. **直接问。** 发消息，agent 跑起来，工具调用、思考过程、markdown、表格一行行流进一张卡片。跑完卡片变绿，答案完整留在里面；停止、复制、重试和 ⚙️ 面板按钮就贴在卡片上。

   | 进行中 | 已完成 |
   |---|---|
   | ![卡片进行中](docs/assets/snapshots/4.1_streaming-mid.png) | ![卡片已完成](docs/assets/snapshots/4.2_streaming-done.png) |

5. **要审批就批，要回答就答。** agent 需要提权时会弹一张审批卡，点 **Allow once** 放行（或 **Reject** 拒绝）；它有问题会弹提问卡，点选项或直接回一句。

   | 审批 | 提问 |
   |---|---|
   | ![审批卡](docs/assets/snapshots/5.1_approval.png) | ![提问卡](docs/assets/snapshots/5.2_question.png) |

6. **管会话。** 点 **🗂️ Sessions** 列出所有已保存的会话、直接在卡片上恢复（等价于 `/sessions`；`/resume <id>` 也能把某个会话搬进当前聊天），点 **➕ New chat** 开新对话、旧的照留（等价于 `/clear`）。

<p align="center"><img src="docs/assets/snapshots/6_sessions.png" width="640" alt="会话列表"></p>

面板卡片上的每个按钮都对应一个 slash 命令——哪种顺手用哪种；`/help` 会把所有命令列一遍。

## 命令

| 命令 | 作用 |
|---|---|
| `/help` | 列出所有命令 |
| `/panel` | 打开控制面板卡（所有命令的按钮版） |
| `/group <name>` | 和机器人建群（无参会弹名称输入卡） |
| `/cancel` | 停下正在跑的回合 |
| `/cd <path>` | 设置本聊天的工作目录（无参会弹路径输入卡） |
| `/repo [path]` | 挑一个项目目录（无参扫描默认 roots；`/repo <path>` 扫描该路径） |
| `/status` | 查看本聊天的会话状态 |
| `/feishu-status` | 显示运行状态诊断卡 |
| `/schedule` | 列出活跃的提醒 |
| `/model <provider/model>` | 切换本会话的模型（无参打开选择器） |
| `/export` | 把会话日志作为文件发出来 |
| `/log` | 把 dsh-feishu 的日志文件发到本聊天（便于排查问题；提 issue 时建议附上关键日志） |
| `/sessions` | 列出已保存会话（卡片上可恢复） |
| `/resume <id>` | 在本聊天恢复一个已保存会话（无参打开会话列表） |
| `/clear` `/new` | 开新对话（旧会话仍保留） |
| `/goal <text>` | 设置任务目标（无参会弹文本输入卡） |
| `/compact` | 压缩较旧的对话历史 |
| `/feedback <text>` | 发送反馈（无参会弹文本输入卡） |
| `/permission <preset>` | 切换权限预设（无参打开选择器） |
| `/plan [on\|off]` | 进入或退出计划模式（无参切换） |

## 能做什么

- **实时流式卡片**——工具调用、思考、markdown、表格，边跑边流出来。
- **一键控制面板**——`/panel` 把命令面板全部做成按钮；不用记命令语法，且每个按钮与敲命令完全等价。
- **卡内审批 / 提问**——提权审批、回答问题都在聊天里完成。
- **会话不丢**——重启守护进程，聊天对应的会话和工作目录都还在。
- **群聊 + @ 提醒**——群里 @ 机器人即可；出错、审批、提问都会 @ 回发起人。
- **回执、白名单、提醒、导出、诊断**——表情回执、`allowedChats` / `allowedUsers` 白名单、定时提醒、会话日志文件、状态卡。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。开发、测试与发布：[docs/development.md](docs/development.md)。

## 交流群

扫码加入 dsh-feishu 飞书交流群：

<img src="docs/assets/feishu-group-qr-code.png" alt="dsh-feishu 交流群二维码" width="220">

## 致谢

- **[botmux](https://github.com/deepcoldy/botmux)** —— 群聊交互模式的参考：流式卡片、审批，以及扫码驱动的开放平台快速接入流程。dsh-feishu 借鉴的是 botmux 的*交互与接入模式*，而非其架构——botmux 桥接外部 CLI，本插件则是 dsh 原生、进程内的。
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —— 本插件所服务的平台。
- **[Lark Open Platform SDK](https://github.com/larksuite/node-sdk)** —— 底层所用的 WebSocket 长连接与卡片 API。

## License

MIT——见 [LICENSE](LICENSE)。
