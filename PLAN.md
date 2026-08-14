# DSH-Feishu 插件开发计划

> 目标：为 DeepSeek Harness（下文简称 **DSH**）开发一个 DSH-native 的飞书（Feishu）操作插件——把飞书变成接近原生体验的 DSH UI 端（类比 Web / TUI），一个飞书群对应一个 DSH 会话，群里机器人即 DSH 的化身，支持流式卡片与 slash 命令（部分操作本插件，部分透传给 DSH）。最终产出可开源的高质量仓库。
>
> 开发方式：**迭代式**——先完成核心功能并测试，再逐步叠加新功能。
>
> 状态：**Iteration 1–2 ✅**（私聊/群聊闭环、重启安全、命令体系（17 个表面命令 + 完整按钮面板 + DSH web 命令包装 `/plan /goal /compact /feedback /permission`、surface-native `/model`）、会话生命周期 `/sessions /resume /clear`、UX 打磨（下拉选择卡、note 状态、按钮分行）、**工作目录门禁**（未显式选 repo 前拒绝工作）；`/export` 因 Web-only 浏览器下载通道有意排除）；**Iteration 3 ✅（交互审批卡 + 提问卡 + 统一交互机制 `cards/interactions.ts`，fail-closed 语义）**；299 测试全绿（含 21 个真实组合集成测试，其中 2 个为真实审批链路：沙箱升级工具调用 → 审批卡 → Allow/Reject → 工具继续/报错）。**Iteration 4（历史回放/表情回执/主动通知/权限白名单）待开始**。`/export` 已落地为**文件消息**（web 浏览器下载的飞书等价物），`ask_user_question` 提问工具已随 bundle 挂载（与 web standard/code 预设对齐）。
>
> 已确认决策（2026-08）：npm 包名 `@dsh-feishu/dsh-feishu`；未知 slash 命令默认报错提示（附 `/help` 指引，配置项留后门）；飞书测试机器人由用户自行申请、稍后提供凭据。
>
> 评审补充（2026-08）：① **部署主机无需公网 IP**（全出站，见 §1.4 网络要求）；② **权限审核（`ctx.approval`）与用户提问（`ctx.userQuestions`）统一以飞书交互卡呈现**，已并入 §1.5、§2.3、§3 P1、Iteration 3。
>
> **核心特点（已确认）**：**DSH-native —— 只为 DSH 而生**。不桥接外部 CLI、不重实现 agent 能力；飞书是 DSH 自己的原生 surface（与 web/TUI 平级）。三条推论：无桥无捕获、完整透明（agent 无需任何配合）、一切皆卡片。
>
> **UX 模型（已确认）**：① **流式卡片 = 过程 + 核心按钮**——实时滚动输出，运行中带 ⏹ 停止、完成后带 📋 复制 / 🔁 重试 / ⚙️ 面板；② **最终答案由卡片就地封口承载全文，另发极简完成通知**（消除双气泡内容重复；官方 streaming_mode 单气泡作为 Iteration 4 实验）；③ **操作面板卡**——按钮直达插件命令/DSH 命令，无需打 slash 消息；④ 卡片回调走 `card.action.trigger`（WS 可达，免公网）。
>
> **按钮分层（已确认细化）**：**流式卡片只放核心按钮**（按状态：运行中 ⏹ Stop；完成 📋 Copy / 🔁 Retry / ⚙️ Panel）；**Panel 弹出完整按钮面板**——所有命令的图形入口（插件命令 + DSH 透传命令，按分类分组、超长分页）。按钮即命令：每个命令声明按钮标签（或自动生成），点击执行与 slash 命令同一处理器。
>
> **Iteration 2 范围（已调整）**：群聊 @ 触发 + 命令体系 + **卡片按钮基础**（card.action.trigger 路由 + 核心按钮）+ **完整按钮面板**（Panel 弹出全量命令按钮）+ 最终消息极简通知；交互审批/提问卡仍在 Iteration 3。

---

## 1. 调研结论（已完成的探索）

### 1.1 DSH 插件机制（一手资料：`deepseek-ai/deepseek-harness` 源码 + 已安装的 `@deepseek-ai/dsh@0.1.0-rc.6`）

**关键事实：DSH 里 "everything is a plugin"，Web UI 本身就是一个插件 bundle（`@deepseek-ai/dsh-web-app`）。**

