/**
 * Unit tests for the /sessions picker card builder and its row helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  ageLabel,
  buildSessionsCard,
  SESSION_SELECT_MAX,
  type SessionRowView,
  sessionRowLine,
} from '../../src/cards/session-list.js';
import type { CardElement } from '../../src/feishu/types.js';

/** The option rows of the sessions dropdown (a no-op when the element is
 *  not the select action — tests pass the filtered element). */
function dropdownOptions(element: CardElement | undefined) {
  if (element === undefined || !('actions' in element)) return [];
  const action = element.actions[0];
  if (action === undefined || action.tag !== 'select_static') return [];
  return action.options;
}

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

  it('renders a dropdown with one option per session and the archive toggle', () => {
    const card = buildSessionsCard([
      row({ sessionId: 'a', title: 'A' }),
      row({ sessionId: 'b', title: 'B', current: true }),
    ]);
    const selects = card.elements.filter(
      (el) => el.tag === 'action' && 'actions' in el && el.actions[0]?.tag === 'select_static',
    );
    expect(selects).toHaveLength(1);
    const select = selects[0];
    expect(select && 'actions' in select ? select.actions[0] : undefined).toMatchObject({
      tag: 'select_static',
      placeholder: { tag: 'plain_text', content: 'Choose a session…' },
    });
    const options = dropdownOptions(select);
    expect(options.map((o) => o.value)).toEqual(['a', 'b']);
    // The current/live badges survive in the option label (row b is current).
    expect(options.map((o) => o.text.content)).toEqual(['A · a', 'B ★ · b']);
    // The marker stamps the dropdown kind; the chosen id arrives in `option`.
    const marker = select && 'actions' in select ? select.actions[0]?.value : undefined;
    expect(marker).toMatchObject({ kind: 'session-select' });
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
    const archived = buildSessionsCard([row({ sessionId: 'a', title: 'A' })], true);
    expect(JSON.stringify(archived.elements)).toContain('Active sessions');
  });

  it('caps the dropdown at SESSION_SELECT_MAX and notes the remainder, with no page nav', () => {
    const many = Array.from({ length: SESSION_SELECT_MAX + 5 }, (_, index) =>
      row({ sessionId: `s${index}`, title: `S${index}` }),
    );
    const card = buildSessionsCard(many);
    const selects = card.elements.filter(
      (el) => el.tag === 'action' && 'actions' in el && el.actions[0]?.tag === 'select_static',
    );
    const options = dropdownOptions(selects[0]);
    expect(options).toHaveLength(SESSION_SELECT_MAX);
    expect(
      card.elements.some(
        (el) =>
          el.tag === 'note' &&
          'elements' in el &&
          el.elements[0]?.content.includes(`${many.length - SESSION_SELECT_MAX} more`),
      ),
    ).toBe(true);
    // The dropdown view has exactly the archive toggle, Find, and Back —
    // no page nav.
    const nav = card.elements.flatMap((el) =>
      el.tag === 'action'
        ? el.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : [],
    );
    expect(nav).toEqual(['🗄️ Archived', '🔎 Find session', '⬅ Back']);
  });
});
