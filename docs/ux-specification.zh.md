# dsh-feishu UX 规范

[English](ux-specification.md) | 中文

本文档精确到足以让开发者无需自行发明细节即可实现每一部分、让用户能够预测机器人会做什么的程度，来规定 dsh-feishu 的用户可见行为。每一部分都源自参考实现 —— DSH web 聊天（deepseek-harness 中的 `ui-conversation`、`ui-tool` 包）或 botmux（`card-builder.ts`、`card-handler.ts`、`event-dispatcher.ts`）—— 并注明出处。

**规则（用户指令）：未经询问不得截断。** 任何会削减用户可见内容（卡片大小、列表长度、输出长度）的功能都必须先与用户确认方案。本规范列出存在的物理限制；其中每一个都是一个待确认问题，而不是静默默认值。

---

## 1. 流式回合卡片（streaming turn card）

### 1.1 布局（自上而下）

参考：DSH web 消息流（思考行 → 工具行 → 答案），以及用户反馈第 2–5 轮。

1. **行序列（Row sequence）** —— 按时间顺序排列的单行行列表。有两种：
   - **思考行（Think row）**：推理块流式输出期间显示 `☁️ Think · Thinking`；该行在稳定（settle）后不再变化（实时更新最新行会因节流 patch 而闪烁，收益甚微 —— 用户决定）。
   - **工具行（Tool row）**：`<status> <Title> · <summary>`，其中 status 为 `🔧`（运行中）、`✅`（完成）、`❌`（出错）；Title 与 summary 来自第 2 节。
2. **完整答案** —— 回合的最终输出，按 markdown 渲染（第 4 节），位于底部。
3. **执行状态** —— 工作中显示 markdown 行 `**… working**` / `**⏹ Stopping…**`（可见进度）；终态时显示安静的 `note`（`✅ Done` / `⏹ Stopped` / `⚠️ Turn ended with an error`）—— 头部模板颜色已承载语义（见 1.4）。
4. **按钮区** —— 两行（第 3.1 节）：先是状态操作，再是行视图切换。

卡片**默认折叠**：行序列被替换为一行 `think -> bash -> read -> …`（完整序列，绝不截断 —— 用户指令），按钮区增加 `▸ Expand`。

### 1.2 卡片状态机（单一权威状态）

参考：用户反馈第 4–6 轮（默认折叠、点击详情不得折叠、折叠期间流式输出必须继续、"card reverted to working after panel" —— 取代了临时逐操作补丁的设计）。

每个聊天对应一个 `ChatCardState`，它是流式卡片的**唯一权威来源**：`title`、`content`、`rows`、`openThinkId`、`status`（working/done/stopped/error）、`collapsed`。bridge 仅依据该状态渲染卡片，别无其他。

```
(none)  --message/retry-->  working  --turn/end(aborted)-->  stopped
working --stop------------>  (unchanged until turn/end aborts it)
working --turn/end-------->  done | error
working --compaction/end-->  done | error   （compaction 不是回合）
done|stopped|error --any action--->  same (state unchanged; card re-synced)
```

- **进入 working**：message 或 retry 设置全新状态（默认折叠）并打开新卡片。
- **流式输出**：会话事件变更 working 状态并调用 `syncCard`（经由 streaming manager）。
- **turn/end**：`completed` → done，`aborted`（用户 Stop）→ **stopped**，`error` → error。被中止的回合必须显示 **Stopped**，绝不能是 Done（DSH web `message.stopped`；用户报告）。`finalize` 冲刷终态渲染。状态保留在 map 中（rows/content 为 ⋯ 按钮和后续重新同步而保留）。
- **卡片操作** 变更状态（toggle 翻转 `collapsed`）或不变更，然后**总是**调用 `syncCard` —— 唯一的渲染路径。已完成卡片被原地重新 patch，通过 macrotask 延迟，使回调 ACK 先到达（botmux 规则：否则 Lark 可能恢复点击前的卡片 —— 这是"reverts to working"类 bug 的根源）。
- **折叠**：`collapsed` 是状态的一部分；`▸ Expand`/`▾ Collapse` 翻转它。折叠期间序列行持续流式更新（每次同步时根据 rows 重新计算）。新回合重置为折叠。
- **compaction 不是回合**（用户报告）：`/compact` 运行
  `compaction/start → summary → end` 事务，**没有** `turn/end`，因此
  bridge 自己掌管 compaction 卡的生命周期——`compaction/start` 立即打开
  一张 🧹 Compacting 卡（按钮即时反馈，而非静默等待），`compaction/summary`
  渲染摘要，`compaction/end` 定稿（成功为 done；事务失败时为 error 并附带
  失败通知），从而释放 working 状态门禁。plugin 源为 `compact` 的 checkpoint
  `user/message` 会作为兜底打开 Compacting 卡。