- **Bundle（bundle patch layer）**：npm 包，其 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` —— 这是 Loader 识别"这是 DSH 插件"的**唯一契约**（modlens 的 CHANGELOG 实证：缺少该字段时包被当作普通依赖，工具完全不出现）。
- **`cordis.patch.yml`**：一个 YAML 数组，行（rows）为 `insert` / `disable` / 按 id `override`；每行是一个 cordis 插件实例（`id` + `name`（包名）+ `config`）。Bundle 的 patch 叠加在 `@deepseek-ai/dsh-base` 之上（`dsh-base` 提供 sessions / agent-loop / tools / commands / llm / fs 等基础行）。
- **Profile 机制**：`dsh --profile <name>` 启动一个 profile（`$DSH_HOME/profiles/<name>/`，含 `package.json` 的 `dsh.profile.bundles` 有序 bundle 栈 + 用户 `cordis.patch.yml`）。安装：`dsh plugin --profile <name> add <pkg>@latest` → 首次自动初始化（默认 bundles=`['@deepseek-ai/dsh-base']`）→ pnpm add → **自动把带 `dsh.bundle` 声明的依赖追加进 bundle 栈**。
- **插件形态**：function plugin，`export const name / inject / Config / apply(ctx, config)`；service 类则 default export。可选服务用 `ctx.get(name)`，注入服务用 `inject`。
- **会话与 Agent API（我们插件的 DSH 侧核心）**：
  - `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model }, setup })` → `{ agent, dispose }`（同时建 session）；`ctx.agents.resume({ resumeSessionId })` 恢复持久化会话；`ctx.agents.get(id)`。
  - `agent.followup(createUserMessage({ content, source: { kind: 'user' } }))`（排队一轮）/ `agent.steer(msg)`（插入进行中的 step）/ `agent.cancel(cause, { keepInbox })` / `agent.whenIdle()`。`createUserMessage` 来自 `@deepseek-ai/dsh-llm`。
  - 事件流：`ctx.on('session/event', (session, event) => …)` 是全量事件水龙头：`assistant/chunk`（token 级流式）、`assistant/message`（成稿）、`tool/call` / `tool/result`、`turn/start|end`、`step/start|end`、`todo/write`、`request/header`。`agent.session.events` 可重放历史。
  - Slash 命令：`ctx.commands.register({ name, description, handler })`（插件自有命令，不经模型）；`ctx.commands.execute(agent, line, signal)`；`parseCommand(line)`。Web UI 的规则：以 `/` 开头的单条文本即命令，未注册命令报 `unknown-command`（cc-tui 则回落到模型——两套语义，我们取可配置）。
  - 交互提问：`ctx.userQuestions.registerProvider({ ask(request) })` —— `ask_user_question` 工具的 UI 端，**天然适配飞书卡片按钮**。
  - 驱动样例：`packages/bundle/headless` 即最小 host-side surface（create → `await loader.await()` → followup → `whenIdle` → `sessions.flush` → 汇总输出）。
- **本插件的定位**：与 `dsh-headless`、`@deepseek-ai/dsh-acp`（自动化服务器）同一类——**host-side surface / client-driver front door**，不 spawn 任何 agent 进程、不依赖浏览器端，直接驱动 DSH 的 agent/session 层。

### 1.2 参考仓库分析（已 clone 到 `_tmp/`）

| 仓库 | 定位 | 我们借鉴的 |
|---|---|---|
| `liustack/modlens` | 原生 DSH 插件（vision 工具） | ① `dsh.bundle.patch` 契约 + `cordis.patch.yml` 单行 insert；② 零 `@deepseek-ai` 运行时依赖、feature-detect、loud-degrade（防 rc 版本漂移）；③ 安装即 `dsh plugin --profile <name> add <pkg>@latest`；④ 工程质量：vitest 单测 + fake ctx（`dshPlugin.test.ts` 手搓 fake ctx 断言集成点）、biome、strict TS、CI 矩阵、OIDC 发布、CHANGELOG 驱动 Release |
| `zhu1090093659/dsh-web-ui` | 官方 web shell 之上的插件家族 | ① 双面包模式（host 半 + client 半）与 `dsh.client` 声明（我们只需 host 半）；② 复用 `apiProxy`（`session.prompt` / `session.list` / `events.mux`）而非另起炉灶——Feishu 侧同样可走 `apiProxy` 或更低层 agent API；③ 独立页面/桥接层模式（remote-web-ui 的 allowlist 代理 + SSE）——若未来要飞书 web 面板可照搬；④ `dsh plugin add link:<path>` 本地开发安装、`--dump-config` 验证 |
| `ccch1mneyyy/dsh-cc-tui` | 原生 DSH TUI 插件 | **与我们的架构同构**：① "client-driver front door"——`ctx.agents.create/resume` + `agent.followup/steer` + `session/event` 订阅渲染 + `commandService.execute`，不 spawn 进程；② bundle 叠 `dsh-base`，`agent-loop → agents: []`（运行期自建 agent）；③ 由 bundle patch 自行 insert 需要的行（如 `dsh-session-persistence-sqlite`、`dsh-working-activity`），不要求用户分开 add；④ 未知 slash 命令回落模型；⑤ 长会话折叠（MAX_ROWS + fold/restore）应对超长输出 |
| `deepcoldy/botmux` | 飞书↔agent TUI（tmux）桥 | 见 1.3：功能迁移清单 + 要避免的设计缺陷 |

### 1.3 botmux 分析（要迁移的功能 / 要避免的问题）

botmux 是"把 agent TUI 进程放进 tmux 会话，飞书消息经 tmux 注入、输出经屏幕捕获回流"的桥。其优秀点与缺陷：

**值得迁移/借鉴的功能**
- **流式卡片**：一轮对话一张 interactive 卡片，随输出实时 `im.v1.message.patch` 更新（静默、不产生未读打扰）；卡片带 显示/隐藏、滚动、重启/关闭/接管 按钮。
- **两条铁律（botmux 实证，直接采用）**：
  1. **`message.patch` 是静默的（无通知/未读）**——流式中间态用 PATCH 没问题；但**最终答案必须发一条新消息**（botmux `worker-pool.ts:10115-10117` 注释原话），否则用户收不到提醒。
  2. **卡片体积上限约 109KB（错误码 230025）**——botmux `truncateContent` 按行二分截断到 100KB 并**保留最新输出尾部**（不是 150KB；150KB 是文本消息的限制，卡片走 109KB）。
- **会话持久化与 resume**：tmux 会话 + 线程 id 持久，daemon 重启后可恢复；`/adopt`（本地 tmux 会话接入）、`/relay`（会话整体搬迁到别的群）。
- **群聊语义**：@机器人触发、话题/群内多 bot @mention 路由、on-call 模式。
- **斜杠命令三层路由**（`passthrough-commands.ts`）：daemon 自有命令 / 透传 CLI 的命令 / adapter 级与 bot 级自定义命令；`/list-slash-command` 把四类命令列成卡片。对应我们：插件命令 / DSH 注册表透传 / 未知策略。
- **工程细节**：消息按 `message_id` 持久化去重（防 6h 重推与 daemon 重启重放）；同一会话 anchor 内严格 FIFO 串行化（防种子消息与回复竞态）；mention 解析兼容 WS 对象形与 REST 字符串形两种结构；`ou_` open_id 是 app-scoped（跨应用不可复用，管理员白名单要注意）；卡片回调按 eventId 去重、先 ACK 后动作。
- **丰富的交互卡片**：配置卡片（下拉/开关）、进度卡、授权/额度卡、summary 卡、设置卡——均基于 `card.action.trigger` 回调（**经 WS 长连接可达，无需公网 HTTPS**，botmux 实证：`eventMode: 4`（WebSocket）下卡片按钮回调照常到达，3s 内 ACK）。

**要避免的缺陷（我们的优势）**
- **agent 透明度问题（用户痛点）**：botmux 要求 agent 完成任务时显式调用 `botmux send` 才把消息发给用户，agent 经常忘记调用——为此 botmux 还写了 transcript 收割的 `final_output` 兜底通道，但兜底也是"CLI 最后输出的文本"，且依赖模型自觉（官方 pitfalls 文档承认：弱模型/包装模型不调用、上下文压缩后 routing 提示丢失）。 → **我们直接订阅 `session/event`，agent 的每个 token/工具调用天然流出，无需 agent 任何配合，没有"忘记发消息"这个命题**。
- **终端捕获脆弱**：ANSI 解析、bracketed paste 丢失、屏幕滚动竞态、多行输入被 TUI 拆成多次提交 → 我们**没有终端**，输入走 `agent.followup`，输出走事件流，零屏幕捕获。
- **与特定 CLI 协议深度耦合**：botmux 为 Codex 写了 `codex app-server` JSON-RPC 引擎，升级即破裂 → 我们**只依赖 DSH 的稳定服务 API**（agents/session/commands/userQuestions）。

### 1.4 飞书侧技术要点（已核实的）

- 官方 SDK：`@larksuiteoapi/node-sdk@^1.73`（botmux 用 `^1.64`）。
- **WS 长连接模式（推荐 v1 主通道）**：`Client({ appId, appSecret, enableWs: true })`，免公网回调地址，适合 DSH 跑在私网主机；事件订阅含 `im.message.receive_v1`（群聊/私聊）与 `card.action.trigger`（卡片按钮）。
- 发送：`im.v1.message.create`（`msg_type: interactive` / `text`，`receive_id_type: chat_id`）；更新：`im.v1.message.patch`（**静默**，见 §1.3 铁律 1）；最终答案发新消息。
- 限额与约束：**卡片 JSON ~109KB 硬限**（错误码 230025）需截断保尾部；文本消息 150KB；patch 频控需节流（目标 100–200ms 一帧）；群聊中机器人被 @ 才响应（机器人只能收到 @ 自己的消息，私聊全量）。
- 权限 scope：`im:message`、`im:message:send_as_bot`、`im:chat` 等（开发者后台配置，文档给出清单）。
- **网络要求（无公网 IP）**：核心链路**全部出站**，部署 DSH 的主机**不需要公网 IP、不需要开放入站端口**——
  - WS 长连接：机器人 client 主动出站连接飞书开放平台（`wss://open.feishu.cn` / 按租户域名），只需出站 443；
  - 发消息 / 更新卡片 / 主动推送（定时任务等）：出站 HTTPS API 调用；
  - 卡片按钮回调（`card.action.trigger`）：经 WS 长连接到达（botmux 实证），无需公网回调地址；
  - 需出站的清单：飞书开放平台（API+WSS）、DeepSeek API、npm registry（仅安装/更新时）；完全离线内网需配置出站代理或白名单。
  - 例外：仅当选择 HTTP webhook 模式（不默认）时才需要公网可达的 HTTPS 回调地址（可配隧道）。

