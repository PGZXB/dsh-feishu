/**
 * Unit tests for the plugin entry point.
 *
 * The plugin is exercised through a hand-built fake context (the modlens
 * pattern): only the surfaces `apply` touches are stubbed, and a fake
 * transport is injected through `ApplyDeps` so the configured path runs
 * without any network.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import type { CommandExecution, CommandId, CommandRuntime } from '@deepseek-ai/dsh-commands';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CardAction,
  CardJson,
  ChatStats,
  FeishuMessage,
  FeishuTransport,
  SentCard,
} from '../src/feishu/types.js';
import {
  apply,
  Config,
  dshHome,
  executeDshCommand,
  name,
  resolveAllowedChats,
  resolveAllowedUsers,
  resolveCredentials,
  resolveGroupMentionMode,
  resolveUnknownCommand,
} from '../src/index.js';

/** A recorded command registration as the fake registry sees it. */
interface RegisteredCommand {
  name: string;
  description: string;
  handler: (invocation: { rawInput: string }) => unknown;
}

/** Recording fake transport injected via ApplyDeps. */
class FakeTransport implements FeishuTransport {
  started = false;
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {}
  private messageHandler: ((message: FeishuMessage) => void) | undefined;
  onMessage(handler: (message: FeishuMessage) => void): void {
    this.messageHandler = handler;
  }
  emitMessage(message: FeishuMessage): void {
    this.messageHandler?.(message);
  }
  onCardAction(_handler: (action: CardAction) => void): void {}
  getBotOpenId(): string | undefined {
    return undefined;
  }
  async chatStats(_chatId: string): Promise<ChatStats | undefined> {
    return undefined;
  }
  async createGroup(name: string, _memberOpenIds: readonly string[]): Promise<{ chatId: string }> {
    return { chatId: `oc_group_${name}` };
  }
  async sendText(_chatId: string, _text: string): Promise<void> {}
  async sendFile(_chatId: string, _fileName: string, _content: Uint8Array): Promise<void> {}
  async sendImage(_chatId: string, _fileName: string, _bytes: Uint8Array): Promise<void> {}
  async addReaction(_messageId: string, _emojiType: string): Promise<string | undefined> {
    return undefined;
  }
  async removeReaction(_messageId: string, _reactionId: string): Promise<void> {}

  async sendCard(_chatId: string, _card: CardJson): Promise<SentCard> {
    return { messageId: 'msg-1' };
  }
  async updateCard(_messageId: string, _card: CardJson): Promise<void> {}
  async deleteMessage(_messageId: string): Promise<void> {}
  async downloadImage(
    _messageId: string,
    _key: string,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    throw new Error('downloadImage not implemented in this fake');
  }
  async downloadFile(
    _messageId: string,
    _key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; head: Uint8Array }> {
    throw new Error('downloadFile not implemented in this fake');
  }
}
/** Minimal fake of the cordis context surface the plugin touches. */
function makeFakeContext(
  options: {
    withCommands?: boolean;
    credentials?: { resolve: () => Promise<unknown>; set: () => unknown };
    agents?: unknown;
    workspaceRegistry?: unknown;
  } = {},
): {
  ctx: Context;
  registered: RegisteredCommand[];
  logs: string[];
} {
  const registered: RegisteredCommand[] = [];
  const logs: string[] = [];
  const logger = {
    info: (msg: string) => void logs.push(`info: ${msg}`),
    warn: (msg: string) => void logs.push(`warn: ${msg}`),
    error: (msg: string) => void logs.push(`error: ${msg}`),
    debug: (msg: string) => void logs.push(`debug: ${msg}`),
    exporter: vi.fn(() => () => {}),
  };
  const commands = {
    register: vi.fn((def: RegisteredCommand) => {
      registered.push(def);
      return () => {};
    }),
  } as unknown as CommandRuntime;
  const get = (service: string): unknown => {
    if (service === 'commands' && options.withCommands !== false) return commands;
    if (service === 'credentials') return options.credentials;
    if (service === 'agents') return options.agents;
    if (service === 'workspaceRegistry') return options.workspaceRegistry;
    return undefined;
  };
  const on = vi.fn(() => () => {});
  const effect = vi.fn(() => {});
  const ctx = { get, on, effect, logger } as unknown as Context;
  return { ctx, registered, logs };
}