- **任何操作都不能让卡片停留在过期状态**：panel、stop、retry、copy、row-details 都以 `syncCard` 收尾，因此屏幕上的卡片始终反映权威状态。

### 1.3 流式机制

参考：botmux 流式卡片；我们的 `StreamingCardManager`。

- 每个回合一张交互卡片，在回合开始时发布。
- 数据块对同一消息进行 patch（`im.v1.message.patch`），节流并合并（最多一个 patch 在途；最新快照胜出）。
- patch 是**静默**的（不产生未读）—— 适合进度显示。
- 最终答案**就在卡片里**（原地以绿色定稿）；完成的回合不再发送第二条气泡。出错回合发送一条提示文本（`⚠️ Turn failed — see the card for details`）。
- 卡片正文上限：飞书约 109 KB。我们的 `MAX_CARD_CHARS = 60_000` 截断**等待用户确认**（依不截断规则）。

### 1.4 视觉语言

- 每种状态对应一种头部模板：working 用 `wathet`（浅蓝），done 用 `green`，error 用 `red`，stopped 用 `orange`。
- 终态是安静的 `note`（不是加粗行）；进行中保持 markdown 行。

### 1.5 回合生命周期

| 事件 | 卡片行为 |
| --- | --- |
| `turn/start`（经由 message） | 打开卡片，状态 working |
| `assistant/chunk` 文本增量 | 追加到答案，patch |
| `assistant/chunk` 推理增量 | 追加到打开的思考行，patch |
| `tool/call` | 稳定打开的思考行；添加工具行（running） |
| `tool/result` | 将匹配的工具行标记为 done/error，存储结果 |
| `assistant/message` | 用组装好的文本替换答案 |
| `turn/end` | 稳定思考行；状态 done/error；定稿卡片；保留 snapshot + rows 供重新断言和 ⋯ 按钮使用 |
| `compaction/start` | 打开 🧹 Compacting 卡，状态 working（compaction 事务不是回合） |
| `compaction/summary` | 用压缩摘要替换卡片答案 |
| `compaction/end` | 状态 done（事务失败时为 error，附带失败通知）；定稿卡片——释放 working 状态门禁 |

---

## 2. 工具行模型（Title · summary）

参考：DSH web `tool-call-model.ts`（`toolRowModel`、`classifyTool`、`VARIANT_TITLES`、`TOOL_TITLES`、`SUMMARY_KEYS`）—— 原样移植到 `src/cards/tool-summary.ts`。

### 2.1 分类

| 工具名 | 变体（Variant） | 标题（Title） |
| --- | --- | --- |
| `bash`, `pwsh` | bash | Bash / Pwsh |
| `read`, `web_fetch`, `cordis_package_inspect`, `cordis_runtime_inspect` | read | Read / Inspect |
| `web_search`, `grep`, `glob` | search | Search |
| `write` | write | Write |
| `edit` | edit | Edit |
| `run_code` | code | Code |
| `job_output`, `job_list`, `job_kill` | read | Read Job / List Jobs / Kill Job |
| unknown | others | Tool call |