### 1.5 用户介入缝隙（interaction seams）——已核实

DSH 所有"需要用户介入"的地方都通过**能力缝隙**暴露给 UI，飞书插件要全覆盖：

| 缝隙 | 服务/事件 | UI 侧机制（我们实现） |
|---|---|---|
| **权限审核**（sandbox 逃逸、危险操作等需要审批的工具调用） | `ctx.approval`；waterfall 事件 `approval/request`（监听后返回 outcome 即认领，或 `next()` 交给下家；无 answerer 时 **fail-closed** 为 `unavailable`）；审计日志 `approval/asked` / `approval/decided` | 监听 `approval/request` → 发**审批卡**（工具名 + 原因 + 允许一次/拒绝按钮）→ `card.action.trigger` 回调 → 返回 `allowed-once` / `rejected`；超时/取消 → `cancelled` |
| **用户提问**（`ask_user_question` 工具） | `ctx.userQuestions`；`registerProvider({ ask })` 单一激活 provider | 问题 → **提问卡**（选项按钮/文本输入）→ 回调解析答案 |
| 凭据请求（如需要用户填 API key，P2 可选） | `ctx.credentials`（web 有 credentials 域） | 凭据录入卡（P2） |

---

## 2. 总体架构设计

### 2.1 设计原则

