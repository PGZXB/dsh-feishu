/**
 * The i18n engine: locale-aware message lookup with `{param}`
 * interpolation — a dependency-free, typed subset of the i18next
 * conventions (flat keys, interpolation tokens) sized to this plugin's
 * needs.
 *
 * Design:
 * - `en-US` is the BASE catalog and the type source of `MessageKey`; every
 *   other catalog is `Record<MessageKey, string>`, so key parity is checked
 *   at COMPILE time (a missing or extra translation fails `pnpm run
 *   typecheck`), not just by tests.
 * - Unknown keys FAIL LOUD (throw listing key + locale) — mirroring the
 *   misconfiguration rule; a silent key echo would ship broken UI quietly.
 * - Placeholder names must match across locales (enforced by test): a
 *   translation that renames `{count}` to `{n}` breaks the call site.
 * - Plurals are deliberately NOT implemented (no ICU dependency); the
 *   documented extension path is `Intl.PluralRules` suffixes (`key.one` /
 *   `key.other`) when a real plural need lands.
 *
 * @module @dsh-feishu/dsh-feishu/i18n
 */

import { enMessages } from './en-US.js';
import { zhMessages } from './zh-CN.js';

/** The locales the plugin ships. */
export type Locale = 'en-US' | 'zh-CN';

/** Every catalog's locale → its messages. */
const CATALOGS: Record<Locale, Record<string, string>> = {
  'en-US': enMessages,
  'zh-CN': zhMessages,
};

/** All locales that have a catalog (the accepted `locale` config values). */
export const LOCALES: readonly Locale[] = ['en-US', 'zh-CN'];

/** A message key (every dot-path in the base `en-US` catalog). */
export type MessageKey = keyof typeof enMessages & string;

/**
 * Translate one key: look it up in the translator's locale and interpolate
 * the `{name}` params. Fails loud on an unknown key.
 * @param key - the message key.
 * @param params - interpolation values for the value's `{name}` tokens.
 * @returns the localized string with parameters substituted.
 * @throws when the key is absent from the translator's catalog.
 */
export type Translator = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

/**
 * Extract the `{name}` placeholder names from one message value.
 * Exposed for the parity test (and future tooling), not for rendering.
 * @param value - a raw catalog value.
 * @returns the distinct placeholder names in first-appearance order.
 */
export function placeholderNames(value: string): readonly string[] {
  const names: string[] = [];
  for (const match of value.matchAll(/\{(\w+)\}/g)) {
    if (!names.includes(match[1] ?? '')) names.push(match[1] ?? '');
  }
  return names;
}

/**
 * Substitute `{name}` tokens with the given params. A token without a
 * param is left verbatim so the breakage is visible in the UI instead of
 * silently vanishing.
 * @param value - the template with `{name}` tokens.
 * @param params - values to substitute (stringified as-is).
 * @returns the substituted string.
 */
function interpolate(value: string, params: Readonly<Record<string, string | number>>): string {
  return value.replace(/\{(\w+)\}/g, (token, name: string) =>
    name in params ? String(params[name]) : token,
  );
}

/**
 * Build a translator bound to one locale. The returned function is the only
 * seam UI code needs; construction validates the locale against the shipped
 * catalogs so a typo fails at boot, not mid-render.
 * @param locale - the locale to translate into.
 * @returns the translator for that locale.
 * @throws when no catalog exists for the locale.
 */
export function createTranslator(locale: Locale): Translator {
  const catalog = CATALOGS[locale];
  if (catalog === undefined) {
    throw new Error(`i18n: no message catalog for locale "${locale}"`);
  }
  return (key, params) => {
    const value = catalog[key];
    // Fail loud: an unknown key is a programming/misconfiguration error, and
    // silently echoing it would ship broken UI (misconfiguration rule).
    if (value === undefined) {
      throw new Error(`i18n: unknown message key "${key}" (locale ${locale})`);
    }
    return params === undefined ? value : interpolate(value, params);
  };
}

/** Is the value one of the shipped locales (config validation helper)? */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && value in CATALOGS;
}

/**
 * The ACTIVE translator, defaulted to `en-US` so the bare import never
 * throws. One dsh process hosts ONE feishu surface, so the module-level
 * default set once at boot (`apply`) is the whole lifecycle — there is no
 * per-request locale and no re-entry after boot.
 */
let active: Translator = createTranslator('en-US');

/**
 * Set the process-wide locale. Called ONCE from `apply()` after the config
 * resolves; later calls replace the translator wholesale (tests may also use
 * this to render a specific locale).
 * @param locale - the locale all subsequent `t()` calls translate into.
 */
export function setActiveLocale(locale: Locale): void {
  active = createTranslator(locale);
}

/**
 * Translate through the ACTIVE translator (see {@link setActiveLocale}).
 * UI modules import this `t` — no parameter threading through builder
 * signatures; production always sets the locale explicitly at boot, and the
 * `en-US` default keeps every existing literal assertion valid.
 */
export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  return active(key, params);
}
