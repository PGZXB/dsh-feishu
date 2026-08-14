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
  buildRowDetailsCard,
  collapseSequence,
  REPO_SELECT_MAX_OPTIONS,
  repoOptionLabel,
  repoRelativePath,
  rowLine,
  truncateTail,
} from '../../src/cards/render.js';
import { toolRowSummary, toolRowTitle } from '../../src/cards/tool-summary.js';
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

/** The one-line lark_md content of a row's text column. */
function rowText(row: CardElement | undefined): string {
  if (row === undefined || row.tag !== 'column_set') return '';
  const text = row.columns[0]?.elements[0];
  return text?.tag === 'div' ? text.text.content : '';
}

/** The ⋯ expand button of a row's button column. */
function rowButton(
  row: CardElement | undefined,
): { content: string; value: Record<string, string> } | undefined {
  if (row === undefined || row.tag !== 'column_set') return undefined;
  const button = row.columns[1]?.elements[0];
  if (button?.tag !== 'button') return undefined;
  return { content: button.text.content, value: button.value };
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

describe('rowLine', () => {
  it('always shows the cloud emoji and Thinking for a think row', () => {
    expect(rowLine({ kind: 'think', id: 't1', text: 'hmm', settled: false })).toBe(
      '☁️ Think · Thinking',
    );
    // Even after the block settles, the line stays minimal.
    expect(rowLine({ kind: 'think', id: 't1', text: 'first line\nsecond', settled: true })).toBe(
      '☁️ Think · Thinking',
    );
  });

  it('renders a tool row as Title · summary with status icon', () => {
    const row = {
      kind: 'tool' as const,
      id: 'c1',
      name: 'bash',
      status: 'done' as const,
      summary: 'ls -la',
      args: '{"command":"ls -la"}',
      result: '',
    };
    expect(rowLine(row)).toBe('✅ Bash · ls -la');
  });

  it('uses the stored summary even when the args were truncated', () => {
    // A long command truncates mid-JSON; the summary was computed from the
    // full arguments at capture time and must not degrade to the raw JSON.
    const row = {
      kind: 'tool' as const,
      id: 'c1',
      name: 'bash',
      status: 'running' as const,
      summary: 'export DOCKER_HOST=unix:///run/user/1001/docker.sock',
      args: '{"command":"export DOCKER_HOST=unix:///run/u',
      result: '',
    };
    expect(rowLine(row)).toBe('🔧 Bash · export DOCKER_HOST=unix:///run/user/1001/docker.sock');
  });
});

describe('collapseSequence', () => {
  it('joins think and tool names with ->', () => {
    const rows = [
      { kind: 'think' as const, id: 't1', text: '', settled: false },
      {
        kind: 'tool' as const,
        id: 'c1',
        name: 'bash',
        status: 'done' as const,
        summary: '',
        args: '',
        result: '',
      },
      {
        kind: 'tool' as const,
        id: 'c2',
        name: 'read',
        status: 'done' as const,
        summary: '',
        args: '',
        result: '',
      },
    ];
    expect(collapseSequence(rows)).toBe('think -> bash -> read');
  });

  it('caps long sequences with an ellipsis', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      kind: 'tool' as const,
      id: `c${i}`,
      name: `t${i}`,
      status: 'done' as const,
      summary: '',
      args: '',
      result: '',
    }));
    const seq = collapseSequence(rows, 3);
    expect(seq).toBe('t0 -> t1 -> t2 …');
  });
});