1. **DSH-native**：插件即 bundle（`dsh.bundle.patch`），叠在 `dsh-base` 上；只依赖 DSH 官方服务 API；不与任何具体 agent TUI/CLI 耦合。
2. **无终端、无透明性 hack**：输入 `agent.followup/steer`，输出 `session/event` 订阅，全量流式。
3. **一个飞书聊天 = 一个 DSH 会话**：群聊/私聊 `chat_id ↔ session_id` 双向映射，持久化，支持重启后恢复。
4. **命令双层**：插件自有命令（`/repo /resume /sessions /help …`，`ctx.commands.register`）与 DSH 命令透传（`ctx.commands.execute`）；未知命令策略可配置（报错 / 回落给模型）。
5. **流式卡片体验**：一轮一张卡片，chunk 节流 patch，工具调用/进度内嵌。
6. **最小 API 面**：对 `@deepseek-ai/*` 仅 type/peer 依赖，feature-detect + loud-degrade（防 rc 漂移，modlens 策略）。
7. **高质量开源**：结构、测试、文档、CI、发布全流程对标 modlens。

### 2.2 数据流

```
飞书用户 ──消息/@──> 飞书开放平台 ──WS 长连接──> feishu-transport（lark-oapi）
                                                │ im.message.receive_v1 / card.action.trigger
                                                ▼
                                        feishu-bridge（核心编排）
                   ┌────────────────────┼─────────────────────┐
                   ▼                    ▼                     ▼
             command-layer       session-bridge          card-renderer
             /repo /resume       chat_id↔session_id        session/event→卡片
             /sessions /help     映射 + 持久化              + 节流 patch
             + DSH 透传           + 会话生命周期              + 折叠/截断
                   │                    │                      │
                   ▼                    ▼                      ▼
            ctx.commands        ctx.agents.create/      ctx.userQuestions
            (DSH 命令注册表)      resume/followup/        (交互提问→按钮卡)
                                 steer/cancel
                   └────────────────────┼──────────────────────┘
                                        ▼
                                 DSH core（dsh-base 层）
              sessions · agent-loop · tools · llm · fs · subagents · skills
```

### 2.3 模块划分（`src/`）