### 2.2 summary 的推导

按顺序优先采用：
1. 该变体首选的关键参数（arg key）—— bash：`description`、`command`；read：`path`、`file_path`、`url`、`job_id`；search：`query`、`pattern`、`url`；write/edit：`path`、`file_path`；code：`description` —— 仅取第一行；
2. 第一个字符串参数值（第一行）；
3. 原始 args 字符串（第一行）。

未知（`others`）工具显示 `name · <base>`。以工作区为根的路径会相对于会话 cwd 进行相对化。

**关键不变量（bug 修复 `bff5180`）：** summary 在 `tool/call` 时从**完整**参数推导并存储在行上。为控制卡片大小而截断已存储的参数，绝不能降低可见 summary 的质量。

---

## 3. 按钮

参考：用户反馈第 1–5 轮；botmux 控制卡片。

### 3.1 状态按钮区（流式卡片底部）

两行操作按钮，让每一行在移动端保持简短：

- **第 1 行 —— 状态操作**
  - **working**：`⏹ Stop`。
  - **done**：`📋 Copy`、`🔁 Retry`、`⚙️ Panel`。
  - **error**：`🔁 Retry`、`⚙️ Panel`。
- **第 2 行 —— 视图切换**（仅当存在行时）：`▾ Collapse` / `▸ Expand`。

### 3.2 行 ⋯ 按钮

每一行（思考行和工具行）都有一个尾部的 `⋯` 按钮，用于打开该行的**详情卡片**（第 5 节）。按钮值携带稳定的行 id（`think-N` 或工具的 `callId`），绝不用索引。

### 3.3 操作 → 行为

| 操作 | 行为 |
| --- | --- |
| `stop` | `agent.cancel({kind:'user'}, {keepInbox:true})`（即 DSH web 的 Stop）+ `⏹ Stopping…` 文本。没有存活 agent → 显示解释性文本。 |
| `copy` | 将最后一条输出作为文本重新发送 |
| `retry` | 在新的回合/卡片上重新投递最后一条 prompt |
| `panel` | 打开面板卡片（stop/retry/copy） |
| `toggle-rows` | 翻转折叠位；重新渲染（延迟 patch） |
| `row-details` | 打开该行的详情卡片；重新断言流式卡片 |
| `repo-pick` / `repo-page` | repo 选择器（第 6 节） |

### 3.4 卡片回调 ACK（关键，botmux 规则）

`card.action.trigger` 是同步回调，具有 **3 秒截止时间且不可重新推送**。处理器必须用有效响应进行 ACK：

- 返回 `{}`（有效 ACK，不更新 UI）—— **绝不能返回 `undefined`**，客户端会将其视为无效而拒绝，并可能把卡片重新渲染到过期状态（"card reverted to Stop after opening details" bug）；
- 改变卡片的工作必须**延迟到回调之外**（macrotask），使 ACK 先于 patch 到达。

---

## 4. Markdown 渲染

参考：botmux `md-card.ts`（markdown-it）、我们的 `cards/markdown.ts`。

飞书 lark_md 支持 CommonMark 的一个子集。我们的转换器：

- `#`/`##`/… 标题 → **加粗**（`lark_md` 没有标题语法；原始 `#` 会以文本形式泄漏）；
- 围栏代码块 → 保留（空行规范化）；
- `---` → `hr` 元素；
- GFM 表格 → 飞书原生 `table` 元素（botmux `buildTableFromTokens`；v1 root-elements 布局支持 `table` —— 仅限根级，与我们的卡片形态匹配；lark_md 单元格保留行内代码和加粗）。原始 `| … |` 源文本绝不泄漏；
- HTML → 剥离（`html: false`）。

这就是最终答案能够正确渲染的原因（反馈第 1 轮：卡片上出现原始 `###` 文本是 bug；第 8 轮：表格显示原始竖线文本）。

---

## 5. 详情卡片

参考：用户反馈第 1、3、5 轮。

