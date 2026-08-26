# 开发陷阱记录
[English](pitfalls.md) | 中文

来自构建本插件过程中的现场笔记 —— 那些耗费了实际数小时的陷阱。
每条记录都说明了症状、根本原因和修复方法。当你遇到新问题时，
请保持更新本页面。

## Feishu 卡片布局约束

交互式卡片的线格式（wire format）是本次集成中最不宽容的部分。
以下规则已在真实设备（沙箱中的 Feishu 应用）上验证，也是多个卡片设计
被返工的原因。

- **使用 v1 布局：根级 `elements`，不要 `schema` 字段。** 带有
  `schema: '2.0'` 的卡片会以 `ErrCode 200861` 拒绝交互式 `action` 标签
  （当 body 形状错误时报 "unknown property `elements`"）。只有 v1 根级
  `elements` 布局接受 `action` 按钮。所有控制卡片（状态按钮、面板、
  仓库选择器）都使用它。botmux 的控制卡片使用相同的布局。
- **在此布局中，`form` 容器内的 `form`、`select_static` 和 `input` 会被
  静默丢弃** —— 卡片在渲染时没有它们，也没有报错，这使 bug 不可见。
  `select_static` 直接放在 `action` 容器内时**确实**可以工作：选择选项会
  触发一个卡片回调，其 `option` 字段携带所选值，而 select 自身的 `value`
  字段携带动作标记（botmux 模式：`value: { key: 'repo_switch' }`）。
  仓库选择器的下拉框就使用这种方式。
- **卡片回调是与事件（events）分离的接收模式。** bot 必须在 Feishu 控制台
  中将 "events" 和 "card callbacks" 都切换到长连接接收模式；否则按钮会
  返回 "该应用尚未配置卡片回调"。参见 `docs/feishu-setup.md`。
- **`message.patch` 是静默的**（没有未读指示器），这对实时流式卡片正好
  合适。每个回合一张卡片：回合开始时发出（那次发送即通知），输出到达时
  不断 patch，并在**原卡上定稿** —— 完成或停止的回合不会发出第二个气泡。
- **卡片大小上限约 109 KB** —— 长输出在渲染前会被截断尾部
  （`MAX_CARD_CHARS`）。
- **`lark_md` 没有可靠的转义语法** —— 不可信文本中的 `**` 会被折叠为 `*`
  而不是被转义。

## 环境与代理怪癖（沙箱）

harness 沙箱（以及本 checkout 的环境）有一些特定规则：

- **`HTTPS_PROXY`/`HTTP_PROXY` 会破坏 axios**（lark-oapi 使用它）：TLS
  握手失败（`ERR_TLS_CERT_ALTNAME_INVALID` 或连接失败），因为 axios 在没有
  agent 的情况下不遵循这些环境变量。运行 bot 时请取消设置它们
  （`unset https_proxy HTTPS_PROXY http_proxy HTTP_PROXY ALL_PROXY
  all_proxy`）。
- **Node 内置 fetch 只有在 `NODE_USE_ENV_PROXY=1` 时才遵循代理；** 基于
  undici 的客户端（modlens 捆绑的 undici）完全忽略环境代理，并以
  `fetch failed` 失败。预加载 shim `_dev/proxy-preload.cjs` 将
  `EnvHttpProxyAgent` 安装为全局 dispatcher；通过
  `NODE_OPTIONS='-r …/proxy-preload.cjs'` 加载它。
- **直连某些 LLM provider 被阻止** —— 它们需要代理；上面的预加载正是
  让这些 provider 工作的原因。
- **`~/.dsh`、`~/.npm`（以及其他工具自己的状态目录）是只读挂载**，
  除非 shell 拥有 `danger-full-access`。所有开发状态都位于仓库的 `_dev/` 下（home 目录、
  bin、corepack、dsh-home）。
- **harness 导出的环境变量 `DSH_HOME` 指向它自己的 home** —— 集成测试
  必须指向它们自己的 `FEISHU_INT_DSH_HOME`（或 `_dev/dsh-home`），绝不要
  使用环境中的值。