```
src/
  index.ts           # cordis 插件入口：name / inject / Config(z) / apply
  config.ts          # 配置 schema：appId/appSecret、允许的 chat 白名单、
                     #   cwd 白名单(/repo)、未知命令策略、群聊@要求、卡片开关
  transport.ts       # lark-oapi 封装：WS 长连接、事件分发、发送/更新/撤回消息、
                     #   卡片回调去重与 ACK、错误码转译（借鉴 botmux client.ts）
  bridge.ts          # 核心编排：消息→命令/会话路由、事件→渲染分发、
                     #   每聊天串行队列、取消/打断
  session-map.ts     # chat_id ↔ session_id 双向映射（JSON 文件持久化，重启恢复）；
                     #   含 session→chat 反查（审批/提问卡需要路由回正确聊天）
  sessions.ts        # 会话工厂：create/resume/list，/repo cwd 白名单校验
  commands.ts        # 插件自有 slash 命令注册 + DSH 透传逻辑
  cards/
    render.ts        # session/event → 卡片 JSON（markdown/工具/进度/todo）
    streaming.ts     # 流式卡片生命周期：创建→节流 patch→封口→失败态
    interactions.ts  # 【统一交互卡机制】审批卡 + 提问卡共用：
                     #   渲染→等待 card.action.trigger 回调→解析答案/outcome
                     #   （含超时、取消、防串扰、回调去重）
    questions.ts     # userQuestions provider：问题→提问卡，回调→答案
    approvals.ts     # approval answerer：approval/request→审批卡，回调→outcome
    controls.ts      # 卡片按钮（显示/隐藏输出、复制、取消、重试…）
  text.ts            # 飞书 markdown 转义、150KB 截断/分段、@mention 解析
  rate-limit.ts      # patch 节流、发送队列、退避
  logger.ts          # 结构化日志（调试可观测）
tests/               # 单测 + 集成测试（见 §6）
examples/            # 最小可运行 profile 配置 + 飞书后台配置指南
```

### 2.4 关键技术决策（默认值，可评审调整）

| 决策点 | 默认（已确认 ✔ 表示评审已定） | 备选/理由 |
|---|---|---|
| 包名/发布 scope | `@dsh-feishu/dsh-feishu` ✔ | 遵循 `@liustack/modlens`、`@linxin666/*` 社区惯例 |
| 飞书通道 | WS 长连接（`enableWs`） | 免公网；HTTP 回调作为配置项留后门 |
| 会话载体 | 每 chat 一个 DSH session（同一 DSH 进程内） | 进程内隔离已足够（headless/cc-tui 同款）；多进程/P2P 为 P2 |
| 会话持久化 | bundle patch 自行 insert `dsh-session-persistence-sqlite` | cc-tui 模式，用户零额外步骤 |
| 流式实现 | 交互卡 + `im.v1.message.patch` 节流更新（botmux 实证方案） | 中间态静默 patch；**turn 结束时最终答案以新消息送达（保证通知）**；官方 `streaming_mode` 打字指示作为增强选项 |
| 最终答案送达 | 新消息（botmux 铁律：PATCH 静默，用户收不到提醒） | 流式卡封口为"完成态" + 短通知消息，或官方 streaming 卡结束时转正式卡 |
| 未知 slash 命令 | 配置项：`error`（默认，✔ 已确认：报"命令不存在" + `/help` 指引）或 `passthrough`（回落模型，对齐 cc-tui） | 用户要求"部分透传 DSH"——已注册命令一律透传，未注册走该策略 |
| 交互提问 | `ctx.userQuestions.registerProvider` → 按钮卡片 | WS 下 `card.action.trigger` 已验证可达 |
| **审批通道（权限审核）** | `ctx.approval`：监听 `approval/request` waterfall → 审批卡 → 回调返回 `allowed-once/rejected` | 无 answerer 时 DSH fail-closed 为 `unavailable`，所以插件**必须**在启动时注册 answerer 并保持在线；审批/提问共用 `cards/interactions.ts` |
| 群聊响应 | 仅响应 @机器人的消息 | 飞书规则；私聊全量响应 |
| 安全 | chat 白名单（默认仅配置的群/人）+ 命令权限（管理员 open_id 白名单） | 可后续加 /grant 粒度（botmux 模式） |
| 依赖策略 | 运行时仅 `@larksuiteoapi/node-sdk` + `schemastery`；`@deepseek-ai/*` 全部 peerDeps（`^0.1.0-rc.6`）+ type-only import | 防 rc 漂移 |

---

## 3. 功能清单（按迭代优先级）

