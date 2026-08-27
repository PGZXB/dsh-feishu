/**
 * The `zh-CN` catalog — simplified-Chinese translations for every message in
 * the base `en-US` catalog. Typed as `Record<MessageKey, string>` so key
 * parity with `en-US` is enforced at COMPILE time: a key translated here but
 * missing from the base (or vice versa) fails `pnpm run typecheck`.
 *
 * Style: concise surface Chinese, full-width punctuation where natural
 * (`，`/`。`/`——`), command names (`/repo`, `/cd`, `/help`) and identifiers
 * kept verbatim (they are commands, not prose), emojis matching the base
 * label so the visual language is identical across locales.
 *
 * @module @dsh-feishu/dsh-feishu/i18n/zh-CN
 */

import type { MessageKey } from './index.js';

export const zhMessages: Record<MessageKey, string> = {
  // Shared fragments.
  'common.untitled': '（未命名）',

  // ── Streaming card buttons + pagination chrome ──────────────────────────
  'card.button.stopTurn': '⏹ 停止回复',
  'card.button.copy': '📋 复制',
  'card.button.retry': '🔁 重试',
  'card.button.panel': '⚙️ 面板',
  'card.button.expand': '▸ 展开',
  'card.button.collapse': '▾ 收起',
  'card.button.exportLog': '📄 导出日志',
  'card.page.prev': '‹ 上一页',
  'card.page.next': '下一页 ›',
  'card.page.prevFull': '◀️ 上一页',
  'card.page.nextFull': '下一页 ▶️',

  // ── Card rows + stats line ──────────────────────────────────────────────
  'card.row.thinking': '☁️ 思考 · 思考中',
  'card.row.steerLine': '💬 插话 · {preview}',
  'card.sequence.think': '思考',
  'card.sequence.steer': '插话',
  'card.stats.turns': '{count} 轮',
  'card.stats.steps': '{count} 步',
  'card.stats.tools': '{count} 次工具',
  'card.stats.tokens': '输入 {input} · 输出 {output}',
  'card.stats.cache': '缓存 {percent}% · {tokens}',
  'card.stats.context': '上下文 {percent}%',

  // ── Repo picker ─────────────────────────────────────────────────────────
  'card.repo.title': '📚 选择项目',
  'card.repo.pickedTitle': '📚 已选定项目',
  'card.repo.note': '再次运行 /repo 可更换项目。',
  'card.repo.placeholder': '请选择项目…',
  'card.repo.pickerIntro':
    '**选择项目目录** —— 从下拉列表中选择，或使用 `/cd <路径>` 指定自定义目录。',
  'card.repo.pickedBody': '✅ 工作目录已设置为\n\n`{path}`',

  // ── Status markers on the streaming card ────────────────────────────────
  'card.status.line.working': '**… 处理中**',
  'card.status.line.stopping': '**⏹ 正在停止…**',
  'card.status.note.done': '✅ 完成',
  'card.status.note.error': '⚠️ 回复失败',
  'card.status.note.stopped': '⏹ 已停止',
  'card.panel.stopTurn': '⏹ 停止当前回复',
  'card.panel.retryLast': '🔁 重试上次',
  'card.panel.copyLast': '📋 复制上次',

  // ── Row-details card ────────────────────────────────────────────────────
  'card.details.produced': '**📎 产出**',
  'card.details.empty': '_（无已记录的参数或结果）_',
  'card.details.title.steer': '💬 插话',
  'card.details.title.think': '☁️ 思考',
  'card.details.title.tool': '🔧 {name}',
  'card.details.emptySteered': '_（空的插话内容）_',
  'card.details.noReasoning': '_（无思考文本）_',

  // ── Shared "currently selected" note + multi-select mark ────────────────
  'card.currentNote': '★ 当前：{label}',
  'card.question.selectedOption': '✅ {label}',
  'card.question.answeredNote': '回答：{answer}',

  // ── Inbound file receipt card ───────────────────────────────────────────
  'card.file.receivedTitle': '📎 收到文件',
  'card.file.tellUnsaved': '**{name}**\n\n告诉我如何处理它。',
  'card.file.tellSaved': '**{name}**\n\n已保存到 `{path}` —— 告诉我如何处理它。',
  'card.file.pending': '**{count} 个文件等待你的指示。**',

  // ── Status card (/status) ───────────────────────────────────────────────
  'card.status.title': '📊 dsh-feishu 状态',
  'card.status.app': '**应用:** `{appId}`',
  'card.status.connection': '**连接:** {state}',
  'card.status.sessions': '**会话数:** {count}',
  'card.status.lastInbound': '**最近消息:** {time}',
  'card.status.never': '从未',
  'card.status.conn.ready': '✅ 正常',
  'card.status.conn.reconnecting': '⚠️ 重连中',
  'card.status.conn.error': '❌ 错误',
  'card.status.conn.memory': '🧪 内存（测试传输）',
  'card.status.conn.unknown': '❓ 未知',

  // ── Approval / question interaction cards ───────────────────────────────
  'card.approval.neededTitle': '🔐 需要批准',
  'card.approval.allowOnce': '✅ 允许一次',
  'card.approval.reject': '❌ 拒绝',
  'card.approval.doneTitle': '🔐 批准',
  'card.question.title': '❓ 提问',
  'card.question.freeTextHint': '没有可选项 —— 请直接以消息形式回复你的答案。',
  'card.question.cancel': '✖ 取消',
  'card.question.submit': '✅ 提交',

  // ── Message-queue card ──────────────────────────────────────────────────
  'card.queue.remove': '🗑️ 移除',
  'card.queue.editPlaceholder': '编辑排队文本',
  'card.queue.submit': '✏️ 提交',
  'card.queue.cancel': '↩️ 取消',
  'card.queue.steerButton': '➡️ 插话',
  'card.queue.steerUnavailable': '➡️ 无法插话 —— 当前没有正在运行的回复。',
  'card.queue.title.editing': '编辑中',
  'card.queue.title.steering': '插话中…',
  'card.queue.title.steered': '已插话',
  'card.queue.title.sent': '已发送',
  'card.queue.title.removed': '已移除',
  'card.queue.marker.steering': '💬 插话中…',
  'card.queue.marker.steered': '✅ 已插话',
  'card.queue.marker.sent': '📤 已发送',
  'card.queue.marker.removed': '🗑️ 已移除',

  // ── Sessions (list, detail, ages, badges) ───────────────────────────────
  'sessions.list.intro': '**已保存的会话** —— 选择一个查看详情并操作。',
  'sessions.list.archivedIntro': '**已归档的会话** —— 选择一个查看并恢复。',
  'sessions.list.toggleArchived': '🗄️ 归档列表',
  'sessions.list.toggleActive': '◀️ 进行中的会话',
  'sessions.list.find': '🔎 查找会话',
  'sessions.list.title': '🗂️ 会话管理',
  'sessions.list.placeholder': '请选择会话…',
  'sessions.list.empty': '还没有会话 —— 发送一条消息开始第一个会话。',
  'sessions.list.emptyArchived': '没有已归档的会话。',
  'sessions.list.moreFiltered': '还有 {count} 个 —— 使用 🔎 查找会话 定位它们。',
  'sessions.list.noMatch': '没有匹配 `{query}` 的会话 —— 请尝试会话 id 或标题的一部分。',
  'sessions.age.justNow': '刚刚',
  'sessions.age.minutes': '{count} 分钟前',
  'sessions.age.hours': '{count} 小时前',
  'sessions.age.days': '{count} 天前',
  'sessions.badge.current': '★ 当前',
  'sessions.badge.currentMark': '★',
  'sessions.badge.liveMark': '●',
  'sessions.badge.live': '● 存活',
  'sessions.badge.saved': '💾 已保存',
  'sessions.detail.title': '🗂️ 会话管理',
  'sessions.detail.cwd': '工作目录：`{cwd}`',
  'sessions.detail.cwdNone': '工作目录：—',
  'sessions.detail.created': '创建于：{age}',
  'sessions.detail.createdNone': '创建于：—',
  'sessions.detail.messages': '消息数：{count}',
  'sessions.detail.lastAnswer': '**上一个回答**',
  'sessions.action.resume': '▶️ 继续会话',
  'sessions.action.rename': '✏️ 重命名',
  'sessions.action.archive': '🗄️ 归档',
  'sessions.action.restore': '♻️ 恢复',
  'sessions.action.export': '📤 导出会话',

  // ── Panel chrome + views ────────────────────────────────────────────────
  'panel.title': '⚙️ dsh-feishu 面板',
  'panel.back': '⬅ 返回',
  'panel.loading': '⏳ 加载中…',
  'panel.operating': '⏳ 处理中…',
  'panel.cardMenu.idle': '**空闲** —— 发送一条消息开始对话。',
  'panel.cardMenu.ready': '**就绪** —— 最新回答在上方卡片中，可复制或重试。',
  'panel.cardMenu.running': '**运行中** —— 有回复正在进行。',
  'panel.cardMenu.stopped': '**已停止** —— 上一次回复被中断。',
  'panel.context.noCwd': '尚未选择工作目录 —— 请先通过 /repo 或 /cd 选择',
  'panel.context.noSession': '还没有会话 · `{cwd}`',
  'panel.context.session': '会话 `{session}` · `{cwd}`',
  'panel.planMode.plan': '🗺️ 计划模式',
  'panel.planMode.leave': '🗺️ 退出计划模式',
  'panel.renderFailedView': '⚠️ 面板视图渲染失败 —— 请查看机器人日志。',
  'panel.renderFailedCard': '⚠️ 面板卡片无法显示 —— 请查看机器人日志。',

  'panel.permission.title': '🔐 权限预设',
  'panel.permission.placeholder': '请选择预设…',
  'panel.permission.noneConfigured': '当前部署未配置权限预设。',
  'panel.permission.noneSelected': '尚未选择预设。',
  'panel.permission.serviceUnavailable': '权限预设在此部署上不可用。',
  'panel.permission.intro': '**选择权限预设** —— 决定该聊天会话的沙箱模式与审批策略。',
  'panel.model.title': '🤖 模型',
  'panel.model.placeholder': '请选择模型…',
  'panel.model.noneConfigured': '当前部署没有可用模型 —— 使用 /model <provider>/<model> 设置一个。',
  'panel.model.noneSelected': '尚未选择模型。',
  'panel.model.intro': '**选择模型** —— 选择会立即切换当前会话的模型，并保存为新会话的默认值。',
  'panel.category.session': '🧩 会话',
  'panel.category.chat': '💬 聊天',
  'panel.category.system': '⚙️ 系统',
  'panel.view.unknownSession': '（未知）',
  'panel.input.fallback.title': '✏️ 输入',
  'panel.input.fallback.hint': '请输入内容。',
  'panel.input.fallback.placeholder': '值',
  'panel.input.fallback.submit': '提交',
  'panel.confirm.fallback.title': '⚠️ 确认',
  'panel.confirm.fallback.message': '继续吗？',
  'panel.confirm.fallback.submit': '确认',

  // ── Panel input sub-view copy (per command) ─────────────────────────────
  'command.input.cd.title': '📁 更改工作目录',
  'command.input.cd.hint': '发送项目的绝对路径（或以 `~` 开头）。',
  'command.input.cd.placeholder': '例如 /home/user/projects/demo',
  'command.input.cd.submit': '设置目录',
  'command.input.group.title': '👥 新建群组',
  'command.input.group.hint': '发送要创建并加入的群组名称。',
  'command.input.group.placeholder': '例如 我的团队',
  'command.input.group.submit': '创建群组',
  'command.input.goal.title': '🎯 目标',
  'command.input.goal.hint': '发送当前任务的目标描述。',
  'command.input.goal.placeholder': '例如 修复构建',
  'command.input.goal.submit': '设置目标',
  'command.input.feedback.title': '💬 反馈',
  'command.input.feedback.hint': '发送你的反馈内容。',
  'command.input.feedback.placeholder': '输入反馈…',
  'command.input.feedback.submit': '发送反馈',
  'command.input.rename-session.title': '✏️ 重命名会话',
  'command.input.rename-session.hint': '发送该会话的新标题。',
  'command.input.rename-session.placeholder': '新标题',
  'command.input.rename-session.submit': '重命名',
  'command.input.find-session.title': '🔎 查找会话',
  'command.input.find-session.hint': '发送会话 id 或标题的一部分来过滤列表。',
  'command.input.find-session.placeholder': '例如 feishu-session-1 或 "旧项目"',
  'command.input.find-session.submit': '查找',

  // ── Panel confirm sub-view copy (per command) ───────────────────────────
  'command.confirm.clear.title': '✨ 新对话',
  'command.confirm.clear.message':
    '开始一个新的对话？之前的会话仍会保留（可通过 /sessions 继续）。',
  'command.confirm.clear.submit': '开始新对话',
  'command.confirm.compact.title': '🧹 压缩',
  'command.confirm.compact.message': '将较早的对话历史压缩成摘要？压缩期间该聊天不可用。',
  'command.confirm.compact.submit': '立即压缩',

  // ── Surface command button labels (registry-facing descriptions stay EN) ─
  'command.cmd.panel.label': '⚙️ 面板',
  'command.cmd.help.label': '❓ 帮助',
  'command.cmd.log.label': '📄 导出日志',
  'command.cmd.group.label': '👥 新建群组',
  'command.cmd.cancel.label': '⏹ 停止回复',
  'command.cmd.cd.label': '📁 更改目录',
  'command.cmd.repo.label': '📚 选择项目',
  'command.cmd.status.label': '📊 会话状态',
  'command.cmd.feishuStatus.label': '📡 插件状态',
  'command.cmd.schedule.label': '⏰ 提醒',
  'command.cmd.model.label': '🤖 模型',
  'command.cmd.export.label': '📤 导出会话',
  'command.cmd.sessions.label': '🗂️ 会话管理',
  'command.cmd.resume.label': '↩️ 继续会话',
  'command.cmd.clear.label': '✨ 新对话',
  'command.cmd.new.label': '➕ 新聊天',
  'command.cmd.permission.label': '🔐 权限',
  'command.cmd.compact.label': '🧹 压缩',
  'command.cmd.plan.label': '🗺️ 计划模式',
  'command.cmd.goal.label': '🎯 目标',
  'command.cmd.feedback.label': '💬 反馈',

  // ── /help 渲染（命令的用户可见描述；注册表的 description 字段按设计保持英文）──
  'command.help.title': 'dsh-feishu 命令：',
  'command.help.hint':
    '不带参数的命令会打开选择/输入卡片（与面板按钮一致）；其余斜杠命令若存在于 dsh 注册表中则透传。',
  'command.help.help': '列出所有界面命令',
  'command.help.panel': '打开控制面板卡片（所有命令以按钮形式展示）',
  'command.help.log': '将 dsh-feishu 日志文件发送到此聊天',
  'command.help.group': '创建包含你和机器人的群聊',
  'command.help.cancel': '停止当前回复',
  'command.help.cd': '设置本聊天的工作目录（会话将在此重启）',
  'command.help.repo': '选择项目目录（不带参数扫描默认根；/repo <路径> 扫描该路径）',
  'command.help.status': '显示本聊天的会话状态',
  'command.help.feishuStatus': '显示界面诊断卡片（连接、会话、活动）',
  'command.help.schedule': '列出本聊天的活跃提醒',
  'command.help.model':
    '切换本会话的模型（不带参数打开选择器）；/model <provider>/<model> 直接切换',
  'command.help.export': '将本聊天的会话日志导出为文件',
  'command.help.sessions': '列出已保存的会话并在此聊天中操作',
  'command.help.resume': '继续一个已保存的会话（不带参数打开会话列表选择）',
  'command.help.clear': '开始全新的对话（之前的会话保持已保存）',
  'command.help.new': '开始新对话（/clear 的别名）',
  'command.help.goal': '设置或查看长期任务的目标',
  'command.help.compact': '压缩较早的对话历史',
  'command.help.feedback': '发送反馈',
  'command.help.permission': '切换权限预设 —— 沙箱模式 + 审批策略',
  'command.help.plan': '进入或退出计划模式（不带参数切换；/plan on|off 显式设置）',

  // ── /status 文本报告（status 命令的文本输出）──────────────────────────
  'command.status.chat': '聊天：{id}',
  'command.status.session': '会话：{id}',
  'command.status.sessionNone': '（还没有）',
  'command.status.agent': '代理：{state}',
  'command.status.agentLive': '运行中',
  'command.status.agentIdle': '空闲',
  'command.status.lastOutput': '最后输出：{summary}',
  'command.status.lastOutputNone': '（无）',
  'command.status.lastOutputChars': '{count} 字符',
  'command.status.mentionMode': '提及模式：{mode}',
  'command.status.mention.always': '总是',
  'command.status.mention.never': '从不',
  'command.status.mention.ambient': '环境',
  'command.status.mention.topic': '话题',

  // ── /schedule 报告 ─────────────────────────────────────────────────────
  'command.schedule.title': '活跃提醒：',
  'command.schedule.rule.after': '{seconds} 秒后',
  'command.schedule.rule.at': '于 {at}',
  'command.schedule.rule.every': '每 {seconds} 秒',

  // ── Command / panel-action feedback ─────────────────────────────────────
  'command.result.stopped': '已停止。',
  'command.info.newConversation': '已开始新对话 —— 之前的会话仍保留；可用 /sessions 继续它。',
  'command.info.noReminders': '暂无提醒 —— 让代理创建一个（如“5 分钟后提醒我”）。',
  'command.error.noSessionStop': '没有活跃会话可停止。',
  'command.error.noSession': '还没有会话 —— 请先发送一条消息。',
  'command.error.turnRunning': '有回复正在运行 —— 请先停止它。',
  'command.error.turnRunningShort': '⚠️ 有回复正在运行 —— 请先停止它。',
  'command.error.nothingToClear': '无可清除内容 —— 该聊天还没有会话。',
  'command.error.scheduleUnavailable': '无法列出提醒 —— 未挂载会话查询服务。',
  'command.error.scheduleFallback': '无法列出提醒 —— 请让代理代为查询提醒。',
  'command.error.modelSelectionUnavailable': '无模型选择信息 —— 未挂载 agentDefaultModel 服务。',
  'command.error.modelSwitchUnavailable': '无法切换模型 —— 未挂载 agentDefaultModel 服务。',
  'command.error.exportNoSession': '尚无可导出的会话 —— 请先发送一条消息。',
  'command.error.exportUnavailable': '无法导出会话 —— 未挂载会话查询服务。',
  'panel.action.renameUnavailable': '当前部署不支持重命名会话。',
  'panel.action.sessionNotLoaded': '该会话无法加载 —— 请先继续它再重命名。',
  'panel.action.invalidProjectPick': '无效的项目选择。',
  'panel.action.permissionPickUnavailable':
    '无法选择权限预设 —— 机器人可能已重启。请重新发送 /permission。',
  'panel.action.modelPickUnavailable': '无法选择模型 —— 未挂载 agentDefaultModel 服务。',
  'panel.action.archiveUnavailable': '当前部署不支持归档会话。',
  'panel.action.sessionRenamed': '会话 {sessionId} 已重命名。',
  'panel.action.sessionArchived': '会话 {sessionId} 已归档。',
  'panel.action.renameFailed': '重命名失败：{message}',
  'panel.action.archiveFailed': '归档失败：{message}',
  'panel.action.permissionSwitchFailed': '无法切换到预设 {preset}：{detail}',

  // ── 权限预设显示名（服务暴露的是原始 id）───────────────────────────────
  'preset.readOnly': '只读',
  'preset.workspaceWrite': '工作区可写',
  'preset.dangerFullAccess': '完全访问',
  'preset.custom': '自定义',

  // ── Streaming controller feedback (stop/retry/copy/compact/reminder) ────
  'controller.info.nothingToRetry': '没有可重试的内容',
  'controller.info.nothingToRetryHint': '没有可重试的回复 —— 请先发送一条消息。',
  'controller.info.nothingToCopy': '没有可复制的回答 —— 回答尚未生成。',
  'controller.error.noTurnToStop': '没有可停止的回复 —— 上一次回复已经结束。',
  'controller.error.noSessionToStop':
    '没有可停止的会话 —— 机器人可能已重启。请发送一条消息重新开始。',
  'controller.error.turnRunning': '有回复正在运行 —— 请先停止它。',
  'controller.info.compacting': '🧹 压缩中…',
  'controller.error.compactionFailed': '⚠️ 压缩失败。',
  'controller.error.compactionFailedDetails': '⚠️ 压缩失败 —— 详情见卡片',
  'controller.reminder.title': '⏰ 提醒',
  'controller.reminder.pluginNotification': '⏰ {plugin} 通知',
  'controller.error.logSendFailed': '⚠️ 无法发送 dsh-feishu 日志（{message}）。',

  // ── Approval card bodies + decision outcomes ────────────────────────────
  'card.approval.wantRunPlain': '**{tool}** 想要执行。',
  'card.approval.wantRunReason': '**{tool}** 想要执行：\n\n{reason}',
  'card.approval.outcome.allowedOnce': '✅ 已允许一次',
  'card.approval.outcome.rejected': '❌ 已拒绝',
  'card.approval.outcome.unavailable': '⚠️ 不可用',
  'card.approval.outcome.cancelled': '⏹ 已取消',

  // ── Command / surface info feedback ─────────────────────────────────────
  'command.info.exportedEvents': '已导出 {count} 条事件到 {file}。',
  'command.info.logSent': '已发送 dsh-feishu 日志（{count} 字节）。',
  'command.info.groupCreated': '群组已创建：{name}（{chatId}）',
  'command.info.modelSet': '模型已设为 {selection}（当前会话 + 默认值）。',
  'command.info.permissionSwitched': '权限预设已切换为 {preset}。',
  'command.info.cwdSetRestart': '工作目录已设为 {path}（下一条消息将重启会话）。',
  'command.info.planOn': '计划模式已开启。使用 /plan off 关闭。',
  'command.info.planOff': '计划模式已关闭。',
  'command.info.planEnterNextStep': '正在进入计划模式（下一步生效）。使用 /plan off 关闭。',
  'command.info.planLeaveNextStep': '正在退出计划模式（下一步生效）。',
  'command.info.planAlreadyActive': '计划模式已经开启。',
  'command.info.planAlreadyInactive': '计划模式已经关闭。',
  'command.info.planEntryCancelled': '已取消进入计划模式。',
  'command.info.modelLine': '模型：{selection}{effort}',
  'command.error.cmdUnavailableDeployment': '/{name} 在当前部署上不可用。',
  'command.error.cmdUnavailableRegistry': '/{name} 不可用 —— 未挂载 dsh 命令注册表。',
  'command.error.exportFailed': '会话导出失败：{detail}',
  'command.error.groupCreateFailed': '群组创建失败：{detail}',
  'command.error.logSendFailedDetail': '无法发送 dsh-feishu 日志：{detail}',
  'resume.error.sessionBusy': '会话 {sessionId} 已在该聊天中激活。',
  'resume.error.sessionTurnRunning': '会话 {sessionId} 有回复正在运行 —— 请先在其聊天中停止。',

  // ── /status display placeholders ────────────────────────────────────────
  'status.none': '（无）',
  'status.notConfigured': '（未配置）',
  'status.noPrompt': '（无目标）',
  'status.effortSuffix': ' · 推理力度 {effort}',

  // ── Result card chrome ──────────────────────────────────────────────────
  'result.doneTitle': '✅ 完成',
  'result.failedTitle': '⚠️ 操作失败',

  // ── Gates + inbound notices (bridge) ────────────────────────────────────
  'gate.workingDirRequired':
    '⚠️ 尚未选择工作目录 —— 在选择之前 DSH 不会在这里开工。' +
    '发送 /repo 选择项目，或发送 /cd <路径> 设置目录。',
  'resume.success': '已继续会话 {sessionId} —— 发送一条消息即可继续。',
  'resume.noCwdHint': ' 该聊天还没有工作目录 —— 请在发送消息前用 /repo 或 /cd 选择。',
  'inbound.unsupportedType': '⚠️ 我还不能处理 `{type}` 类型的消息。',
  'inbound.unavailableUploadScope':
    ' —— 飞书应用需要 im:resource:upload 权限范围（开发者控制台 → 权限）。',
  'inbound.folderNote': ' API 无法下载文件夹内容 —— 请改为逐个发送文件或打包成 zip 归档。',
  'command.unknown': '未知命令 {line} —— 发送 /help 查看命令列表。',
  'queue.alreadyConsumed': '⚠️ 那条排队的消息已被处理。',

  // ── Turn errors (streaming) ─────────────────────────────────────────────
  'error.turnFailed': '⚠️ 回复失败：{error}',
  'error.unknown': '未知错误',
  'error.unspecified': '该次回复因未指明的错误而失败。',
};