- **`kill $!` 杀死的是 bash 包装器，而不是子进程** —— `nohup` 子进程
  存活下来，并堆积出并发的 dsh 进程（曾发生过会话损坏事件，以及一次
  "卡片更新乱套"事件：N 个 bot 进程同时连着同一个飞书 app，各自维护
  自己的内存面板状态，互相覆盖对方的卡片）。真实进程是
  `node …/dsh/lib/bin.js --profile <名字>` —— `pkill -f "dsh --profile …"`
  **匹配不到它**（前面有 `node` 前缀）。按真实命令行杀，并**验证**只剩
  一个进程：

  ```sh
  pkill -f "bin.js --profile feishu-d[e]v"   # [e] 防止匹配到自身
  sleep 2
  ps aux | grep "bin.js --profile" | grep -v grep   # 期望恰好一个（或零个）
  ```

  任何重启前后都要数一下 bot 进程 —— 卡片行为异常时，残留的第二个
  bot 是第一嫌疑。
- **调试追踪需要 `FEISHU_DEBUG=1` 且 exporter 的 `levels` 配合。**
  console exporter 只有在 `process.env.FEISHU_DEBUG` 为 `1` 时才输出
  debug 记录，而 cordis 还会跳过高于 exporter `levels` 阈值的记录 ——
  在 exporter 上设置 `levels: { default: 3 }`，debug（level 3）才会到达
  它。之后调试行可以沿着消息/卡片/session 走完整个管道（见
  `docs/development.md` → "Debug logging"）：面板行精确显示每个动作的
  目标卡片（`panel action <kind> on card <messageId>` → `panel update
  card <messageId>`），这是排查"哪张卡被更新了"问题的工具。每个模块
  收到的 logger 接口（`StreamingLogger`、`InteractionLogger`、
  `TransportLogger`、面板 context logger）都暴露 `debug`；**新模块**如果
  要记日志，必须接收带 `debug` 的 logger 并用它做追踪——不设环境变量
  时生产环境保持安静。

## Feishu SDK（lark-oapi）与开放平台 API

- **SDK 默认的 axios 实例会遵循 `http(s)_proxy` 环境变量。** 启用代理时，
  WS 端点发现和 REST 调用会因 follow-redirects 而崩出
  `Protocol "https:" not supported. Expected "http:"` 错误。向 `Client`
  和 `WSClient` 都注入共享的 `proxy: false` axios 实例（`FEISHU_HTTP`）。
- **自定义 `httpInstance` 必须复刻 SDK 默认实例的响应拦截器。** 默认实例
  会解包 `resp.data`；没有它，`request()` 返回的是 AxiosResponse 包装，
  SDK 的 `{code, data:{URL}, msg}` 解构得到 undefined（`code: undefined`）。
  同时还要复刻 `$return_headers` 的透传。
- **QR 登录 init 必须带 `x-locale` 和 `x-terminal-type` 头。**
  `POST accounts.feishu.cn/accounts/qrlogin/init` 缺少它们会返回 4401
  "请求无效"——`{"unit":"eu_nc"}` 之类的响应体是障眼法，别被误导。发送
  `x-locale: zh-CN` + `x-terminal-type: 2`。

## Gemini / modlens

- 新密钥使用新的 API-key 格式（`AQ.…`）。较旧的模型名称可能对新用户
  被门禁（404），或在负载下 503——把具体的模型名称视为随环境而变化；
  modlens 的 provider 配置存放在它自己的状态目录下，并且需要 undici
  代理预加载（见上文）才能访问需要代理的 provider。

## pnpm

- pnpm ≥ 10 从 `pnpm-workspace.yaml` 读取设置，**而不是** `.npmrc`。
  `minimumReleaseAge` 可能隔离刚发布的 harness 包并静默安装旧版——
  workspace 维护了一份 `minimumReleaseAgeExclude` 清单（当前为
  `@deepseek-ai/*` + schemastery）；需要立刻用新版时把包加进去。
