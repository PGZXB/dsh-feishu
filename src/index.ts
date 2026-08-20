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
 * approvals, and questions land in later iterations.
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Context } from '@deepseek-ai/cordis';
// Empty type imports carry the Context merges (`ctx.commands`, `ctx.agents`,
// `ctx.credentials`, and the `session/event` event) into this compilation.
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { SessionId } from '@deepseek-ai/dsh-session';
// Carries the `approval/request` event key and `ctx.userQuestions` /
// `ctx.approval` Context merges into this compilation.
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-user-questions';
import z from '@deepseek-ai/schemastery';
import { pickAttachmentFileName } from './attachment-naming.js';
import {
  type AgentDefaultModelService,
  type AgentStore,
  type ApprovalRequestLike,
  type AskQuestionsRequestLike,
  Bridge,
  type BridgeLogger,
  type LlmService,
  type PermissionPresetService,
  type PlanModeService,
  type SessionListRow,
} from './bridge.js';
import { StreamingCardManager } from './cards/streaming.js';
import type { CommandResult } from './commands.js';
import { consoleExporter } from './console-exporter.js';
import type { FeishuTransport } from './feishu/types.js';
import { createMemoryTransport } from './memory-transport.js';
import type { SessionExportEvent } from './session-export.js';
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
  /**
   * Environment variable naming the model API key to promote into the dsh
   * credentials seam at boot (default `DEEPSEEK_API_KEY`). The llm adapter
   * only consults the credentials seam when the service exists (dsh-base
   * mounts it), so an ambient env key must be stored there to be usable.
   */
  readonly apiKeyEnv?: string;
  /**
   * Group mention policy (botmux-compatible): `always` requires an
   * @-mention (relaxed in 1-person-1-bot solo groups); `never` answers every
   * group message; `ambient` answers every message unless it redirects to
   * another member; `topic` behaves like `always` until threads land.
   * Default `always`.
   */
  readonly groupMentionMode?: 'always' | 'never' | 'ambient' | 'topic';
  /**
   * Chat allowlist: when non-empty, only these chat ids are served (anything
   * else is ignored). Empty means all chats are served.
   */
  readonly allowedChats?: string[];
  /**
   * User allowlist: when non-empty, only messages from these sender open ids
   * are served (anything else is ignored, including inside an allowed chat).
   * Note `ou_` open ids are app-scoped. Empty means all users are served.
   */
  readonly allowedUsers?: string[];
  /**
   * Unknown slash-line policy: `error` replies with an unknown-command notice
   * (default); `passthrough` delivers the line to the model as a normal turn.
   */
  readonly unknownCommand?: 'error' | 'passthrough';
  /**
   * Roots scanned by `/repo` (one level deep) for candidate project
   * directories. Empty means `/repo` lists nothing (use `/cd <path>`).
   */
  readonly repoRoots?: string[];
  /**
   * Refuse to start turns until the chat has an explicitly chosen working
   * directory (/repo pick or /cd). Default true — the deployment defaultCwd
   * is never an implicit choice.
   */
  readonly requireWorkingDir?: boolean;
  /**
   * Two-stage reaction ack emojis (received / done / error / stopped).
   * Defaults GoGoGo / DONE / WARN / WARN. Set `received` to '' to disable
   * the ack entirely.
   */
  readonly reactions?: {
    readonly received?: string;
    readonly done?: string;
    readonly error?: string;
    readonly stopped?: string;
  };
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
  apiKeyEnv: z.string().required(false),
  groupMentionMode: z
    .union([z.const('always'), z.const('never'), z.const('ambient'), z.const('topic')])
    .required(false),
  allowedChats: z.array(z.string()).required(false),
  allowedUsers: z.array(z.string()).required(false),
  unknownCommand: z.union([z.const('error'), z.const('passthrough')]).required(false),
  repoRoots: z.array(z.string()).required(false),
  requireWorkingDir: z.boolean().required(false),
  reactions: z
    .object({
      received: z.string().required(false),
      done: z.string().required(false),
      error: z.string().required(false),
      stopped: z.string().required(false),
    })
    .required(false),
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

