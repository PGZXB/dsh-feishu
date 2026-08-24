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

卡片**默认折叠**：行序列被替换为一行 `think → bash → read → …`（完整序列，绝不截断 —— 用户指令），按钮区增加 `▸ Expand`。

### 1.2 卡片状态机（单一权威状态）

参考：用户反馈第 4–6 轮（默认折叠、点击详情不得折叠、折叠期间流式输出必须继续、"card reverted to working after panel" —— 取代了临时逐操作补丁的设计）。

每个聊天对应一个 `ChatCardState`，它是流式卡片的**唯一权威来源**：`title`、`content`、`rows`、`openThinkId`、`status`（working/done/stopped/error）、`collapsed`。流式卡片控制器仅依据该状态渲染卡片，别无其他。

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
  流式卡片控制器掌管 compaction 卡的生命周期——`compaction/start` 立即打开
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
  - **working**：`⏹ Stop turn`。
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
| `/sessions` | session | 会话选择器卡片：一个**下拉框**（会话 `title ★ ● · id`）；选择后打开会话详情子视图（Resume / Rename / Archive / Export） |
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

- **面板卡片是独立的状态机。** 一条键入的 slash 命令（`/model /repo /permission /sessions /cd` 无参）会打开一张**专属的全新卡片**（用该视图作为种子）——它绝不会"驾驶"/更新更早的面板卡片。有父级可回退（面板栈深度大于 1）的卡片渲染 `⬅ Back`；键入命令开的卡是独立根（深度 1），**不显示 Back**。在独立根卡上完成的选卡/提交会**停留在其结果上**（不会跳回面板菜单）；只有可导航的卡片才能出栈返回。

- `/sessions` 是**下拉选择器**（移动端友好，用户需求 —— 无长列表、无分页）：一个 `select_static`，选项为各会话（`title ★ ● · id`），上限 `SESSION_SELECT_MAX = 50`（飞书 select_static 真实上限），超出部分用 `note` 说明。**🔎 Find session** 按钮打开输入子视图：输入 id 或标题片段即可过滤列表，因此上限之外的任意会话都可到达。选择后打开**会话详情子视图**（面板卡片内入栈）；所选会话 id 通过回调的 `option` 字段送达。
- `/sessions` + `/resume` 数据：`ctx.sessionQuery`（由 dsh-base 的 `session-query-sqlite` 挂载）、`listSessions()` 最新优先 + 批量 `readTitleSnapshots()` 获取标题。服务缺失时 surface 降级为仅列出已绑定会话（响亮日志）。
- 会话详情子视图（`🗂️ Session`）：会话信息（标题、id、cwd、创建时长、消息数、最后回答）加 **Resume**（当前会话隐藏）、**Rename**、**Archive**（归档时显示 **Restore** —— 宿主 `workspace.archiveSession` 可逆）、**Export**、**Back**（出栈）。仅当宿主 `apiProxy` seam 挂载时才有 Rename/Archive（否则静默降级）。
- Resume 流程（`/resume <id>` 与详情页的 Resume 按钮共用）：聊天必须空闲；目标会话不得在另一个聊天中运行（"has an active turn — stop it in its chat first"）；恢复聊天自身的会话会提示 "already active"。然后 `SessionMap.set` 重新绑定（先前绑定解除 —— 1:1 chat↔session 模型），当没有存活的 agent 时 `agents.resume` 加载持久化的 agent。恢复失败（没有持久化日志）报告 ⚠️ 并保持 map 不变。Resume **不会**改变聊天固定的 cwd（那归 `/cd` 管），并且它会重置卡片状态，使历史永远不会被重放到卡片中。
- `/clear`/`/new`：`SessionMap.remint` + 完整卡片状态重置（无活动卡片，无 copy/retry 目标）。旧会话保持持久化 → 仍会被 `/sessions` 列出且可恢复。

### 8.6 面板调色板与面板状态机

面板是一个**状态机**，而不是无状态重发 —— 而且权威视图栈是**每张卡一份，而不是每聊天一份**：`PanelController` 维护 `Map<chatId, Map<messageId, PanelView[]>>`（菜单根在栈底），只有一条渲染路径（`renderPanelView`）。每张面板卡拥有自己的栈，因此某张卡上的按钮 PUSH / POP / REPLACE **那张卡**的栈，并**原地**渲染那张卡 —— 点旧卡就更新旧卡，绝不会更新别的卡（用户报告："点这张卡，另一张卡响应"）。守护进程重启前留在屏幕上的卡，第一次被点击时从菜单根开始。按钮 PUSH 子视图（`input` 表单、`confirm`、`sessions`、`session-detail`、`picker`）；Back POPS；完成/拒绝回到菜单根（重命名后回到详情）。每次转换都在同一张卡片上原地更新（patch）；更新失败时重发卡片并记录新 id。`/panel` 与打开视图的斜杠命令（`openPanel` / `openPanelView`）会发布**全新**卡片并重置栈 —— 之前的面板卡继续留在屏幕上独立可用，聊天永远不会"一张换另一张"。斜杠命令行更新该聊天**最近发布**的面板卡（`latestPanelCardId`）；卡片回调永远更新**自己那张**卡。异步数据视图（`sessions`、`session-detail`、`picker`）会先发布**⏳ Loading… 占位卡**（仅 Back），再发布真实卡片 —— 回调必须立刻携带面板 patch，否则数据加载期间 Lark 会把面板恢复到点击前（菜单）的卡片，肉眼可见"退回菜单"（用户报告）。渲染失败时该卡的栈重置回菜单根并重发菜单卡，换页与 Back 永不死（用户报告：渲染失败后"换页按钮不再有反应"）。