- **pnpm ≥ 11 默认拦截依赖的构建脚本。** profile 里执行
  `dsh plugin add @dsh-feishu/dsh-feishu` 会以 `ERR_PNPM_IGNORED_BUILDS`
  失败（lark SDK 的 `protobufjs` postinstall 被拦），除非批准该构建。
  pnpm 11 完全忽略 package.json 中的 `pnpm.*` 字段——唯一修复是
  `pnpm add --allow-build=protobufjs`（dsh 会透传该参数）或在 profile 的
  `pnpm-workspace.yaml` 中加入 `allowBuilds` 条目。
- 默认 store 目录位于只读文件系统上 —— 将 `store-dir` 固定到仓库内
  （`_dev/pnpm-store`）。
- **pnpm ≥ 11 默认 `minimumReleaseAge` 为 1440 分钟（24 小时）。** 新生成的
  lockfile 可能包含 24 小时内发布的传递依赖；pnpm ≥ 11 会以
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 拒绝整个安装。在
  `pnpm-workspace.yaml` 中显式设置 `minimumReleaseAge: 0`（`allowBuilds`
  白名单——供应链安全控制——保持不变）。
- **pnpm ≥ 11 会把 `pnpm run <script> -- <args>` 中的 `--` 原样转发。**
  脚本收到 `-- --new …`，把 `--` 当作未知选项拒绝。CLI 参数解析必须跳过
  开头的 `--` 运行参数分隔符。
- **harness 的 `@deepseek-ai/*` 包必须放 `peerDependencies`，绝不能放
  `dependencies`。** 把 harness 核心包（如 `dsh-tools`、`dsh-llm`、
  `dsh-storage`×3、`dsh-workspace`）写进 `dependencies`，会让 pnpm 在
  profile 的 `node_modules` 里装一份**真实物理副本**，遮蔽 dsh 宿主的扁平
  symlink 回退目录 —— 同一包在单进程里被加载两次。靠模块内局部 Symbol 键
  存的"模块身份"状态（`dsh-tools` 的工具调度器）在两份拷贝之间不一致，于是
  调用工具时报 `Cannot read properties of undefined (reading 'prepare')`，
  中断的回合又在会话尾部留下一条没有工具回复的 `tool_calls`，下次请求被
  provider 以 `INVALID_REQUEST` 拒绝。纯文本回复正常，任何调用工具的回复都失败。
  修法：把该 harness 包移到 `peerDependencies`，让宿主提供单实例（dsh-TUI
  把每个 `@deepseek-ai/*` 包（含 `@deepseek-ai/schemastery`）都移出
  `dependencies`）。由 `check-conventions.mjs` 的 "@deepseek-ai packages are
  peerDependencies" 检查把关。

## 提及门禁（mention gate）

- 提及门禁是 **bot 侧**的：无论是否被提及，Feishu 都会把群消息投递给
  bot；由 bot 决定是否响应。`groupMentionMode: always`（默认）与 botmux
  兼容（always/never/ambient/topic）。在 1 人 1 bot 的私人群中，`@`
  要求被放宽（`isSoloGroup`）。
- `allowedChats` 是一个 allowlist；其外的聊天会被完全忽略。

## Git 发现 vs 扫描根目录

- 一个假的或部分的 `.git` 标记（没有真实对象库的目录，或指向虚无的
  gitfile）会使 git **向上遍历树**，寻找最近的真实仓库。当扫描根目录位于
  真实仓库内部时（例如插件仓库下的 `_dev`，或仓库下的 `~`），从候选目录
  执行 `git rev-parse --git-common-dir` 可能解析到 *祖先* 仓库，从而静默地
  把整个扫描折叠成一个虚假的项目。修复：在每一个 git 子进程上传递
  `GIT_CEILING_DIRECTORIES=<scan root>`，使发现过程无法逃出根目录
  （参见 `src/projects.ts`）。botmux 有这个潜在 bug；它的扫描根目录都是
  真实仓库，所以从未触发。

## 参考资料

- 卡片/布局模式：botmux `src/im/lark/card-builder.ts`（action 内选择）、
  `card-handler.ts`（回调归一化）、`project-scanner.ts`（递归扫描语义）。
  未来的斜杠命令 UI/UX 应首先对照 botmux 检查 —— 它已经解决了大多数
  Feishu 卡片 UX 问题。