/**
 * Default transport factory: the lark-oapi implementation, unless the
 * `FEISHU_TRANSPORT=memory` test/demo seam is set — then a file-channel
 * in-memory transport rooted at `FEISHU_MEMORY_DIR` (or the surface data
 * dir) replaces the wire (see memory-transport.ts).
 * @param dataDir - the surface data directory used for the memory channel.
 * @returns the factory selected for this process.
 */

/**
 * Structural subsets of the `ctx.sessionTitle` and `ctx.workspaceRegistry`
 * services (dsh web parity for session rename/archive). `sessionTitle` is
 * mounted by dsh-base; `workspaceRegistry` comes from the storage×3 +
 * workspace bundle rows this plugin adds. The plugin only needs the two
 * session actions.
 */
type SessionTitleLike = {
  rename(session: unknown, title: string): unknown;
};
type WorkspaceRegistryLike = {
  archiveSession(sessionId: string): Promise<unknown>;
  readonly archivedSessionIds: readonly string[];
};

/**
 * Structural subset of `ctx.sessionQuery` (`@deepseek-ai/dsh-session-query`,
 * mounted by dsh-base's `session-query-sqlite` row). Kept local so the plugin
 * compiles without a dependency on the query package; `ctx.get('sessionQuery')`
 * returns the full engine at runtime.
 */
