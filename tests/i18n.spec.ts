/**
 * i18n engine + catalog parity tests.
 *
 * The parity checks are the load-bearing part: key sets and placeholder
 * names must match across catalogs, so a translation added to one locale
 * only (or one that renames an interpolation token) fails here even though
 * the compile-time `Record<MessageKey, string>` check already catches the
 * key-set half.
 *
 * @module tests/i18n.spec
 */

import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  isLocale,
  LOCALES,
  placeholderNames,
  type Translator,
} from '../src/i18n/index.js';
import { enMessages } from '../src/i18n/en-US.js';
import { zhMessages } from '../src/i18n/zh-CN.js';

describe('catalog parity', () => {
  it('has the exact same key set in every locale', () => {
    const enKeys = Object.keys(enMessages).sort();
    const zhKeys = Object.keys(zhMessages).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('uses the same placeholder names in both locales for every key', () => {
    const mismatches: string[] = [];
    for (const key of Object.keys(enMessages)) {
      const en = placeholderNames(enMessages[key as keyof typeof enMessages]);
      const zh = placeholderNames(zhMessages[key as keyof typeof zhMessages]);
      if (en.join(',') !== zh.join(',')) mismatches.push(`${key}: en{${en}} vs zh{${zh}}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('never ships an empty translation', () => {
    for (const [key, value] of Object.entries(zhMessages)) {
      expect(value.trim(), `zh value for ${key} must be non-empty`).not.toBe('');
    }
  });

  it('keeps emoji prefixes consistent across locales', () => {
    // The visual language must not drift: a label that starts with an emoji
    // in en starts with the SAME first emoji in zh.
    const drifted: string[] = [];
    for (const [key, en] of Object.entries(enMessages)) {
      const zh = zhMessages[key as keyof typeof zhMessages];
      const enEmoji = en.match(/^\p{Extended_Pictographic}/u)?.[0];
      const zhEmoji = zh.match(/^\p{Extended_Pictographic}/u)?.[0];
      if (enEmoji !== zhEmoji) drifted.push(key);
    }
    expect(drifted).toEqual([]);
  });
});

describe('placeholderNames', () => {
  it('extracts distinct names in order', () => {
    expect(placeholderNames('{a} and {b} and {a}')).toEqual(['a', 'b']);
  });

  it('returns empty when there are no tokens', () => {
    expect(placeholderNames('plain text')).toEqual([]);
  });
});

describe('createTranslator', () => {
  it('returns base values verbatim with no params', () => {
    const t = createTranslator('en-US');
    expect(t('card.button.stopTurn')).toBe('⏹ Stop turn');
  });

  it('interpolates string and number params in en-US', () => {
    const t = createTranslator('en-US');
    expect(t('card.stats.turns', { count: 3 })).toBe('3 turns');
    expect(t('card.row.steerLine', { preview: 'hi' })).toBe('💬 Steer · hi');
  });

  it('interpolates in zh-CN', () => {
    const t = createTranslator('zh-CN');
    expect(t('card.button.stopTurn')).toBe('⏹ 停止回复');
    expect(t('card.stats.turns', { count: 3 })).toBe('3 轮');
    expect(t('error.turnFailed', { error: 'boom' })).toBe('⚠️ 回复失败：boom');
  });

  it('leaves an unsubstituted token verbatim (visible breakage)', () => {
    const t = createTranslator('en-US');
    // A missing param must stay visible in the UI instead of vanishing.
    expect(t('card.stats.turns')).toBe('{count} turns');
  });

  it('throws loud on an unknown key (misconfiguration rule)', () => {
    const t = createTranslator('en-US');
    expect(() => t('card.button.nope' as Parameters<Translator>[0])).toThrowError(
      /unknown message key "card\.button\.nope" \(locale en-US\)/,
    );
  });

  it('gives each locale its own translator instance with its catalog', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale);
      // Any real key resolves non-empty on BOTH locales.
      expect(t('panel.loading').length).toBeGreaterThan(0);
    }
    expect(createTranslator('en-US')('common.untitled')).toBe('(untitled)');
    expect(createTranslator('zh-CN')('common.untitled')).toBe('（未命名）');
  });

  it('throws on a locale with no catalog', () => {
    expect(() => createTranslator('fr-FR' as never)).toThrowError(/no message catalog/);
  });
});

describe('isLocale', () => {
  it('accepts exactly the shipped locales', () => {
    expect(isLocale('en-US')).toBe(true);
    expect(isLocale('zh-CN')).toBe(true);
  });

  it('rejects other values loudly-ish (config validation)', () => {
    expect(isLocale('fr-FR')).toBe(false);
    expect(isLocale(42)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
