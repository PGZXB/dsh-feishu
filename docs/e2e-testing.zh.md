# E2E UI 测试（feishu.cn 网页版）

真实客户端 E2E 套件在无头浏览器中驱动**真实的 feishu.cn 网页客户端**，像用户一样操作 bot：打开群聊、发送斜杠命令、点击卡片按钮、断言渲染结果。它是第三层测试：

| 层级 | 验证什么 | 何时运行 |
| --- | --- | --- |
| 单元测试 | 逻辑（fakes） | 每次 `pnpm test` |
| 集成测试（`tests/integration/`） | 真实 dsh 进程 + 真实 agent 循环，**飞书通道 mock**（memory transport），LLM mock | 每次 `pnpm test` |
| **E2E UI（本套件）** | 真实 dsh 进程 + **真实飞书**（长连接、卡片、回调）+ 真实浏览器客户端 | 先 `pnpm run e2e:setup` 一次，之后 `pnpm run e2e:ui`（按需） |

## 约束

- **断言全部规则化。** 所有断言只读渲染后的 DOM（消息文本、按钮、面板）或飞书 Open API。套件绝不调用付费视觉服务——测试必须免费且确定。
- **`modlens` CLI 仅作开发侧验证。** 编写/调试场景时用它看截图实际内容；它不是任何测试的一部分，且消耗 provider 配额——少用。
- **每个测试用例一个群聊。** 每个用例运行在自己独立的群聊里，群名 `<caseId>-<runId>`（每次运行全局唯一），通过后台创建——与插件 `/group` 命令底层相同的 `im.v1.chat.create` 调用。用例之间永不共享聊天页面，并行运行不会互相抢消息。
- **被测 bot 使用专用应用。** 用测试飞书应用（setup 会自动创建，名字带唯一后缀 `DSH-E2E-TESTBOT-<时间戳>`）和专用测试账号，绝不用生产 bot。

## 架构

```
pnpm run e2e:setup  →  scripts/e2e-setup.mjs（一次性，宿主，幂等）
  └─ docker：复制仓库（只读挂载 → /app）→ 安装 → 构建 →
     profile → 创建 bot 应用（开放平台扫码）→ 浏览器登录（扫码）→
     提取测试用户 open_id → 探针验证后台建群/删群 →
     全部导出到 e2e/.state/
     （creds.json、console-session.json、web-session.json、user.json）

pnpm run e2e:ui     →  scripts/e2e-ui.mjs（宿主启动器）
  └─ docker：复制仓库 → 安装 → 构建 → profile →
     复用导出的凭据/会话/用户（无需扫码）→
     启动 mock DeepSeek server + dsh（profile e2e-dev）→
     运行 Playwright 场景（每个用例后台创建自己的群聊）→ 录屏转 mp4 →
     生成单入口运行报告到 e2e/.output/<runId>/
     （summary.html → cases/<caseId>/report.html + JSON；`latest` 软链指向最新）
```

一切都在容器内按 README 的「从源码安装」流程执行。宿主只读挂载仓库 + 两个 git-ignored 目录：

- **`e2e/.state/`** — 持久 setup 状态（setup 期间的二维码文件、`creds.json`、`console-session.json`、`web-session.json`、`user.json`）。setup 从容器导出，运行用例时再导入。
- **`e2e/.output/`** — 运行报告：每次运行一个带时间戳的目录（`<runId>/`）存放单入口报告，另有 `latest` 软链指向最新一次。

构建产物（node_modules、lib、pnpm store、dsh home）只存在于容器内，随容器退出消失。

**使用专用测试账号。** bot 应用和浏览器会话都创建在「扫码时所用账号」之下——请用专用测试账号扫码，绝不用生产账号。

**Setup 幂等。** 重跑 `e2e:setup` 不会对已导出的登录状态重新扫码：`creds.json` 已存在则跳过开放平台扫码，`web-session.json` 已存在则跳过浏览器扫码，`user.json` 已存在则跳过 open_id 提取。只补齐缺失的部分。

关键组成：