- 菜单（`⚙️ dsh-feishu panel`）：`buildPanelCard(statusLine, running, commands, page)` —— 核心行（运行中显示 Stop / Retry / Copy）保持最前；其下是完整命令调色板，按类别分组并带 emoji 标题（`🧩 Session` / `💬 Chat` / `⚙️ System`），每页 `PANEL_PAGE_SIZE = 8` 个按钮，一个安静的 `note` 页码指示器（`Commands · page 1/2`），◀️/▶️ 导航在边界处隐藏。每个按钮标记 `{kind:'command', name}` 并执行与斜杠命令相同的处理器。状态行携带聊天的会话上下文（`` session `id` · `cwd` ``）。
- **输入子视图**（`📁 Change working directory`、`👥 Create group`、`🎯 Goal`、`💬 Feedback`、`✏️ Rename session`）：根级 `form`，含一个 `input` 和一个带 `name` 的 `form_submit` 按钮（飞书拒绝无名字的表单按钮 —— ErrCode 200530）。标签在 `form` 之外；提交后以输入值执行命令并回到菜单。
- **确认子视图**（`✨ New chat`、`🧹 Compact`）：破坏性操作先说明后果；确认后执行命令并回到菜单。
- **结果卡片（面板原则，用户需求）**。面板操作若结果是**最终**的，则以一张**新的纯信息卡片**（`✅ Done` / `⚠️ Action failed`，无按钮/输入框）通知：repo/model/permission 选择、重命名、归档、输入/确认提交、恢复、导出，以及所有无子视图的面板命令（help、status、plan、surface status 等）。中间步骤（输入表单、确认提示、选择器）留在面板卡片内并原地更新 —— 需要继续操作的按钮跳转面板，无需再操作的按钮以惰性新卡通知。所有完成路径共享同一个出口（`replyResultCard` + `popToMenu`）：该出口会把面板卡 patch 回菜单根 —— 正是这个 patch 防止 Lark 在回调未携带面板更新时把面板恢复到点击前（第一页）的卡片（用户报告：第二页上的直接结果按钮点击后跳回第一页）。
- **每次面板交互都必须第一时间携带面板 patch（回调-patch 保证）**。只要回调没有携带面板更新，Lark 就会把面板恢复到点击前的卡片 —— 因此面板操作内**任何 await 之前必须先发 patch**。两条结构强制这一点，**绝不要写"先 await 再 patch"的新异步面板操作**：
  - 异步面板**视图**（`sessions` / `session-detail` / `picker`）在 `showPanel` 中先发 `⏳ Loading…` 占位卡（仅 Back），再发真实卡片；
  - 异步面板**操作**（重命名、归档、导出、恢复、选择器的应用步骤、输入/确认/命令 handler）统一走 `runPanelOperation` 封装：先发 `⏳ Operating…` 占位卡（无按钮 —— 禁止误操作），再执行工作，再发结果卡，最后完成退出。这是所有"面板操作中途退回"bug 的根源（用户报告：sessions 界面内的操作没有占位卡）。

### 8.7 新操作的状态机矩阵

| 操作 \ 状态 | none | working | done | stopped | error |
|---|---|---|---|---|---|
| command（只读） | allowed | **allowed** | allowed | allowed | allowed |
| command（变更性） | allowed | **refused** "stop first" | allowed | allowed | allowed |
| resume-session | allowed* | **refused** | allowed* | allowed* | allowed* |
| panel-page | 无状态翻页重发（无卡片状态转换） | | | | |

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

触发的提醒唤醒 agent，agent 注入一条 `user/message`，其 `source.kind` 为 `'plugin'`（`plugin: 'schedule'`）。流式卡片控制器以该标记为键：没有卡片的聊天收到 plugin 来源的用户消息，即为**agent 发起的回合** —— surface 打开一张全新的 `⏰ Reminder` 卡片，并将响应渲染到完成（绿色）。用户发起的回合不受影响（其 working 卡片状态在任何事件之前就已存在）；resume 绝不重放历史（历史用户消息携带 `source.kind: 'user'`）。`/schedule` 通过折叠会话日志列出活动提醒。

## Part: inbound-attachments

> 入站图片/文件消息不再被忽略：图片注入 agent 的用户消息（模型可见），文件保存到工作区、agent 按路径读取。

### 预期行为

**触发** —— `im.message.receive_v1` 事件的 `message_type` 为 `image` 或 `file`（当前 surface 只接受 `text`）。消息可来自 p2p 或群聊（mention gate 与文本消息完全相同）。

**消息规范化** —— `normalizeMessageEvent` 新增两种类型：

| message_type | content JSON | 规范化结果 |
|---|---|---|
| `image` | `{"image_key": "img_v2_…"}` | `text: ''`，一个 image 附件 |
| `file` | `{"file_key": "file_v2_…"}` | `text: ''`，一个 file 附件 |

`FeishuMessage` 增加可选 `attachments` 数组（`{kind:'image'|'file'; key: string; name?: string}`）。`message_type` 为**已知但未处理**的飞书类型（folder、sticker、share_chat、share_user、system、media、merge、interactive）时归一化为带 `unsupportedType` 的消息，bridge 回复响亮提示而非静默丢弃——用户发文件夹必须知道 bot 处理不了（文件夹内容无法通过 API 下载）。完全未知的类型仍忽略。每条消息只有一种类型（飞书不支持混合消息）。

**统一附件路径（所有附件都是文件）** —— 飞书图片对 agent 就是普通文件：transport 通过**消息资源端点**下载图片字节（`im.v1.messageResource.get` —— `/messages/{message_id}/resources/{image_key}?type=image`；`im.v1.image.get` 只能下载机器人自己上传的图片，所以用户发的图片必须走 message-resource API；复用现有 `im:resource` scope），然后与文件一样保存进同一附件目录、由 agent 按路径读取。**没有 image 内容块 / 视觉输入路径**——裸图片消息像裸文件一样登记为 pending（见 inbound-wait-instruction part），agent 读取已保存的文件。这对应了"DSH Web 把图片粘贴进输入框"的能力在飞书场景没有意义这一决定。

