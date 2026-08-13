/**
 * Unit tests for the pure card-rendering helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  assistantText,
  buildCard,
  buildPanelCard,
  buildRepoPickerCard,
  escapeMarkdown,
  REPO_SELECT_MAX_OPTIONS,
  truncateTail,
} from '../../src/cards/render.js';
import type { ButtonAction, CardElement, SelectAction } from '../../src/feishu/types.js';

/** Button-only labels of an action element (skips select dropdowns). */
function buttonLabels(el: CardElement | undefined): string[] {
  if (el === undefined || el.tag !== 'action') return [];
  return el.actions.filter((a): a is ButtonAction => a.tag === 'button').map((a) => a.text.content);
}

/** The select dropdown of an action element, if any. */
function selectOf(el: CardElement | undefined): SelectAction | undefined {
  if (el === undefined || el.tag !== 'action') return undefined;
  return el.actions.find((a): a is SelectAction => a.tag === 'select_static');
}

describe('escapeMarkdown', () => {
  it('collapses bold markers', () => {
    expect(escapeMarkdown('a **b** c')).toBe('a *b* c');
  });

  it('leaves plain text untouched', () => {
    expect(escapeMarkdown('hello world')).toBe('hello world');
  });
});

describe('truncateTail', () => {
  it('returns short text unchanged', () => {
    expect(truncateTail('short', 10)).toBe('short');
  });

  it('keeps the newest tail with a truncation marker', () => {
    const text = 'a'.repeat(100);
    const out = truncateTail(text, 40);
    expect(out).toContain('truncated');
    expect(out.endsWith('aaaa')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(45);
  });
});

describe('assistantText', () => {
  it('joins text blocks', () => {
    const blocks = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ] as const;
    expect(assistantText(blocks)).toBe('hello world');
  });
});

describe('buildCard', () => {
  it('emits a v1 card (no schema field) with header template by status', () => {
    const card = buildCard({
      title: 'T',
      content: 'body',
      toolLines: [],
      status: 'working',
    });
    // The v1 root-elements layout is used deliberately so the card can carry
    // interactive action buttons (schema 2.0 rejects the action tag).
    expect(card.schema).toBeUndefined();
    expect(card.header?.title.content).toBe('T');
    expect(card.header?.template).toBe('blue');
    expect(card.elements[0]).toEqual({ tag: 'markdown', content: 'body' });
  });

  it('uses green for done and red for error', () => {
    expect(
      buildCard({ title: 'T', content: '', toolLines: [], status: 'done' }).header?.template,
    ).toBe('green');
    expect(
      buildCard({ title: 'T', content: '', toolLines: [], status: 'error' }).header?.template,
    ).toBe('red');
  });

  it('renders tool lines as markdown elements', () => {
    const card = buildCard({
      title: 'T',
      content: '',
      toolLines: ['🔧 bash'],
      status: 'working',
    });
    expect(card.elements.some((el) => el.tag === 'markdown' && el.content === '🔧 bash')).toBe(
      true,
    );
  });
});
describe('card buttons', () => {
  it('shows only the stop button while working', () => {
    const card = buildCard({ title: 'T', content: 'x', toolLines: [], status: 'working' });
    const action = card.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(action)).toEqual(['⏹ Stop']);
  });

  it('shows copy/retry/panel when done', () => {
    const card = buildCard({ title: 'T', content: 'x', toolLines: [], status: 'done' });
    const action = card.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(action)).toEqual(['📋 Copy', '🔁 Retry', '⚙️ Panel']);
  });
});

describe('buildPanelCard', () => {
  it('emits a control card with the operation buttons', () => {
    const card = buildPanelCard('**Idle** — send a message.');
    expect(card.header?.title.content).toBe('⚙️ dsh-feishu panel');
    const action = card.elements.find((el) => el.tag === 'action');
    expect(action && 'actions' in action ? action.actions.length : 0).toBe(3);
  });
});
describe('buildRepoPickerCard', () => {
  it('renders a select_static dropdown inside an action container', () => {
    const card = buildRepoPickerCard([
      { name: 'a', path: '/work/a', type: 'repo', branch: 'main' },
      { name: 'b', path: '/work/b', type: 'repo', branch: 'dev' },
    ]);
    const action = card.elements.find((el) => el.tag === 'action');
    const select = selectOf(action);
    expect(select).toBeDefined();
    expect(select?.options.map((o) => o.value)).toEqual(['/work/a', '/work/b']);
    expect(select?.value).toEqual({ kind: 'repo-pick' });
  });

  it('labels dropdown options with name, branch, and worktree tag', () => {
    const card = buildRepoPickerCard([
      { name: 'a', path: '/work/a', type: 'repo', branch: 'main' },
      { name: 'b', path: '/work/b', type: 'worktree', branch: 'feature' },
    ]);
    const action = card.elements.find((el) => el.tag === 'action');
    const select = selectOf(action);
    expect(select?.options.map((o) => o.text.content)).toEqual([
      '1. a (main)',
      '2. b (feature) [worktree]',
    ]);
  });

  it('falls back to paginated buttons beyond the dropdown option cap', () => {
    const projects = Array.from(
      { length: REPO_SELECT_MAX_OPTIONS + 2 },
      (_, i) =>
        ({
          name: `p${i}`,
          path: `/work/p${i}`,
          type: 'repo',
          branch: 'main',
        }) as const,
    );
    const card = buildRepoPickerCard(projects, 0);
    const actions = card.elements.filter((el) => el.tag === 'action');
    const last = actions.at(-1);
    expect(buttonLabels(last)).toEqual(['Next ›']);
    const first = actions[0];
    expect(selectOf(first)).toBeUndefined();
    expect(buttonLabels(first).length).toBeGreaterThan(0);
  });
});
