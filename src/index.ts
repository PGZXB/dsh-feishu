/**
 * @module @dsh-feishu/dsh-feishu
 *
 * Feishu (Lark) as a native DeepSeek Harness (dsh) surface: a Feishu chat
 * maps to a dsh session, the chat bot is the agent's avatar, with streaming
 * cards and slash commands.
 *
 * Core identity: DSH-native — born for dsh, not bridged to it. The surface
 * drives the dsh agent/session layer in-process; the agent never does
 * anything to be seen.
 *
 * Iteration 1: the private-chat loop — inbound messages create a per-chat
 * session, stream back as one live card per turn, and deliver the final
 * answer as a fresh message. Slash commands, group-chat mention routing,
 * approvals, and questions land in later iterations (see PLAN.md).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
// Empty type imports carry the Context merges (`ctx.commands`, `ctx.agents`,
// and the `session/event` event) into this compilation.
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import type { SessionId } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import type { AgentStore } from './bridge.js';
import { Bridge, type BridgeLogger } from './bridge.js';
import { StreamingCardManager } from './cards/streaming.js';
import { consoleExporter } from './console-exporter.js';
import type { FeishuTransport } from './feishu/types.js';
import { SessionMap } from './session-map.js';
import { createLarkTransport } from './transport.js';

/** Stable cordis plugin name (also the bundle row id in cordis.patch.yml). */
export const name = 'feishu';

/** Plugin configuration. */
export interface Config {
  /** Feishu app id; falls back to the `FEISHU_APP_ID` environment variable. */
  readonly appId?: string;
  /** Feishu app secret; falls back to the `FEISHU_APP_SECRET` environment variable. */
  readonly appSecret?: string;
  /** Working directory for sessions created by the bridge (default: the process cwd). */
  readonly defaultCwd?: string;
  /** Directory for durable surface state (session map); default `$DSH_HOME/feishu`. */
  readonly dataDir?: string;
  /** Provider route for created agents (default: the dsh default). */
  readonly provider?: string;
  /** Model for created agents (default: the provider default). */
  readonly model?: string;
  /** Streaming-card patch throttle in ms (default 150). */
  readonly cardThrottleMs?: number;
}

/** Validated plugin configuration (schemastery schema). */
export const Config: z<Config> = z.object({
  appId: z.string().required(false),
  appSecret: z.string().required(false),
  defaultCwd: z.string().required(false),
  dataDir: z.string().required(false),
  provider: z.string().required(false),
  model: z.string().required(false),
  cardThrottleMs: z.natural().min(1).required(false),
});

/** Resolved credentials, or `undefined` when either value is missing. */
export type Credentials = { readonly appId: string; readonly appSecret: string };

/**
 * Resolve credentials from config first, then the environment.
 * @param config - validated plugin config.
 * @returns resolved credentials, or `undefined` when either value is absent.
 */
export function resolveCredentials(config: Config): Credentials | undefined {
  const appId = config.appId ?? process.env.FEISHU_APP_ID;
  const appSecret = config.appSecret ?? process.env.FEISHU_APP_SECRET;
  if (appId === undefined || appSecret === undefined) return undefined;
  return { appId, appSecret };
}

/** The dsh home directory (`$DSH_HOME` or `~/.dsh`). */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** Default directory for durable surface state. */
export function defaultDataDir(): string {
  return join(dshHome(), 'feishu');
}

/** Injectable dependencies so `apply` is unit-testable without a network. */
export interface ApplyDeps {
  /** Transport factory; defaults to the lark-oapi implementation. */
  createTransport?: (credentials: Credentials, logger: BridgeLogger) => FeishuTransport;
}

/**
 * Mount the Feishu surface.
 * @param ctx - plugin context carrying optional DSH services.
 * @param config - validated plugin config.
 * @param deps - injectable dependencies (tests swap the transport).
 */
export function apply(ctx: Context, config: Config, deps: ApplyDeps = {}): void {
  // dsh surfaces mount no console exporter by default; bridge operators need
  // visible logs, so route structured log records to the console (the logger
  // service disposes the exporter with the current fiber).
  ctx.logger.exporter(consoleExporter());
  const credentials = resolveCredentials(config);
  const logger = ctx.logger as unknown as BridgeLogger;
  if (credentials === undefined) {
    ctx.logger.info(
      '[feishu] starting in not-configured mode: set FEISHU_APP_ID / FEISHU_APP_SECRET ' +
        'or the appId/appSecret config keys',
    );
    registerStatusCommand(ctx, () => ({
      kind: 'error',
      text: 'dsh-feishu is not configured: set FEISHU_APP_ID and FEISHU_APP_SECRET.',
    }));
    return;
  }
  ctx.logger.info(`[feishu] starting surface for app ${credentials.appId}`);
  registerStatusCommand(ctx, () => ({
    kind: 'success',
    text: `dsh-feishu is configured for app ${credentials.appId}; bridge running.`,
  }));

  const transportFactory = deps.createTransport ?? createLarkTransport;
  const dataDir = config.dataDir ?? defaultDataDir();
  const sessionMap = new SessionMap(join(dataDir, 'session-map.json'));
  sessionMap.load();
  const transport = transportFactory(credentials, logger);
  const cards = new StreamingCardManager(transport, { throttleMs: config.cardThrottleMs ?? 150 });
  const agentStore: AgentStore = {
    get: (sessionId) => ctx.get('agents')?.get(sessionId as unknown as SessionId),
    create: async (sessionId, cwd) => {
      const agents = ctx.get('agents');
      if (agents === undefined) {
        throw new Error('agents service unavailable; cannot create a session');
      }
      const agentOptions = {
        ...(config.provider !== undefined ? { provider: config.provider } : {}),
        ...(config.model !== undefined ? { model: config.model } : {}),
      };
      const { agent } = await agents.create({
        sessionId: sessionId as unknown as SessionId,
        meta: { cwd },
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      });
      return agent;
    },
  };
  const agentOptions =
    config.provider !== undefined || config.model !== undefined
      ? {
          ...(config.provider !== undefined ? { provider: config.provider } : {}),
          ...(config.model !== undefined ? { model: config.model } : {}),
        }
      : undefined;
  const bridge = new Bridge({
    transport,
    sessionMap,
    agentStore,
    onSessionEvent: (listener) =>
      ctx.on('session/event', (session, event) => {
        listener(session.id, event);
      }),
    cards,
    defaultCwd: config.defaultCwd ?? process.cwd(),
    logger,
    ...(agentOptions !== undefined ? { agentOptions } : {}),
  });
  ctx.effect(() => () => {
    bridge.dispose();
    sessionMap.persist();
  });
  void transport
    .start()
    .then(() => ctx.logger.info('[feishu] bridge ready'))
    .catch((error: unknown) => ctx.logger.error(`[feishu] bridge start failed: ${String(error)}`));
}

/** Register the `feishu-status` diagnostic command when the registry exists. */
function registerStatusCommand(
  ctx: Context,
  status: () => { kind: 'success'; text: string } | { kind: 'error'; text: string },
): void {
  const commands = ctx.get('commands');
  if (commands === undefined) {
    ctx.logger.warn('[feishu] commands service unavailable; slash commands disabled');
    return;
  }
  commands.register({
    name: 'feishu-status',
    description: 'Show the dsh-feishu bridge status',
    handler: () => status(),
  });
}
