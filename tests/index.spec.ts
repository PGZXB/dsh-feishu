/**
 * Unit tests for the plugin entry point.
 *
 * The plugin is exercised through a hand-built fake context (the modlens
 * pattern): only the surfaces `apply` touches are stubbed, and a fake
 * transport is injected through `ApplyDeps` so the configured path runs
 * without any network.
 */

import type { Context } from '@deepseek-ai/cordis';
import type { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CardAction,
  CardJson,
  FeishuMessage,
  FeishuTransport,
  SentCard,
} from '../src/feishu/types.js';
import { apply, Config, dshHome, name, resolveCredentials } from '../src/index.js';

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
  onMessage(_handler: (message: FeishuMessage) => void): void {}
  onCardAction(_handler: (action: CardAction) => void): void {}
  async sendText(_chatId: string, _text: string): Promise<void> {}
  async sendCard(_chatId: string, _card: CardJson): Promise<SentCard> {
    return { messageId: 'msg-1' };
  }
  async updateCard(_messageId: string, _card: CardJson): Promise<void> {}
}

/** Minimal fake of the cordis context surface the plugin touches. */
function makeFakeContext(
  options: {
    withCommands?: boolean;
    credentials?: { resolve: () => Promise<unknown>; set: () => unknown };
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

  it('reports the configured app from the feishu-status handler', () => {
    const { ctx, registered } = makeFakeContext();
    apply(
      ctx,
      { appId: 'cli_app', appSecret: 'secret' },
      { createTransport: () => new FakeTransport() },
    );
    const status = registered.find((def) => def.name === 'feishu-status');
    const result = status?.handler({ rawInput: '' });
    expect(result).toEqual({
      kind: 'success',
      text: 'dsh-feishu is configured for app cli_app; bridge running.',
    });
  });

  it('skips command registration when the commands service is unavailable', () => {
    const { ctx, registered, logs } = makeFakeContext({ withCommands: false });
    apply(ctx, {});
    expect(registered).toHaveLength(0);
    expect(logs.some((line) => line.includes('commands service unavailable'))).toBe(true);
  });
});
