/**
 * Surface command registration: the plugin-owned slash commands (and their
 * panel buttons) behind a host seam.
 *
 * Every command declares a button label and category so the control panel
 * can render the full command set as buttons; the button and the slash line
 * execute the same handler. The Bridge implements {@link SurfaceCommandHost};
 * this module owns the command COPY and the harness passthrough, so the
 * Bridge's command block shrinks to one registration call.
 *
 * @module @dsh-feishu/dsh-feishu/commands/surface
 */

import type { Agent } from '@deepseek-ai/dsh-agent';
import type {
  AgentDefaultModelService,
  AgentStore,
  BridgeLogger,
  LlmService,
  ModelSelectionView,
  PermissionPresetService,
  PlanModeService,
  SessionListRow,
} from '../bridge.js';
import type { StatusView } from '../cards/render.js';
import { buildStatusCard } from '../cards/render.js';
import type { CommandInvocation, CommandRegistry, CommandResult } from '../commands.js';
import { resolveDirectory } from '../directory.js';
import type { FeishuTransport } from '../feishu/types.js';
import { type MessageKey, t } from '../i18n/index.js';
import { parseModelArg } from '../model-args.js';
import { applySessionModelSwitch, sessionSelection } from '../model-switch.js';
import type { PanelView } from '../panel/types.js';
import { buildSessionExport, type SessionExportEvent } from '../session-export.js';
import type { SessionMap } from '../session-map.js';

/**
 * Surface-wrapped dsh web commands (mounted by dsh-base's command rows):
 * thin handlers that ensure an agent, then execute the dsh registry command
 * with the same arguments — the Feishu surface covers the web command set
 * in-chat, buttons included. `/export` is intentionally absent: it is a
 * Web-only command whose handler a browser download plugin observes.
 *
 * `/plan` and `/permission` are handled bespoke (state-aware): a bare
 * `/plan` toggles plan mode instead of only entering it, and `/permission`
 * opens a preset picker card instead of only reporting the current preset —
 * a button press must be able to actually choose/switch (user report).
 */
const HARNESS_COMMANDS: ReadonlyArray<{
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  /** A catalog key, resolved to a label AT REGISTRATION TIME (never at
   *  module load — a module-level `t()` freezes the pre-`apply()` locale). */
  readonly buttonLabelKey: MessageKey;
}> = [
  {
    name: 'goal',
    description: 'Set or view the goal for a long-running task',
    usage: '<text>',
    buttonLabelKey: 'command.cmd.goal.label',
  },
  {
    name: 'compact',
    description: 'Compact older conversation history',
    buttonLabelKey: 'command.confirm.compact.title',
  },
  {
    name: 'feedback',
    description: 'Send feedback',
    usage: '<text>',
    buttonLabelKey: 'command.cmd.feedback.label',
  },
];

/**
 * Surface command name → its localized `/help` description key. The
 * registry-facing `description` fields stay English (contract text); `/help`
 * renders the localized copy instead. Unknown names (not ours) fall back to
 * the English description.
 */
const COMMAND_HELP_KEYS: Readonly<Record<string, MessageKey>> = {
  help: 'command.help.help',
  panel: 'command.help.panel',
  log: 'command.help.log',
  group: 'command.help.group',
  cancel: 'command.help.cancel',
  cd: 'command.help.cd',
  repo: 'command.help.repo',
  status: 'command.help.status',
  'feishu-status': 'command.help.feishuStatus',
  schedule: 'command.help.schedule',
  model: 'command.help.model',
  export: 'command.help.export',
  sessions: 'command.help.sessions',
  resume: 'command.help.resume',
  clear: 'command.help.clear',
  new: 'command.help.new',
  goal: 'command.help.goal',
  compact: 'command.help.compact',
  feedback: 'command.help.feedback',
  permission: 'command.help.permission',
  plan: 'command.help.plan',
};