type SessionQueryLike = {
  listSessions(signal?: AbortSignal): Promise<
    readonly {
      header: { readonly id: unknown; readonly createdAt: number; readonly cwd?: string };
      readonly live: boolean;
      readonly persisted: boolean;
    }[]
  >;
  readSession(sessionId: unknown): Promise<{
    readonly session: { readonly id: unknown };
    readonly events: readonly SessionExportEvent[];
  }>;
  readTitleSnapshots(
    sessionIds: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<
    readonly {
      readonly sessionId: unknown;
      readonly status: 'fulfilled';
      readonly value: { readonly title?: { readonly title?: string } };
    }[]
  >;
};

/** Resolve the user allowlist: config first, then the `FEISHU_ALLOWED_USERS`
 *  environment variable (comma-separated open ids; the integration-test
 *  seam — sender open ids are fixed there). Empty means no restriction. */
export function resolveAllowedUsers(config: Config): string[] | undefined {
  // Schemastery materializes absent optional arrays as `[]` — treat an empty
  // list as "no restriction" exactly like an absent one.
  if (config.allowedUsers !== undefined && config.allowedUsers.length > 0) {
    return config.allowedUsers;
  }
  const env = process.env.FEISHU_ALLOWED_USERS;
  if (env === undefined || env.trim() === '') return undefined;
  return env
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/** Resolve the chat allowlist: config first, then `FEISHU_ALLOWED_CHATS`
 *  (comma-separated chat ids). Empty means no restriction. */
export function resolveAllowedChats(config: Config): string[] | undefined {
  if (config.allowedChats !== undefined && config.allowedChats.length > 0) {
    return config.allowedChats;
  }
  const env = process.env.FEISHU_ALLOWED_CHATS;
  if (env === undefined || env.trim() === '') return undefined;
  return env
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/** Resolve the group mention mode: config first, then
 *  `FEISHU_GROUP_MENTION_MODE` (always | never | ambient | topic). */
export function resolveGroupMentionMode(
  config: Config,
): 'always' | 'never' | 'ambient' | 'topic' | undefined {
  if (config.groupMentionMode !== undefined) return config.groupMentionMode;
  const env = process.env.FEISHU_GROUP_MENTION_MODE;
  if (env === 'always' || env === 'never' || env === 'ambient' || env === 'topic') return env;
  return undefined;
}

/** Resolve the unknown-slash policy: config first, then
 *  `FEISHU_UNKNOWN_COMMAND` (error | passthrough). */
export function resolveUnknownCommand(config: Config): 'error' | 'passthrough' | undefined {
  if (config.unknownCommand !== undefined) return config.unknownCommand;
  const env = process.env.FEISHU_UNKNOWN_COMMAND;
  if (env === 'error' || env === 'passthrough') return env;
  return undefined;
}

/** The default transport factory picks this up; see below. */
function defaultTransportFactory(
  dataDir: string,
): (credentials: Credentials, logger: BridgeLogger) => FeishuTransport {
  if (process.env.FEISHU_TRANSPORT === 'memory') {
    const dir = process.env.FEISHU_MEMORY_DIR ?? join(dataDir, 'memory');
    const mockStats = parseMockChatStats();
    return (_credentials, _logger) =>
      createMemoryTransport({
        dir,
        // Mention-gate integration tests inject the bot's open id; absent,
        // group messages without an @-mention are ignored (the gate).
        ...(process.env.FEISHU_MOCK_BOT_OPEN_ID !== undefined
          ? { botOpenId: process.env.FEISHU_MOCK_BOT_OPEN_ID }
          : {}),
        // Solo-group relaxation tests inject member counts ('2u,1b').
        ...(mockStats !== undefined ? { chatStats: mockStats } : {}),
        // Inbound-attachment integration tests seed download bytes from
        // FEISHU_MEMORY_ATTACHMENTS: `<key>.bin` holds the bytes, and an
        // optional `<key>.mediaType` file declares the media type.
        ...(process.env.FEISHU_MEMORY_ATTACHMENTS !== undefined
          ? { attachments: loadMemoryAttachments(process.env.FEISHU_MEMORY_ATTACHMENTS) }
          : {}),
      });
  }
  return createLarkTransport;
}

/** Load seeded inbound-attachment bytes from a directory (`<key>.bin` +
 *  optional `<key>.mediaType`). The test-only seam that lets the memory
 *  transport serve `downloadImage`/`downloadFile` without Feishu. */
function loadMemoryAttachments(
  dir: string,
): ReadonlyMap<string, { data: Uint8Array; mediaType?: string }> {
  const map = new Map<string, { data: Uint8Array; mediaType?: string }>();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return map;
  }
  for (const file of files) {
    if (!file.endsWith('.bin')) continue;
    const key = file.slice(0, -'.bin'.length);
    const data = new Uint8Array(readFileSync(join(dir, file)));
    let mediaType: string | undefined;
    try {
      mediaType = readFileSync(join(dir, `${key}.mediaType`), 'utf8').trim();
    } catch {
      // No media type file: leave undefined (defaults to image/png).
    }
    map.set(key, mediaType === undefined ? { data } : { data, mediaType });
  }
  return map;
}

/** Parse `FEISHU_MOCK_CHAT_STATS` ('<users>u,<bots>b' — a test-only seam) into
 *  the member counts the memory transport serves for every chat. `undefined`
 *  when the variable is absent or malformed (no relaxation applied). */
function parseMockChatStats():
  | { readonly userCount: number; readonly botCount: number }
  | undefined {
  const env = process.env.FEISHU_MOCK_CHAT_STATS;
  if (env === undefined) return undefined;
  const users = /(\d+)u/.exec(env)?.[1];
  const bots = /(\d+)b/.exec(env)?.[1];
  if (users === undefined || bots === undefined) return undefined;
  return { userCount: Number(users), botCount: Number(bots) };
}

/**
 * List the session corpus for `/sessions` and `/resume` through the mounted
 * query engine. Newest-first records with folded titles; `undefined` when the
 * engine is absent (the surface falls back to a degraded bound-sessions list).
 * @param ctx - plugin context.
 * @returns session rows, or `undefined` when `sessionQuery` is unavailable.
 */
async function listSessions(ctx: Context): Promise<readonly SessionListRow[] | undefined> {
  const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined;
  if (sessionQuery === undefined) {
    ctx.logger.warn('[feishu] sessionQuery service unavailable; /sessions is degraded');
    return undefined;
  }
  const records = await sessionQuery.listSessions();
  const ids = records.map((record) => record.header.id);
  const observations = await sessionQuery.readTitleSnapshots(ids);
  const titles = new Map<string, string | undefined>();
  for (const observation of observations) {
    if (observation.status === 'fulfilled') {
      titles.set(String(observation.sessionId), observation.value.title?.title);
    }
  }
  return records.map((record) => ({
    sessionId: String(record.header.id),
    title: titles.get(String(record.header.id)),
    cwd: record.header.cwd,
    createdAt: record.header.createdAt,
    live: record.live,
    persisted: record.persisted,
  }));
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

  const dataDir = config.dataDir ?? defaultDataDir();
  const sessionMap = new SessionMap(join(dataDir, 'session-map.json'), undefined, logger);
  sessionMap.load();
  logger.debug(`[feishu] dataDir=${dataDir}`);
  const allowedUsers = resolveAllowedUsers(config);
  const allowedChats = resolveAllowedChats(config);
  const groupMentionMode = resolveGroupMentionMode(config);
  const unknownCommand = resolveUnknownCommand(config);
  logger.debug(
    `[feishu] routing: allowedChats=${allowedChats !== undefined && allowedChats.length > 0 ? allowedChats.join(',') : '(all)'} ` +
      `allowedUsers=${allowedUsers !== undefined && allowedUsers.length > 0 ? allowedUsers.length : '(all)'} ` +
      `groupMentionMode=${groupMentionMode ?? 'always'} unknownCommand=${unknownCommand ?? 'reply'}`,
  );
  const transportFactory = deps.createTransport ?? defaultTransportFactory(dataDir);
  const transport = transportFactory(credentials, logger);
  const cards = new StreamingCardManager(transport, {
    throttleMs: config.cardThrottleMs ?? 400,
    logger,
  });
  // Agents need an explicit provider/model; config overrides win, otherwise
  // the deployment default selection applies (the headless-runner pattern).
  const resolvedAgentOptions = resolveAgentOptions(ctx, config);
  const agentStore: AgentStore = {
    get: (sessionId) => ctx.get('agents')?.get(sessionId as unknown as SessionId),
    resume: async (sessionId) => {
      const agents = ctx.get('agents');
      if (agents === undefined) {
        throw new Error('agents service unavailable; cannot resume a session');
      }
      const { agent } = await agents.resume({
        resumeSessionId: sessionId as unknown as SessionId,
        ...(resolvedAgentOptions !== undefined ? { agentOptions: resolvedAgentOptions } : {}),
      });
      return agent;
    },
    create: async (sessionId, cwd) => {
      const agents = ctx.get('agents');
      if (agents === undefined) {
        throw new Error('agents service unavailable; cannot create a session');
      }
      const { agent } = await agents.create({
        sessionId: sessionId as unknown as SessionId,
        meta: { cwd },
        ...(resolvedAgentOptions !== undefined ? { agentOptions: resolvedAgentOptions } : {}),
      });
      return agent;
    },
  };
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
    appId: credentials.appId,
    transportMode: process.env.FEISHU_TRANSPORT === 'memory' ? 'memory' : 'lark',
    ...(groupMentionMode !== undefined ? { groupMentionMode } : {}),
    ...(allowedChats !== undefined ? { allowedChats } : {}),
    ...(allowedUsers !== undefined ? { allowedUsers } : {}),
    ...(unknownCommand !== undefined ? { unknownCommand } : {}),
    ...(config.repoRoots !== undefined ? { repoRoots: config.repoRoots } : {}),
    ...(config.requireWorkingDir !== undefined
      ? { requireWorkingDir: config.requireWorkingDir }
      : {}),
    ...(config.reactions !== undefined ? { reactions: config.reactions } : {}),
    executeCommand: (agent, line) => executeDshCommand(ctx, agent, line),
    listSessions: () => listSessions(ctx),
    readSession: (sessionId) => {
      const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined;
      if (sessionQuery === undefined) {
        throw new Error('sessionQuery service unavailable');
      }
      return sessionQuery.readSession(sessionId) as Promise<{
        readonly session: { readonly id: string };
        readonly events: readonly SessionExportEvent[];
      }>;
    },
    // Host session-management seam (dsh web parity for rename/archive). The
    // Session rename/archive seams: `sessionTitle` is mounted by dsh-base;
    // `workspaceRegistry` comes from this bundle's storage×3 + workspace
    // rows. Absent, the session detail view hides those actions.
    ...(ctx.get('sessionTitle') !== undefined
      ? { sessionTitle: ctx.get('sessionTitle') as SessionTitleLike }
      : {}),
    // workspaceRegistry initializes asynchronously after apply, so it is
    // resolved lazily at use time — a startup snapshot would be permanently
    // undefined. Absent, the session detail view hides archive actions.
    getWorkspaceRegistry: () => {
      const registry = ctx.get('workspaceRegistry');
      return registry === undefined ? undefined : (registry as WorkspaceRegistryLike);
    },
    // Inbound-file seam: persist one downloaded file under the chat's
    // working directory at `.dsh_feishu/attachments/<appId>/<chatId>/<name>.<ext>`
    // (hidden subdirectory; bucketed per app + chat so the WeChat-style
    // `(1)`/`(2)` dedupe actually fires when the SAME chat re-sends a file
    // with the same name — a per-message bucket would never collide and
    // dedupe would be dead code). The name is the user's original
    // `file_name` when present (sanitized), falling back to the resource
    // key. Files are kept permanently.
    saveInboundFile: async ({ chatId, appId, attachment, stream, extension }) => {
      const cwd = sessionMap.cwdFor(chatId) ?? config.defaultCwd ?? process.cwd();
      const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const dir = join(cwd, '.dsh_feishu', 'attachments', safeAppId, safeChatId);
      mkdirSync(dir, { recursive: true });
      const fileName = pickAttachmentFileName(
        dir,
        attachment.name,
        attachment.key,
        extension,
        existsSync,
      );
      const path = join(dir, fileName);
      // Stream the body to disk (pipeline handles backpressure + cleanup);
      // the resource API serves files up to ~100 MB — buffering would spike
      // memory (botmux lesson).
      await pipeline(stream, createWriteStream(path));
      return { path };
    },
    // Feature-detect the two stateful web-command services (both mounted by
    // dsh-base); absent, the /permission and /plan wrappers degrade.
    ...(ctx.get('permissionPresets') !== undefined
      ? { permissionPresets: ctx.get('permissionPresets') as PermissionPresetService }
      : {}),
    ...(ctx.get('planMode') !== undefined
      ? { planMode: ctx.get('planMode') as PlanModeService }
      : {}),
    ...(ctx.get('agentDefaultModel') !== undefined
      ? { agentDefaultModel: ctx.get('agentDefaultModel') as AgentDefaultModelService }
      : {}),
    ...(ctx.get('llm') !== undefined ? { llm: ctx.get('llm') as LlmService } : {}),
  });
  logger.debug(
    `[feishu] host services: sessionTitle=${ctx.get('sessionTitle') !== undefined} ` +
      `workspaceRegistry=${ctx.get('workspaceRegistry') !== undefined} ` +
      `permissionPresets=${ctx.get('permissionPresets') !== undefined} ` +
      `planMode=${ctx.get('planMode') !== undefined} ` +
      `agentDefaultModel=${ctx.get('agentDefaultModel') !== undefined} ` +
      `llm=${ctx.get('llm') !== undefined} attachments=${ctx.get('attachments') !== undefined}`,
  );
  // Interactive approvals: answer every `approval/request` with a Feishu
  // approval card. Fail-closed semantics are the service's own (throwing or
  // no answerer yields `unavailable`), so an absent service is logged, not
  // fatal.
  const approvalService = ctx.get('approval');
  if (approvalService !== undefined) {
    ctx.on('approval/request', (request: ApprovalRequestLike) =>
      bridge.handleApprovalRequest(request),
    );
  } else {
    ctx.logger.warn('[feishu] approval service unavailable; approvals fail closed');
  }
  // Interactive questions: become the single userQuestions provider.
  const userQuestionsService = ctx.get('userQuestions');
  if (userQuestionsService !== undefined) {
    // The provider is cast through the service's own contract type: the
    // surface stays structurally typed (no runtime dependency on the
    // questions package), and the service's parameter shape may drift.
    const questionsProvider = {
      ask: (request: unknown) => bridge.askQuestions(request as AskQuestionsRequestLike),
    } as Parameters<typeof userQuestionsService.registerProvider>[0];
    const disposeQuestions = userQuestionsService.registerProvider(questionsProvider);
    ctx.effect(() => disposeQuestions);
  } else {
    ctx.logger.warn('[feishu] userQuestions service unavailable; questions cannot be rendered');
  }
  ctx.effect(() => () => {
    bridge.dispose();
    sessionMap.persist();
  });
  promoteAmbientApiKey(ctx, config);
  void transport
    .start()
    .then(() => ctx.logger.info('[feishu] bridge ready'))
    .catch((error: unknown) => ctx.logger.error(`[feishu] bridge start failed: ${String(error)}`));
}

