/**
 * The Feishu app surface manifest — the single source of truth for what the
 * surface needs from the Open Platform. The quick-setup automation
 * (`src/setup/*`), its manual fallback, and `docs/feishu-setup.md` all derive
 * from `feishu-manifest.json`.
 *
 * ⚠️ KEEP IN SYNC: any feature that needs a new Feishu scope, event, or card
 * callback must update `feishu-manifest.json` in the SAME change (see
 * AGENTS.md → "Feishu permissions manifest"). The setup tool grants exactly
 * what this file lists — an unlisted scope is a bot that cannot do the
 * feature.
 */

import feishuManifest from './feishu-manifest.json' with { type: 'json' };

/** Feishu console receive-mode value for the WebSocket long connection. */
export const LONG_CONNECTION_EVENT_MODE = feishuManifest.longConnectionMode;

/** Event (not callback) types the surface consumes via `im.message.receive_v1`. */
export const APP_EVENTS = feishuManifest.appEvents as readonly string[];

/**
 * Card callback types the surface consumes. The Open Platform treats card
 * button presses as callbacks configured separately from events; missing
 * `card.action.trigger` makes every button dead ("该应用尚未配置卡片回调").
 */
export const CARD_CALLBACKS = feishuManifest.cardCallbacks as readonly string[];

/** Permission scopes the surface needs (console: 权限管理). */
export const SCOPES = feishuManifest.scopes as readonly string[];

/** Default name for an app created by the setup tool. */
export const DEFAULT_APP_NAME = feishuManifest.defaultAppName;

/** The raw manifest object (as committed). */
export const FEISHU_MANIFEST = feishuManifest;