### P0 —— 核心可用（Iteration 1–2）✅
- [x] WS 长连接收消息（私聊 + 群聊 @）
- [x] 每聊天一个 DSH 会话；`agent.followup` 注入用户消息
- [x] **流式卡片**：`assistant/chunk` → 节流 patch；最终答案由卡片就地封口承载（不再另发重复气泡）；失败才发 ⚠️ 通知
- [x] 工具调用渲染（`tool/call`/`tool/result` 卡片内嵌 + 折叠序列 + 详情卡）
- [x] 文本兜底通道（卡片失败/被禁时）
- [x] 消息按 `message_id` 去重（进程内）
- [x] 插件自有命令（15 个）：`/help /status /cancel /cd /repo /group /sessions /resume /clear /new` + DSH web 包装 `/plan /goal /compact /feedback /permission`；面板按钮与 slash 同一 handler
- [x] DSH 命令透传：`ctx.commands.execute`；`/export` 有意排除（Web-only 浏览器下载通道，见 ux-spec §8.1）
- [x] chat↔session 映射持久化 + 重启恢复（resume）+ `/sessions` 会话列表 + `/resume` 跨聊天搬移 + `/clear`（非破坏性新会话）
- [x] 卡片截断保尾部、patch 节流、错误码转译（表格 5 上限兜底）、@mention 解析

### P1 —— 交互与多会话（Iteration 3–4）
- [x] **审批卡（高优先级，用户介入核心场景）**：监听 `approval/request` → 审批卡（工具名+原因+允许一次/拒绝）→ 回调 → `allowed-once/rejected`；超时/abort → `cancelled`；无聊天/发卡失败 → fail-closed `unavailable`（DSH 语义）
- [x] **提问卡**：`userQuestions.registerProvider` → 单选点即答 / 多选切换+提交 / 无选项回复文本捕获（与审批卡共用 `cards/interactions.ts` 统一机制）
- [ ] 交互按钮卡：`/repo` 目录选择器、确认/取消
- [ ] 卡片控制按钮：显示/隐藏输出、复制、重试、停止
- [ ] 表情回执：收到消息时 `addReaction`（botmux `RECEIVED_REACTION_EMOJI_TYPE`）
- [ ] 多群并发（每群独立 session + 独立串行队列）
- [ ] 会话历史回放（`/history` 或进群先发最近摘要卡）
- [ ] 长会话输出折叠（cc-tui MAX_ROWS 思路的卡片折叠）
- [ ] 权限：群管理员/用户白名单控制命令（注意 `ou_` open_id app-scoped）
- [ ] 主动通知（agent 空闲/出错/需要确认时 @ 提醒）

### P2 —— botmux 精选迁移（Iteration 5，按需）
- [ ] 定时任务（复用 DSH `dsh-schedule`）+ 外部 webhook 触发
- [ ] 多机器人（bots.json 式注册表、@ 路由）
- [ ] 话题粒度会话（飞书超级群 thread_id → 独立 session，默认 chat 粒度）
- [ ] `/relay`（会话从一个群搬到另一个群）、`/adopt`（接入本地已存在会话）
- [ ] 消息配额/授权卡（botmux grant 体系简化版）
- [ ] 群成员角色（管理员/只读）
- [ ] 飞书 web 面板（复用 dsh-web-ui remote-web-ui 的桥接模式）——可选

### 明确不做
- 不做 agent TUI 桥接/屏幕捕获（本插件无终端）
- 不做 DSH 核心功能重实现（记忆、上下文、工具、权限系统——DSH 已有）
- 不要求 agent 显式调用任何"发消息"命令（透明性由事件流天然保证）

---

## 4. 迭代路线图

> 每轮结束的验收标准：**代码合入 + 该轮测试通过 + 文档/CHANGELOG 更新**。P0 轮次全部有真实 DSH profile boot 的集成验证。