describe('buildCard', () => {
  it('emits a v1 card (no schema field) with header template by status', () => {
    const card = buildCard({ title: 'T', content: 'body', rows: [], status: 'working' });
    // The v1 root-elements layout is used deliberately so the card can carry
    // interactive action buttons (schema 2.0 rejects the action tag).
    expect(card.schema).toBeUndefined();
    expect(card.header?.title.content).toBe('T');
    expect(card.header?.template).toBe('blue');
  });

  it('uses green for done and red for error', () => {
    expect(buildCard({ title: 'T', content: '', rows: [], status: 'done' }).header?.template).toBe(
      'green',
    );
    expect(buildCard({ title: 'T', content: '', rows: [], status: 'error' }).header?.template).toBe(
      'red',
    );
  });

  it('renders think/tool rows in chronological order with expand buttons', () => {
    const card = buildCard({
      title: 'T',
      content: '',
      rows: [
        { kind: 'think', id: 't1', text: 'hmm', settled: true },
        {
          kind: 'tool',
          id: 'c1',
          name: 'bash',
          status: 'done',
          summary: 'ls',
          args: '{"command":"ls"}',
          result: '',
        },
        {
          kind: 'tool',
          id: 'c2',
          name: 'read',
          status: 'error',
          summary: 'a.txt',
          args: '{"path":"a.txt"}',
          result: '',
        },
      ],
      status: 'done',
    });
    const rows = card.elements.filter((el) => el.tag === 'column_set');
    expect(rows).toHaveLength(3);
    expect(rowText(rows[0])).toBe('☁️ Think · Thinking');
    expect(rowText(rows[1])).toContain('✅ Bash');
    expect(rowText(rows[2])).toContain('❌ Read');
    expect(rowButton(rows[0])?.content).toBe('⋯');
    expect(rowButton(rows[1])?.value).toEqual({ kind: 'row-details', id: 'c1' });
  });

  it('collapsed mode renders one sequence line with an expand toggle', () => {
    const card = buildCard({
      title: 'T',
      content: 'done',
      rows: [
        { kind: 'think', id: 't1', text: 'hmm', settled: true },
        {
          kind: 'tool',
          id: 'c1',
          name: 'bash',
          status: 'done',
          summary: '',
          args: '{}',
          result: '',
        },
        {
          kind: 'tool',
          id: 'c2',
          name: 'read',
          status: 'done',
          summary: '',
          args: '{}',
          result: '',
        },
      ],
      collapsed: true,
      status: 'done',
    });
    const sequence = card.elements.find(
      (el): el is Extract<CardElement, { tag: 'markdown' }> =>
        el.tag === 'markdown' && el.content.includes(' -> '),
    );
    expect(sequence?.content).toBe('think -> bash -> read');
    expect(card.elements.filter((el) => el.tag === 'column_set')).toHaveLength(0);
    const action = card.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(action)).toContain('▸ Expand');
  });

  it('expanded mode shows the collapse toggle when rows exist', () => {
    const card = buildCard({
      title: 'T',
      content: 'done',
      rows: [
        {
          kind: 'tool',
          id: 'c1',
          name: 'bash',
          status: 'done',
          summary: '',
          args: '{}',
          result: '',
        },
      ],
      status: 'done',
    });
    const action = card.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(action)).toContain('▾ Collapse');
  });

  it('renders the complete output at the bottom as markdown', () => {
    const card = buildCard({
      title: 'T',
      content: '# Hello\n\nsome **bold** text',
      rows: [{ kind: 'think', id: 't1', text: 'hmm', settled: true }],
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

  it('shows copy/retry/panel plus the rows toggle when done', () => {
    const card = buildCard({
      title: 'T',
      content: 'done',
      rows: [
        {
          kind: 'tool',
          id: 'c1',
          name: 'bash',
          status: 'done',
          summary: '',
          args: '{}',
          result: 'ok',
        },
      ],
      status: 'done',
    });
    const action = card.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(action)).toEqual(['📋 Copy', '🔁 Retry', '⚙️ Panel', '▾ Collapse']);
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
    const card = buildCard({ title: 'T', content: 'x', rows: [], status: 'working' });
    const action = card.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(action)).toEqual(['⏹ Stop']);
  });
});