## 仅 Web 端的 harness 命令

- 一些 dsh 命令只存在于 web 客户端，而不在 host 命令注册表中。
  `/export`（`dsh-session-log-export`）是一个浏览器下载观察者
  （"Register the Web-only `/export` command that the browser download
  plugin observes"）—— 在非 web 表面上不会有任何下载。
  `/model`（`ui-model-selection`）作为 `popupSelect` 客户端贡献注册在
  `commandUi` 上，没有对应的 host 命令。在承诺某个命令之前，请检查
  harness 源码中的 "Web-only"；实现一个表面原生的等价物（`/model` 读取
  `ctx.llm.listProviders` × `listModels` 和 `ctx.agentDefaultModel`）。

## compaction 不是回合

- `/compact` 运行一个持久事务——`compaction/start → summary → end`——
  并且**不会**发出 `turn/end`。如果表面只在 `turn/end` 时定稿卡片，
  聊天会永远停在 "working"：之后每个命令都被 "a turn is running —
  stop it first." 拒绝（用户报告）。应该自己掌管 compaction 卡的
  生命周期：在 `compaction/start` 打开（按钮即时反馈）、渲染
  `compaction/summary`、在 `compaction/end` 定稿——该事件无论成败都会
  发出（失败的关闭会携带 `error`）。plugin 源为 `compact` 的 checkpoint
  `user/message` 是表面替换标记，不是回合开始。

## 服务接缝：getter vs 方法

- 结构化的 `ctx.get(name)` 接缝必须镜像 REAL 服务的形状。
  `ctx.permissionPresets.names` 是一个 **属性 getter**（写 `names`，而不是
  `names()`）；`current(events)` 折叠会话的 events，而 `set(session, name)`
  写入会话的 knobs —— 传入 Agent 而不是 `agent.session.events` 会在运行时
  以 "events is not iterable" 失败。`ctx.planMode.get(agent)` /
  `set(agent, active)` 接受 Agent。在编写接缝之前阅读已安装的 `.d.ts`；
  错误的形状也能干净地通过类型检查。

## 按钮必须是有状态感知的，而不是透传

- 一个面板按钮，其 handler 运行裸命令，对于带有选择/切换维度的命令是
  坏掉的：无参数的 `/permission` 只 REPORT 当前预设，无参数的 `/plan` 只
  ENTER 计划模式，无参数的 `/model` 只显示。修复：`/permission` 和
  `/model` 打开选择器卡片（`action` 容器内的 `select_static` 下拉框，用
  `initial_option` 预选当前值 —— SDK 支持；当有效状态为 `custom`/未知时
  省略它）；裸 `/plan` 通过 `ctx.planMode` 切换（读 `get`，写
  `set(!active)`）。
- 打开面板本身的面板按钮就是面板启动自己 —— 隐藏它
  （`SurfaceCommand.hiddenFromPanel`）。

## 工作目录门禁

- 在没有固定工作目录（/repo 或 /cd）的聊天中，表面拒绝轮次；
  `defaultCwd` 是回退，绝不是隐式选择。新的聊天状态流程必须尊重它：
  `/resume` 采用被恢复会话的 cwd（会话详情页的 Resume 按钮在它的 value
  中携带它；键入的 `/resume` 从会话列表中查找它），否则被恢复的聊天会
  卡在门禁后面。

## 集成测试陷阱

- 集成测试套件共享真实 profile（`_dev/dsh-home`）。通过表面写入状态的
  测试（`/model` → `saveSelection` 写入 `settings.yaml`）必须恢复原始值，
  否则后续运行和真实 bot 都会继承该更改。
- 每个新会话都会触发一个 **标题生成完成**（"Create a concise title for an
  AI coding…"）。绝不要断言精确的 LLM 完成次数；断言卡片内容。