**文件路径（保存到工作区，agent 按路径读取）** —— agent 无法把任意文件字节作为内容块摄取（attachment 域仅限图片），但可以读取工作目录下的文件（其 bash/read 工具在 fs sandbox 下运行，`workspace-write` 允许写工作区根）。因此 bridge：
1. **流式**下载文件体（`im.v1.messageResource.get` —— `/messages/{message_id}/resources/{file_key}?type=file`；`im.v1.file.get` 只能下载机器人自己上传的文件）。流式而非缓冲——资源 API 服务最大约 100 MB 的文件；先 peek 开头字节做扩展名嗅探再推回流，完整文件体经 `pipeline()` 直接写盘（botmux `downloadWithAppToken` 同款）；
2. 保存到聊天工作目录 `<cwd>/.dsh_feishu/attachments/<appId>/<chatId>/<name>.<ext>` —— 隐藏子目录，按 app + chat 分桶。文件名 = 用户**原始文件名**（`file_name`，飞书文件事件携带，解析进 `attachment.name`），做路径安全清洗（分隔符、穿越段、控制字符、Windows 保留字符替换；保留 Unicode；200 字节上限），并微信式去重——同一 chat 重复发送同名文件依次存为 `name(1).ext`、`name(2).ext`…… 永不覆盖。按 chat（而非 message）分桶正是去重生效的前提；`file_name` 无法清洗时回退到清洗后的资源 key（同样去重）。文件永久保留，agent 随时可重读；
3. 发布 `📎 File received` 回执卡（名称/扩展名 + 路径）；
4. 注入带**真实路径**的文本备注：
   `[user sent a file: <name>.<ext> — saved at <cwd>/.dsh_feishu/attachments/<appId>/<chatId>/<file>]`
   模型可用文件工具读取（read、grep、跑脚本）。

飞书 `file_key` 没有公开下载 URL —— 工作区文件本身就是交付物。下载/保存失败仍发布回执 + 响亮日志，回合以纯文本继续（附件绝不卡死聊天）。

### 状态与转换

本特性**没有新状态机**：喂入现有 turn 管道。唯一新分支在 `deliverTurn`（构建内容块时）：

| 步骤 | 附件（image / file 统一） |
|---|---|
| 下载 | image → message-resource (image) → bytes；file → message-resource (file) → stream + head（嗅探） |
| 保存 | 统一流式/字节写入 `cwd/.dsh_feishu/attachments/<appId>/<chatId>/<name>.<ext>`（宿主 seam，微信式去重） |
| 内容 | `[text 备注带真实路径]`（无 image 内容块） |
| 卡片 | `📎 File received` 回执卡 |
| 失败 | 降级回执 + 响亮日志，回合/后续文字不受影响 |

### 卡片/面板形态

无新面板视图。回执卡是普通 markdown 卡（类似审批/提问通知），在 `beginTurn` 前发布，不干扰 streaming 卡。

### 失败模式

- message-resource 下载失败（scope 缺失、key 过期）：响亮日志 + 降级回执（无路径）——裸附件消息不登记任何东西，后续文字仍正常工作；坏附件绝不卡死聊天。
- 文件保存到工作区失败（cwd 不可写、路径冲突）：响亮日志，回执卡照发，pending 条目仅名称。
- 群裸附件未 @：豁免 gate（登记 pending——见 inbound-wait-instruction part）；群**文字**仍受 gate 约束。
- 下载时 key 过期/未知：同下载失败。

### 验收清单

- [ ] `image` 消息 → 图片保存到 `cwd/.dsh_feishu/attachments/<appId>/<chatId>/`，回执卡发布，agent 消息带**真实保存路径**（单测 + 集成测试）
- [ ] `file` 消息 → 文件保存到 `cwd/.dsh_feishu/attachments/<appId>/<chatId>/`，回执卡发布，agent 消息带**真实保存路径**（单测 + 集成测试）
- [ ] 同一 chat 重复发送同名文件 → 第二个存为 `name(1).ext`（微信式去重，集成测试）
- [ ] 保存的文件可被 agent 工具读取（集成测试断言文件落在磁盘上、路径出现在 agent 回合中）
- [ ] 从不注入 image 内容块（飞书图片对 agent 是普通文件）——回归
- [ ] 下载失败 → 降级回执，不登记任何东西，不卡死（单测）

## Part: inbound-wait-instruction

> 裸附件消息（文件或图片——所有附件对 agent 都是普通文件）不再自行触发
> turn：字节落到工作区、回执卡发布、agent 等用户补指令（文字，或在群里
> @）才开始工作。下一条文字消息把全部 pending 附件**按顺序**带进同一个
> turn。

### 预期行为

**触发** —— `text` 为空且至少带一个附件的入站消息（裸 `file`/`image` 消息；
`video` 与富文本 `post` 支持在兄弟特性 inbound-rich-text 中落地并复用本
pending 路径）。此类消息**登记**（pending）而非投递：附件照常下载并保存到
工作区，每份文件发一张**新**回执卡（旧卡保留——每份文件在聊天记录中可追溯），
**不启动 turn**。

pending 集是 per-chat 列表而非单槽：连续裸附件消息**追加**（每张新卡显示
`📎 已收到 N 个文件`），用户可先发多份文件再发一条指令一起分析。

**跟进机制** —— 同 chat 下一条带文字的消息排空 pending 列表：把每条
saved-path 备注**按到达顺序**注入该 turn 的用户内容（在文字之前），清空列表，
正常跑 turn。只有 pending 之后第一条文字消息会触发——后续消息看到空列表。
turn 运行中到达的新裸附件消息只追加（不影响正在跑的 turn）。

**群 mention gate** —— 附件消息无法带 @（飞书发文件/图片没有输入框，
`@bot` 物理上不可能），否则 gate 会让群文件永远进不了 pending。因此裸附件
消息**绕过** mention gate 直接登记（仅 pending、不干活——gate 的安全目的仍
保留：agent 在收到一条通过 gate 的文字指令前不会做任何事）。跟进**文字**消息
仍走正常 gate（群文字必须 @ bot，或 solo 群豁免）。p2p 无 gate。

