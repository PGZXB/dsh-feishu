/**
 * Unit tests for the pure card-rendering helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  assistantText,
  buildCard,
  buildPanelCard,
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
  it('emits a schema-2.0 card with header template by status', () => {
    const card = buildCard({
      title: 'T',
      content: 'body',
      toolLines: [],
      status: 'working',
    });
    expect(card.schema).toBe('2.0');
    expect(card.header?.title.content).toBe('T');
    expect(card.header?.template).toBe('blue');
    expect(card.body.elements[0]).toEqual({ tag: 'markdown', content: 'body' });
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
    expect(card.body.elements.some((el) => el.tag === 'markdown' && el.content === '🔧 bash')).toBe(
      true,
    );
  });
});
describe('card buttons', () => {
  it('shows only the stop button while working', () => {
    const card = buildCard({ title: 'T', content: 'x', toolLines: [], status: 'working' });
    const action = card.body.elements.find((el) => el.tag === 'action');
    expect(action && 'actions' in action ? action.actions.map((a) => a.text.content) : []).toEqual([
      '⏹ Stop',
    ]);
  });

  it('shows copy/retry/panel when done', () => {
    const card = buildCard({ title: 'T', content: 'x', toolLines: [], status: 'done' });
    const action = card.body.elements.find((el) => el.tag === 'action');
    const labels = action && 'actions' in action ? action.actions.map((a) => a.text.content) : [];
    expect(labels).toEqual(['📋 Copy', '🔁 Retry', '⚙️ Panel']);
  });
});

describe('buildPanelCard', () => {
  it('emits a control card with the operation buttons', () => {
    const card = buildPanelCard('**Idle** — send a message.');
    expect(card.header?.title.content).toBe('⚙️ dsh-feishu panel');
    const action = card.body.elements.find((el) => el.tag === 'action');
    expect(action && 'actions' in action ? action.actions.length : 0).toBe(3);
  });
});