/**
 * Promote the ambient model API key into the dsh credentials seam.
 *
 * The llm adapter resolves the key through `ctx.credentials` when the
 * service exists (dsh-base mounts it) and only falls back to the launch
 * environment when it does not — so an env-exported key is invisible to the
 * agent on a base profile unless it is stored in the seam. The web surface
 * writes the key from its Models page; this surface does the same at boot
 * from the configured environment variable, without overwriting an existing
 * stored value.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
function promoteAmbientApiKey(ctx: Context, config: Config): void {
  const envName = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
  const ambient = process.env[envName];
  const credentials = ctx.get('credentials');
  if (ambient === undefined || ambient === '' || credentials === undefined) return;
  void (async () => {
    try {
      if ((await credentials.resolve(credentialRef(envName))) === undefined) {
        await credentials.set(credentialRef(envName), ambient);
        ctx.logger.info(`[feishu] stored ${envName} into the dsh credentials seam`);
      }
    } catch (error: unknown) {
      ctx.logger.warn(
        `[feishu] could not store ${envName} into the credentials seam: ${String(error)}`,
      );
    }
  })();
}

/**
 * Resolve the agent's provider/model: config overrides win, otherwise the
 * deployment's default selection (`agentDefaultModel`). Agents reject
 * requests without both, so the resolved options carry whichever of the two
 * is known (a partial config with no default service fails loud at turn
 * time).
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 * @returns agent options to pass on create/resume, or `undefined` when
 *   neither provider nor model could be resolved.
 */