**并发** —— 消息通道批量投递不 await（`drainInbox` 逐个调用 handler），所以
`registerPending` 在任何 await 之前**同步**把占位条目追加进该 chat 的 pending
列表，之后原地更新。两条并发裸附件消息彼此都能看到对方的条目——围绕 await
的"先读后写"会静默丢文件。

**卡片/面板形态** —— `buildInboundFileCard` 增加计数：多于一份文件时 markdown
正文显示 `📎 已收到 N 个文件`（单份为 1），列出刚到的文件 + 路径。卡片仍显示
保存路径和"发送指令"提示。**无操作按钮**（曾考虑过「▶ 开始处理」按钮并否决：
它让交互变得含糊——"该打字还是点按钮？"；唯一心智模型是"发文字指令"）。
每份文件发自己的卡——旧卡留在聊天记录。无面板视图。

**失败模式**：
- 裸附件下载/保存失败：现有响亮降级路径（回执带提示、不登记、不触发 turn）——
  坏附件绝不卡死聊天。
- 跟进文字被 working-directory gate 拒绝：pending 保留（用户修好 /cd 重发）。
- 群跟进文字未 @ bot：现有 gate 丢弃，pending 保留——用户必须 @ 触发。
- turn 运行中新裸附件消息：追加 pending；运行中的 turn 不受影响（不会重复投递）。
- （PR-A inbound-rich-text）post 解析失败：回退纯文本提示；`md` 缺失时用元素
  数组序列化兜底。

**验收清单**：
- [ ] 裸文件消息 → 文件落盘、新回执卡、无 turn（mock LLM 未收到任何请求）——单测 + 集成
- [ ] 裸图片消息 → 图片落盘（嗅探扩展名）、新回执卡、无 turn——单测 + 集成
- [ ] 两条裸附件消息 → 两份文件落盘、两张卡（计数 1、2）、仍无 turn——集成
- [ ] 跟进文字消息 → 一个 turn 的用户内容按顺序带**两条** saved-path，然后列表清空——集成
- [ ] 群里跟进必须 @ bot；未 @ 文字保留列表——集成
- [ ] 群裸附件未 @ 也登记（绕过 gate）——集成
- [ ] pending 期间发斜杠命令 → 命令正常运行、列表不动——单测
- [ ] 下载失败 → 降级回执、不登记、不卡死——单测
- [ ] 从不注入 image 内容块（飞书图片对 agent 是普通文件）——回归

### Reference

- botmux 没有 wait-for-instruction 机制（文件立即触发处理）——本 part 是
  dsh-feishu 自己的 UX，因文件消息会在用户说出用途前就启动 turn 而新增
  （用户实测 F1.5 问题 1）。
- mention-gate 绕过对应现实：飞书附件消息无法带 @（无输入框）——gate 仍保护
  实际工作（必须通过 gate 的文字指令）。
- `im.v1.messageResource.get`：`type=file` 覆盖文件、音频和视频——pending
  下载路径对它们全部复用现有 file seam。
- post / video 支持是兄弟 PR（inbound-rich-text），它们排空进本 pending 路径。

## Part: inbound-rich-text

> 飞书富文本（`post`）和 `video` 消息不再被静默丢弃。`post` 归一化为保留
> 气泡内元素顺序（文字 / 图片 / 视频 / 文件在一个气泡里——"先看图再看文字"
> 与反过来不同）的 markdown 式序列化文本 + 有序附件列表；`video` 消息与
> 其它文件一样处理。带文字的富文本立即触发 turn（现有混合路径）；纯附件
> post 和裸 video 登记为 pending（兄弟特性 inbound-wait-instruction 路径）。

### 预期行为

**触发** —— `message_type` 为 `post`（富文本）、`video` 或 `audio`（语音条；
同一 `type=file` 下载路径服务它们）的入站消息。它们曾被静默忽略——用户带
格式的消息（加粗/列表/引用/链接/代码块）、视频或语音无回执、无保存、无
turn 地消失。本特性让它们成为一等公民。

**飞书 `post` content 模型** —— 富文本消息的 `content` 是二维 JSON 数组：

```json
{
  "title": "…",
  "content": [
    [ {"tag":"text","text":"第一行","style":["bold"]}, {"tag":"a","href":"…","text":"链接"}, {"tag":"at","user_id":"…","user_name":"…"} ],
    [ {"tag":"img","image_key":"img_…"} ],
    [ {"tag":"text","text":"第二行"}, {"tag":"code_block","language":"PYTHON","text":"print(1)"} ],
    [ {"tag":"media","file_key":"file_…","image_key":"img_…"} ],
    [ {"tag":"hr"} ]
  ]
}
```

每个外层元素是一段（paragraph），内层元素有序且**顺序即信息**。官方元素
tag：`text`（`style`：`bold`/`underline`/`lineThrough`/`italic`）、`a`（链接）、
`at`、`img`（图片）、`media`（视频）、`emotion`（表情）、`hr`、
`code_block`（`language`+`text`）、`file`。客户端还生成 `md` 字段（markdown
原文，已含格式与 `![img](image_key)` token）。

**归一化 —— `post` → 序列化富文本 + 有序附件** —— `post` 消息归一化为：

1. `text` 字符串 —— 内联元素的线性化 markdown 式渲染，保持顺序，附件用
   行内占位符：

```
第一行: **加粗** [链接](https://…) @用户
<image 1>

第二行: ```python
print(1)
```

<video 2>
---
```

   映射：`text` 样式 → `**`/`*`/`~~`/`<u>…</u>`；`a` → `[text](href)`；
   `at` → `@名字`；`code_block` → 围栏代码块（语言+内容）；`hr` → `---`；
   `emotion` → 表情文本；`img` → `<image N>`，`media` → `<video N>`，
   `file` → `<file N>`。`md` 字段存在时优先（已含格式与 `![img](image_key)`
   token，改写成 `<image N>` 占位符）；`md` 缺失时用元素数组序列化兜底。
   每个元素组之间换行；组顺序严格保留。

