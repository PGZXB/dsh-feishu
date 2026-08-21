# E2E UI 测试（feishu.cn 网页版）

真实客户端 E2E 套件在无头浏览器中驱动**真实的 feishu.cn 网页客户端**，像用户一样操作 bot：打开聊天、发送斜杠命令、点击卡片按钮、断言渲染结果。它是第三层测试：

| 层级 | 验证什么 | 何时运行 |
| --- | --- | --- |
| 单元测试 | 逻辑（fakes） | 每次 `pnpm test` |
| 集成测试（`tests/integration/`） | 真实 dsh 进程 + 真实 agent 循环，**飞书通道 mock**（memory transport），LLM mock | 每次 `pnpm test` |
| **E2E UI（本套件）** | 真实 dsh 进程 + **真实飞书**（长连接、卡片、回调）+ 真实浏览器客户端 | 先 `pnpm run e2e:setup` 一次，之后 `pnpm run e2e:ui`（按需） |

## 约束

- **断言全部规则化。** 所有断言只读渲染后的 DOM（消息文本、按钮、面板）或飞书 Open API。套件绝不调用付费视觉服务——测试必须免费且确定。
- **`modlens` CLI 仅作开发侧验证。** 编写/调试场景时用它看截图实际内容；它不是任何测试的一部分，且消耗 provider 配额——少用。
- **同一时间只跑一个真实聊天。** 场景单 worker 运行、共用 bot 聊天；并行场景会互相抢消息。
- **被测 bot 使用专用应用。** 用测试飞书应用（setup 会自动创建）和测试聊天，绝不用生产 bot。

## 架构

```
pnpm run e2e:setup  →  scripts/e2e-setup.mjs（一次性，宿主）
  └─ docker：复制仓库（只读挂载 → /app）→ 安装 → 构建 →
     profile → 创建 bot 应用（控制台扫码）→ 浏览器登录（扫码）→
     校验聊天存在  →  全部导出到 _dev/e2e-exchange/
     （creds.json、console-session.json、web-session.json、report/）

pnpm run e2e:ui     →  scripts/e2e-ui.mjs（宿主启动器）
  └─ docker：复制仓库 → 安装 → 构建 → profile →
     复用导出的凭据/会话（无需扫码）→
     启动 mock DeepSeek server + dsh（profile e2e-dev）→
     运行 Playwright 场景 →
     录屏转 mp4 → 写报告 + manifest.json
```

一切都在容器内按 README 的「从源码安装」流程执行。宿主只读挂载仓库 + 一个 **exchange** 目录——只有 exchange 会随容器留存：你要扫的二维码、复用的会话与应用凭据、最终报告。构建产物（node_modules、lib、pnpm store、dsh home）只存在于容器内，随容器退出消失。

**使用专用测试账号。** bot 应用和浏览器会话都创建在「扫码时所用账号」之下——请用专用测试账号扫码，绝不用生产账号。setup 带 `--force-login`，因此跨账号永远不会复用缓存的会话。

关键组成：