- **思考详情**：完整推理文本，放在代码块中。
- **工具详情**：
  - 头部 `✅ **<Title>** — <tool name>`；
  - `IN` —— **完整**参数，在 `json` 代码块中做美化打印的 JSON（无法解析时用原始文本）；
  - `OUT` —— **完整**结果，放在代码块中。
- **不截断**（用户指令）：2000 字符的详情截断和 300 字符的存储截断都已移除。物理卡片上限是唯一剩余的限制，且仍是待定问题。

---

## 6. Repo 选择器

参考：botmux `buildRepoSelectCard` / `project-scanner.ts`，反馈第 1–5 轮。

- `/repo` 递归扫描 `repoRoots`（深度 3，跳过点目录/依赖目录，git-common-dir 去重，预算限制）并发布选择器卡片。
- ≤ 50 个项目：一个 `select_static` 下拉框**直接放在 `action` 容器内**（放在 `form` 中会被飞书静默丢弃）。选项标签 = **repoRoot 相对路径** + `(branch)` —— 绝不是裸 basename（像 `source` 这种通用名字单独出现毫无意义）。
- \> 50：带上一页/下一页分页的编号按钮。
- **选择器生命周期**：一次选择将选择器卡片 patch 成静态确认（无操作）并记录消息 id；来自已被取代的选择器的回调会被拒绝（stale-picker 防护）。
- `repo-pick` 从 `action.option`（下拉框）或 `value.path`（按钮）读取所选路径。

---

## 7. 验收清单（在宣布某 UX 部分完成前执行）

1. 卡片默认折叠；折叠期间序列持续流式更新。
2. 打开行详情绝不会折叠流式卡片，也不会将其重新渲染到过期状态（toggle 位不变；重新断言被延迟）。
3. 卡片操作 ACK `{}`（绝不返回 `undefined`）；卡片 patch 延迟到回调之外。
4. 工具 summary 绝不为长命令显示原始 JSON 包裹。
5. 详情卡片显示完整参数/结果。
6. Repo 下拉框显示相对路径；选择后选择器即被消费；过期选择器的回调被忽略。
7. 每一步都有单元测试；状态机转换以显式测试覆盖（见 `tests/bridge.spec.ts` 的 UX 状态机区块）。

## 8. 命令面（Command surface）

### 8.1 命令集（20 个命令：15 个 surface + 5 个 web 包装）

每个命令都是一个 `SurfaceCommand`：斜杠命令与面板按钮共享同一个处理器（按钮 = 命令，即 botmux `/list-slash-command` 调色板思路）。`category` 对面板调色板进行分组。

