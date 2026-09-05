# dsh-feishu 架构

[English](architecture.md) | 中文

dsh-feishu 如何工作，逐迭代展开。

## 核心身份

**DSH 原生——为 dsh 而生，而非桥接过去。** 该 surface 只针对一个 agent（dsh）并在进程内集成；它不桥接外部 CLI，也不重新实现 agent 能力。由此引出三个承诺：

1. **无桥接、无捕获。** 没有 CLI 适配器，没有 tmux/PTY，没有屏幕捕获，没有 ANSI 解析——surface 直接驱动 dsh 的 agent/session 层。
2. **完全透明。** 每一个 token、工具调用、提问和审批都原生地流入聊天；agent 从不为了被看见而做任何事。
3. **一切都是卡片。** 每一个 dsh surface 元素都映射为一张飞书卡片。

## 运行时形态

该插件是一个 dsh **bundle**（`dsh.bundle.patch` → `cordis.patch.yml`），搭载于 `@deepseek-ai/dsh-base` 之上。它以 profile 中的 `feishu` 行挂载；凭据来自配置或 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。

```
Feishu user ──message──> Feishu platform ──WS long connection──> transport (lark-oapi)
                                                                    │ receive events / send & patch cards
                                                                    ▼
                                                              bridge (orchestrator)
                                                    ┌──────────────┼───────────────┐
                                                    ▼              ▼               ▼
                                             dedup         session-map      streaming cards
                                             (message id)   chat ↔ session    (1 card/turn,
                                                             durable map       throttled patch)
                                                    │              │               │
                                                    ▼              ▼               ▼
                                             agent.followup   ctx.agents      sendText (final
                                                             create/resume   answer, notifies)
                                                                    │
                                                                    ▼
                                                              dsh session/event stream
```

## 模块

| 模块 | 职责 |
|---|---|
| `src/feishu/types.ts` | Transport seam 类型：归一化后的 `FeishuMessage`、`FeishuTransport`、卡片 JSON。 |
| `src/transport.ts` | lark-oapi 实现：`WSClient` 长连接 + `Client` API 调用；纯函数 `normalizeMessageEvent`；`FeishuApiError`。 |
| `src/memory-transport.ts` | 文件通道的内存 transport（`FEISHU_TRANSPORT=memory`）：集成测试/调试用的 seam——`inbox/` 投递消息，`outbox/` 记录每一次发送。 |
| `src/message-dedup.ts` | 有界的内存消息 id 去重（平台重投）。 |
| `src/session-map.ts` | 持久的 chat ↔ session 映射（原子 JSON 写入），供事件反向查找。 |
| `src/directory.ts` | 用户输入的工作目录路径解析（`/cd`、`/repo`）。 |
| `src/model-args.ts` | `/model` 参数解析（`<provider>/<model>`）。 |
| `src/cards/render.ts` | 纯渲染：session 事件 → 卡片 JSON（v1 布局）、markdown 转义、尾部截断、控制面板调色板（分组、分页、分类块）、权限/模型选择器卡片（带 `initial_option` 的下拉框），以及纯信息**结果卡片**（`✅ Done` / `⚠️ Action failed`）。 |
| `src/cards/session-list.ts` | `/sessions` 选择器卡片：已保存会话的**下拉框**（上限 `SESSION_SELECT_MAX = 50`，带 Find 过滤），以及会话详情子视图卡片（Resume / Rename / Archive / Export / Back）——纯渲染。 |
| `src/cards/streaming.ts` | 每轮一张卡片：打开时 POST，节流/合并的 `message.patch` 更新，终态 finalize。 |
| `src/cards/StreamingCardController.ts` | 流式卡片**状态机**：每个聊天的 `ChatCardState`、单一 `syncCard` 渲染路径、session 事件 → 卡片管道（`handleEvent`，含 compaction 生命周期与 agent 主动发起的卡片）、`beginTurn`（ack + 工作态），以及流式卡片动作（stop/copy/retry/row-details/toggle-rows）。只依赖 `StreamingCardHost` seam。 |
| `src/cards/interactions.ts` | 由审批和提问共享的 pending-interaction 注册表：仅解析一次、超时、过期回调拒绝、中止、释放。 |
| `src/cards/InteractionCardController.ts` | 审批/提问**卡片流程**：`handleApprovalRequest` / `askQuestions`（单选、多选 toggle、经下一条聊天消息回答的文本题）、交互卡片动作与 `answerFreeText`——依赖 `InteractionCardHost` seam。 |
| `src/panel/types.ts` | 面板视图联合类型（`PanelView`）与输入/确认子视图文案（`PANEL_INPUT_SPEC`、`PANEL_CONFIRM_SPEC`）。 |
| `src/panel/PanelController.ts` | 面板**状态机**：每张面板卡一份权威视图栈（`Map<chatId, Map<messageId, PanelView[]>>`——点旧卡就更新那张卡）、单一 `showPanel` 渲染路径（异步视图先发 Loading 占位、渲染失败重置菜单）、以及 `runPanelOperation`——唯一的异步操作包装（busy 占位 → 工作 → 结果 → 退出），依赖 `PanelHost` seam。 |
| `src/panel/actions/` | 作为 **Strategy 对象**的面板卡片动作：`PanelAction` 基类（模板方法——transition → gate → busy → work → result → exit 顺序）+ `PanelActionRegistry`（kind → action）+ 每个动作族一个类（导航、选择器、session 操作、命令）。 |
| `src/panel/views/` | 作为 **Strategy 对象**的面板视图：每个视图一个 `PanelViewState`（自声明 `asyncData`）+ `PanelViewRegistry`；选择器是独立状态（`picker:repo` / `picker:model` / `picker:permission`）。 |
| `src/commands/surface.ts` | surface 命令集：插件自有斜杠命令（及其面板按钮）的完整注册 + `runHarnessCommand`，依赖 `SurfaceCommandHost` seam。 |
| `src/bridge.ts` | **门面 + 编排**：消息路由（去重、提及 gate、斜杠分发）、agent 解析阶梯（live → 恢复已映射 session → 新建 → 冲突时重绑新 id）、工作状态与工作目录 gate、session 生命周期（`/sessions /resume /clear`）、主动提及，以及四个宿主 seam（`StreamingCardHost` / `PanelHost` / `InteractionCardHost` / `SurfaceCommandHost`）。所有卡片表面都位于上述模块。 |
| `src/index.ts` | 插件入口：配置、凭据解析、agent 选项（配置或 `agentDefaultModel`，在**每次 create/resume 时惰性解析**——绝不在激活时快照一次，见 `docs/pitfalls.md` → “宿主服务的激活期快照”）、接线、`feishu-status` 命令。 |