### Iteration 0 —— 仓库脚手架与可行性验证（1 个目标轮）
**交付**：
- 完整仓库骨架：`package.json`（`dsh.bundle.patch` + peerDeps）、`cordis.patch.yml`、`tsconfig`（strict）、`vitest`、`biome`、`.github/workflows/ci.yml`、`.gitignore`、`LICENSE`（MIT）、`README.md`（中英）、`AGENTS.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`
- `src/index.ts` 最小可 mount 插件（只打印启动日志 + 注册 `/feishu-status` 测试命令）
- **可行性验证**：本地建一个 `dsh --profile feishu-dev` 测试 profile，`dsh plugin add link:<repo>` 挂载成功，`--dump-config` 确认 bundle 层生效；`dsh --profile feishu-dev` 能启动且日志出现插件行
- `examples/feishu-dev/` 示例 profile + 文档
**验收**：`pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿；真实 profile 可 boot。

### Iteration 1 —— P0 核心闭环：私聊 + 流式卡片
**交付**：
- `transport.ts`：WS 长连接、`im.message.receive_v1` 接收、发送文本/交互卡
- `bridge.ts` + `session-map.ts`：私聊 `chat_id → session` 创建，`followup` 注入
- `cards/streaming.ts`：interactive 卡创建 → `assistant/chunk` 节流 patch → `assistant/message` 封口 → `turn/end` 完成态；文本兜底
- `cards/render.ts`：markdown 渲染（lark_md）、工具调用卡
- 配置：appId/appSecret 环境变量读取
**测试**：`transport` 用 fake client（内存实现 lark-oapi 接口）；`bridge` 用 fake ctx + 录制事件流断言卡片 patch 序列；**集成**：boot 最小 profile + fake transport，跑一轮真实 DSH agent（需 DEEPSEEK_API_KEY 的用例打 tag，无 key 自跳，参照 harness `test:e2e` 模式）
**验收**：真实飞书机器人私聊发消息 → 收到流式更新的卡片直至完成。

### Iteration 2 —— P0 群聊与命令体系 ✅
**交付（已完成）**：
- 群聊 @ 触发与 mention 解析（always/never/ambient/topic）；chat 白名单
- 命令体系（15 个表面命令 + DSH 透传）：`/help /status /cancel /cd /repo /group /sessions /resume /clear /new` + DSH web 包装 `/plan /goal /compact /feedback /permission`（`ctx.commands.execute`）；未知命令策略配置；`/export` 有意排除
- **完整按钮面板**：Panel 弹出全量命令按钮（按分类分组、每页 8 个、分页导航），按钮与 slash 同一 handler（`{kind:'command', name}`）
- `/repo`：cwd 白名单递归扫描 → 下拉/按钮交互卡
- `/sessions`：会话列表卡（标题/id/cwd/时长/live/已保存 徽标、分页、每行 Resume 按钮、陈旧回调守卫）
- `/resume`：跨聊天搬移会话（1:1 模型）；运行中目标拒绝；不重放历史
- `/clear`/`/new`：非破坏性新会话（旧会话仍可 `/sessions` 恢复）
- session-map 持久化 + 启动时恢复（`agents.resume`）；dsh-base 自带 `session-persistence-jsonl`
- 截断/节流/错误转译；**working 状态门**（运行中仅只读命令可用）
**测试**：命令解析单测；透传 fake command registry；完整状态机矩阵扩展（command/resume-session × 5 状态）；集成测试覆盖 `/repo /resume /sessions` 全链路 + 面板按钮 + 真 harness `/permission`
**验收**：真实飞书群内 @ 机器人 → 正常对话 + slash 命令/面板按钮可用；重启 daemon 后会话恢复。

### Iteration 3 —— P1 交互卡片：审批 + 提问 + 多会话
**交付**：
- `cards/interactions.ts`：统一交互卡机制（渲染 → 等 `card.action.trigger` 回调 → 解析；去重、超时、取消、防串扰）
- `cards/approvals.ts`：`approval/request` answerer → 审批卡（工具名/原因/允许一次/拒绝）→ 回调返回 outcome；超时 `cancelled`
- `cards/questions.ts`：`userQuestions.registerProvider` → 提问卡（选项按钮/文本输入）→ 回调解析答案
- `/repo` 升级为图形目录选择器；确认/取消流程
- 卡片控制按钮（显示/隐藏、复制、停止）
- 多群并发（串行队列/群隔离）+ 会话历史回放卡
**测试**：交互卡状态机单测（回调/超时/取消/去重）；approval answerer 集成测试（触发 `approval/request` → 断言审批卡 → fake 回调返回 outcome）；userQuestions provider 集成测试
**验收**：① 群内 agent 触发需要审批的工具调用 → 出现审批卡，点"允许一次"后 agent 继续、点"拒绝"则中止，审计事件落日志；② agent 调用 `ask_user_question` → 出现提问卡，点击选项后 agent 拿到答案继续。

### Iteration 4 —— P1 打磨与健壮性
**交付**：
- 长输出折叠、会话摘要、@ 提醒（空闲/出错/需确认）
- 权限：管理员白名单 + 命令级权限
- 限流/退避/重试、断线重连（WS 断线指数退避）
- 可观测：结构化日志、`/feishu-status` 诊断卡
- 性能：长 session 的卡片折叠与内存控制
**测试**：压力/长会话集成测试；断线重连测试
**验收**：连续长时间使用无卡片堆积、无频控报错。

### Iteration 5 —— P2 精选功能 + 发布
**交付**：
- 按 §3 P2 清单挑选（默认：定时任务 + webhook 触发 + 多机器人 + `/relay`）
- i18n（zh/en 文案表）
- 开源收尾：完整双语 README、安装文档（飞书后台配置步骤 + `dsh plugin add`）、发布脚本（OIDC）、GitHub Release、`examples/` 完善
**验收**：npm publish 后按 README 从零安装可用。

---

## 5. 仓库结构（目标态）

```
dsh-feishu/
├── package.json          # dsh.bundle.patch、peerDeps(@deepseek-ai/*)、files 白名单
├── cordis.patch.yml      # bundle 层：insert feishu 行 + 依赖行(sqlite persistence…)
├── tsconfig.json         # strict，extends harness 风格
├── vitest.config.ts
├── biome.json
├── .github/workflows/    # ci.yml（lint/typecheck/test/build 矩阵）、release.yml（OIDC）
├── src/                  # 见 §2.3
├── tests/                # 单测 + 集成（fake transport / fake ctx / profile boot）
├── examples/             # 示例 profile 与飞书后台配置指南
├── docs/                 # 架构、命令、飞书后台配置、故障排查
├── scripts/              # 发布、版本戳、校验脚本
├── README.md / README.zh-CN.md / AGENTS.md / CHANGELOG.md
├── LICENSE / SECURITY.md / CONTRIBUTING.md / CODE_OF_CONDUCT.md
└── PLAN.md               # 本计划（迭代过程中同步更新）
```

---

## 6. 测试策略

| 层 | 工具/方式 | 覆盖 |
|---|---|---|
| 纯函数单测 | vitest | 卡片渲染、markdown 转义、截断/分段、命令解析、mention 解析、节流器 |
| 插件单测 | vitest + **fake ctx**（modlens `dshPlugin.test.ts` 模式：手搓 `tools/agents/sessions/commands/on` 桩） | 命令注册、session 工厂、userQuestions provider、事件→渲染分发 |
| 集成测试 | boot 最小 profile（`cordis.yml`）+ **fake transport**（内存实现 lark-oapi 收发） | 全链路：消息→followup→事件→卡片 patch 序列断言（cc-tui `verify-*.mjs` 思路） |
| 真实 E2E | 需真实飞书 app + `DEEPSEEK_API_KEY`，`describe.skipIf` 自跳（harness `test:e2e` 模式） | 私聊/群聊/卡片按钮/命令真机验收脚本（文档化手动步骤） |
| 门禁 | CI：`lint → typecheck → test → build`；发布前 `prepublishOnly` | — |

## 7. 风险与应对

| 风险 | 应对 |
|---|---|
| DSH 处于 `0.1.0-rc`，API 可能漂移 | `@deepseek-ai/*` 全部 peerDeps + type-only import；feature-detect + loud-degrade；锁定 `^0.1.0-rc.6`（dsh-web-ui 用 `minimumReleaseAgeExclude` 保证装到该版本） |
| 飞书 API 限制（卡片 ~109KB、patch 频控） | 截断保尾部 + patch 节流（100–200ms）+ 发送退避 |
| 最终答案被静默吞掉（PATCH 无通知） | botmux 铁律：最终答案走新消息；流式卡仅承载中间态 |
| 卡片按钮回调可用性 | 已由 botmux 实证 WS 可达；仍保留文本编号兜底 |
| 群聊隐私/安全 | chat 白名单（默认关闭全部）、命令权限白名单、`ou_` open_id app-scoped 注意跨应用 |
| 审批/提问卡无人应答或断线 | DSH fail-closed（`unavailable`）：审批超时返回 `cancelled`，断线期间请求 fail-closed 为 `unavailable`；启动即注册 answerer 并监控 WS 存活（Iteration 3） |
| 审批/提问卡路由错聊天 | 依赖 session→chat 反查映射（session-map 双向持久化），agent 无映射时 fail-closed 并告警 |
| 长会话卡片堆积 | 折叠/隐藏 + 摘要卡（P1） |
| 单机多群并发资源 | 每群 session 进程内隔离足够；必要时 P2 上多进程 |
| 流式 patch 触发用户未读打扰 | `message.patch` 静默更新（botmux 实证）；不采用删除重发 |

## 8. 决策记录（评审结果）

1. **npm 包名/scope**：✔ `@dsh-feishu/dsh-feishu`。
2. **未知 slash 命令默认策略**：✔ 报错提示（"命令不存在" + `/help` 指引）；`passthrough` 作为配置项后门。
3. **P2 功能取舍**：待定（Iteration 5 前再定；默认倾向 定时任务/webhook → 多机器人/`/relay`）。
4. **飞书测试机器人**：✔ 用户自行申请，稍后提供凭据；文档先给出申请步骤，真机验收在拿到凭据后进行。