| 命令 | 类别 | 行为 |
|---|---|---|
| `/help` | system | 列出所有 surface 命令 + 透传说明 |
| `/status` | system | chat/session/agent/最后输出/提及 一行 |
| `/cancel` | session | 停止当前回合 |
| `/cd <path>` | session | 设置聊天的 working directory，重新绑定全新会话 |
| `/repo [<path>]` | session | 项目选择器卡片（≤ 50 用下拉框，以上用按钮 + 分页） |
| `/group [<name>]` | chat | 与机器人和发送者创建一个群组 |
| `/sessions` | session | 会话列表卡片（title/id/cwd/age/live/saved），分页，每行带 Resume 按钮 |
| `/feishu-status` | system | **surface 诊断卡片**：app id、实时长连接状态（`✅ ready` / `⚠️ reconnecting` / `❌ error`，测试传输用 `🧪 memory`）、会话数、最近入站活动。只读（回合运行期间允许） |
| `/schedule` | system | 列出本聊天的**活动提醒**（用 dsh-schedule 的纯函数折叠会话日志；包缺失时降级为提示）。提醒由 agent 在聊天中通过其 `schedule_create`/`schedule_delete`/`schedule_list` 工具创建 —— 无需 surface 命令 |
| `/model` | system | **模型选择器卡片**（目录来自 `ctx.llm` 的 `listProviders` × `listModels`，当前模型预选）；选择后为新会话设置默认模型。`/model <provider>/<model>` 直接设置。surface 原生 —— web 的 `/model` 是客户端弹窗，没有宿主命令 |
| `/export` | system | 将本聊天的会话日志作为**文件消息**发送（来自 `ctx.sessionQuery.readSession` 的 `session-<id>.md` markdown 转录）—— 相当于 web 端浏览器下载 `/export` 的飞书版 |
| `/panel` | system | 从任意聊天打开控制面板卡片（仅限斜杠命令 —— 其调色板按钮被隐藏，因为一个打开面板的调色板按钮会让面板自己启动自己） |
| `/resume [<id>]` | session | 恢复已保存会话；不带 id 时打开 `/sessions` 选择器 |
| `/clear` | session | 开始全新对话 —— **非破坏性**：先前会话保持已保存且可恢复（内容完整性规则） |
| `/new` | session | `/clear` 的别名（与 web/cc-tui 的 "new chat" 对齐） |
| `/plan` `/goal` `/compact` `/feedback` `/permission` | system | **dsh web 包装**：确保存在 session/agent，然后通过 `ctx.commands.execute` 执行 harness 命令（dsh-base 挂载了全部五个）；错误类型以 ⚠️ 呈现。其中两个是状态感知的（见下文）：裸 `/plan` 切换 plan 模式，`/permission` 打开预设选择器。 |

web 端的 `/export` 命令本身是一个浏览器下载观察器（`dsh-session-log-export` —— "Register the Web-only `/export` command that the browser download plugin observes"），因此飞书实现了自己的 surface 原生 `/export`，将转录作为文件消息上传（`im.v1.file.create` → `msg_type: 'file'`）。同样，web 的 `/model` 弹窗是客户端贡献（`commandUi.popupSelect`），没有宿主命令 —— 飞书改用 surface 原生的 `/model` 选择器。未知斜杠命令保留透传/回退路径。

### 8.2 有状态的 web 包装（/plan 切换、/permission 选择器）

harness 的裸 `/plan` 和 `/permission` 形式无法*选择*或*切换*：不带参数的 `/plan` 只会进入 plan 模式，不带参数的 `/permission` 只会报告当前预设。按一下按钮必须能够切换（用户报告）—— 因此这两个包装是状态感知的：

- **`/model`（不带参数，或面板按钮）** 打开**模型选择器卡片**：目录来自 `ctx.llm`（`listProviders` × `listModels` —— deepseek 适配器自带静态默认目录，因此无需网络），一个 `select_static` 下拉框，通过 `initial_option` 预选当前模型（超出选项上限时用分页按钮），并附一条说明文字标明 `★ current`。选择后通过 `ctx.agentDefaultModel.saveSelection` 为新会话设置默认模型。过期选择被拒绝；回合运行期间拒绝选择。没有 `ctx.llm` 时，裸 `/model` 降级为文本显示（响亮日志）。
- **`/permission`（不带参数，或面板按钮）** 打开**预设选择器卡片**，由真实的 `ctx.permissionPresets` 服务构建（dsh-base 挂载）：一个 `select_static` **下拉框**（repo 选择器模式 —— 放在 `action` 容器内，绝不用 `form`）列出每个可切换的预设（`names` + `optionOf` 标签），用 `initial_option` 预选当前预设（当有效状态为 `custom` 时省略 —— 没有表格选项）。一条安静的说明文字标明当前预设（`★ current: …`）。选择后通过 `service.set(agent.session, preset)` 应用 —— 回调的 `option` 字段携带预设 —— 并回复 "switched to …"。来自被取代的选择器卡片的过期选择被拒绝；回合运行期间的选择被拒绝（working-state 门禁）。输入 `/permission <preset>` 透传给 harness 命令。没有该服务时，包装降级为 harness 报告文本（响亮日志）。
- **`/plan`（不带参数，或面板按钮）** 通过 `ctx.planMode` **切换** plan 模式：读取 `get(agent)` 并 `set(agent, !active)`，复刻 harness 的结果措辞（"Plan mode on…" / "Plan mode off."，以及 queued/cancelled 变体）。再次按下即退出 plan 模式。`/plan off` 和 `/plan <message>` 原样透传。没有该控制器时，裸形式回退到 harness 行为（响亮日志）。