describe('plugin metadata', () => {
  it('exports the stable plugin name', () => {
    expect(name).toBe('feishu');
  });
});

describe('resolveCredentials', () => {
  afterEach(() => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
  });

  it('returns credentials from config when both values are present', () => {
    expect(resolveCredentials({ appId: 'cli_app', appSecret: 'secret' })).toEqual({
      appId: 'cli_app',
      appSecret: 'secret',
    });
  });

  it('prefers config values over environment values', () => {
    process.env.FEISHU_APP_ID = 'env_app';
    process.env.FEISHU_APP_SECRET = 'env_secret';
    expect(resolveCredentials({ appId: 'cfg_app', appSecret: 'cfg_secret' })).toEqual({
      appId: 'cfg_app',
      appSecret: 'cfg_secret',
    });
  });

  it('falls back to the environment when config omits a value', () => {
    process.env.FEISHU_APP_ID = 'env_app';
    process.env.FEISHU_APP_SECRET = 'env_secret';
    expect(resolveCredentials({})).toEqual({ appId: 'env_app', appSecret: 'env_secret' });
  });

  it('returns undefined when either value is missing', () => {
    expect(resolveCredentials({})).toBeUndefined();
    expect(resolveCredentials({ appId: 'cli_app' })).toBeUndefined();
    process.env.FEISHU_APP_ID = 'env_app';
    expect(resolveCredentials({ appId: 'cli_app' })).toBeUndefined();
  });
});

describe('allowlist / policy resolvers (config first, env fallback)', () => {
  const VARS = [
    'FEISHU_ALLOWED_USERS',
    'FEISHU_ALLOWED_CHATS',
    'FEISHU_GROUP_MENTION_MODE',
    'FEISHU_UNKNOWN_COMMAND',
  ];
  afterEach(() => {
    for (const variable of VARS) delete process.env[variable];
  });

  it('resolveAllowedUsers: config wins; env comma-list parses; [] means unrestricted', () => {
    process.env.FEISHU_ALLOWED_USERS = ' ou_a, ou_b ';
    expect(resolveAllowedUsers({})).toEqual(['ou_a', 'ou_b']);
    expect(resolveAllowedUsers({ allowedUsers: ['ou_cfg'] })).toEqual(['ou_cfg']);
    // Schemastery materializes absent optional arrays as [] — the resolver
    // treats an empty list as "no restriction" (regression: the real
    // process silently served everyone when the config defaulted to []).
    // With no env either, [] must resolve to undefined, not [].
    process.env.FEISHU_ALLOWED_USERS = '';
    expect(resolveAllowedUsers({ allowedUsers: [] })).toBeUndefined();
    expect(resolveAllowedUsers({})).toBeUndefined();
  });

  it('resolveAllowedChats: config wins; env comma-list parses; [] means unrestricted', () => {
    process.env.FEISHU_ALLOWED_CHATS = 'oc_a,oc_b';
    expect(resolveAllowedChats({})).toEqual(['oc_a', 'oc_b']);
    expect(resolveAllowedChats({ allowedChats: ['oc_cfg'] })).toEqual(['oc_cfg']);
    // An explicit empty list with an env set falls through to the env (the
    // config did not restrict); with no env it must be undefined, not [].
    process.env.FEISHU_ALLOWED_CHATS = '';
    expect(resolveAllowedChats({ allowedChats: [] })).toBeUndefined();
  });

  it('resolveGroupMentionMode: config wins; env accepts the four modes only', () => {
    process.env.FEISHU_GROUP_MENTION_MODE = 'never';
    expect(resolveGroupMentionMode({})).toBe('never');
    expect(resolveGroupMentionMode({ groupMentionMode: 'ambient' })).toBe('ambient');
    process.env.FEISHU_GROUP_MENTION_MODE = 'bogus';
    expect(resolveGroupMentionMode({})).toBeUndefined();
  });

  it('resolveUnknownCommand: config wins; env accepts error|passthrough only', () => {
    process.env.FEISHU_UNKNOWN_COMMAND = 'passthrough';
    expect(resolveUnknownCommand({})).toBe('passthrough');
    expect(resolveUnknownCommand({ unknownCommand: 'error' })).toBe('error');
    process.env.FEISHU_UNKNOWN_COMMAND = 'bogus';
    expect(resolveUnknownCommand({})).toBeUndefined();
  });
});