/** Mirror the harness /plan command's outcome wording for a toggle. */
export function planModeResultText(
  target: boolean,
  outcome: 'committed' | 'queued' | 'cancelled' | 'noop',
): string {
  switch (outcome) {
    case 'committed':
      return target ? t('command.info.planOn') : t('command.info.planOff');
    case 'queued':
      return target ? t('command.info.planEnterNextStep') : t('command.info.planLeaveNextStep');
    case 'cancelled':
      return t('command.info.planEntryCancelled');
    case 'noop':
      return target ? t('command.info.planAlreadyActive') : t('command.info.planAlreadyInactive');
  }
}

/**
 * What the surface command set needs from the rest of the surface. The
 * Bridge implements this; the command module never touches Bridge internals
 * directly (structural types avoid a circular import).
 */
export interface SurfaceCommandHost {
  readonly transport: FeishuTransport;
  readonly sessionMap: SessionMap;
  readonly agentStore: AgentStore;
  readonly logger: BridgeLogger;
  readonly executeCommand:
    | ((agent: Agent, line: string) => Promise<CommandResult | undefined>)
    | undefined;
  readonly readSession:
    | ((sessionId: string) => Promise<{
        readonly session: { readonly id: string };
        readonly events: readonly SessionExportEvent[];
      }>)
    | undefined;
  readonly permissionPresets: PermissionPresetService | undefined;
  readonly planMode: PlanModeService | undefined;
  readonly agentDefaultModel: AgentDefaultModelService | undefined;
  readonly llm: LlmService | undefined;
  readonly listSessions: (() => Promise<readonly SessionListRow[] | undefined>) | undefined;
  readonly groupMentionMode: 'always' | 'never' | 'ambient' | 'topic' | undefined;
  readonly appId: string | undefined;
  readonly transportMode: 'lark' | 'memory' | undefined;
  readonly unknownCommand: 'error' | 'passthrough' | undefined;
  /** Epoch ms of the last accepted inbound message (for /feishu-status). */
  readonly lastInboundAt: number | undefined;
  /** Open the control panel (the /panel command). */
  openPanel(chatId: string): Promise<string>;
  /** PUSH a panel sub-view (pickers / sessions list). */
  pushPanel(chatId: string, view: PanelView): Promise<void>;
  /** Ensure a live agent exists for the chat (harness passthrough). */
  ensureAgent(chatId: string): Promise<Agent>;
  /** The shared /resume flow (slash line and /sessions Resume button). */
  resumeSession(chatId: string, sessionId: string, cwd?: string): Promise<CommandResult>;
  /** Whether a turn is running (the working-state gate). */
  isWorking(chatId: string): boolean;
  /** Reset a chat's card state (/clear and /resume). */
  resetChat(chatId: string): void;
  /** The chat's last completed output, or `undefined`. */
  lastOutput(chatId: string): string | undefined;
  /** The live agent for a chat, or `undefined`. */
  liveAgent(chatId: string): Agent | undefined;
  /** Read the dsh-feishu log and ship it to the chat (`/log` + error-card button). */
  sendLog(chatId: string): Promise<CommandResult>;
}

/**
 * Execute one harness command through the dsh registry (shared by the
 * web-command wrappers): ensure an agent, run the line, map the result.
 */
export async function runHarnessCommand(
  host: SurfaceCommandHost,
  invocation: { readonly chatId: string; readonly rawInput: string },
  name: string,
): Promise<CommandResult> {
  if (host.executeCommand === undefined) {
    return {
      kind: 'error',
      text: t('command.error.cmdUnavailableRegistry', { name }),
    };
  }
  const agent = await host.ensureAgent(invocation.chatId);
  const result = await host.executeCommand(agent, `/${name}${invocation.rawInput}`);
  if (result !== undefined) return result;
  return { kind: 'error', text: t('command.error.cmdUnavailableDeployment', { name }) };
}