### 8.3 working directory 门禁（未选择 repo 前 DSH 不可用）

没有**显式固定** working directory（/repo 选择或 `/cd`）的聊天不可用：每个回合都会被拒绝并附引导（"No working directory chosen yet — send /repo or /cd"），不创建会话/卡片，消息也不会被记住。部署的 `defaultCwd` 回退绝不是隐式选择 —— 新聊天或全新群组必须先选一个 repo，DSH 才能在那里工作（用户要求）。`requireWorkingDir`（默认 true）可为希望使用回退的部署禁用该门禁。

- 只读命令（`/help /status /sessions /panel` 及各选择器）在未固定时仍可用；面板显示 "No working directory — pick one with /repo or /cd first"。
- `/clear` 保留已固定的目录（仅会话重新绑定）。
- **Resume 采用会话的 working directory**：/sessions 的 Resume 按钮在其 value 中携带会话的 cwd，输入 `/resume` 则从会话列表中查找 —— 因此恢复的会话在新聊天中保持可用（否则门禁会拒绝每一个后续操作）。

### 8.4 working 状态门禁（状态机规则）

当回合正在运行时（`cardStates[chatId].status === 'working'`），只有只读命令可以执行：`/help`、`/status`、`/feishu-status`、`/schedule`、`/sessions`（读取状态）、`/cancel`（停止本身）、`/group`（独立聊天）、`/model`（选择器 —— 回合中途拒绝选择，但打开它没问题）、`/panel`（面板带 Stop）。其他所有命令 —— `/cd /repo /clear /new /resume` 以及五个 web 包装 —— 都会被拒绝并提示 "a turn is running — stop it first."。该门禁位于 `handleCommand` 和面板的 `command` 操作中（一条规则，两个入口），因此回合中途的会话重绑定/重铸（remint）绝不会损坏活动卡片。

### 8.5 会话生命周期命令

- `/sessions` 行有两行：第 1 行 = `**title** · age · badges`（★ current 标记内联），第 2 行 = `` `id` · cwd ``（安静的标识）；页码指示器是一个 `note`。
- `/sessions` + `/resume` 数据：`ctx.sessionQuery`（由 dsh-base 的 `session-query-sqlite` 挂载）、`listSessions()` 最新优先 + 批量 `readTitleSnapshots()` 获取标题。服务缺失时 surface 降级为仅列出已绑定会话（响亮日志）。
- Resume 流程（`/resume <id>` 与选择器的 Resume 按钮共用）：聊天必须空闲；目标会话不得在另一个聊天中运行（"has an active turn — stop it in its chat first"）；恢复聊天自身的会话会提示 "already active"。然后 `SessionMap.set` 重新绑定（先前绑定解除 —— 1:1 chat↔session 模型），当没有存活的 agent 时 `agents.resume` 加载持久化的 agent。恢复失败（没有持久化日志）报告 ⚠️ 并保持 map 不变。Resume **不会**改变聊天固定的 cwd（那归 `/cd` 管），并且它会重置卡片状态，使历史永远不会被重放到卡片中。
- `/clear`/`/new`：`SessionMap.remint` + 完整卡片状态重置（无活动卡片，无 copy/retry 目标）。旧会话保持持久化 → 仍会被 `/sessions` 列出且可恢复。

### 8.6 面板调色板