describe('dshHome', () => {
  afterEach(() => {
    delete process.env.DSH_HOME;
  });

  it('prefers DSH_HOME over the home directory', () => {
    process.env.DSH_HOME = '/custom/home';
    expect(dshHome()).toBe('/custom/home');
  });
});

describe('Config schema', () => {
  it('accepts an empty config', () => {
    expect(() => Config({})).not.toThrow();
  });

  it('accepts valid credentials', () => {
    expect(() => Config({ appId: 'cli_app', appSecret: 'secret' })).not.toThrow();
  });

  it('rejects non-string credential values', () => {
    // The schema input type already rejects numbers at compile time; cast to
    // exercise the runtime validation boundary (config is a parser boundary).
    const bad = { appId: 42 } as unknown as Parameters<typeof Config>[0];
    expect(() => Config(bad)).toThrow();
  });
});

describe('apply', () => {
  afterEach(() => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.DSH_HOME;
  });

  it('registers a console log exporter on boot', () => {
    const { ctx } = makeFakeContext();
    const logger = ctx.logger as unknown as { exporter: ReturnType<typeof vi.fn> };
    apply(ctx, {});
    expect(logger.exporter).toHaveBeenCalledOnce();
  });

  it('logs a not-configured notice when no credentials resolve', () => {
    const { ctx, logs } = makeFakeContext();
    apply(ctx, {});
    expect(logs.some((line) => line.includes('not-configured'))).toBe(true);
  });

  it('logs the app id and starts the transport when credentials resolve', () => {
    process.env.FEISHU_APP_ID = 'env_app';
    process.env.FEISHU_APP_SECRET = 'env_secret';
    const { ctx, logs } = makeFakeContext();
    const transport = new FakeTransport();
    apply(ctx, {}, { createTransport: () => transport });
    expect(logs.some((line) => line.includes('env_app'))).toBe(true);
    // start() is fire-and-forget; give the microtask queue a tick.
    return Promise.resolve().then(() => expect(transport.started).toBe(true));
  });

  it('promotes the ambient model key into the credentials seam when absent', async () => {
    process.env.FEISHU_APP_ID = 'env_app';
    process.env.FEISHU_APP_SECRET = 'env_secret';
    process.env.DEEPSEEK_API_KEY = 'sk-test-key';
    const set = vi.fn(async () => {});
    const credentials = { resolve: async () => undefined, set };
    const { ctx } = makeFakeContext({ credentials });
    apply(ctx, {}, { createTransport: () => new FakeTransport() });
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-test-key'));
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('does not overwrite an existing stored model key', async () => {
    process.env.FEISHU_APP_ID = 'env_app';
    process.env.FEISHU_APP_SECRET = 'env_secret';
    process.env.DEEPSEEK_API_KEY = 'sk-test-key';
    const set = vi.fn(async () => {});
    const credentials = { resolve: async () => ({ value: 'sk-existing' }), set };
    const { ctx } = makeFakeContext({ credentials });
    apply(ctx, {}, { createTransport: () => new FakeTransport() });
    await Promise.resolve();
    expect(set).not.toHaveBeenCalled();
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('attaches a newly created session to the workspace owning its cwd', async () => {
    process.env.FEISHU_APP_ID = 'env_app';
    process.env.FEISHU_APP_SECRET = 'env_secret';
    const attachSession = vi.fn(async () => {});
    const workspaceCreate = vi.fn(async () => ({ attachSession }));
    const followup = vi.fn();
    const create = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      agent: { id: sessionId, followup },
    }));
    const agents = {
      get: () => undefined,
      resume: vi.fn(async () => {
        throw new Error('not found');
      }),
      create,
    };
    const { ctx } = makeFakeContext({
      agents,
      workspaceRegistry: {
        create: workspaceCreate,
        archivedSessionIds: [],
        archiveSession: vi.fn(),
      },
    });
    // The surface persists its session map under `$DSH_HOME/feishu`; point it
    // at a scratch dir so the test never touches the real `~/.dsh`.
    process.env.DSH_HOME = mkdtempSync(`${tmpdir()}/dsh-feishu-`);
    const transport = new FakeTransport();
    apply(ctx, { requireWorkingDir: false }, { createTransport: () => transport });
    transport.emitMessage({
      messageId: 'om_1',
      chatId: 'oc_1',
      chatType: 'p2p',
      senderOpenId: 'ou_1',
      text: 'hi',
      mentions: [],
      attachments: [],
      createdAt: 1_700_000_000_000,
    });
    await vi.waitFor(() => expect(attachSession).toHaveBeenCalled());
    // The workspace record was resolved/created for the session's cwd
    // (process.cwd(), since the test config omits defaultCwd) under a
    // title derived from that directory's basename.
    expect(workspaceCreate).toHaveBeenCalledWith(process.cwd(), expect.any(String));
    // And the freshly minted `feishu-…` session id was attached to it.
    expect(attachSession).toHaveBeenCalledWith(expect.stringMatching(/^feishu-/));
  });

  it('registers the feishu-status command when the commands service exists', () => {
    const { ctx, registered } = makeFakeContext();
    apply(ctx, {});
    expect(registered.map((def) => def.name)).toContain('feishu-status');
  });

  it('reports not-configured from the feishu-status handler', () => {
    const { ctx, registered } = makeFakeContext();
    apply(ctx, {});
    const status = registered.find((def) => def.name === 'feishu-status');
    expect(status).toBeDefined();
    const result = status?.handler({ rawInput: '' });
    expect(result).toEqual({
      kind: 'error',
      text: 'dsh-feishu is not configured: set FEISHU_APP_ID and FEISHU_APP_SECRET.',
    });
  });

  it('configured mode leaves feishu-status to the bridge card command', () => {
    // The configured `/feishu-status` is the bridge's diagnostic CARD
    // command (connection/sessions/activity); the harness registry only
    // keeps the not-configured text hint.
    const { ctx, registered } = makeFakeContext();
    apply(
      ctx,
      { appId: 'cli_app', appSecret: 'secret' },
      { createTransport: () => new FakeTransport() },
    );
    expect(registered.map((def) => def.name)).not.toContain('feishu-status');
  });

  it('skips command registration when the commands service is unavailable', () => {
    const { ctx, registered, logs } = makeFakeContext({ withCommands: false });
    apply(ctx, {});
    expect(registered).toHaveLength(0);
    expect(logs.some((line) => line.includes('commands service unavailable'))).toBe(true);
  });
});

