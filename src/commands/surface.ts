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
  readonly buttonLabel: string;
}> = [
  {
    name: 'goal',
    description: 'Set or view the goal for a long-running task (dsh web)',
    buttonLabel: '🎯 Goal',
  },
  {
    name: 'compact',
    description: 'Compact older conversation history (dsh web)',
    buttonLabel: '🧹 Compact',
  },
  {
    name: 'feedback',
    description: 'Send feedback (dsh web)',
    buttonLabel: '💬 Feedback',
  },
];

/** Mirror the harness /plan command's outcome wording for a toggle. */
export function planModeResultText(
  target: boolean,
  outcome: 'committed' | 'queued' | 'cancelled' | 'noop',
): string {
  switch (outcome) {
    case 'committed':
      return target ? 'Plan mode on. Use /plan off to leave.' : 'Plan mode off.';
    case 'queued':
      return target
        ? 'Entering plan mode (applies from the next step). Use /plan off to leave.'
        : 'Leaving plan mode (applies from the next step).';
    case 'cancelled':
      return 'Plan mode entry cancelled.';
    case 'noop':
      return target ? 'Plan mode is already active.' : 'Plan mode is already inactive.';
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
      text: `/${name} is unavailable — the dsh command registry is not mounted.`,
    };
  }
  const agent = await host.ensureAgent(invocation.chatId);
  const result = await host.executeCommand(agent, `/${name}${invocation.rawInput}`);
  if (result !== undefined) return result;
  return { kind: 'error', text: `/${name} is unavailable on this deployment.` };
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
    buttonLabel: '❓ Help',
    handler: () => {
      const lines = commands
        .list()
        .map((command) => `/${command.name} — ${command.description}`)
        .join('\n');
      return {
        kind: 'success',
        text: `dsh-feishu commands:\n${lines}\n\nOther slash lines are forwarded to dsh when they exist in its registry.`,
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
    name: 'group',
    description: 'Create a group chat with you and the bot',
    category: 'chat',
    buttonLabel: '👥 New group',
    handler: async (invocation) => {
      const name = invocation.rawInput.trim() || 'dsh-feishu';
      try {
        const { chatId } = await options.transport.createGroup(name, [invocation.senderOpenId]);
        return { kind: 'success', text: `Group created: ${name} (${chatId})` };
      } catch (error: unknown) {
        return { kind: 'error', text: `group creation failed: ${String(error)}` };
      }
    },
  });
  commands.register({
    name: 'cancel',
    description: 'Stop the current turn',
    category: 'session',
    buttonLabel: '⏹ Stop turn',
    handler: (invocation) => {
      const sessionId = options.sessionMap.get(invocation.chatId);
      const agent = sessionId === undefined ? undefined : options.agentStore.get(sessionId);
      if (agent !== undefined) {
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        return { kind: 'success', text: 'Stopped.' };
      }
      return { kind: 'error', text: 'no active session to stop.' };
    },
  });
  commands.register({
    name: 'cd',
    description: 'Set this chat\u2019s working directory (session restarts in it)',
    category: 'session',
    buttonLabel: '📁 Change dir',
    handler: async (invocation) => {
      const target = invocation.rawInput.trim();
      if (target === '') {
        return { kind: 'error', text: 'usage: /cd <absolute-or-~ path>' };
      }
      const resolved = resolveDirectory(target);
      if (!resolved.ok) return { kind: 'error', text: resolved.error };
      options.sessionMap.setCwd(invocation.chatId, resolved.path);
      // A live session keeps its old cwd; rebind so the next message starts
      // a fresh session in the new directory (mirrors botmux /cd).
      options.sessionMap.remint(invocation.chatId);
      return {
        kind: 'success',
        text: `Working directory set to ${resolved.path} (session restarts on your next message).`,
      };
    },
  });
  commands.register({
    name: 'repo',
    description: 'List candidate project directories (from repoRoots)',
    category: 'session',
    buttonLabel: '📚 Pick project',
    handler: async (invocation) => {
      // Direct path selection stays supported: /repo <abs-path>.
      const raw = invocation.rawInput.trim();
      if (raw.startsWith('/') || raw.startsWith('~')) {
        const resolved = resolveDirectory(raw);
        if (!resolved.ok) return { kind: 'error', text: resolved.error };
        options.sessionMap.setCwd(invocation.chatId, resolved.path);
        options.sessionMap.remint(invocation.chatId);
        return {
          kind: 'success',
          text: `Working directory set to ${resolved.path} (session restarts on your next message).`,
        };
      }
      // The picker renders INSIDE the panel state machine (single card).
      await options.pushPanel(invocation.chatId, { kind: 'picker', picker: 'repo', page: 0 });
      return { kind: 'success', text: '' };
    },
  });
  commands.register({
    name: 'status',
    description: 'Show this chat’s session status',
    category: 'system',
    buttonLabel: '📊 Status',
    handler: (invocation) => {
      const sessionId = options.sessionMap.get(invocation.chatId);
      const agent = sessionId === undefined ? undefined : options.agentStore.get(sessionId);
      const output = options.lastOutput(invocation.chatId);
      const lines = [
        `chat: ${invocation.chatId}`,
        `session: ${sessionId ?? '(none yet)'}`,
        `agent: ${agent !== undefined ? 'live' : 'idle'}`,
        `last output: ${output === undefined ? '(none)' : `${output.length} chars`}`,
        `mention mode: ${options.groupMentionMode ?? 'always'}`,
      ];
      return { kind: 'success', text: lines.join('\n') };
    },
  });
  commands.register({
    name: 'feishu-status',
    description: 'Show the surface diagnostic card (connection, sessions, activity)',
    category: 'system',
    buttonLabel: '📡 Surface status',
    handler: async (invocation) => {
      const raw = options.transport.connectionState?.();
      const connection: StatusView['connection'] =
        options.transportMode === 'memory' ? 'memory' : (raw ?? 'unknown');
      await options.transport.sendCard(
        invocation.chatId,
        buildStatusCard({
          appId: options.appId ?? '(not configured)',
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
    buttonLabel: '⏰ Reminders',
    handler: async (invocation) => {
      const sessionId = options.sessionMap.get(invocation.chatId);
      if (sessionId === undefined) {
        return { kind: 'error', text: 'no session yet — send a message first.' };
      }
      if (options.readSession === undefined) {
        return {
          kind: 'error',
          text: 'schedule listing unavailable — the session query service is not mounted.',
        };
      }
      try {
        const { foldScheduleEvents, scheduleView } = await import('@deepseek-ai/dsh-schedule');
        const log = await options.readSession(sessionId);
        const folded = foldScheduleEvents(log.events as never);
        if (folded.active.length === 0) {
          return {
            kind: 'success',
            text: 'No active reminders — ask the agent to create one (e.g. “remind me in 5 minutes”).',
          };
        }
        const now = Date.now();
        const lines = folded.active.map((record) => {
          const view = scheduleView(record, now);
          const prompt = record.prompt === '' ? '(no prompt)' : record.prompt;
          const rule =
            record.kind === 'after'
              ? `after ${record.afterSeconds}s`
              : record.kind === 'at'
                ? `at ${record.scheduledAt}`
                : `every ${record.everySeconds}s`;
          return `${rule} · ${prompt} (${view.state})`;
        });
        return { kind: 'success', text: `Active reminders:\n${lines.join('\n')}` };
      } catch (error: unknown) {
        options.logger.warn(`schedule listing unavailable: ${String(error)}`);
        return {
          kind: 'error',
          text: 'schedule listing unavailable — ask the agent to list reminders instead.',
        };
      }
    },
  });
  commands.register({
    name: 'model',
    description:
      'Choose a model (opens the picker); or /model <provider>/<model> to set the default',
    category: 'system',
    buttonLabel: '🤖 Model',
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
            text: 'no model selection available — the agentDefaultModel service is not mounted.',
          };
        }
        const effort =
          selection.reasoningEffort === undefined ? '' : ` · effort ${selection.reasoningEffort}`;
        return {
          kind: 'success',
          text: `model: ${selection.provider} · ${selection.model}${effort}`,
        };
      }
      const parsed = parseModelArg(raw);
      if (!parsed.ok) return { kind: 'error', text: parsed.error };
      const service = options.agentDefaultModel;
      if (service === undefined) {
        return {
          kind: 'error',
          text: 'model switching unavailable — the agentDefaultModel service is not mounted.',
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
        text: `Model set to ${parsed.selection.provider} · ${parsed.selection.model} (this session + default).`,
      };
    },
  });
  commands.register({
    name: 'export',
    description: 'Export this chat’s session log as a file',
    category: 'system',
    buttonLabel: '📤 Export',
    handler: async (invocation) => {
      const sessionId = options.sessionMap.get(invocation.chatId);
      if (sessionId === undefined) {
        return { kind: 'error', text: 'no session to export yet — send a message first.' };
      }
      if (options.readSession === undefined) {
        return {
          kind: 'error',
          text: 'session export unavailable — the session query service is not mounted.',
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
          text: `Exported ${log.events.length} events to ${fileName}.`,
        };
      } catch (error: unknown) {
        options.logger.warn(`session export failed: ${String(error)}`);
        const detail = String(error);
        const scopeHint = detail.includes('im:resource')
          ? ' — the Feishu app needs the im:resource:upload permission scope (developer console → Permissions).'
          : '';
        return { kind: 'error', text: `session export failed: ${detail}${scopeHint}` };
      }
    },
  });
  commands.register({
    name: 'sessions',
    description: 'List saved sessions and act on one in this chat',
    category: 'session',
    buttonLabel: '🗂️ Sessions',
    handler: async (invocation) => {
      // The panel state machine owns the session list/detail flow.
      await options.pushPanel(invocation.chatId, { kind: 'sessions', archived: false });
      return { kind: 'success', text: '' };
    },
  });
  commands.register({
    name: 'resume',
    description: 'Resume a saved session (no id opens the session list)',
    category: 'session',
    buttonLabel: '↩️ Resume session',
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
      return { kind: 'error', text: 'a turn is running — stop it first.' };
    }
    if (options.sessionMap.get(invocation.chatId) === undefined) {
      return { kind: 'error', text: 'nothing to clear — this chat has no session yet.' };
    }
    options.sessionMap.remint(invocation.chatId);
    options.resetChat(invocation.chatId);
    return {
      kind: 'success',
      text: 'New conversation started — the previous session stays saved; /sessions can resume it.',
    };
  };
  commands.register({
    name: 'clear',
    description: 'Start a fresh conversation (previous session stays saved)',
    category: 'session',
    buttonLabel: '✨ Fresh start',
    // /new IS the panel button; /clear stays a slash-only alias (the two
    // commands are the same action — duplicate buttons confuse (user report)).
    hiddenFromPanel: true,
    handler: startFresh,
  });
  commands.register({
    name: 'new',
    description: 'Start a new conversation (alias of /clear)',
    category: 'session',
    buttonLabel: '➕ New chat',
    handler: startFresh,
  });
  for (const spec of HARNESS_COMMANDS) {
    commands.register({
      name: spec.name,
      description: spec.description,
      category: 'system',
      buttonLabel: spec.buttonLabel,
      handler: async (invocation) => {
        if (options.isWorking(invocation.chatId)) {
          return { kind: 'error', text: 'a turn is running — stop it first.' };
        }
        if (options.executeCommand === undefined) {
          return {
            kind: 'error',
            text: `/${spec.name} is unavailable — the dsh command registry is not mounted.`,
          };
        }
        const agent = await options.ensureAgent(invocation.chatId);
        const result = await options.executeCommand(agent, `/${spec.name}${invocation.rawInput}`);
        if (result !== undefined) return result;
        return {
          kind: 'error',
          text: `/${spec.name} is unavailable on this deployment.`,
        };
      },
    });
  }
  // /permission: typed presets pass through to the harness command; a bare
  // /permission (or the panel button) opens the preset picker card so the
  // user can actually choose — the bare harness command only reports.
  commands.register({
    name: 'permission',
    description: 'Switch the permission preset — sandbox mode + approval policy (dsh web)',
    category: 'system',
    buttonLabel: '🔐 Permission',
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim();
      if (raw !== '') return runHarnessCommand(options, invocation, 'permission');
      if (options.isWorking(invocation.chatId)) {
        return { kind: 'error', text: 'a turn is running — stop it first.' };
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
    description: 'Enter or leave plan mode (dsh web)',
    category: 'system',
    buttonLabel: '🗺️ Plan mode',
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim();
      if (raw !== '') return runHarnessCommand(options, invocation, 'plan');
      if (options.isWorking(invocation.chatId)) {
        return { kind: 'error', text: 'a turn is running — stop it first.' };
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
      const target = !(state.pending ?? state.active);
      const outcome = planMode.set(agent, target);
      return { kind: 'success', text: planModeResultText(target, outcome) };
    },
  });
}
