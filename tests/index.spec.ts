/**
 * Unit tests for the iteration-0 bridge entry point.
 *
 * The plugin is exercised through a hand-built fake context (the modlens
 * pattern): only the surfaces `apply` touches are stubbed, so the tests do
 * not require a live dsh composition.
 */

import type { Context } from '@deepseek-ai/cordis';
import type { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, Config, name, resolveCredentials } from '../src/index.js';

/** A recorded command registration as the fake registry sees it. */
interface RegisteredCommand {
  name: string;
  description: string;
  handler: (invocation: { rawInput: string }) => unknown;
}

/** Minimal fake of the cordis context surface the plugin touches. */
function makeFakeContext(options: { withCommands?: boolean } = {}): {
  ctx: Context;
  registered: RegisteredCommand[];
  logs: string[];
} {
  const registered: RegisteredCommand[] = [];
  const logs: string[] = [];
  const logger = {
    info: (msg: string) => void logs.push(`info: ${msg}`),
    warn: (msg: string) => void logs.push(`warn: ${msg}`),
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
    return undefined;
  };
  const ctx = { get, logger } as unknown as Context;
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

  it('logs the app id when credentials resolve from the environment', () => {
    process.env.FEISHU_APP_ID = 'env_app';
    process.env.FEISHU_APP_SECRET = 'env_secret';
    const { ctx, logs } = makeFakeContext();
    apply(ctx, {});
    expect(logs.some((line) => line.includes('env_app'))).toBe(true);
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
    apply(ctx, { appId: 'cli_app', appSecret: 'secret' });
    const status = registered.find((def) => def.name === 'feishu-status');
    const result = status?.handler({ rawInput: '' });
    expect(result).toEqual({
      kind: 'success',
      text: 'dsh-feishu is configured for app cli_app; transport lands in iteration 1.',
    });
  });

  it('skips command registration when the commands service is unavailable', () => {
    const { ctx, registered, logs } = makeFakeContext({ withCommands: false });
    apply(ctx, {});
    expect(registered).toHaveLength(0);
    expect(logs.some((line) => line.includes('commands service unavailable'))).toBe(true);
  });
});