describe('buildRowDetailsCard', () => {
  it('shows the full reasoning in a code block for a think row', () => {
    const card = buildRowDetailsCard({
      kind: 'think',
      id: 't1',
      text: 'full reasoning',
      settled: true,
    });
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[0]?.content).toBe('```\nfull reasoning\n```');
  });

  it('shows formatted JSON input and code-blocked output for a tool row', () => {
    const card = buildRowDetailsCard({
      kind: 'tool',
      id: 'c1',
      name: 'bash',
      status: 'done',
      summary: 'ls',
      args: '{"command":"ls","n":1}',
      result: 'file.txt',
    });
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[0]?.content).toContain('Bash');
    // IN: pretty-printed JSON inside a json fence.
    expect(markdowns[1]?.content).toContain('IN');
    expect(markdowns[1]?.content).toContain('```json');
    expect(markdowns[1]?.content).toContain('  "command": "ls",');
    // OUT: fenced result.
    expect(markdowns[2]?.content).toContain('OUT');
    expect(markdowns[2]?.content).toContain('```');
  });

  it('handles unparseable args as raw text', () => {
    const card = buildRowDetailsCard({
      kind: 'tool',
      id: 'c1',
      name: 'bash',
      status: 'done',
      summary: '{not json',
      args: '{not json',
      result: '',
    });
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[1]?.content).toContain('{not json');
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

describe('repo relative paths', () => {
  it('labels options with the repoRoot-relative path, not the basename', () => {
    const roots = ['/work'];
    const card = buildRepoPickerCard(
      [
        { name: 'source', path: '/work/a/source', type: 'repo', branch: 'main' },
        { name: 'source', path: '/work/b/source', type: 'repo', branch: 'dev' },
      ],
      roots,
    );
    const action = card.elements.find((el) => el.tag === 'action');
    const select = selectOf(action);
    const labels = select?.options.map((o) => o.text.content) ?? [];
    expect(labels).toEqual(['1. a/source (main)', '2. b/source (dev)']);
  });

  it('repoRelativePath picks the longest matching root and falls back to full path', () => {
    expect(
      repoRelativePath({ name: 'x', path: '/work/sub/x', type: 'repo', branch: 'main' }, ['/work']),
    ).toBe('sub/x');
    expect(
      repoRelativePath({ name: 'x', path: '/elsewhere/x', type: 'repo', branch: 'main' }, [
        '/work',
      ]),
    ).toBe('/elsewhere/x');
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
    const card = buildRepoPickerCard(projects, ['/work'], 0);
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
  it('appends branch and worktree marker', () => {
    expect(
      repoOptionLabel({ name: 'a', path: '/work/a', type: 'worktree', branch: 'feature' }, [
        '/work',
      ]),
    ).toBe('a (feature) [worktree]');
  });
});

describe('toolRowSummary / toolRowTitle', () => {
  it('bash summary prefers the description then the command', () => {
    expect(toolRowSummary('bash', '{"command":"ls"}')).toBe('ls');
    expect(toolRowSummary('bash', '{"description":"check deps","command":"ls"}')).toBe(
      'check deps',
    );
  });

  it('read summary is the file path', () => {
    expect(toolRowSummary('read', '{"path":"/work/src/a.ts"}', '/work')).toBe('src/a.ts');
  });

  it('unknown tools fall back to the first string arg with a Tool call title', () => {
    expect(toolRowSummary('my_tool', '{"msg":"hello"}')).toBe('my_tool · hello');
    expect(toolRowTitle('my_tool')).toBe('Tool call');
    expect(toolRowTitle('bash')).toBe('Bash');
  });

  it('classifies background-job tools as Read rows with the job id summary', () => {
    expect(toolRowTitle('job_output')).toBe('Read Job');
    expect(toolRowTitle('job_list')).toBe('List Jobs');
    expect(toolRowTitle('job_kill')).toBe('Kill Job');
    expect(toolRowSummary('job_output', '{"job_id":"bash-1"}')).toBe('bash-1');
  });
});
