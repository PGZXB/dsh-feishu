/**
 * Unit tests for the pure card-rendering helpers.
 */

import { describe, expect, it } from 'vitest';
import { markdownToElements } from '../../src/cards/markdown.js';
import {
  assistantText,
  buildCard,
  buildPanelCard,
  buildRepoPickedCard,
  buildRepoPickerCard,
  buildToolDetailsCard,
  REPO_SELECT_MAX_OPTIONS,
  repoOptionLabel,
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
      thinking: '',
      tools: [],
      status: 'working',
    });
    // The v1 root-elements layout is used deliberately so the card can carry
    // interactive action buttons (schema 2.0 rejects the action tag).
    expect(card.schema).toBeUndefined();
    expect(card.header?.title.content).toBe('T');
    expect(card.header?.template).toBe('blue');
  });

  it('uses green for done and red for error', () => {
    expect(
      buildCard({ title: 'T', content: '', thinking: '', tools: [], status: 'done' }).header
        ?.template,
    ).toBe('green');
    expect(
      buildCard({ title: 'T', content: '', thinking: '', tools: [], status: 'error' }).header
        ?.template,
    ).toBe('red');
  });

  it('renders tool records as compact lines in order', () => {
    const card = buildCard({
      title: 'T',
      content: '',
      thinking: '',
      tools: [
        { name: 'bash', status: 'running', args: '{}', result: '' },
        { name: 'grep', status: 'done', args: '{}', result: 'ok' },
        { name: 'ls', status: 'error', args: '{}', result: 'boom' },
      ],
      status: 'working',
    });
    const lines = card.elements
      .filter((el) => el.tag === 'markdown' && typeof el.content === 'string')
      .map((el) => (el.tag === 'markdown' ? el.content : ''));
    expect(lines).toContain('🔧 bash');
    expect(lines).toContain('✅ grep');
    expect(lines).toContain('❌ ls');
  });

  it('renders thinking first, dimmed, then the final output last', () => {
    const card = buildCard({
      title: 'T',
      content: 'final answer',
      thinking: 'let me think',
      tools: [{ name: 'bash', status: 'done', args: '{}', result: 'ok' }],
      status: 'done',
    });
    const markdowns = card.elements.filter((el) => el.tag === 'markdown') as Extract<
      CardElement,
      { tag: 'markdown' }
    >[];
    const contents = markdowns.map((el) => el.content);
    const thinkingIdx = contents.findIndex((c) => c.includes('let me think'));
    const toolIdx = contents.findIndex((c) => c.includes('✅ bash'));
    const answerIdx = contents.findIndex((c) => c === 'final answer');
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThan(thinkingIdx);
    expect(answerIdx).toBeGreaterThan(toolIdx);
  });

  it('renders the final output as markdown (headings become bold)', () => {
    const card = buildCard({
      title: 'T',
      content: '# Hello\n\nsome **bold** text',
      thinking: '',
      tools: [],
      status: 'done',
    });
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    const joined = markdowns.map((el) => el.content).join('\n');
    expect(joined).toContain('**Hello**');
    expect(joined).toContain('**bold**');
    expect(joined).not.toContain('# Hello');
  });

  it('shows a tools button when the turn invoked tools', () => {
    const card = buildCard({
      title: 'T',
      content: 'done',
      thinking: '',
      tools: [{ name: 'bash', status: 'done', args: '{}', result: 'ok' }],
      status: 'done',
    });
    const action = card.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(action)).toContain('🔧 Tools');
  });
});

describe('markdownToElements', () => {
  it('converts headings to bold and keeps code fences', () => {
    const elements = markdownToElements('# Title\n\n```js\nconst x = 1;\n```');
    const markdowns = elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    const joined = markdowns.map((el) => el.content).join('\n');
    expect(joined).toContain('**Title**');
    expect(joined).toContain('```js');
  });

  it('emits an hr element for thematic breaks', () => {
    const elements = markdownToElements('a\n\n---\n\nb');
    expect(elements.some((el) => el.tag === 'hr')).toBe(true);
  });

  it('returns an empty array for empty input', () => {
    expect(markdownToElements('')).toEqual([]);
  });
});

describe('card buttons', () => {
  it('shows only the stop button while working', () => {
    const card = buildCard({
      title: 'T',
      content: 'x',
      thinking: '',
      tools: [],
      status: 'working',
    });
    const action = card.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(action)).toEqual(['⏹ Stop']);
  });

  it('shows copy/retry/panel when done', () => {
    const card = buildCard({ title: 'T', content: 'x', thinking: '', tools: [], status: 'done' });
    const action = card.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(action)).toEqual(['📋 Copy', '🔁 Retry', '⚙️ Panel']);
  });
});

describe('buildToolDetailsCard', () => {
  it('lists each tool call with args and result', () => {
    const card = buildToolDetailsCard('My turn', [
      { name: 'bash', status: 'done', args: '{"cmd":"ls"}', result: 'file.txt' },
    ]);
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[0]?.content).toContain('✅ **1. bash**');
    expect(markdowns[1]?.content).toContain('args:');
    expect(markdowns[2]?.content).toContain('result:');
  });

  it('handles a turn with no tools', () => {
    const card = buildToolDetailsCard('T', []);
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[0]?.content).toContain('No tool calls');
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

  it('disambiguates duplicate basenames with a path suffix', () => {
    const card = buildRepoPickerCard([
      { name: 'repo', path: '/work/a/repo', type: 'repo', branch: 'main' },
      { name: 'repo', path: '/work/b/repo', type: 'repo', branch: 'main' },
    ]);
    const action = card.elements.find((el) => el.tag === 'action');
    const select = selectOf(action);
    const labels = select?.options.map((o) => o.text.content) ?? [];
    expect(labels[0]).toContain('a/repo');
    expect(labels[1]).toContain('b/repo');
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

describe('buildRepoPickedCard', () => {
  it('emits a static confirmation card with no action buttons', () => {
    const card = buildRepoPickedCard('/work/a');
    expect(card.elements.some((el) => el.tag === 'action')).toBe(false);
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[0]?.content).toContain('/work/a');
  });
});

describe('repoOptionLabel', () => {
  it('keeps short labels for unique names', () => {
    const label = repoOptionLabel(
      { name: 'a', path: '/work/a', type: 'repo', branch: 'main' },
      new Set(),
      '/work',
    );
    expect(label).toBe('a (main)');
  });

  it('appends a relative path for duplicate names', () => {
    const label = repoOptionLabel(
      { name: 'a', path: '/work/x/a', type: 'repo', branch: 'main' },
      new Set(['a']),
      '/work',
    );
    expect(label).toBe('a (main) — x/a');
  });
});