## 关键行为

- **带按钮对等的斜杠命令。** 所有 surface 命令（`/help /status /cancel /cd /repo /group /sessions /resume /clear /new /export /model /feishu-status /schedule`，外加五个 dsh web 包装 `/plan /goal /compact /feedback /permission`，以及 `/panel`——仅斜杠，其调色板按钮隐藏）在斜杠行和面板调色板按钮之间共享同一个处理器。`ctx.commands.execute` 透传处理其余任何命令。`/export` 以文件消息发送会话日志，`/model` 是 surface 原生的（web 的 `/model` 是一个没有宿主命令的客户端弹窗）。
- **Session 生命周期。** `/sessions` 打开持久化语料的**下拉选择器**（`ctx.sessionQuery.listSessions()` + 批量 `readTitleSnapshots()`，服务缺失时退化为 bound-sessions 兜底）；选择选项后在面板状态机栈上推入**会话详情子视图**。当没有 live agent 时，`/resume <id>` 和详情的 Resume 按钮会重绑该聊天（`SessionMap.set`——1:1 模型）并 `agents.resume`；正在运行的目标会被拒绝；resume 会重置卡片状态（不重放历史）。Rename/Archive 经由宿主 `apiProxy` seam（`sessions.rename`、`workspace.archiveSession`——可逆）。`/clear`/`/new` 非破坏性地重新铸造一个新 session（旧 session 保持已保存且可恢复）。
- **面板状态机。** 控制面板是**每张面板卡**一份权威视图栈（`Map<chatId, Map<messageId, PanelView[]>>`，菜单根在栈底）加单一渲染路径：按钮 PUSH 子视图（输入表单、确认、sessions、会话详情、选择器），Back POPS，完成时回到菜单。点旧面板卡就更新**那张卡**——绝不会更新别的卡（每张卡拥有自己的栈；守护进程重启前留在屏幕上的卡从菜单根开始）。中间步骤原地更新同一张面板卡片；最终结果发布一张**新的纯信息结果卡片**（面板原则——用户需求）。
- **工作状态 gate。** 回合运行期间，只有只读命令可以执行（`/help /status /feishu-status /schedule /sessions /cancel /group /model /panel`）；变更类命令会带着解释被拒绝，以保持状态机一致（见 ux-spec §8.4）。
- **工作目录 gate。** 没有显式固定 cwd（/repo 或 /cd）的聊天会带着指引拒绝回合——不创建 session/卡片，消息也不会被记住；`defaultCwd` 永远不会是隐式选择（`requireWorkingDir`，默认为 true）。`/clear` 保留固定；`/resume` 采用被恢复 session 的 cwd（选择器按钮值，或 session-list 查找），使恢复后的聊天保持可用（见 ux-spec §8.3）。
- **交互式审批。** `ctx.on('approval/request')` 发布一张审批卡片（工具 + 原因，Allow once / Reject），并通过共享的 `InteractionRegistry` 结算——来自卡片回调的 `'allowed-once'` / `'rejected'`，信号中止或超时时的 `'cancelled'`，当聊天未知或卡片失败时 fail-closed 的 `'unavailable'`。已决定的卡片是一张静态的无按钮卡片。
- **交互式提问。** `ctx.userQuestions.registerProvider` 通过提问卡片回答问题：单选点击即答，多选开关 + Submit，自由文本捕获下一条聊天消息。特性检测：缺失的审批/提问服务会被大声记录日志，且不会挂载任何东西（见 ux-spec §9）。
- **可配置的群提及 gate。** `groupMentionMode`（botmux 语义）：`always` 要求 @ 提及（在 1 人 1 bot 的独享群中通过缓存的群成员数放宽）；`never` 回答每一条群消息；`ambient` 在消息被重定向给其他成员时让位；`topic` 在话题落地前行为同 `always`。`allowedChats` 限制哪些聊天会被服务；`allowedUsers` 限制哪些发送者的 open id 会被服务（未列入名单的用户发来的消息和卡片按钮会被忽略）。
- **两阶段反应确认。** 被接受的回合消息会得到一个已收到反应（默认 `GoGoGo`），在回合结束时换成 `DONE` / `WARN` / `WARN`（可通过 `reactions` 配置覆盖）；失败只记日志。
- **主动 @ 提及。** 每个聊天最后被接受的发送者会被记住；群错误通知、审批卡片和提问卡片都会 @ 提及该请求者，以便把正确的人拉进来。
- **Session 重放。** 只有一个入口：`/export` 将聊天的 session 日志以文件消息形式发送（lark_md 安全的转录）。`/history` 因冗余已被移除。
- **一个聊天就是一个 session。** 一个飞书聊天映射到一个 dsh session id（`feishu-*`），持久化保存，重启后每个聊天都会被恢复。
- **重启安全的 session 解析。** 对于有映射 session 但没有 live agent 的聊天，bridge 会恢复持久化的 session；如果没有持久化则新建；如果映射的 id 与磁盘上的日志冲突，则重绑一个新 id。历史在守护进程重启后仍然存在。
- **每轮一张卡片。** 消息到达时发布卡片，并在块/工具流入时进行 patch。**最终答案保留在卡片中**（它就地绿色 finalize——没有第二个气泡）；失败会附加一个 ⚠️ 提示，使中断的回合永远不会被忽略。patch 是静默的（无未读），这也是第一次卡片发送就是通知的原因。
- **文本兜底。** 如果发布流式卡片失败，回合仍会运行，最终答案以文本形式送达。
- **去重。** 在进程生命周期内，重投的消息 id 会被忽略（持久化去重延后）。

## 测试

- **单元测试**（`tests/`）：每个模块，通过 fake context 和记录型 fake——包括完整的卡片状态机矩阵（state × action，扩展了命令/恢复 session 动作）、面板调色板分页、session-list 构建器，以及 `executeDshCommand` 结果映射。
- **真实组合集成**（`tests/integration/`）：从真实 profile 启动的真实 dsh 进程，对 mock LLM 服务器运行一次真实的 agent 回合，并将飞书替换为 memory transport。端到端断言整个循环（卡片发布/被 patch、最终消息送达）。当前置条件缺失时自我跳过；见 [development.md](development.md) → 集成测试。

## 剩余路线图

- 多 bot 群协作（`/relay` 式流程）。
- 重连加固与更广的可观测性。