function resolveAgentOptions(
  ctx: Context,
  config: Config,
): { provider?: string; model?: string } | undefined {
  const selection = (
    ctx.get('agentDefaultModel') as
      | { currentSelection(): { provider: string; model: string } }
      | undefined
  )?.currentSelection();
  const provider = config.provider ?? selection?.provider;
  const model = config.model ?? selection?.model;
  if (provider === undefined && model === undefined) return undefined;
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Execute a slash line through the dsh command registry, if present. Maps
 * the harness result kind to the surface CommandResult (error kinds surface
 * as ⚠️ via the caller); `undefined` when the registry is absent, the
 * command does not resolve, or the handler throws.
 * @param ctx - plugin context (unit tests inject a fake `commands` service).
 * @param agent - the agent to execute against.
 * @param line - the complete slash-command line.
 * @returns the mapped result, or `undefined`.
 */
export async function executeDshCommand(
  ctx: Context,
  agent: Agent,
  line: string,
): Promise<CommandResult | undefined> {
  const commands = ctx.get('commands');
  if (commands === undefined) return undefined;
  try {
    // dsh rc.8: commands.execute(agent, line, images, signal) — the surface
    // never passes encoded images to slash commands (inbound images go
    // through the attachment-injection path instead), so images is empty.
    const execution = await commands.execute(agent, line, [], new AbortController().signal);
    if (execution === undefined) return undefined;
    return execution.result.kind === 'success'
      ? { kind: 'success', text: execution.result.text ?? '' }
      : { kind: 'error', text: execution.result.text };
  } catch (error: unknown) {
    ctx.logger.warn(`[feishu] dsh command ${line} failed: ${String(error)}`);
    return undefined;
  }
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
