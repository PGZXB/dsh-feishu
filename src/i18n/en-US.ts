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

  // ── Row-details card ────────────────────────────────────────────────────
  'card.details.produced': '**📎 Produced**',
  'card.details.empty': '_(no recorded args or result)_',

  // ── Repo picker ─────────────────────────────────────────────────────────
  'card.repo.title': '📚 Pick a project',
  'card.repo.pickedTitle': '📚 Project picked',
  'card.repo.note': 'Run /repo again to change it.',
  'card.repo.placeholder': 'Choose a project…',

  // ── Inbound file receipt card ───────────────────────────────────────────
  'card.file.receivedTitle': '📎 File received',
  'card.file.tellUnsaved': '**{name}**\n\nTell me what to do with it.',
  'card.file.tellSaved': '**{name}**\n\nSaved to `{path}` — tell me what to do with it.',
  'card.file.pending': '**{count} files awaiting your instruction.**',

  // ── Status card (/status) ───────────────────────────────────────────────
  'card.status.title': '📊 dsh-feishu status',
  'card.status.app': '**app:** {appId}',
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
  'sessions.age.justNow': 'just now',
  'sessions.age.minutes': '{count}m ago',
  'sessions.age.hours': '{count}h ago',
  'sessions.age.days': '{count}d ago',
  'sessions.badge.current': '★ current',
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
  'panel.model.title': '🤖 Model',
  'panel.model.placeholder': 'Choose a model…',
  'panel.model.noneConfigured':
    'No models available on this deployment — use /model <provider>/<model> to set one.',
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
  'command.error.noSessionStop': 'no active session to stop.',
  'command.error.noSession': 'no session yet — send a message first.',
  'command.error.turnRunning': 'a turn is running — stop it first.',
  'command.error.turnRunningShort': '⚠️ a turn is running — stop it first.',
  'command.error.nothingToClear': 'nothing to clear — this chat has no session yet.',
  'command.error.scheduleUnavailable':
    'schedule listing unavailable — the session query service is not mounted.',
  'command.error.scheduleFallback': 'schedule listing unavailable — ask the agent to list reminders instead.',
  'command.error.modelSelectionUnavailable':
    'no model selection available — the agentDefaultModel service is not mounted.',
  'command.error.modelSwitchUnavailable':
    'model switching unavailable — the agentDefaultModel service is not mounted.',
  'command.error.exportNoSession': 'no session to export yet — send a message first.',
  'command.error.exportUnavailable': 'session export unavailable — the session query service is not mounted.',
  'panel.action.renameUnavailable': 'Renaming sessions is unavailable on this deployment.',
  'panel.action.sessionNotLoaded': 'This session could not be loaded — resume it before renaming.',
  'panel.action.invalidProjectPick': 'Invalid project selection.',
  'panel.action.permissionPickUnavailable':
    'Permission pick unavailable — the bot may have restarted. Send /permission again.',
  'panel.action.modelPickUnavailable': 'Model pick unavailable — the agentDefaultModel service is not mounted.',
  'panel.action.archiveUnavailable': 'Archiving sessions is unavailable on this deployment.',

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
  'inbound.folderNote':
    ' Folder contents cannot be downloaded via the API — please send the files individually or as a zip archive instead.',
  'command.unknown': 'Unknown command {line} — send /help to list commands.',
  'queue.alreadyConsumed': '⚠️ That queued message was already consumed.',

  // ── Turn errors (streaming) ─────────────────────────────────────────────
  'error.turnFailed': '⚠️ Turn failed: {error}',
  'error.unknown': 'unknown error',
  'error.unspecified': 'The turn failed with an unspecified error.',
} as const;