2. `attachments` 数组，按占位符顺序——每个 `img`/`media`/`file` 变成附件
   （`{kind:'image'|'file', key, name?}`），按占位符位置（从 1 起）编号。
   agent 通过有序的 `[user sent a file: … — saved at …]` 备注把 `<image N>`
   与真实保存路径对应起来。

**`video` / `audio` 消息** —— `message_type: 'video'`（content 含 `file_key`
+ 封面 `image_key`）与 `message_type: 'audio'`（语音条，`file_key` +
`duration`）归一化为单个 `file` 类附件（媒体本体），与裸文件消息完全一样
——登记为 pending，跟进文字排空。`im.v1.messageResource.get?type=file`
服务文件、音频和视频，无需新下载路径。

**路由（复用兄弟 part）** —— 归一化后：

- `post` 带文字 → 现有混合路径：立即 turn，序列化文本作为 `text` 块，附件
  按占位符顺序注入（inbound-attachments part 的统一路径）。
- `post` 文字为空（仅附件）/ 裸 `video` / 裸 `audio` → inbound-wait-instruction
  的 pending 路径（回执卡、不触发 turn、由跟进文字排空）。
- `post` 既无文字也无附件 → 响亮日志忽略（无可用内容）。

**卡片/面板形态** —— 无新增。带文字的富文本用 streaming 卡（与普通文字
消息一致）；纯附件 post / 视频 / 语音用现有 `📎 File received` pending
回执卡。无按钮、无面板视图。

**失败模式**：
- `post` content JSON 解析失败：降级为纯文本提示 + 响亮日志——原始 content
  字符串**不**作为 agent 文本投递（它是机器 JSON，对模型无用）。
- `md` 字段缺失：元素数组序列化兜底——存在元素时绝不产生空 agent 消息。
- 未知元素 tag：debug 日志跳过（向前兼容——新飞书 tag 优雅降级而非破坏解析）。
- post 内附件下载/保存失败：兄弟特性的降级回执路径（响亮日志、仅名称备注、
  绝不卡死）。
- `video` / `audio` 消息 key 过期：同下载失败路径。

**验收清单**：
- [ ] `post` 带文字 + 加粗/链接/代码/at → agent 用户消息带序列化 markdown
      式文本、格式保留（单测）
- [ ] `post` 混合文字 + 图片 + 视频 → `<image 1>`/`<video 2>` 占位符按顺序、
      附件数组同序、保存路径对应（单测 + 集成）
- [ ] `post` 带文字 → 立即 turn（单测 + 集成）
- [ ] `post` 仅附件 → pending（回执卡、无 turn；跟进文字排空）（集成）
- [ ] `video` 消息 → 像裸文件一样 pending，跟进文字排空（单测 + 集成）
- [ ] `audio`（语音）消息 → 像裸文件一样 pending，跟进文字排空（单测）
- [ ] `post` 有 `md` 字段 → 优先 `md` 序列化（单测）
- [ ] `post` content 损坏 → 响亮日志、不崩溃、原始 JSON 不投递（单测）
- [ ] 未知 tag → debug 日志跳过，其余 post 完整（单测）

### Reference

- 飞书消息内容规范（`open.feishu.cn … message-content-description`）：
  `post` content 是二维元素数组，含 `text`/`a`/`at`/`img`/`media`/`emotion`/
  `hr`/`code_block`/`file` tag 与客户端 `md` 字段；样式为
  `bold`/`underline`/`lineThrough`/`italic`。
- `im.v1.messageResource.get`：`type=image` 覆盖图片与富文本图片；`type=file`
  覆盖文件、音频和视频——现有下载 seam 服务 post 的每个元素与 `video`
  消息，无需新端点。
- lark-cli 的 `lark-event-im` 参考确认 `post`/`video` 是与 `text`/`image`/
  `file`/`audio`/`sticker` 并列的独立 `message_type`。
- botmux 的富文本处理只把 post 内容摊平成纯文本（无附件顺序）——dsh-feishu
  的有序占位符序列化是我们自己的设计，保留用户要求的气泡内顺序。
- pending 路由复用兄弟特性 inbound-wait-instruction part（跟进文字排空；
  附件消息绕过群 mention gate，因为飞书无法从附件里 @）。

## Part: turn-produced-files

> turn 结束后，流式卡列出 agent 产出的文件（write/edit 变更）为可点击 chips；
> 点一个 chip 把该文件以原生飞书图片/文件消息发给聊天。镜像 DSH web
> 的「Turn produced files」行（相同路径，路径级一致）。

### 预期行为

**为什么是路径级一致、不是渲染意图一致** — DSH web 从工具结果卡的渲染意图
（`card === 'diff'` 或 `generic + edit` → `locations[].path`）派生产出文件，
由浏览器端的 `client-runtime` 从每个工具的 `presentCall`/`presentResult` 构建。
该渲染意图数据不在宿主会话事件流里 — surface（插件）看不到 `card`/`locations`。
宿主能看到 `tool/result` 的 `meta`（工具私有展示载荷）与关联的 `tool/call`
行。因此 surface 组合这两个宿主可见来源，复现同一组产出路径（write/edit
变更）——路径级一致，与 web 行同路径。

**宿主侧的变更信号** — fs write/edit 工具在 `tool/result` 上持久化一个
`meta.diffs` KEY：update/overwrite 是非空 `{path, oldText, newText}[]`，
新建文件 CREATE 是空列表（没有 before 镜像可 diff）。read 带窗口/摘要 meta
（无 `diffs` key），delete 与纯 terminal 工具不带任何 meta —— 所以
`meta.diffs` KEY（哪怕空数组）即变更信号，正是 web 的渲染意图规则
（「read 只是看，delete 是移除，terminal 是运行」）。

**触发** — `tool/result` 事件的 `meta` 带 `diffs` 数组 key。非空 `diffs` 取
第一条的 `path`（变更工具一次改一个文件；行即该文件）。空 `diffs`（新建）
路径不在 meta —— 从关联的 `tool/call` 参数的 `file_path` 派生（fs write/edit
工具在此命名目标，匹配 web 的 `presentCall.locations`）。无关联 `tool/call`
行且 `diffs` 为空 → 不加任何路径（绝不出现坏 chip）。

