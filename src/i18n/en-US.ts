/**
 * The `en-US` catalog — the BASE locale and the source of truth for message
 * keys. Every other catalog is typed against these keys (`Record<MessageKey,
 * string>`), so adding a key here without translating it fails typecheck,
 * and a key present only in another catalog fails typecheck too.
 *
 * Conventions (`docs/development.md` → "Internationalization"):
 * - Flat dot-namespaced keys mirroring ownership: `card.*`, `panel.*`,
 *   `sessions.*`, `command.*`, `gate.*`, `error.*`.
 * - Emojis live INSIDE values so a locale owns its whole label.
 * - `{name}` tokens are interpolated parameters; every token in a value must
 *   be passed by the caller (enforced by test).
 *
 * @module @dsh-feishu/dsh-feishu/i18n/en-US
 */

export const enMessages = {
  // Shared fragments.
  'common.untitled': '(untitled)',

  // ── Streaming card buttons + pagination chrome ──────────────────────────
  'card.button.stopTurn': '⏹ Stop turn',
  'card.button.copy': '📋 Copy',
  'card.button.retry': '🔁 Retry',
  'card.button.panel': '⚙️ Panel',
  'card.button.expand': '▸ Expand',
  'card.button.collapse': '▾ Collapse',
  'card.button.exportLog': '📄 Export log',
  'card.page.prev': '‹ Prev',
  'card.page.next': 'Next ›',
  'card.page.prevFull': '◀️ Prev',
  'card.page.nextFull': 'Next ▶️',

  // ── Card rows + stats line ──────────────────────────────────────────────
  'card.row.thinking': '☁️ Think · Thinking',
  'card.row.steerLine': '💬 Steer · {preview}',
  'card.sequence.think': 'think',
  'card.sequence.steer': 'steer',
  'card.stats.turns': '{count} turns',
  'card.stats.steps': '{count} steps',
  'card.stats.tools': '{count} tools',
  'card.stats.tokens': 'input {input} · output {output}',
  'card.stats.cache': 'cache {percent}% · {tokens}',
  'card.stats.context': 'context {percent}%',

  // ── Repo picker ─────────────────────────────────────────────────────────
  'card.repo.title': '📚 Pick a project',
  'card.repo.pickedTitle': '📚 Project picked',
  'card.repo.note': 'Run /repo again to change it.',
  'card.repo.placeholder': 'Choose a project…',
  'card.repo.pickerIntro':
    '**Pick a project directory** — choose one from the dropdown, or use `/cd <path>` for a custom directory.',
  'card.repo.pickedBody': '✅ Working directory set to\n\n`{path}`',

  // ── Status markers on the streaming card + panel core buttons ───────────
  'card.status.line.working': '**… working**',
  'card.status.line.stopping': '**⏹ Stopping…**',
  'card.status.note.done': '✅ Done',
  'card.status.note.error': '⚠️ Turn failed',
  'card.status.note.stopped': '⏹ Stopped',
  'card.panel.stopTurn': '⏹ Stop current turn',
  'card.panel.retryLast': '🔁 Retry last',
  'card.panel.copyLast': '📋 Copy last',

  // ── Row-details card ────────────────────────────────────────────────────
  'card.details.produced': '**📎 Produced**',
  'card.details.empty': '_(no recorded args or result)_',
  'card.details.title.steer': '💬 Steer',
  'card.details.title.think': '☁️ Think',
  'card.details.title.tool': '🔧 {name}',
  'card.details.emptySteered': '_(empty steered message)_',
  'card.details.noReasoning': '_(no reasoning text)_',

  // ── Shared "currently selected" note + multi-select mark ────────────────
  'card.currentNote': '★ current: {label}',
  'card.question.selectedOption': '✅ {label}',
  'card.question.answeredNote': 'Answer: {answer}',

  // ── Inbound file receipt card ───────────────────────────────────────────
  'card.file.receivedTitle': '📎 File received',
  'card.file.tellUnsaved': '**{name}**\n\nTell me what to do with it.',
  'card.file.tellSaved': '**{name}**\n\nSaved to `{path}` — tell me what to do with it.',
  'card.file.pending': '**{count} files awaiting your instruction.**',

  // ── Status card (/status) ───────────────────────────────────────────────
  'card.status.title': '📊 dsh-feishu status',
  'card.status.app': '**app:** `{appId}`',
  'card.status.connection': '**connection:** {state}',
  'card.status.sessions': '**sessions:** {count}',
  'card.status.lastInbound': '**last inbound:** {time}',
  'card.status.never': 'never',
  'card.status.conn.ready': '✅ ready',
  'card.status.conn.reconnecting': '⚠️ reconnecting',
  'card.status.conn.error': '❌ error',
  'card.status.conn.memory': '🧪 memory (test transport)',
  'card.status.conn.unknown': '❓ unknown',

  // ── Approval / question interaction cards ───────────────────────────────
  'card.approval.neededTitle': '🔐 Approval needed',
  'card.approval.allowOnce': '✅ Allow once',
  'card.approval.reject': '❌ Reject',
  'card.approval.doneTitle': '🔐 Approval',
  'card.approval.wantRunPlain': '**{tool}** wants to run.',
  'card.approval.wantRunReason': '**{tool}** wants to run:\n\n{reason}',
  'card.approval.outcome.allowedOnce': '✅ Allowed once',
  'card.approval.outcome.rejected': '❌ Rejected',
  'card.approval.outcome.unavailable': '⚠️ Unavailable',
  'card.approval.outcome.cancelled': '⏹ Cancelled',
  'card.question.title': '❓ Question',
  'card.question.freeTextHint': 'Reply with your answer as a message — no options to pick from.',
  'card.question.cancel': '✖ Cancel',
  'card.question.submit': '✅ Submit',

  // ── Message-queue card ──────────────────────────────────────────────────
  'card.queue.remove': '🗑️ Remove',
  'card.queue.editPlaceholder': 'Edit queued text',
  'card.queue.submit': '✏️ Submit',
  'card.queue.cancel': '↩️ Cancel',
  'card.queue.steerButton': '➡️ Steer',
  'card.queue.steerUnavailable': '➡️ Steer unavailable — no turn is running.',
  'card.queue.nQueued': '{count} queued',
  'card.queue.title.editing': 'Editing',
  'card.queue.title.steering': 'Steering…',
  'card.queue.title.steered': 'Steered',
  'card.queue.title.sent': 'Sent',
  'card.queue.title.removed': 'Removed',
  'card.queue.marker.steering': '💬 Steering…',
  'card.queue.marker.steered': '✅ Steered',
  'card.queue.marker.sent': '📤 Sent',
  'card.queue.marker.removed': '🗑️ Removed',

  // ── Sessions (list, detail, ages, badges) ───────────────────────────────
  'sessions.list.intro': '**Saved sessions** — pick one to view details and act on it.',
  'sessions.list.archivedIntro': '**Archived sessions** — pick one to view and restore.',
  'sessions.list.toggleArchived': '🗄️ Archived',
  'sessions.list.toggleActive': '◀️ Active sessions',
  'sessions.list.find': '🔎 Find session',
  'sessions.list.title': '🗂️ Sessions',
  'sessions.list.placeholder': 'Choose a session…',
  'sessions.list.empty': 'No sessions yet — send a message to start the first one.',
  'sessions.list.emptyArchived': 'No archived sessions.',
  'sessions.list.moreFiltered': '{count} more — use 🔎 Find session to reach any of them.',
  'sessions.list.noMatch': 'No session matches `{query}` — try the id or part of the title.',
  'sessions.age.justNow': 'just now',
  'sessions.age.minutes': '{count}m ago',
  'sessions.age.hours': '{count}h ago',
  'sessions.age.days': '{count}d ago',
  'sessions.badge.current': '★ current',
  'sessions.badge.currentMark': '★',
  'sessions.badge.liveMark': '●',
  'sessions.badge.live': '● live',
  'sessions.badge.saved': '💾 saved',
  'sessions.detail.title': '🗂️ Session',
  'sessions.detail.cwd': 'cwd: `{cwd}`',
  'sessions.detail.cwdNone': 'cwd: —',
  'sessions.detail.created': 'created: {age}',
  'sessions.detail.createdNone': 'created: —',
  'sessions.detail.messages': 'messages: {count}',
  'sessions.detail.lastAnswer': '**Last answer**',
  'sessions.action.resume': '▶️ Resume',
  'sessions.action.rename': '✏️ Rename',
  'sessions.action.archive': '🗄️ Archive',
  'sessions.action.restore': '♻️ Restore',
  'sessions.action.export': '📤 Export',

  // ── Panel chrome + views ────────────────────────────────────────────────
  'panel.title': '⚙️ dsh-feishu panel',
  'panel.back': '⬅ Back',
  'panel.loading': '⏳ Loading…',
  'panel.operating': '⏳ Operating…',
  'panel.cardMenu.idle': '**Idle** — send a message to start a turn.',
  'panel.cardMenu.ready': '**Ready** — the last answer is in the card above; copy or retry it.',
  'panel.cardMenu.running': '**Running** — a turn is in progress.',
  'panel.cardMenu.stopped': '**Stopped** — the last turn was interrupted.',
  'panel.context.noCwd': 'No working directory — pick one with /repo or /cd first',
  'panel.context.noSession': 'No session yet · `{cwd}`',
  'panel.context.session': 'session `{session}` · `{cwd}`',
  'panel.planMode.plan': '🗺️ Plan mode',
  'panel.planMode.leave': '🗺️ Leave plan mode',
  'panel.renderFailedView': '⚠️ The panel view could not be rendered — see the bot log.',
  'panel.renderFailedCard': '⚠️ The panel card could not be displayed — see the bot log.',

  'panel.permission.title': '🔐 Permission presets',
  'panel.permission.placeholder': 'Choose a preset…',
  'panel.permission.noneConfigured': 'No presets configured on this deployment.',
  'panel.permission.noneSelected': 'No preset selected yet.',
  'panel.permission.serviceUnavailable': 'Permission presets are unavailable on this deployment.',
  'panel.permission.intro':
    '**Choose a permission preset** — sandbox mode + approval policy for this chat’s session.',
  'panel.model.title': '🤖 Model',
  'panel.model.placeholder': 'Choose a model…',
  'panel.model.noneConfigured':
    'No models available on this deployment — use /model <provider>/<model> to set one.',
  'panel.model.noneSelected': 'No model selected yet.',
  'panel.model.intro':
    '**Choose a model** — the pick switches THIS session’s model immediately and saves the default for new sessions.',
  'panel.category.session': '🧩 Session',
  'panel.category.chat': '💬 Chat',
  'panel.category.system': '⚙️ System',
  'panel.view.unknownSession': '(unknown)',
  'panel.input.fallback.title': '✏️ Input',
  'panel.input.fallback.hint': 'Enter a value.',
  'panel.input.fallback.placeholder': 'Value',
  'panel.input.fallback.submit': 'Submit',
  'panel.confirm.fallback.title': '⚠️ Confirm',
  'panel.confirm.fallback.message': 'Continue?',
  'panel.confirm.fallback.submit': 'Confirm',

  // ── Panel input sub-view copy (per command) ─────────────────────────────
  'command.input.cd.title': '📁 Change working directory',
  'command.input.cd.hint': 'Send the absolute (or `~`) path to the project directory.',
  'command.input.cd.placeholder': 'e.g. /home/user/projects/demo',
  'command.input.cd.submit': 'Set directory',
  'command.input.group.title': '👥 New group',
  'command.input.group.hint': 'Send the group name to create and join.',
  'command.input.group.placeholder': 'e.g. my team',
  'command.input.group.submit': 'Create group',
  'command.input.goal.title': '🎯 Goal',
  'command.input.goal.hint': 'Send the goal text for the ongoing task.',
  'command.input.goal.placeholder': 'e.g. fix the build',
  'command.input.goal.submit': 'Set goal',
  'command.input.feedback.title': '💬 Feedback',
  'command.input.feedback.hint': 'Send your feedback text.',
  'command.input.feedback.placeholder': 'Type feedback…',
  'command.input.feedback.submit': 'Send feedback',
  'command.input.rename-session.title': '✏️ Rename session',
  'command.input.rename-session.hint': 'Send the new title for this session.',
  'command.input.rename-session.placeholder': 'New title',
  'command.input.rename-session.submit': 'Rename',
  'command.input.find-session.title': '🔎 Find session',
  'command.input.find-session.hint': 'Send a session id or part of its title to filter the list.',
  'command.input.find-session.placeholder': 'e.g. feishu-session-1 or "old project"',
  'command.input.find-session.submit': 'Find',

  // ── Panel confirm sub-view copy (per command) ───────────────────────────
  'command.confirm.clear.title': '✨ New chat',
  'command.confirm.clear.message':
    'Start a NEW conversation? The previous session stays saved (resumable via /sessions).',
  'command.confirm.clear.submit': 'Start new chat',
  'command.confirm.compact.title': '🧹 Compact',
  'command.confirm.compact.message':
    'Compact older conversation history into a summary? The chat is unavailable while it runs.',
  'command.confirm.compact.submit': 'Compact now',

  // ── Surface command button labels (registry-facing descriptions stay EN) ─
  'command.cmd.panel.label': '⚙️ Panel',
  'command.cmd.help.label': '❓ Help',
  'command.cmd.log.label': '📄 Export log',
  'command.cmd.group.label': '👥 New group',
  'command.cmd.cancel.label': '⏹ Stop turn',
  'command.cmd.cd.label': '📁 Change dir',
  'command.cmd.repo.label': '📚 Pick project',
  'command.cmd.status.label': '📊 Status',
  'command.cmd.feishuStatus.label': '📡 Surface status',
  'command.cmd.schedule.label': '⏰ Reminders',
  'command.cmd.model.label': '🤖 Model',
  'command.cmd.export.label': '📤 Export',
  'command.cmd.sessions.label': '🗂️ Sessions',
  'command.cmd.resume.label': '↩️ Resume session',
  'command.cmd.clear.label': '✨ Fresh start',
  'command.cmd.new.label': '➕ New chat',
  'command.cmd.permission.label': '🔐 Permission',

  // ── Command / panel-action feedback ─────────────────────────────────────
  'command.result.stopped': 'Stopped.',
  'command.info.newConversation':
    'New conversation started — the previous session stays saved; /sessions can resume it.',
  'command.info.noReminders':
    'No active reminders — ask the agent to create one (e.g. “remind me in 5 minutes”).',
  'command.info.exportedEvents': 'Exported {count} events to {file}.',
  'command.info.logSent': 'Sent the dsh-feishu log ({count} bytes).',
  'command.info.groupCreated': 'Group created: {name} ({chatId})',
  'command.info.modelSet': 'Model set to {selection} (this session + default).',
  'command.info.permissionSwitched': 'Permission preset switched to {preset}.',
  'command.info.cwdSetRestart':
    'Working directory set to {path} (session restarts on your next message).',
  'command.info.planOn': 'Plan mode on. Use /plan off to leave.',
  'command.info.planOff': 'Plan mode off.',
  'command.info.planEnterNextStep':
    'Entering plan mode (applies from the next step). Use /plan off to leave.',
  'command.info.planLeaveNextStep': 'Leaving plan mode (applies from the next step).',
  'command.info.planAlreadyActive': 'Plan mode is already active.',
  'command.info.planAlreadyInactive': 'Plan mode is already inactive.',
  'command.info.planEntryCancelled': 'Plan mode entry cancelled.',
  'command.error.noSessionStop': 'no active session to stop.',
  'command.error.noSession': 'no session yet — send a message first.',
  'command.error.turnRunning': 'a turn is running — stop it first.',
  'command.error.turnRunningShort': '⚠️ a turn is running — stop it first.',
  'command.error.nothingToClear': 'nothing to clear — this chat has no session yet.',
  'command.error.cmdUnavailableDeployment': '/{name} is unavailable on this deployment.',
  'command.error.cmdUnavailableRegistry':
    '/{name} is unavailable — the dsh command registry is not mounted.',
  'command.error.scheduleUnavailable':
    'schedule listing unavailable — the session query service is not mounted.',
  'command.error.scheduleFallback':
    'schedule listing unavailable — ask the agent to list reminders instead.',
  'command.error.modelSelectionUnavailable':
    'no model selection available — the agentDefaultModel service is not mounted.',
  'command.error.modelSwitchUnavailable':
    'model switching unavailable — the agentDefaultModel service is not mounted.',
  'command.error.exportNoSession': 'no session to export yet — send a message first.',
  'command.error.exportUnavailable':
    'session export unavailable — the session query service is not mounted.',
  'command.error.exportFailed': 'session export failed: {detail}',
  'resume.error.sessionBusy': 'Session {sessionId} is already active in this chat.',
  'resume.error.sessionTurnRunning':
    'Session {sessionId} has an active turn — stop it in its chat first.',
  'panel.action.renameUnavailable': 'Renaming sessions is unavailable on this deployment.',
  'panel.action.sessionNotLoaded': 'This session could not be loaded — resume it before renaming.',
  'panel.action.invalidProjectPick': 'Invalid project selection.',
  'panel.action.permissionPickUnavailable':
    'Permission pick unavailable — the bot may have restarted. Send /permission again.',
  'panel.action.modelPickUnavailable':
    'Model pick unavailable — the agentDefaultModel service is not mounted.',
  'panel.action.archiveUnavailable': 'Archiving sessions is unavailable on this deployment.',
  'panel.action.sessionRenamed': 'Renamed session {sessionId}.',
  'panel.action.sessionArchived': 'Archived session {sessionId}.',
  'panel.action.renameFailed': 'Rename failed: {message}',
  'panel.action.archiveFailed': 'Archiving failed: {message}',

  // ── Streaming controller feedback (stop/retry/copy/compact/reminder) ────
  'controller.info.nothingToRetry': 'Nothing to retry',
  'controller.info.nothingToRetryHint': 'Nothing to retry — send a message first.',
  'controller.info.nothingToCopy': 'Nothing to copy — no completed answer yet.',
  'controller.error.noTurnToStop': 'No active turn to stop — the last turn already finished.',
  'controller.error.noSessionToStop':
    'No active session to stop — the bot may have restarted. Send a message to start fresh.',
  'controller.error.turnRunning': 'a turn is running — stop it first.',
  'controller.info.compacting': '🧹 Compacting…',
  'controller.error.compactionFailed': '⚠️ Compaction failed.',
  'controller.error.compactionFailedDetails': '⚠️ Compaction failed — see the card for details',
  'controller.reminder.title': '⏰ Reminder',
  'controller.reminder.pluginNotification': '⏰ {plugin} notification',
  'controller.error.logSendFailed': '⚠️ Could not send the dsh-feishu log ({message}).',

  // ── Result card chrome ──────────────────────────────────────────────────
  'result.doneTitle': '✅ Done',
  'result.failedTitle': '⚠️ Action failed',

  // ── Gates + inbound notices (bridge) ────────────────────────────────────
  'gate.workingDirRequired':
    '⚠️ No working directory chosen yet — DSH won’t start work here until you pick one. ' +
    'Send /repo to choose a project, or /cd <path> to set a directory.',
  'resume.success': 'Resumed session {sessionId} — send a message to continue it.',
  'resume.noCwdHint':
    ' This chat has no working directory — pick one with /repo or /cd before sending a message.',
  'inbound.unsupportedType': '⚠️ I can’t process messages of type `{type}` yet.',
  'inbound.unavailableUploadScope':
    ' — the Feishu app needs the im:resource:upload permission scope (developer console → Permissions).',
  'inbound.folderNote':
    ' Folder contents cannot be downloaded via the API — please send the files individually or as a zip archive instead.',
  'command.unknown': 'Unknown command {line} — send /help to list commands.',
  'queue.alreadyConsumed': '⚠️ That queued message was already consumed.',

  // ── /status display placeholders ────────────────────────────────────────
  'status.none': '(none)',
  'status.notConfigured': '(not configured)',
  'status.noPrompt': '(no prompt)',
  'status.effortSuffix': ' · effort {effort}',

  // ── Turn errors (streaming) ─────────────────────────────────────────────
  'error.turnFailed': '⚠️ Turn failed: {error}',
  'error.unknown': 'unknown error',
  'error.unspecified': 'The turn failed with an unspecified error.',
} as const;