- **`holdNextResponse()` 之后、驱动 stop/panel 动作之前，先 `await
  waitForHold()`。** working 卡在 turn 一开始就出现，但 agent 的 LLM 请求
  是异步建立的（buildRequest → resolveApiKey → fetch）。在请求到达 mock
  （且其 abort signal 绑定到在途 body）之前发出的 stop 什么也取消不了，
  turn 会正常完成——没有 stopped 卡 / ERROR 表情，在慢或高负载的 CI
  上超时。`waitForHold()` 在 hold 请求真正在途时 resolve，使 abort 确定性
  落地。
- 由 `Date.now()` 构建的消息 id 在同一毫秒内写入两条消息时会冲突（并且
  表面的去重会静默丢弃第二条）。追加一个随机后缀。匹配 ANY 聊天回复的
  waitFor 谓词会提前通过先前聊天的文本 —— 用 `r.chatId` 过滤。
- 回答脚本化错误的 mock 必须在写入 200 头之前决定状态 —— 在
  `writeHead(200)` 之后调用 `writeHead(500)` 会抛出 "headers already sent"
  并使适配器挂在打开的 body 上。
- 每个 mock 完成请求必须恰好消费脚本一次 —— 在错误检查和流写入器中都
  消费会使消费翻倍，并静默地使每个后续脚本化响应偏移。
- **集成测试套件运行的是构建后的 `lib/`，而不是 `src/`。** 对 `src/` 的
  更改在 `pnpm run build` 之前不会到达生成的进程；"本地正常、集成失败"
  的症状通常是过期的 lib（真实进程的 `/model` 案例：命令在重建落地之前
  一直是 "Unknown"）。
- **两个真实进程测试套件不能共享同一个 dsh home。** vitest 并行运行测试
  文件；两个套件都会启动 dsh 子进程，持久化会话映射 + 日志，并发的写入
  会竞争（固定的 `/cd` 丢失、轮次被拒绝）。场景套件使用自己的
  `_dev/dsh-home-scenarios`（`FEISHU_INT_SCENARIOS_DSH_HOME`），CI 会准备
  两个 profile。
- **Schemastery 会把缺失的可选数组物化为 `[]`。** 声明为
  `z.array(z.string()).required(false)` 的配置键读出来是 `[]`，而不是
  `undefined` —— 检查 `config.x !== undefined` 然后又把空列表当作
  "无限制" 的门禁逻辑会静默地永远处于开启状态。allowlist 解析器
  （`resolveAllowedUsers` 等）会把 `[]` 归一化为 `undefined`；在
  `tests/index.spec.ts` 中有回归测试。
- **断言卡片 markdown 内容，而不是 `JSON.stringify` 过的卡片。** 卡片中的
  提及渲染为 `<at id="ou_x"></at>`；`JSON.stringify(card.elements)` 会把
  引号转义成 `\"`，所以 `.includes('<at id="ou_x"></at>')` 永远不会匹配。
  改为读取 `markdown` 元素的 `content` 字段。
- **`ask_user_question` 工具的 schema 是 snake_case。** 线参数是
  `multi_select`（不是 `multiSelect`）；camelCase 会被工具 schema 静默
  丢弃，问题到达时变成单选。
- **切换重新发布会把交互重定向到最新的卡片。** 在多选切换之后，Submit
  动作必须携带最新问题卡片的 message id —— 原始卡片 id 已过期，注册表会
  拒绝它（然后该轮次会挂在一个未回答的问题上）。

## 提交卫生：本地 "green" vs CI green

- `pnpm run lint` 运行的是 `biome check src tests` —— 正是 CI 命令。
  `biome check --write`（本地便捷命令）只应用 SAFE 修复；不安全的诊断
  （`lint/style/useTemplate`、`lint/complexity/useIndexOf`）留在树中，使
  普通的 `check` 失败。如果本地工作使用了 `--write`，提交前仍然要运行
  `pnpm run lint` 并检查退出码 —— 这里曾因最终门禁只读取最后一行输出
  （`Found 3 infos.`）而不是退出状态，而把 CI 失败带到了线上。
- 规则：每次提交前，运行 `pnpm run lint`、`pnpm run typecheck`、
  `pnpm run test`、`pnpm run build`，并确认每个都以 0 退出 —— 永远不要
  相信输出尾部或 `--write` 运行可以作为 lint 的裁决。