**状态** — `ChatCardState` 增 `producedPaths: string[]`（权威的 turn 内产出文件
路径，去重，按到达顺序）。新 turn 开始（`turn/start`）时重置，随 `tool/result`
事件填充。`CardSnapshot`/单一渲染路径（`syncCard`）携带它。

**卡/面板形态** — 流式卡的最终状态（done / stopped / error）在最后一条
tool/message 行下渲染 `📎 Produced` 行：每个产出路径一个按钮（label =
basename）。点一个 chip 通过既有 outbound transport 把文件发给聊天
（图片扩展名 → `sendImage`，否则 `sendFile` — #29 `send_file` 基建）。
chip 是卡片动作（`value.kind: 'send-produced'`、`value.path`）；它不改卡片
状态（只发送 + 一条 debug 日志），卡片保持终态。只发送文件消息 — 不额外
发回执卡（chips 行本身就是提示）。

**排序/清理** — `producedPaths` 是 turn 内作用域：`turn/start` 重置，
`turn/end` 冻结 chips 行（卡片随它定稿）。后续 turn 的变更替换上一份列表。
路径相对 chat 固定的 cwd（正是工具 `meta.diffs[].path` 携带的），因此相对
`cwd` 解析即可复现文件。

**失败模式**：
- `meta` 缺失 / `diffs` 空：什么都不加（read、delete、terminal —— 正确的排除）。
- `meta.diffs` 存在但畸形（无 path）：跳过并 debug 日志（绝不出现坏 chip）。
- 点 chip 时文件已丢失（turn 与点击之间删了）：发送响亮失败（工具错误浮出），
  无部分发送，卡片不变。
- 点不支持的类型的 chip：`sendFile` 兜底（资源 API 服务任意字节，含音频/视频）。
- 无产出路径：不渲染 `📎 Produced` 行（卡片同今日）。

**验收清单**：
- [ ] `tool/result` 带非空 `meta.diffs` 把第一条 path 加入
      `ChatCardState.producedPaths`（单测）。
- [ ] `tool/result` 带空 `meta.diffs`（新建文件）把关联 `tool/call` 参数的
      `file_path` 加入 `producedPaths`（单测）。
- [ ] `tool/result` 来自 read（meta 无 `diffs` key）不加路径（单测）。
- [ ] `turn/start` 重置 `producedPaths`；`turn/end` 保留累计列表用于最终 chips
      行（单测）。
- [ ] 最终卡每个产出路径渲染一个 `📎 Produced` chip（label = basename）
      （单测 + 集成）。
- [ ] 点 chip 把文件发给聊天（图片路径 → 图片消息，其他 → 文件消息）（集成）。
- [ ] 点 chip 不改卡片状态（卡片保持终态）（单测）。
- [ ] 无产出路径 → 无 `📎 Produced` 行（单测）。
- [ ] 畸形 `meta.diffs` / 空 `meta.diffs` 且无关联 `file_path` 跳过并 debug 日志
      （单测）。

### Reference

- DSH web `packages/client/ui-deliverables/src/client/turn-deliverables.ts`：
  `producedPaths(view)` 只对 `card === 'diff'` 或 `generic + edit` 返回
  `locations[].path` — 本 part 在路径级镜像的渲染意图规则（按其头部说明仅客户端，
  因此宿主按 `meta` 复刻）。
- `@deepseek-ai/dsh-tool-fs` write/edit 工具：`presentationMeta` 输出
  `{diffs}`（新建 create 为 `[]`），`presentCall` 的 `locations`
  `[{path: file_path}]` — 两个宿主信号来源。

## Part: session-stats-context

> 终态流式卡上，一行紧凑的统计显示本次会话的轮/步/工具/token 用量（仅精确
> 字段）加一个上下文占用百分比，镜像 DSH web 的 `StatsLine`/context meter
> 作为路径级一致的表面。不含 timing（TTFT/tok/s/时长）——宿主看不到 web 的
> `node.timing`；只统计可精确计数的字段。

### 预期行为

**为什么只做精确字段、不做 timing** — DSH web `StatsLine`
（`turn-metrics.ts`、`StatsLine.tsx`）从每个 node 的 `node.timing`
（`stepStartTime`/`firstTokenTime`/`completedTime`）和一个 `sessionStats`
全日志投影推导 TTFT/tok/s/时长——都是浏览器侧。宿主插件只看到会话事件流，
事件带 `usage: TokenUsage`（input/output/cacheRead/cacheWrite）但**不带
timing**。所以本表面复刻可精确计数的字段（轮/步/工具/token/缓存命中）与
上下文占用（已用 token 对比模型 `contextWindow`），并省略任何依赖 timing 的
数值（时长、TTFT、tok/s——那需要从事件时间戳估算）。

**触发** — 一个有会话活动的 chat 的终态流式卡。该行渲染在卡片 FINAL 状态
（done / stopped / error），与其他终态行（如 `📎 Produced` chips）一起。
working 时不显示。

**状态** — `ChatCardState` 之外，controller 维护一个会话级累计器（NOT 每
turn 重置——整会话累计，镜像 web 的 whole-log `sessionStats`）：

- `turnCount` — 已记录轮数（`turn/start` 自增）。
- `stepCount` — assistant 步数（`assistant/message` 自增）。
- `toolCount` — 工具调用数（`tool/call` 自增）。
- `tokenUsage` — 累计 `TokenUsage`（`assistant/message.usage` 跨步求和，
  无 usage 不计）。
- `contextWindow` — chat 当前模型的 `contextWindow`（经 `ctx.llm` 解析），
  解析前 `undefined`。

`CardSnapshot`/单一渲染路径（`syncCard`）携带它。

**卡/面板形态** — 终态卡上，内容之后、与任何 `📎 Produced` chips 一起，渲染
一行由 `|` 分隔的组（镜像 web `StatsLine` 组，但只取精确字段）：