/** Localize a group-mention mode id for the /status report. */
function mentionModeLabel(mode: 'always' | 'never' | 'ambient' | 'topic' | undefined): string {
  switch (mode) {
    case 'always':
      return t('command.status.mention.always');
    case 'never':
      return t('command.status.mention.never');
    case 'ambient':
      return t('command.status.mention.ambient');
    case 'topic':
      return t('command.status.mention.topic');
    default:
      return t('command.status.mention.always');
  }
}

/**
 * Register the built-in surface commands.
 * @param commands - the surface command registry.
 * @param host - the surface seam (Bridge implements it).
 */
export function registerSurfaceCommands(commands: CommandRegistry, host: SurfaceCommandHost): void {
  const options = host;
  commands.register({
    name: 'help',
    description: 'List all surface commands',
    category: 'system',
    buttonLabel: t('command.cmd.help.label'),
    handler: () => {
      const lines = commands
        .list()
        .map((command) => {
          const helpKey = COMMAND_HELP_KEYS[command.name];
          return `/${command.name}${command.usage === undefined ? '' : ` ${command.usage}`} — ${
            helpKey === undefined ? command.description : t(helpKey)
          }`;
        })
        .join('\n');
      return {
        kind: 'success',
        text: `${t('command.help.title')}\n${lines}\n\n${t('command.help.hint')}`,
      };
    },
  });
  commands.register({
    name: 'panel',
    description: 'Open the control panel card (all commands as buttons)',
    category: 'system',
    hiddenFromPanel: true,
    handler: async (invocation) => {
      await options.openPanel(invocation.chatId);
      return { kind: 'success', text: '' };
    },
  });
  commands.register({
    name: 'log',
    description: 'Send the dsh-feishu log file to this chat',
    category: 'system',
    buttonLabel: t('card.button.exportLog'),
    handler: (invocation) => options.sendLog(invocation.chatId),
  });
  commands.register({
    name: 'group',
    description: 'Create a group chat with you and the bot',
    usage: '<name>',
    category: 'chat',
    buttonLabel: t('command.cmd.group.label'),
    handler: async (invocation) => {
      // A bare /group opens the same text-input card as the panel's "New
      // group" button (the user types the group name); /group <name> creates
      // it directly.
      if (invocation.rawInput.trim() === '') {
        await options.pushPanel(invocation.chatId, { kind: 'input', command: 'group' });
        return { kind: 'success', text: '' };
      }
      const name = invocation.rawInput.trim() || 'dsh-feishu';
      try {
        const { chatId } = await options.transport.createGroup(name, [invocation.senderOpenId]);
        return { kind: 'success', text: t('command.info.groupCreated', { name, chatId }) };
      } catch (error: unknown) {
        return {
          kind: 'error',
          text: t('command.error.groupCreateFailed', { detail: String(error) }),
        };
      }
    },
  });
  commands.register({
    name: 'cancel',
    description: 'Stop the current turn',
    category: 'session',
    buttonLabel: t('card.button.stopTurn'),
    handler: (invocation) => {
      const sessionId = options.sessionMap.get(invocation.chatId);
      const agent = sessionId === undefined ? undefined : options.agentStore.get(sessionId);
      if (agent !== undefined) {
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        return { kind: 'success', text: t('command.result.stopped') };
      }
      return { kind: 'error', text: t('command.error.noSessionStop') };
    },
  });
  commands.register({
    name: 'cd',
    description: 'Set this chat\u2019s working directory (session restarts in it)',
    usage: '<path>',
    category: 'session',
    buttonLabel: t('command.cmd.cd.label'),
    handler: async (invocation) => {
      const target = invocation.rawInput.trim();
      if (target === '') {
        // Consistency: a bare /cd opens the same text-input card the panel's
        // "Change dir" button shows (the user types the absolute path).
        await options.pushPanel(invocation.chatId, { kind: 'input', command: 'cd' });
        return { kind: 'success', text: '' };
      }
      const resolved = resolveDirectory(target);
      if (!resolved.ok) return { kind: 'error', text: resolved.error };
      options.sessionMap.setCwd(invocation.chatId, resolved.path);
      // A live session keeps its old cwd; rebind so the next message starts
      // a fresh session in the new directory (mirrors botmux /cd).
      options.sessionMap.remint(invocation.chatId);
      return {
        kind: 'success',
        text: t('command.info.cwdSetRestart', { path: resolved.path }),
      };
    },
  });
  commands.register({
    name: 'repo',
    description:
      'Pick a project directory (bare scans the default roots; /repo <path> scans that path)',
    usage: '[path]',
    category: 'session',
    buttonLabel: t('command.cmd.repo.label'),
    handler: async (invocation) => {
      // /repo ALWAYS opens the picker card (the only command whose arg form
      // does too). `/repo <path>` scans that path as the repo root; bare uses
      // the deployment's default repoRoots. It never sets the cwd — use /cd
      // for that (that's the distinction between the two).
      const raw = invocation.rawInput.trim();
      let roots: readonly string[] | undefined;
      if (raw !== '') {
        const resolved = resolveDirectory(raw);
        if (!resolved.ok) return { kind: 'error', text: resolved.error };
        roots = [resolved.path];
      }
      await options.pushPanel(invocation.chatId, {
        kind: 'picker',
        picker: 'repo',
        page: 0,
        ...(roots === undefined ? {} : { roots }),
      });
      return { kind: 'success', text: '' };
    },
  });
  commands.register({
    name: 'status',
    description: 'Show this chat’s session status',
    category: 'system',
    buttonLabel: t('command.cmd.status.label'),
    handler: (invocation) => {
      const sessionId = options.sessionMap.get(invocation.chatId);
      const agent = sessionId === undefined ? undefined : options.agentStore.get(sessionId);
      const output = options.lastOutput(invocation.chatId);
      const lines = [
        t('command.status.chat', { id: invocation.chatId }),
        t('command.status.session', {
          id: sessionId === undefined ? t('command.status.sessionNone') : sessionId,
        }),
        t('command.status.agent', {
          state:
            agent !== undefined ? t('command.status.agentLive') : t('command.status.agentIdle'),
        }),
        t('command.status.lastOutput', {
          summary:
            output === undefined
              ? t('command.status.lastOutputNone')
              : t('command.status.lastOutputChars', { count: output.length }),
        }),
        t('command.status.mentionMode', { mode: mentionModeLabel(options.groupMentionMode) }),
      ];
      return { kind: 'success', text: lines.join('\n') };
    },
  });
  commands.register({
    name: 'feishu-status',
    description: 'Show the surface diagnostic card (connection, sessions, activity)',
    category: 'system',
    buttonLabel: t('command.cmd.feishuStatus.label'),
    handler: async (invocation) => {
      const raw = options.transport.connectionState?.();
      const connection: StatusView['connection'] =
        options.transportMode === 'memory' ? 'memory' : (raw ?? 'unknown');
      await options.transport.sendCard(
        invocation.chatId,
        buildStatusCard({
          appId: options.appId ?? t('status.notConfigured'),
          connection,
          sessionCount: options.sessionMap.size,
          lastInboundAt: options.lastInboundAt,
        }),
      );
      return { kind: 'success', text: '' };
    },
  });
  // /schedule: list this chat's active reminders. The dsh-schedule package
  // is optional at runtime — dynamic import + loud degradation (the agent
  // itself can list reminders through its schedule tools when the surface
  // cannot).
  commands.register({
    name: 'schedule',
    description: 'List active reminders for this chat',
    category: 'system',
    buttonLabel: t('command.cmd.schedule.label'),
    handler: async (invocation) => {
      const sessionId = options.sessionMap.get(invocation.chatId);
      if (sessionId === undefined) {
        return { kind: 'error', text: t('command.error.noSession') };
      }
      if (options.readSession === undefined) {
        return {
          kind: 'error',
          text: t('command.error.scheduleUnavailable'),
        };
      }
      try {
        const { foldScheduleEvents, scheduleView } = await import('@deepseek-ai/dsh-schedule');
        const log = await options.readSession(sessionId);
        const folded = foldScheduleEvents(log.events as never);
        if (folded.active.length === 0) {
          return {
            kind: 'success',
            text: t('command.info.noReminders'),
          };
        }
        const now = Date.now();
        const lines = folded.active.map((record) => {
          const view = scheduleView(record, now);
          const prompt = record.prompt === '' ? t('status.noPrompt') : record.prompt;
          const rule =
            record.kind === 'after'
              ? t('command.schedule.rule.after', { seconds: record.afterSeconds })
              : record.kind === 'at'
                ? t('command.schedule.rule.at', { at: record.scheduledAt })
                : t('command.schedule.rule.every', { seconds: record.everySeconds });
          return `${rule} · ${prompt} (${view.state})`;
        });
        return { kind: 'success', text: `${t('command.schedule.title')}\n${lines.join('\n')}` };
      } catch (error: unknown) {
        options.logger.warn(`schedule listing unavailable: ${String(error)}`);
        return {
          kind: 'error',
          text: t('command.error.scheduleFallback'),
        };
      }
    },
  });
  commands.register({
    name: 'model',
    description:
      'Switch this session\u2019s model (bare opens the picker); /model <provider>/<model> switches directly',
    usage: '<provider/model>',
    category: 'system',
    buttonLabel: t('panel.model.title'),
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim();
      if (raw === '') {
        if (options.llm !== undefined) {
          // A bare /model (or the panel button) opens the picker INSIDE
          // the panel state machine.
          await options.pushPanel(invocation.chatId, { kind: 'picker', picker: 'model', page: 0 });
          return { kind: 'success', text: '' };
        }
        // No catalog: fall back to the text display. The session-switched model
        // (via /model, dsh web parity) wins over the live agent's static
        // options (which a switch does NOT mutate); otherwise the deployment
        // default.
        const live = options.liveAgent(invocation.chatId);
        const switched = sessionSelection(live?.ctx)?.current;
        const liveSelection =
          switched !== undefined
            ? { provider: switched.provider, model: switched.model }
            : live !== undefined &&
                live.options?.provider !== undefined &&
                live.options?.model !== undefined
              ? { provider: live.options.provider, model: live.options.model }
              : undefined;
        const selection: ModelSelectionView | undefined =
          liveSelection ?? options.agentDefaultModel?.currentSelection();
        if (selection === undefined) {
          return {
            kind: 'error',
            text: t('command.error.modelSelectionUnavailable'),
          };
        }
        const effort =
          selection.reasoningEffort === undefined
            ? ''
            : t('status.effortSuffix', { effort: selection.reasoningEffort });
        return {
          kind: 'success',
          text: t('command.info.modelLine', {
            selection: `${selection.provider} · ${selection.model}`,
            effort,
          }),
        };
      }
      const parsed = parseModelArg(raw);
      if (!parsed.ok) return { kind: 'error', text: parsed.error };
      const service = options.agentDefaultModel;
      if (service === undefined) {
        return {
          kind: 'error',
          text: t('command.error.modelSwitchUnavailable'),
        };
      }
      await service.saveSelection(parsed.selection);
      // (B) switch the CURRENT session immediately, not just the default for
      // future sessions: couple the agent's model selection so the next turn
      // assembles with the new provider/model (dsh web parity).
      applySessionModelSwitch(
        options.liveAgent(invocation.chatId)?.ctx,
        parsed.selection,
        options.logger,
      );
      return {
        kind: 'success',
        text: t('command.info.modelSet', {
          selection: `${parsed.selection.provider} · ${parsed.selection.model}`,
        }),
      };
    },
  });
  commands.register({
    name: 'export',
    description: 'Export this chat’s session log as a file',
    category: 'system',
    buttonLabel: t('sessions.action.export'),
    handler: async (invocation) => {
      const sessionId = options.sessionMap.get(invocation.chatId);
      if (sessionId === undefined) {
        return { kind: 'error', text: t('command.error.exportNoSession') };
      }
      if (options.readSession === undefined) {
        return {
          kind: 'error',
          text: t('command.error.exportUnavailable'),
        };
      }
      try {
        const log = await options.readSession(sessionId);
        const transcript = buildSessionExport(log.events);
        const fileName = `session-${sessionId}.md`;
        await options.transport.sendFile(
          invocation.chatId,
          fileName,
          new TextEncoder().encode(transcript),
        );
        return {
          kind: 'success',
          text: t('command.info.exportedEvents', { count: log.events.length, file: fileName }),
        };
      } catch (error: unknown) {
        options.logger.warn(`session export failed: ${String(error)}`);
        const detail = String(error);
        const scopeHint = detail.includes('im:resource') ? t('inbound.unavailableUploadScope') : '';
        return { kind: 'error', text: t('command.error.exportFailed', { detail }) + scopeHint };
      }
    },
  });
  commands.register({
    name: 'sessions',
    description: 'List saved sessions and act on one in this chat',
    category: 'session',
    buttonLabel: t('sessions.list.title'),
    handler: async (invocation) => {
      // The panel state machine owns the session list/detail flow.
      await options.pushPanel(invocation.chatId, { kind: 'sessions', archived: false });
      return { kind: 'success', text: '' };
    },
  });
  commands.register({
    name: 'resume',
    description: 'Resume a saved session (bare opens the session list to pick one)',
    usage: '<id>',
    category: 'session',
    buttonLabel: t('command.cmd.resume.label'),
    // The Sessions button owns the list/detail flow; a separate resume
    // button is redundant (user report).
    hiddenFromPanel: true,
    handler: async (invocation) => {
      const target = invocation.rawInput.trim();
      if (target === '') {
        await options.pushPanel(invocation.chatId, { kind: 'sessions', archived: false });
        return { kind: 'success', text: '' };
      }
      const result = await options.resumeSession(invocation.chatId, target);
      return result;
    },
  });
  // /clear and /new share one handler: start a fresh conversation. The old
  // session is NOT deleted — it stays saved and resumable (/sessions) — so
  // the reset never destroys user data (content-integrity rule).
  const startFresh = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (options.isWorking(invocation.chatId)) {
      return { kind: 'error', text: t('command.error.turnRunning') };
    }
    if (options.sessionMap.get(invocation.chatId) === undefined) {
      return { kind: 'error', text: t('command.error.nothingToClear') };
    }
    options.sessionMap.remint(invocation.chatId);
    options.resetChat(invocation.chatId);
    return {
      kind: 'success',
      text: t('command.info.newConversation'),
    };
  };
  commands.register({
    name: 'clear',
    description: 'Start a fresh conversation (previous session stays saved)',
    category: 'session',
    buttonLabel: t('command.cmd.clear.label'),
    // /new IS the panel button; /clear stays a slash-only alias (the two
    // commands are the same action — duplicate buttons confuse (user report)).
    hiddenFromPanel: true,
    handler: startFresh,
  });
  commands.register({
    name: 'new',
    description: 'Start a new conversation (alias of /clear)',
    category: 'session',
    buttonLabel: t('command.cmd.new.label'),
    handler: startFresh,
  });
  for (const spec of HARNESS_COMMANDS) {
    commands.register({
      name: spec.name,
      description: spec.description,
      ...(spec.usage === undefined ? {} : { usage: spec.usage }),
      category: 'system',
      buttonLabel: t(spec.buttonLabelKey),
      handler: async (invocation) => {
        // A bare /goal /feedback opens the panel text-input card (matching
        // the panel palette button). /compact stays direct: it is a harness
        // command, and the panel's confirm button also invokes this handler
        // with an empty arg — routing a bare /compact to the confirm view
        // would re-open the confirm view instead of running the compaction.
        if (
          invocation.rawInput.trim() === '' &&
          (spec.name === 'goal' || spec.name === 'feedback')
        ) {
          await options.pushPanel(invocation.chatId, { kind: 'input', command: spec.name });
          return { kind: 'success', text: '' };
        }
        if (options.isWorking(invocation.chatId)) {
          return { kind: 'error', text: t('command.error.turnRunning') };
        }
        if (options.executeCommand === undefined) {
          return {
            kind: 'error',
            text: t('command.error.cmdUnavailableRegistry', { name: spec.name }),
          };
        }
        const agent = await options.ensureAgent(invocation.chatId);
        const result = await options.executeCommand(agent, `/${spec.name}${invocation.rawInput}`);
        if (result !== undefined) return result;
        return {
          kind: 'error',
          text: t('command.error.cmdUnavailableDeployment', { name: spec.name }),
        };
      },
    });
  }
  // /permission: typed presets pass through to the harness command; a bare
  // /permission (or the panel button) opens the preset picker card so the
  // user can actually choose — the bare harness command only reports.
  commands.register({
    name: 'permission',
    description: 'Switch the permission preset — sandbox mode + approval policy',
    usage: '<preset>',
    category: 'system',
    buttonLabel: t('command.cmd.permission.label'),
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim();
      if (raw !== '') return runHarnessCommand(options, invocation, 'permission');
      if (options.isWorking(invocation.chatId)) {
        return { kind: 'error', text: t('command.error.turnRunning') };
      }
      if (options.permissionPresets === undefined) {
        // Degraded: no picker data source — fall back to the harness report.
        options.logger.warn(
          '[feishu] permissionPresets service unavailable; /permission degraded to report',
        );
        return runHarnessCommand(options, invocation, 'permission');
      }
      // The picker renders INSIDE the panel state machine.
      await options.pushPanel(invocation.chatId, {
        kind: 'picker',
        picker: 'permission',
        page: 0,
      });
      return { kind: 'success', text: '' };
    },
  });
  // /plan: `off` and message forms pass through; a bare /plan (or the
  // panel button) TOGGLES plan mode through ctx.planMode — pressing it
  // again leaves plan mode (user report: bare /plan only ever entered).
  commands.register({
    name: 'plan',
    description: 'Enter or leave plan mode (bare toggles; /plan on|off sets it)',
    usage: '[on|off]',
    category: 'system',
    buttonLabel: t('panel.planMode.plan'),
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim();
      // A bare /plan toggles plan mode; /plan on|off sets it explicitly. The
      // surface handles on/off directly — deferring a bare arg to the harness
      // echoed it as a message (the `/plan on` bug). An unrecognized arg still
      // falls back to the harness.
      const explicit = raw === 'on' ? true : raw === 'off' ? false : undefined;
      if (explicit === undefined && raw !== '') {
        return runHarnessCommand(options, invocation, 'plan');
      }
      if (options.isWorking(invocation.chatId)) {
        return { kind: 'error', text: t('command.error.turnRunning') };
      }
      const planMode = options.planMode;
      if (planMode === undefined) {
        // Degraded: no controller — fall back to the harness behavior.
        options.logger.warn(
          '[feishu] planMode service unavailable; bare /plan degraded to harness behavior',
        );
        return runHarnessCommand(options, invocation, 'plan');
      }
      const agent = await options.ensureAgent(invocation.chatId);
      const state = planMode.get(agent);
      const target = explicit ?? !(state.pending ?? state.active);
      const outcome = planMode.set(agent, target);
      return { kind: 'success', text: planModeResultText(target, outcome) };
    },
  });
}