`buildPanelCard(statusLine, running, commands, page)`：核心行（运行中显示 Stop / Retry / Copy）保持最前；其下是完整命令调色板 —— 全部 16 个命令作为按钮，按类别分组并带 emoji 标题（`🧩 Session` / `💬 Chat` / `⚙️ System`），每页 `PANEL_PAGE_SIZE = 8` 个按钮，一个安静的 `note` 页码指示器（`Commands · page 1/2`），◀️/▶️ 导航在边界处隐藏。每个类别渲染为独立的块 —— 先是标题行，接着是该类别自己的按钮行（标题绝不会在所有按钮之前堆叠）。每个按钮标记 `{kind:'command', name}` 并执行与斜杠命令相同的处理器。状态行携带聊天的会话上下文（`` session `id` · `cwd` ``），因此一次点击总能显示按钮作用于什么。面板是无状态的：每次打开/翻页都发布一张基于当前权威状态构建的新卡片（无需 stale-guard）。

### 8.7 新操作的状态机矩阵

| 操作 \ 状态 | none | working | done | stopped | error |
|---|---|---|---|---|---|
| command（只读） | allowed | **allowed** | allowed | allowed | allowed |
| command（变更性） | allowed | **refused** "stop first" | allowed | allowed | allowed |
| resume-session | allowed* | **refused** | allowed* | allowed* | allowed* |
| panel-page / sessions-page | 无状态翻页重发（无卡片状态转换） | | | | |

\* 另有目标运行中 → 拒绝；目标 == 当前 → already-active。所有单元格都 ACK `{}` 并通过 `syncCard` 结束于一致状态（既有规则）；该矩阵在 `tests/bridge.spec.ts` 的 "state machine matrix extension" 中有单元测试。

## 9. 交互卡片：审批与提问（第 3 轮迭代）

参考：`@deepseek-ai/dsh-user-approval`（`approval/request` 瀑布流、`ApprovalOutcome`）和 `@deepseek-ai/dsh-user-questions`（`registerProvider`）。一个共享机制 —— `src/cards/interactions.ts`（`InteractionRegistry`）：请求发布一张卡片，surface 等待卡片回调（或超时 / 中止），并且恰好定案一次。迟到或过期的回调（错误的 chat/card、已定案、被取代的卡片）会被忽略。

### 9.1 审批卡片

`approval/request` → surface 将 agent 映射到其聊天（`sessionMap.chatFor(agent.session.id)`），发布一张**审批卡片**（`🔐 Approval needed`，橙色）：工具名 + 请求者的理由，带 `✅ Allow once`（主按钮）和 `❌ Reject`（危险按钮）。卡片回调定案 `'allowed-once'` / `'rejected'`；请求的 `signal` 中止或 5 分钟超时定案 `'cancelled'`。决策之后，卡片原地替换为一张静态的已决策卡片（无按钮 —— 再点也没有任何作用），延迟到回调 ACK 之外。失败模式为 fail-closed 的 `'unavailable'` 并伴以响亮日志：未知聊天、卡片发送失败或 bridge 销毁（每个待处理条目都定案为 `'cancelled'`）。

### 9.2 提问卡片

`ctx.userQuestions.registerProvider` —— 每个 `AskUserQuestionItem` 变成一张**提问卡片**（`❓ Question`，wathet）：

- **单选**（默认）：每个选项一个按钮；第一次点击即为答案。
- **多选**：切换按钮（卡片重新发布，在选中选项上带 `✅` 勾选标记 —— 最新卡片成为交互目标），外加一个 `✅ Submit` 按钮，用收集到的标签定案。
- **自由文本**（无选项）：卡片请用户以消息回复；下一条普通聊天消息被捕获为答案（它绕过 working-directory 门禁，且不算一个回合）。`✖ Cancel` 按钮中止。

模型通过标准的 `ask_user_question` 工具（`@deepseek-ai/dsh-tool-ask-user`）触达提问，web surface 通过其 standard/code agent 预设挂载该工具；本 bundle 将同样的工具行插入 profile 组合中，使飞书 agent 具备与 web 对等的提问能力。

agent 的 `signal` 中止将未回答的提问以空答案定案。答案卡片变成静态确认。

## 10. 第 4 轮迭代：reaction 确认、allowlist、主动提及