1. counts — `N turns · M steps`（无活动时省略）。
2. tokens — `input A · output B`（`formatTokens`：517 / 12.2K / 517K / 1.2M），
   有计费输入时加 `cache X%`。
3. context occupancy — `context P%`（`usedTokens` 与 `contextWindow` 均已知
   时；四舍五入整数，上限 100）。

工具调用数在 counts 组用括号折叠（`M steps · T tools`），仅当有工具运行时。
**永不显示 timing 组。**

**失败模式**：
- 尚无会话活动：不渲染统计行（卡片同今日）。
- `assistant/message` 无 `usage`：不计 token（绝不给全部步骤都未计费的会话
  渲染零 token 组）。
- `contextWindow` 未知（模型解析缺失/失败）：省略 context 组（只显示
  counts/tokens 组）。
- chat 未固定 cwd：不受影响（这是只读卡行，不发送、不解路径）。

**验收清单**：
- [ ] `assistant/message.usage` 累加进 token 总量；无 usage 的步不计（单测）。
- [ ] `turn/start` / `assistant/message` / `tool/call` 正确自增计数；计数是
      会话级（不随 `turn/start` 重置）（单测）。
- [ ] 终态卡只对精确字段渲染 counts + tokens（+ cache %）组；绝不显示
      timing 组（单测 + 集成）。
- [ ] `contextWindow` 与 usedTokens 已知时渲染 context 组，否则省略（单测）。
- [ ] 无活动 → 无统计行（单测）。
- [ ] 统计行仅终态（working 不显示），且不改卡片状态（单测）。

### Reference

- DSH web `packages/client/ui-conversation/src/client/chat/turn-metrics.ts`
  与 `StatsLine.tsx`：`deriveTurnMetrics`/`deriveStats` 读 `node.timing`
  （TTFT/decode）与 `sessionStats`/`tokenUsage` 投影——浏览器独有的 timing+
  token 来源。`formatTokens`/`formatDuration`/`cacheHitPercent`/
  `contextOccupancy` 给出本 part 为 count/token/context 组镜像的精确显示
  规则（timing 组特意排除）。
- 已安装 dsh 类型：`dsh-session` `SessionEventMap['assistant/message']` 带
  `usage?: TokenUsage`；`dsh-llm` `TokenUsage`
  （`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`）与
  `LlmResolvedModelInfo.context.contextWindow`——宿主可见数据。
## Part: message-queue

> turn 运行期间收到的消息不再打断它——每条排队消息都有它**自己**的专属卡片，
> 每张卡各自维护一个生命周期状态机（没有共享的『N queued』卡，也没有撤回/重发的
> 单卡不变量）。每条排队消息可被插话（steer）、编辑或删除；终态卡片**保留**并
> 显示其状态标记。镜像 DSH web 的 `QueueDock`。

### 意图行为

**为什么一条排队消息一张卡，而不是流式卡上的行** —— DSH web 把排队输入放在
`QueueDock`（一个固定 dock）里，生产问题（用户反馈）：turn 运行期间发送的消息
必须*被看见接受*，否则流式卡会显得"死掉"（用户消息下没有新气泡）。发一张
确认"已排队"的专属卡片让接受无歧义。每条排队消息**一张卡**，各自拥有自己的
生命周期状态，用户可以一步步跟随单项从 `queued` → `editing` →
`steering` → `steered`/`sent`/`removed`，无需撤回并重发共享卡。共享单卡本身很
脆弱（用逐项 `form` + `input.default_value` 构建 —— 曾产生 Feishu 400 —— 且难
维护）。

**触发** —— 一条用户消息在聊天 turn 运行期间到达（
`streaming.isWorking(chatId)`）。这条消息不立即作为新 turn 投递；而是放入
surface **自己**的内存队列，并发布它**自己**的 `buildQueueItemCard`（状态
`queued`）。

**队列数据 / 状态** —— 队列是 surface **自有**的内存 `Map<chatId,
QueueItem[]>`（绝不是 agent inbox 的 `nextTurn` 列表——agent loop 会在自己的
step 边界自动 claim 该列表并绕过 `deliverTurn`，导致用户只看到 "Sent" 标记却
没有流式卡）。它是 surface 所有的（不是会话所有的），所以卡片重渲染不会丢；不
持久化，重启会丢弃排队消息（可接受的取舍）。每项携带已解析的 `UserMessage`
（供重新投递 / 插话）、`text`、`status` 以及原始入站消息。与之并行，bridge
维护逐项卡片注册表 `Map<chatId, Map<itemId, { cardMessageId, status, text,
message, feishu }>>`，使每项的专属卡在状态变化时**原地**更新（`updateCard`）
——即使该项已离开活动队列（保留的标记卡仍需要自己的预览文本）。

**条目生命周期状态（每张卡一个状态机）**：
`queued | editing | steering | steered | sent | removed`
- **queued** —— 在队列中等待。头部 `⏳ <preview>` + 消息预览 + 动作：`➡️ Steer`
  （仅在 turn 运行时；空闲时省略 Steer 并显示禁用提示）、`✏️ Edit`（打开内联编辑
  表单）、`🗑️ Remove`（删除）。
- **editing** —— 内联编辑表单在本卡上打开：一个 `form`，含一个 `input` +
  一个 `form_submit` 的 Submit 和一个 Cancel 按钮。提交回到 `queued` 并带新文本；
  Cancel 不变地回到 `queued`。**不使用** `input.default_value`（已验证的
  `buildInputCard` 形状 —— input 上的 `default_value` 曾产生 Feishu 400）。
- **steering** —— 已点击 Steer；等待 agent 在它的 step 边界消费。显示
  "💬 Steering…"，无按钮。
- **steered** —— agent 已消费该插话。显示 "✅ Steered"，无按钮。
- **sent** —— 排队消息在所属 turn 结束后作为它自己的 turn 被投递（非插话路径）。
  显示 "📤 Sent"，无按钮。
- **removed** —— 用户已删除。显示 "🗑️ Removed"，无按钮。

