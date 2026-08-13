/**
 * @module @dsh-feishu/dsh-feishu
 *
 * Feishu (Lark) as a native DeepSeek Harness (dsh) surface: a Feishu chat
 * maps to a dsh session, the chat bot is the agent's avatar, with streaming
 * cards and slash commands.
 *
 * Iteration 0: the bridge entry point only. It registers the `feishu-status`
 * diagnostic command and idles in "not configured" mode until credentials
 * are supplied. The Feishu transport, session bridge, and streaming cards
 * land in later iterations (see PLAN.md).
 */

import type { Context } from '@deepseek-ai/cordis';
// Empty type import carries the dsh-commands Context merge (`ctx.commands` /
// the service key accepted by `ctx.get`) into this compilation.
import type {} from '@deepseek-ai/dsh-commands';
import z from '@deepseek-ai/schemastery';
import { consoleExporter } from './console-exporter.js';

/** Stable cordis plugin name (also the bundle row id in cordis.patch.yml). */
export const name = 'feishu';

/** Plugin configuration. */
export interface Config {
  /** Feishu app id; falls back to the `FEISHU_APP_ID` environment variable. */
  readonly appId?: string;
  /** Feishu app secret; falls back to the `FEISHU_APP_SECRET` environment variable. */
  readonly appSecret?: string;
}

/** Validated plugin configuration (schemastery schema). */
export const Config: z<Config> = z.object({
  appId: z.string().required(false),
  appSecret: z.string().required(false),
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

/**
 * Mount the bridge entry point.
 * @param ctx - plugin context carrying optional DSH services.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  // dsh surfaces mount no console exporter by default; bridge operators need
  // visible logs, so route structured log records to the console (the logger
  // service disposes the exporter with the current fiber).
  ctx.logger.exporter(consoleExporter());
  const credentials = resolveCredentials(config);
  if (credentials === undefined) {
    ctx.logger.info(
      '[feishu] starting in not-configured mode: set FEISHU_APP_ID / FEISHU_APP_SECRET ' +
        'or the appId/appSecret config keys',
    );
  } else {
    ctx.logger.info(
      `[feishu] starting for app ${credentials.appId} (transport lands in iteration 1)`,
    );
  }

  // The commands registry is optional: a composition without dsh-commands
  // still boots, with slash commands silently unavailable.
  const commands = ctx.get('commands');
  if (commands === undefined) {
    ctx.logger.warn('[feishu] commands service unavailable; slash commands disabled');
    return;
  }
  commands.register({
    name: 'feishu-status',
    description: 'Show the dsh-feishu bridge status',
    handler: () => {
      if (credentials === undefined) {
        return {
          kind: 'error',
          text: 'dsh-feishu is not configured: set FEISHU_APP_ID and FEISHU_APP_SECRET.',
        };
      }
      return {
        kind: 'success',
        text: `dsh-feishu is configured for app ${credentials.appId}; transport lands in iteration 1.`,
      };
    },
  });
}