参考：botmux（`im/lark/client.ts` reactions、`RECEIVED_REACTION_EMOJI_TYPE` / `DONE`）、DSH web（`/export` 文件下载）以及 harness 配置面。

### 10.1 两阶段 reaction 确认

每条被接受的回合消息立即获得一个 **received** reaction（默认 `GoGoGo`，即 botmux 代码），按聊天跟踪 `{messageId, reactionId}`。回合定案时，received reaction 被**移除并替换**为终态 emoji：

| 回合结果 | Emoji（配置 `reactions`） | 默认值 |
|---|---|---|
| completed | `done` | `DONE` |
| error | `error` | `WARN` |
| stopped（用户 Stop） | `stopped` | `WARN` |

可通过 `reactions.received/done/error/stopped` 配置；`received: ''` 完全禁用该确认。reaction 调用是尽力而为的：失败只记日志，绝不会阻塞回合。斜杠命令和被门禁拒绝的消息不获得 reaction。`/clear`/`/resume` 会丢弃待跟踪条目。

### 10.2 会话回放仅通过 `/export`

会话日志恰好只有一个出口：`/export` 将转录作为**文件消息**发送（见 §8.1）。曾构建过一个卡片回放命令（`/history`），后来**经决定移除**：它与 `/export` 的内容重复，而且把完整历史打印进卡片很难看 —— 文件消息才是查看面。

### 10.3 `allowedUsers` allowlist

`allowedUsers`（配置项；`FEISHU_ALLOWED_USERS` 环境变量回退，逗号分隔）限制 surface 服务的**发送者 open id** —— 即 `allowedChats` 在用户层面的对应物。非空时，未列出的发送者的消息会被完全忽略（记录日志，无 reaction/卡片/回合），包括在已允许的聊天内部；卡片按钮（即命令）通过 `operatorOpenId` 以同样方式受门禁约束。注意 `ou_` 开头的 open id 是应用作用域的 —— 该列表按应用区分。

### 10.4 群组中的主动 @ 提及

bridge 记住每个聊天的**最近被接受的发送者**（及其聊天类型）。当群组需要某个具体的人 —— 失败回合的 `⚠️ Turn failed` 通知、审批卡片或提问卡片 —— 消息会带上对该请求者的 `@` 提及：文本消息中用 `<at user_id="…"></at>`，卡片 markdown 中用 `<at id="…"></at>`（botmux 验证过的语法）。p2p 聊天不加提及（单用户；属噪音）。请求者未知 → 优雅地不加提及。

## 11. 定时提醒（dsh-schedule）

参考：`@deepseek-ai/dsh-schedule`（基于会话事件日志的 agent 作用域持久提醒）。dsh-base 不挂载它 —— bundle 添加 `schedule` cordis 行，因此 agent 获得 `schedule_create` / `schedule_delete` / `schedule_list` 工具。

### 11.1 聊天原生配置

"Remind me in 5 minutes" / "remind me at 9:00 daily" —— 用户在聊天中提出要求，agent 调用 schedule 工具；无需 surface 命令。`every` 提醒有 5 分钟下限；`after`/`at` 是一次性的。工具为插件加载后创建的根 agent 安装，因此现有聊天在新会话（/clear 或新聊天）中获得它们。

### 11.2 agent 发起的回合渲染为卡片

触发的提醒唤醒 agent，agent 注入一条 `user/message`，其 `source.kind` 为 `'plugin'`（`plugin: 'schedule'`）。bridge 以该标记为键：没有卡片的聊天收到 plugin 来源的用户消息，即为**agent 发起的回合** —— surface 打开一张全新的 `⏰ Reminder` 卡片，并将响应渲染到完成（绿色）。用户发起的回合不受影响（其 working 卡片状态在任何事件之前就已存在）；resume 绝不重放历史（历史用户消息携带 `source.kind: 'user'`）。`/schedule` 通过折叠会话日志列出活动提醒。