在终态（`steered` / `sent` / `removed`）之后该卡**保留**并显示其状态标记——绝不
自动撤回。没有共享单卡。

**卡片/面板形状** —— 每条排队消息一个 `buildQueueItemCard(item, running)`：
- 头部：`⏳ <preview>`（queued）或 `⏳ <状态标签>`（editing/steering/steered/
  sent/removed）。
- 正文：消息预览，然后是状态标记（steering/steered/sent/removed）或动作
  （queued）或编辑表单（editing）。
- 每项动作（驱动 surface **自有**队列，镜像 web `updateQueue`）：
  - `queue-steer`：仅在 turn 运行时；把该项从 surface 队列取出然后
    `agent.steer(message)`（driver 在下一个 STEP 边界消费——绝不是 `nextTurn`
    列表）。镜像 web 的 `steer-unavailable` 守卫。把卡片置为 `steering`；该消息
    的下一次 `user/message` 事件把它翻转为 `steered`。
  - `queue-edit`：打开内联编辑表单（`editing`）。
  - `queue-edit-submit`：在 surface 队列中重写排队内容（保持**同一**身份）→
    `queued`。
  - `queue-edit-cancel`：→ 不变地回到 `queued`。
  - `queue-remove`：把该项从 surface 队列取出 → `removed`。

**队列消费** —— 在一个 turn 结束（`turn/end`）后，surface 清空它**自己的**队列：
每条排队的非插话消息作为它自己的 turn 被投递（`beginTurn` → `followup`），打开的
流式卡与刚到达的消息完全一致。每个 `turn/end` 只投递一条——若紧接着投递下一条，
会把它放进 agent inbox，而 agent loop 会在那里自动 claim 它且没有流式卡——因此
链条在下一个 `turn/end` 继续。每条已投递项被标记为 `sent`，其保留卡被更新。
插话消息经 `agent.steer` 进入正在跑的 turn，**不会**转移到新卡；流式卡 trace 在
它被注入的位置添加一个 `steering` 行（修复 1），让用户看到自己插话的正是那条
消息。

**流式 trace（steering 行）** —— 当流式卡收到被插话消息的 `user/message` 事件
（source kind `user`，由 `agent.steer` 在 turn 中途注入）时，控制器在 trace 中
追加一个 `{ kind: 'steering', id, text }` 行。折叠时只显示 `steer`；展开时显示
完整被插话的消息文本——用户总能看见自己插话的那条消息被插在哪里。

**失败模式**：
- 无 inbox（agent 缺失 / `agent.inbox` 不可用）：消息按普通 turn 投递（降级为今天
  的行为），记日志——绝不出现坏队列。
- 空闲时 steer（`streaming.isWorking(chatId)` 为 false）：按钮被省略并显示禁用提示
  （"steer unavailable — no turn running"）；不触发任何卡片动作。
- 队列项已被消费（turn 边界与点击竞态）：动作报告"no longer pending"（一条文本
  通知）；若仍为 `queued`/`editing`，则标记该项为 `sent`。
- 卡片更新/发送失败：记日志；注册表状态不变——下一次变更会重渲染。
- 无固定 cwd 的聊天：工作目录 gate 仍拒绝**第一个** turn；排队消息进入 turn 时按
  今天的方式取 cwd。

**验收清单**：
- [ ] turn 运行期间发送的消息被排入 surface **自有**队列（不是 agent inbox
      `nextTurn`），不是作为打断 turn 投递；它发布**自己**的条目卡，并且在
      `turn/end` 后作为自己的 turn 投递并打开流式卡（单测 + 集成）。
- [ ] 每条排队消息各有一张卡；变更时**原地**更新（`updateCard`），绝不删除+重发；
      没有任何卡被撤回（单测 + 集成）。
- [ ] 每个生命周期状态渲染正确的按钮/标记：queued（Steer/Edit/Remove，Steer 仅在
      turn 运行时）、editing（编辑表单）、steering（"💬 Steering…"）、steered
      （"✅ Steered"）、sent（"📤 Sent"）、removed（"🗑️ Removed"）——终态卡无按钮
      （单测）。
- [ ] 运行中 steer 把卡片置为 `steering`；随后的 `user/message` 把它翻转为
      `steered`，流式 trace 显示 `steer` 行（展开 = 完整被插话文本）（单测）。
- [ ] Edit 打开表单；submit 替换文本并回到 `queued`；cancel 不变；无
      `input.default_value`（单测）。
- [ ] Remove 把卡片置为 `removed` 并保留它（单测）。
- [ ] agent inbox 缺失 → 降级为普通 turn，大声记日志（单测）。
- [ ] 队列条目卡不干扰流式卡 / 产出 chips / 统计行（集成）。

### Reference

- DSH web `packages/client/ui-conversation/src/client/queue/QueueDock.tsx`：把队列渲染
  为 dock，`{ kind: 'edit' | 'remove' | 'steer' }` 动作经 `updateQueue`，可折叠计数头
  （单条直接渲染），以及子代理拥有会话时的 `queueMutable` 门。
- DSH web `packages/client/runtime/src/client/sessions/session.ts`
  （`updateQueue`）+ `packages/host/apiproxy/src/api-proxy.ts`：队列动作映射 —
  `edit` → `inbox.replace`，其余先 `inbox.remove` 再 `agent.steer(message)` 用于
  `steer`；steer 要求 `target === 'next-turn'` 且 `agent.status === 'running'`
  （否则 `steer-unavailable`）。dsh-feishu 把这些映射到它**自己**的队列（非插话
  排队消息**不会**使用 agent inbox）；只委托 `agent.steer`。
- dsh `@deepseek-ai/dsh-agent` `Inbox`（`inbox.d.ts`）：`nextTurn` 列表、
  `append`/`prepend`/`replace`/`remove`/`clear`，以及 `Agent.steer`
  （`runtime-types.ts`）：运行中的 driver 在下一个 STEP 边界消费 steering，绝不
  中途插入。dsh-feishu 只用 `agent.steer`；绝不把非插话排队消息追加进 inbox。

