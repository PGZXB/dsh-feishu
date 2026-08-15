/**
 * Unit tests for the /sessions picker card builder and its row helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  ageLabel,
  buildSessionsCard,
  SESSION_PAGE_SIZE,
  type SessionRowView,
  sessionRowLine,
} from '../../src/cards/session-list.js';

function row(overrides: Partial<SessionRowView> = {}): SessionRowView {
  return {
    sessionId: 'feishu-session-1',
    title: 'My project',
    cwd: '/work/my-project',
    createdAt: Date.now() - 3_600_000,
    live: false,
    persisted: true,
    current: false,
    ...overrides,
  };
}

describe('ageLabel', () => {
  it('returns empty for unknown timestamps', () => {
    expect(ageLabel(0, 1_700_000_000_000)).toBe('');
    expect(ageLabel(-5, 1_700_000_000_000)).toBe('');
  });

  it('labels minutes, hours, and days', () => {
    const now = 1_700_000_000_000;
    expect(ageLabel(now - 30_000, now)).toBe('just now');
    expect(ageLabel(now - 5 * 60_000, now)).toBe('5m ago');
    expect(ageLabel(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(ageLabel(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('sessionRowLine', () => {
  it('renders title, id, cwd, age, and badges', () => {
    const line = sessionRowLine(
      row({ live: true, persisted: true, current: false, createdAt: Date.now() - 60_000 }),
    );
    expect(line).toContain('**My project**');
    expect(line).toContain('`feishu-session-1`');
    expect(line).toContain('/work/my-project');
    expect(line).toContain('● live');
    expect(line).toContain('💾 saved');
  });

  it('marks the current session and hides nothing', () => {
    const line = sessionRowLine(row({ current: true }));
    expect(line).toContain('★ current');
  });

  it('strips angle brackets from titles', () => {
    const line = sessionRowLine(row({ title: 'a <b> c', cwd: undefined, createdAt: 0 }));
    expect(line).toContain('**a b c**');
  });

  it('falls back to untitled when the title is missing', () => {
    const line = sessionRowLine(row({ title: undefined, cwd: undefined, createdAt: 0 }));
    expect(line).toContain('(untitled)');
  });
});

describe('buildSessionsCard', () => {
  it('shows the empty state with no rows', () => {
    const card = buildSessionsCard([]);
    expect(card.header?.title.content).toBe('🗂️ Sessions');
    expect(
      card.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('No sessions yet'),
      ),
    ).toBe(true);
  });

  it('renders one row per session with a Details button and the archive toggle', () => {
    const card = buildSessionsCard([
      row({ sessionId: 'a', title: 'A' }),
      row({ sessionId: 'b', title: 'B', current: true }),
    ]);
    const rows = card.elements.filter((el) => el.tag === 'column_set');
    expect(rows).toHaveLength(2);
    // Every row carries a Details button with the session id payload.
    const expectedIds = ['a', 'b'];
    rows.forEach((r, index) => {
      const buttons =
        r && 'columns' in r
          ? r.columns.flatMap((column) =>
              column.elements.filter((element) => element.tag === 'button'),
            )
          : [];
      expect(buttons).toHaveLength(1);
      expect(buttons[0] && 'value' in buttons[0] ? buttons[0].value.kind : undefined).toBe(
        'session-select',
      );
      expect(buttons[0] && 'value' in buttons[0] ? buttons[0].value.sessionId : undefined).toBe(
        expectedIds[index],
      );
    });
    // The archive toggle row is present.
    expect(
      card.elements.some(
        (el) =>
          el.tag === 'action' &&
          'actions' in el &&
          el.actions.some(
            (a) =>
              'value' in a &&
              (a.value as Record<string, string>).kind === 'sessions-archived-toggle',
          ),
      ),
    ).toBe(true);
    // The archived view flips the toggle label.
    const archived = buildSessionsCard([row({ sessionId: 'a', title: 'A' })], 0, true);
    expect(JSON.stringify(archived.elements)).toContain('Active sessions');
  });

  it('paginates rows and page nav at bounds', () => {
    const many = Array.from({ length: SESSION_PAGE_SIZE + 5 }, (_, index) =>
      row({ sessionId: `s${index}`, title: `S${index}` }),
    );
    const card = buildSessionsCard(many, 0);
    expect(
      card.elements.some(
        (el) =>
          el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page 1/2'),
      ),
    ).toBe(true);
    const nav = card.elements.flatMap((el) =>
      el.tag === 'action'
        ? el.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : [],
    );
    // Row 0: the archive toggle plus the Next nav button plus Back.
    expect(nav).toEqual(['🗄️ Archived', 'Next ›', '⬅ Back']);
    const last = buildSessionsCard(many, 1);
    const lastNav = last.elements.flatMap((el) =>
      el.tag === 'action'
        ? el.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : [],
    );
    expect(lastNav).toEqual(['🗄️ Archived', '‹ Prev', '⬅ Back']);
    // Out-of-range pages clamp to the last page.
    const clamped = buildSessionsCard(many, 99);
    expect(
      clamped.elements.some(
        (el) =>
          el.tag === 'note' && 'elements' in el && el.elements[0]?.content.includes('page 2/2'),
      ),
    ).toBe(true);
  });
});