- **e2e/playwright.config.ts** — Playwright 配置；所有开关来自环境变量（见 `e2e/lib/config.ts`）。
- **e2e/lib/feishu.ts** — feishu.cn 网页 helper（打开应用/聊天、发消息、读聊天、点按钮、截图）。
- **e2e/lib/group.ts** — 后台建群/删群（`im.v1.chat.create` / `im.v1.chat.delete`，与 `/group` 同一底层调用）+ 唯一群名构造器。
- **e2e/lib/assert.ts** — 规则化聊天断言。
- **e2e/scenarios/*.spec.ts** — 每个场景一个文件。
- **Dockerfile.e2e** — 运行镜像：Playwright 官方镜像 + 完整 ffmpeg（自带版只支持 VP8；转 mp4 需要 H.264）。

## Setup（一次性，之后免人工）

```sh
pnpm install
pnpm run build
pnpm run e2e:setup
```

setup 依次完成：

1. 缺少 e2e docker 镜像时先构建；
2. 容器内：复制仓库（只读挂载）、安装 + 构建、把插件装进 profile `e2e-dev`；
3. **创建 bot 应用** — README quick-setup；用**测试账号**扫 `e2e/.state/setup.log` 里的开放平台二维码（过期自动换新）；应用以**唯一名称** `DSH-E2E-TESTBOT-<YYYYMMDDHHmmss>` 创建（持久化到 `e2e/.state/bot-name`；可用 `E2E_BOT_NAME` 覆盖），确保 setup 的搜索 bot 步骤不会匹配到更早运行留下的同名残留应用；凭据导出到 `e2e/.state/creds.json`（已存在则跳过；设了 `E2E_APP_ID`/`E2E_APP_SECRET` 也跳过）；
4. **浏览器登录** — 用同一账号扫 `e2e/.state/qr.png`；storageState 导出到 `e2e/.state/web-session.json`（已存在则跳过）；
5. **测试用户 open_id** — 浏览器给 bot 发一条一次性私聊消息（创建 p2p 聊天），然后用应用自身凭据（manifest 已有的 `im:chat` / `im:chat.members:read`，无需额外 scope）从该聊天的成员里解析出测试用户 open_id，存入 `e2e/.state/user.json`——后台建群需要用它把测试用户拉进群（已存在则跳过）；
6. **建群探针** — 通过后台创建并删除一个探针群，验证应用能管理群聊。

退出码：`0` = 就绪（之后的 `e2e:ui` 免人工）；其他 = 失败（看输出）。

## 快速开始（setup 之后）

```sh
pnpm run e2e:ui

# 选项
E2E_VIDEO=off            # 不要视频（默认 mp4，webm 源也保留）
E2E_SCREENSHOTS=failure  # 仅失败时截图（默认 on）
E2E_BOT_NAME="DSH-E2E-TESTBOT-20260821191530"  # bot 应用名（默认：setup 生成的唯一名）
E2E_APP_ID / E2E_APP_SECRET # 可选：覆盖 bot 应用
```

不需要聊天名：每个用例自己通过后台创建群聊（`<caseId>-<runId>`）并打开它。

## 报告

每次运行写入 `e2e/.output/<runId>/` 下的一个带时间戳目录（`latest` 软链指向最新）。报告**只有一个入口**——`summary.html`，采用 Playwright HTML 报告的视觉风格（深色侧边栏用例列表 + 状态点 + 浅色主面板），链接到每个用例的自包含页面：

```
<runId>/
  summary.html      唯一入口：运行统计 + 所有用例（侧边栏），可点进
                    cases/<caseId>/report.html
  summary.json      机器可读的运行 + 每用例摘要
  cases/<caseId>/
    report.html     单用例自包含页（状态、错误、注解、截图、<video> 录屏、产物、stdout）
    report.json     单用例的详尽 JSON
    screenshots/    该用例的关键截图（场景通过 snapshot(page, cfg, label) 自选）
                    + Playwright 自动截图
    video.mp4       该用例完整录屏（mp4；webm 源保留为 video.webm）
  report.json       Playwright 原始 JSON（生成器的数据源）
  manifest.json     扁平产物清单（路径 + 类型 + 大小）
```

单用例 `report.json` 事无巨细：状态、耗时、开始时间、重试次数、错误消息 + 位置、注解、stdout/stderr、产物，以及运行环境（node/playwright/插件版本、视频/截图策略）。

## 添加场景

1. 新建 `e2e/scenarios/<name>.spec.ts` —— 共享 helper 已覆盖大部分管道，场景只需几行意图。**每个用例先后台创建自己的群聊**（`<caseId>-<runId>`，每次运行唯一）再打开；**关键截图由你在场景里指定**：在重要时刻（聊天打开、流式中、最终态）调用 `snapshot(page, cfg, label)`：

   ```ts
   import { test } from '@playwright/test';
   import { loadE2eConfig } from '../lib/config.js';
   import { waitForBotReplyContaining } from '../lib/assert.js';
   import { openApp, openChat, sendMessage, snapshot } from '../lib/feishu.js';
   import { caseIdFromTitle } from '../lib/report.js';
   import { createGroup, groupNameFor } from '../lib/group.js';

   const cfg = loadE2eConfig();

   test('send /model → model picker card', async ({ page }, testInfo) => {
     const groupName = groupNameFor(caseIdFromTitle(testInfo.title), cfg.runId);
     await createGroup(cfg, groupName, [cfg.userOpenId!]);
     await openApp(page, cfg);
     await openChat(page, groupName, cfg.timeoutMs);
     await snapshot(page, cfg, 'model-chat-open');
     await sendMessage(page, '/model');
     await waitForBotReplyContaining(page, 'Model', cfg.timeoutMs);
     await snapshot(page, cfg, 'model-picker');
   });
   ```

2. 只断言 DOM 可见内容（消息文本、按钮文案、面板内容）——规则化、免费、确定。
3. 需要新交互 helper（打开面板、选择器选择）时，加进 `e2e/lib/feishu.ts` 并注明它定位的选择器，同时更新下方选择器表。

## Helper API（`e2e/lib/`）

| Helper | 用途 |
| --- | --- |
| `openApp(page, cfg)` | 打开消息应用并等待应用外壳 |
| `openChat(page, name, timeoutMs)` | 按名称打开聊天（轮询懒加载列表；搜索兜底） |
| `sendMessage(page, text)` | 在聊天输入框输入并发送 |
| `chatMessages(page)` | 读取已渲染消息 `{text, isSelf}[]` |
| `clickButton(page, label)` / `clickCardText(page, label)` | 点击卡片按钮 / 卡片文本 |
| `snapshot(page, cfg, label)` | 保存关键截图到 `report/screenshots/` |
| `waitForBotReplyContaining(page, text, timeoutMs)` | 等待包含指定文本的 bot 回复（规则化） |
| `groupNameFor(caseId, runId)` | 唯一群名 `<caseId>-<runId>`，截断至 ≤ 60 字符 |
| `createGroup(cfg, name, memberOpenIds)` / `deleteGroup(cfg, chatId)` | 后台建群/删群（`im.v1.chat.create` / `im.v1.chat.delete`） |

## 选择器（从真实客户端会话捕获）

以下是 helper 依赖的 feishu.cn 网页 DOM 锚点。飞书网页端可能变动；选择器失效时请同步更新此处与 helper。

| 对象 | 选择器 |
| --- | --- |
| 应用外壳 URL | 路径匹配 `/(messenger\|home\|space\|contact\|drive)/`（任意租户子域） |
| 聊天消息项 | `.js-message-item`；`.message-self` 标记自己发的 |
| 聊天输入框（composer） | `.innerdocbody` / `.zone-container.editor-kit-container`（可见） |
| 卡片按钮 | `<button>` 元素；按可访问名称匹配 |
| 登录二维码 | accounts 登录页 `[class*="scan-QR-code"]` 内的 `canvas`（会过期——登录 helper 会 reload 换新） |

## 排障

- **「feishu app did not open」** — 浏览器会话过期；重跑 `pnpm run e2e:setup`（一次扫码）刷新。
- **setup 在建群探针处失败** — 应用无法通过后台创建群聊；检查应用的权限/scope（见 `docs/feishu-setup.md`），并确认 `E2E_USER_OPEN_ID` 解析到的是测试账号。
- **「setup state missing」** — 先跑 `pnpm run e2e:setup`；运行模式拒绝猜测凭据。
- **dsh 一直不报 "long connection ready"** — 应用凭据错误，或应用未配置长连接事件模式（见 `docs/feishu-setup.md`）。
- **docker build 失败** — 构建需要写 `~/.docker` 的 buildx 状态；确保可写（可用 `DOCKER_CONFIG` 重定向）。
- **mp4 转换被跳过** — 镜像自带 ffmpeg 无 H.264；容器用的是 `Dockerfile.e2e` 里的完整 ffmpeg（升级 Playwright 基础镜像后重建镜像）。