describe('executeDshCommand', () => {
  function makeCommands(
    result: { kind: 'success'; text?: string } | { kind: 'error'; text: string } | undefined,
  ): { execute: CommandRuntime['execute'] } {
    return {
      execute: async (): Promise<CommandExecution | undefined> =>
        result === undefined ? undefined : { commandId: 'c1' as CommandId, result },
    };
  }

  const ctxWith = (commands: unknown): Context =>
    ({
      get: (name: string) => (name === 'commands' ? commands : undefined),
      logger: { warn: () => {} },
    }) as unknown as Context;

  it('maps a success result to a success CommandResult', async () => {
    const ctx = ctxWith(makeCommands({ kind: 'success', text: 'Compacted.' }));
    const result = await executeDshCommand(ctx, {} as never, '/compact');
    expect(result).toEqual({ kind: 'success', text: 'Compacted.' });
  });

  it('maps an empty success text to an empty string', async () => {
    const ctx = ctxWith(makeCommands({ kind: 'success' }));
    const result = await executeDshCommand(ctx, {} as never, '/plan off');
    expect(result).toEqual({ kind: 'success', text: '' });
  });

  it('maps an error result to an error CommandResult', async () => {
    const ctx = ctxWith(makeCommands({ kind: 'error', text: 'unknown preset "nope"' }));
    const result = await executeDshCommand(ctx, {} as never, '/permission nope');
    expect(result).toEqual({ kind: 'error', text: 'unknown preset "nope"' });
  });

  it('returns undefined when the registry is absent or the command misses', async () => {
    expect(await executeDshCommand(ctxWith(undefined), {} as never, '/nope')).toBeUndefined();
    const ctx = ctxWith(makeCommands(undefined));
    expect(await executeDshCommand(ctx, {} as never, '/nope')).toBeUndefined();
  });

  it('returns undefined when the handler throws', async () => {
    const throwing = {
      execute: async () => {
        throw new Error('boom');
      },
    };
    const ctx = ctxWith(throwing);
    expect(await executeDshCommand(ctx, {} as never, '/goal')).toBeUndefined();
  });
});
