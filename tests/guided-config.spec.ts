/**
 * Unit tests for the guided setup prompts: the answer-to-config merge is
 * pure and fully covered; prompting itself only runs on a TTY (non-TTY
 * runs return no answers so CI/scripts never block).
 */

import { describe, expect, it } from 'vitest';
import { mergeGuidedConfig, promptGuidedConfig } from '../src/setup/guided-config.js';

const DEFAULTS = {
  repoRoots: ['/home/me'],
  groupMentionMode: 'always' as const,
  requireWorkingDir: true,
};

describe('mergeGuidedConfig', () => {
  it('keeps defaults on empty answers (Enter = default)', () => {
    expect(mergeGuidedConfig({}, DEFAULTS)).toEqual(DEFAULTS);
    expect(
      mergeGuidedConfig({ repoRoots: '', groupMentionMode: '', requireWorkingDir: '' }, DEFAULTS),
    ).toEqual(DEFAULTS);
  });

  it('parses a comma-separated repoRoots answer', () => {
    expect(mergeGuidedConfig({ repoRoots: ' /a, /b, ' }, DEFAULTS).repoRoots).toEqual(['/a', '/b']);
  });

  it('accepts a valid mention mode and rejects an invalid one', () => {
    expect(mergeGuidedConfig({ groupMentionMode: 'never' }, DEFAULTS).groupMentionMode).toBe(
      'never',
    );
    expect(mergeGuidedConfig({ groupMentionMode: 'bogus' }, DEFAULTS).groupMentionMode).toBe(
      'always',
    );
  });

  it('accepts a valid locale and falls back to the default otherwise', () => {
    expect(mergeGuidedConfig({ locale: 'zh-CN' }, DEFAULTS).locale).toBe('zh-CN');
    expect(mergeGuidedConfig({ locale: 'en-us' }, DEFAULTS).locale).toBe('en-US');
    expect(mergeGuidedConfig({ locale: 'fr' }, DEFAULTS).locale).toBeUndefined();
    expect(mergeGuidedConfig({ locale: '' }, DEFAULTS).locale).toBeUndefined();
  });

  it('parses y/n/yes/no and falls back to the default otherwise', () => {
    expect(mergeGuidedConfig({ requireWorkingDir: 'n' }, DEFAULTS).requireWorkingDir).toBe(false);
    expect(mergeGuidedConfig({ requireWorkingDir: 'yes' }, DEFAULTS).requireWorkingDir).toBe(true);
    expect(mergeGuidedConfig({ requireWorkingDir: 'maybe' }, DEFAULTS).requireWorkingDir).toBe(
      true,
    );
  });
});

describe('promptGuidedConfig', () => {
  it('returns no answers when stdin is not a TTY (CI / scripts)', async () => {
    // The test runner's stdin is not a TTY — the prompts must not block.
    const answers = await promptGuidedConfig(DEFAULTS);
    expect(answers).toEqual({});
  });
});
