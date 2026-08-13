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
  truncateTail,
} from '../../src/cards/render.js';

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
    expect(action && 'actions' in action ? action.actions.map((a) => a.text.content) : []).toEqual([
      '⏹ Stop',
    ]);
  });

  it('shows copy/retry/panel when done', () => {
    const card = buildCard({ title: 'T', content: 'x', toolLines: [], status: 'done' });
    const action = card.elements.find((el) => el.tag === 'action');
    const labels = action && 'actions' in action ? action.actions.map((a) => a.text.content) : [];
    expect(labels).toEqual(['📋 Copy', '🔁 Retry', '⚙️ Panel']);
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
  it('emits a dropdown and a manual-path form', () => {
    const card = buildRepoPickerCard(['/work/a', '/work/b']);
    // The select and the manual input live inside form elements.
    const nested = card.elements.flatMap((el) => (el.tag === 'form' ? el.elements : []));
    const selects = nested.filter((el) => el.tag === 'select_static');
    expect(selects).toHaveLength(1);
    expect(selects[0] && 'options' in selects[0] ? selects[0].options.length : 0).toBe(2);
    const inputs = nested.filter((el) => el.tag === 'input');
    expect(inputs.some((el) => el.tag === 'input' && el.name === 'repo_manual')).toBe(true);
  });
});