- **e2e/playwright.config.ts** — Playwright 配置；所有开关来自环境变量（见 `e2e/lib/config.ts`）。
- **e2e/lib/feishu.ts** — feishu.cn 网页 helper（打开应用/聊天、发消息、读聊天、点按钮、截图）。
- **e2e/lib/assert.ts** — 规则化聊天断言。
- **e2e/scenarios/*.spec.ts** — 每个场景一个文件。
- **Dockerfile.e2e** — 运行镜像：Playwright 官方镜像 + 完整 ffmpeg（自带版只支持 VP8；转 mp4 需要 H.264）。

## Setup（一次性，之后免人工）

```sh
pnpm install
pnpm run build
E2E_CHAT="My Test Bot" pnpm run e2e:setup
```

setup 依次完成：

1. 缺少 e2e docker 镜像时先构建；
2. 容器内：复制仓库（只读挂载）、安装 + 构建、把插件装进 profile `e2e-dev`；
3. **创建 bot 应用** — README quick-setup 带 `--force-login`；用**测试账号**扫 `_dev/e2e-exchange/setup.log` 里的控制台二维码（过期自动换新）；应用凭据导出到 `_dev/e2e-exchange/creds.json`（已存在则跳过）；
4. **浏览器登录** — 用同一账号扫 `_dev/e2e-exchange/qr.png`；storageState 导出到 `_dev/e2e-exchange/web-session.json`（已存在则跳过）；
5. **聊天校验** — 确认名为 `E2E_CHAT` 的聊天在消息列表中存在。

退出码：`0` = 就绪（之后的 `e2e:ui` 免人工）；`3` = 聊天缺失——在飞书 App 里搜索 bot 并给它发一条消息（飞书不允许程序化创建「用户↔全新 bot」的首个会话），然后重跑 `pnpm run e2e:setup` 收尾。

## 快速开始（setup 之后）

```sh
E2E_CHAT="My Test Bot" pnpm run e2e:ui

# 选项
E2E_VIDEO=off            # 不要视频（默认 mp4，webm 源也保留）
E2E_SCREENSHOTS=failure  # 仅失败时截图（默认 on）
E2E_BOT_NAME="My Test Bot"   # bot 应用名（默认 "DSH Agent (e2e)"）
E2E_APP_ID / E2E_APP_SECRET # 可选：覆盖 bot 应用
```

把聊天名放进 `_dev/e2e.env`（git-ignored）并 `set -a; source _dev/e2e.env; set +a` 再运行，避免进入 shell 历史或仓库。

## 报告

每次运行写入 `_dev/e2e-exchange/report/`：

- `html/` — Playwright HTML 报告
- `report.json` — Playwright JSON 报告
- `screenshots/` — 每个场景自选的关键截图（通过 `snapshot(page, cfg, label)`）+ Playwright 自动截图
- `*.webm` / `*.mp4` — 完整会话录屏（默认 mp4，webm 源保留）
- `manifest.json` — 机器可读产物清单（路径 + 类型 + 大小）

## 添加场景

1. 新建 `e2e/scenarios/<name>.spec.ts` —— 共享 helper 已覆盖大部分管道，场景只需几行意图。**关键截图由你在场景里指定**：在重要时刻（聊天打开、流式中、最终态）调用 `snapshot(page, cfg, label)`：

   ```ts
   import { test } from '@playwright/test';
   import { loadE2eConfig } from '../lib/config.js';
   import { waitForBotReplyContaining } from '../lib/assert.js';
   import { openApp, openChat, sendMessage, snapshot } from '../lib/feishu.js';

   const cfg = loadE2eConfig();

   test('send /model → model picker card', async ({ page }) => {
     await openApp(page, cfg);
     await openChat(page, cfg.chatName, cfg.timeoutMs);
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

## 选择器（从真实客户端会话捕获）

以下是 helper 依赖的 feishu.cn 网页 DOM 锚点。飞书网页端可能变动；选择器失效时请同步更新此处与 helper。

| 对象 | 选择器 |
| --- | --- |
| 应用外壳 URL | 路径匹配 `/(messenger\|home\|space\|contact\|drive)/`（任意租户子域） |
| 聊天消息项 | `.js-message-item`；`.message-self` 标记自己发的 |
| 聊天输入框（composer） | `[contenteditable="true"]`（`.zone-container.editor-kit-container.innerdocbody`） |
| 卡片按钮 | `<button>` 元素；按可访问名称匹配 |
| 登录二维码 | accounts 登录页 `[class*="scan-QR-code"]` 内的 `canvas`（会过期——登录 helper 会 reload 换新） |

## 排障

- **「feishu app did not open」** — 浏览器会话过期；重跑 `pnpm run e2e:setup`（一次扫码）刷新。
- **`e2e:setup` 退出码 3** — 聊天尚不存在；在飞书 App 里给 bot 发一条消息，然后重跑 `e2e:setup`。
- **dsh 一直不报 "long connection ready"** — 应用凭据错误，或应用未配置长连接事件模式（见 `docs/feishu-setup.md`）。
- **docker build 失败** — 构建需要写 `~/.docker` 的 buildx 状态；确保可写（可用 `DOCKER_CONFIG` 重定向）。
- **mp4 转换被跳过** — 镜像自带 ffmpeg 无 H.264；容器用的是 `Dockerfile.e2e` 里的完整 ffmpeg（升级 Playwright 基础镜像后重建镜像）。
