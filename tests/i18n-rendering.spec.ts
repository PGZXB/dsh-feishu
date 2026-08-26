import { describe, expect, it } from 'vitest';
import { buildApprovalCard, buildStatusCard } from '../src/cards/render.js';
import { friendlyTurnError } from '../src/cards/StreamingCardController.js';
import { buildSessionsCard, type SessionRowView } from '../src/cards/session-list.js';
import { createTranslator, setActiveLocale } from '../src/i18n/index.js';
import { panelConfirmCopy, panelInputCopy } from '../src/panel/types.js';

/**
 * Targeted zh-CN rendering checks: flip the ACTIVE locale and assert the
 * translated copy actually comes out (en-US byte-identity is covered by the
 * rest of the suite running under the default locale). Every test restores
 * `en-US` so neighboring spec files stay unaffected.
 */

const ROW: SessionRowView = {
  sessionId: 'feishu-session-1',
  title: undefined,
  cwd: undefined,
  createdAt: Date.now(),
  live: false,
  persisted: true,
  current: true,
};

describe('i18n zh-CN rendering', () => {
  it('renders the working-directory gate refusal in Chinese', () => {
    const zh = createTranslator('zh-CN');
    const text = zh('gate.workingDirRequired');
    expect(text).toContain('工作目录');
    expect(text).toContain('/repo');
    expect(text).toContain('/cd');
    expect(text.startsWith('⚠️')).toBe(true);
  });

  it('keeps friendlyTurnError raw; only the empty fallback localizes', () => {
    // en fallback
    expect(friendlyTurnError({ message: '' })).toBe('The turn failed with an unspecified error.');
    // raw `code: message` is locale-independent by design
    setActiveLocale('zh-CN');
    try {
      expect(friendlyTurnError({ code: 'boom', message: 'exploded' })).toBe('boom: exploded');
      expect(friendlyTurnError({ message: '' })).toBe(constZh('error.unspecified'));
    } finally {
      setActiveLocale('en-US');
    }
  });

  it('renders the sessions picker in Chinese under the active locale', () => {
    const enCard = JSON.stringify(buildSessionsCard([ROW]));
    setActiveLocale('zh-CN');
    try {
      const zhCard = JSON.stringify(buildSessionsCard([ROW]));
      expect(zhCard).toContain('会话');
      expect(zhCard).toContain('★');
      expect(zhCard).toContain('选择会话');
      expect(enCard).not.toContain('选择会话');
    } finally {
      setActiveLocale('en-US');
    }
  });

  it('translates the approval card buttons and body in Chinese', () => {
    setActiveLocale('zh-CN');
    try {
      const card = JSON.stringify(buildApprovalCard('bash', 'why', 'req-1'));
      expect(card).toContain('允许一次');
      expect(card).toContain('拒绝');
      expect(card).toContain('想要执行：');
    } finally {
      setActiveLocale('en-US');
    }
  });

  it('localizes the status-card connection labels in Chinese', () => {
    setActiveLocale('zh-CN');
    try {
      const card = JSON.stringify(
        buildStatusCard({
          appId: 'cli_a1',
          connection: 'ready',
          sessionCount: 2,
          lastInboundAt: Date.now(),
        }),
      );
      expect(card).toContain('📊 dsh-feishu 状态');
      expect(card).toContain('✅ 正常');
    } finally {
      setActiveLocale('en-US');
    }
  });

  it('resolves panel input/confirm copy per locale at call time', () => {
    expect(panelInputCopy('cd').title).toBe(createTranslator('en-US')('command.input.cd.title'));
    setActiveLocale('zh-CN');
    try {
      expect(panelInputCopy('cd').title).toBe(constZh('command.input.cd.title'));
      // The static field name stays stable across locales.
      expect(panelInputCopy('cd').fieldName).toBe('path');
      expect(panelConfirmCopy('compact').message).toBe(constZh('command.confirm.compact.message'));
    } finally {
      setActiveLocale('en-US');
    }
  });
});

/** The zh-CN translator, resolved fresh (value source for expectations). */
function constZh(key: Parameters<ReturnType<typeof createTranslator>>[0]): string {
  return createTranslator('zh-CN')(key);
}
