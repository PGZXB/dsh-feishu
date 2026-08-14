/**
 * Unit tests for the pure card-rendering helpers.
 */

import { describe, expect, it } from 'vitest';
import { markdownToElements } from '../../src/cards/markdown.js';
import {
  assistantText,
  buildCard,
  buildPanelCard,
  buildPermissionPickerCard,
  buildRepoPickedCard,
  buildRepoPickerCard,
  buildRowDetailsCard,
  collapseSequence,
  PANEL_PAGE_SIZE,
  type PanelCommand,
  panelPages,
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

  it('shows the full sequence — no truncation (feedback)', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      kind: 'tool' as const,
      id: `c${i}`,
      name: `t${i}`,
      status: 'done' as const,
      summary: '',
      args: '',
      result: '',
    }));
    const seq = collapseSequence(rows);
    expect(seq).toBe(
      't0 -> t1 -> t2 -> t3 -> t4 -> t5 -> t6 -> t7 -> t8 -> t9 -> t10 -> t11 -> t12 -> t13 -> t14',
    );
  });
});

describe('buildCard', () => {
  it('emits a v1 card (no schema field) with header template by status', () => {
    const card = buildCard({ title: 'T', content: 'body', rows: [], status: 'working' });
    // The v1 root-elements layout is used deliberately so the card can carry
    // interactive action buttons (schema 2.0 rejects the action tag).
    expect(card.schema).toBeUndefined();
    expect(card.header?.title.content).toBe('T');
    expect(card.header?.template).toBe('wathet');
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
    const actions = card.elements.filter((el) => el.tag === 'action');
    expect(buttonLabels(actions[1])).toContain('▸ Expand');
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
    const actions = card.elements.filter((el) => el.tag === 'action');
    expect(buttonLabels(actions[1])).toContain('▾ Collapse');
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
    const actions = card.elements.filter((el) => el.tag === 'action');
    expect(buttonLabels(actions[0])).toEqual(['📋 Copy', '🔁 Retry', '⚙️ Panel']);
    expect(buttonLabels(actions[1])).toEqual(['▾ Collapse']);
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

  it('renders GFM tables as native Feishu table elements, not raw pipes', () => {
    // Regression: tables previously fell back to their source lines, so the
    // final card showed raw '| 路径 | 内容 |' text (user report).
    const table = `| 路径 | 内容 |
|---|---|
| \`Agent4AVR/\` | 主代码包 |
| \`Agent4AVR/main.py\` | 入口：加载数据集 |
| \`results/\` | Lite/Full 的 \`preds.json\` |`;
    const elements = markdownToElements(table);
    const tableElement = elements.find(
      (el): el is Extract<CardElement, { tag: 'table' }> => el.tag === 'table',
    );
    expect(tableElement).toBeDefined();
    expect(tableElement?.columns.map((c) => c.display_name)).toEqual(['路径', '内容']);
    expect(tableElement?.rows).toHaveLength(3);
    expect(tableElement?.rows[0]?.c0).toContain('Agent4AVR/');
    expect(tableElement?.rows[2]?.c1).toContain('preds.json');
    // No raw pipe text leaks into markdown elements.
    const markdowns = elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns.every((el) => !el.content.includes('|'))).toBe(true);
  });

  it('caps native tables at the Feishu limit and keeps overflow as code blocks', () => {
    // Regression: >5 tables in one card made message.patch fail with
    // ErrCode 11310 ('card table number over limit'), surfacing as
    // '目标回调服务未在线'. The sixth table must degrade to a code block
    // (content preserved), not fail the patch.
    const sixTables = Array.from({ length: 6 }, (_, i) => `| h${i} |\n|---|\n| v${i} |`).join(
      '\n\n',
    );
    const elements = markdownToElements(sixTables);
    const tables = elements.filter(
      (el): el is Extract<CardElement, { tag: 'table' }> => el.tag === 'table',
    );
    expect(tables).toHaveLength(5);
    const markdowns = elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    const joined = markdowns.map((el) => el.content).join('\n');
    expect(joined).toContain('```');
    expect(joined).toContain('h5'); // the sixth table's header survives
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
  it('emits a control card with operation buttons', () => {
    const card = buildPanelCard('**Idle** — send a message.', false);
    expect(card.header?.title.content).toBe('⚙️ dsh-feishu panel');
    const action = card.elements.find((el) => el.tag === 'action');
    expect(action && 'actions' in action ? action.actions.length : 0).toBe(2);
  });

  it('includes the Stop button only while a turn is running', () => {
    const running = buildPanelCard('**Running**', true);
    const idle = buildPanelCard('**Idle**', false);
    const labelsOf = (card: ReturnType<typeof buildPanelCard>): string[] => {
      const action = card.elements.find((el) => el.tag === 'action');
      return action && 'actions' in action
        ? action.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : [];
    };
    expect(labelsOf(running)).toEqual(['⏹ Stop current', '🔁 Retry last', '📋 Copy last']);
    expect(labelsOf(idle)).toEqual(['🔁 Retry last', '📋 Copy last']);
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

const paletteCommands: PanelCommand[] = [
  { name: 'cancel', buttonLabel: '⏹ Stop', category: 'session' },
  { name: 'cd', buttonLabel: '📁 Change dir', category: 'session' },
  { name: 'repo', buttonLabel: '📚 Pick project', category: 'session' },
  { name: 'sessions', buttonLabel: '🗂️ Sessions', category: 'session' },
  { name: 'resume', buttonLabel: '🔁 Resume session', category: 'session' },
  { name: 'clear', buttonLabel: '🧹 Fresh start', category: 'session' },
  { name: 'new', buttonLabel: '➕ New chat', category: 'session' },
  { name: 'group', buttonLabel: '👥 New group', category: 'chat' },
  { name: 'help', buttonLabel: '❓ Help', category: 'system' },
  { name: 'status', buttonLabel: '📊 Status', category: 'system' },
  { name: 'plan', buttonLabel: '🗺️ Plan mode', category: 'system' },
  { name: 'goal', buttonLabel: '🎯 Goal', category: 'system' },
  { name: 'compact', buttonLabel: '🧹 Compact', category: 'system' },
  { name: 'feedback', buttonLabel: '💬 Feedback', category: 'system' },
  { name: 'permission', buttonLabel: '🔐 Permission', category: 'system' },
];

describe('panelPages', () => {
  it('groups by category with one header per group', () => {
    const pages = panelPages(paletteCommands);
    const headers = pages.flat().filter((e) => e.type === 'header');
    expect(headers.map((h) => ('label' in h ? h.label : ''))).toEqual([
      'session',
      'chat',
      'system',
    ]);
  });

  it('paginates by button count, not entry count', () => {
    const pages = panelPages(paletteCommands);
    const buttonCounts = pages.map((page) => page.filter((e) => e.type === 'button').length);
    expect(buttonCounts).toEqual([PANEL_PAGE_SIZE, paletteCommands.length - PANEL_PAGE_SIZE]);
  });

  it('rides a stranded category header onto the next page', () => {
    const pages = panelPages(
      [
        { name: 'a', buttonLabel: 'A', category: 'session' },
        { name: 'b', buttonLabel: 'B', category: 'system' },
        { name: 'c', buttonLabel: 'C', category: 'system' },
      ],
      1,
    );
    // The system header would strand on page 1 (its first button starts page
    // 2); it rides along so page 2 labels its commands.
    expect(pages.map((p) => p.map((e) => (e.type === 'header' ? e.label : e.name)))).toEqual([
      ['session', 'a'],
      ['system', 'b'],
      ['c'],
    ]);
  });
});

describe('buildPanelCard palette', () => {
  it('keeps the core buttons first, then the palette page grouped by category', () => {
    const card = buildPanelCard('**Idle**', false, paletteCommands, 0);
    const actions = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'action' }> => el.tag === 'action',
    );
    expect(buttonLabels(actions[0])).toEqual(['🔁 Retry last', '📋 Copy last']);
    // Each category is its own block: header line, then THAT category's
    // button row (user report: headers stacked with nothing between them).
    const sessionRow = buttonLabels(actions[1]);
    expect(sessionRow).toHaveLength(7);
    expect(sessionRow[0]).toBe('⏹ Stop');
    expect(sessionRow).not.toContain('👥 New group');
    const chatRow = buttonLabels(actions[2]);
    expect(chatRow).toEqual(['👥 New group']);
    // Category headers render as emoji-tagged markdown lines, each BEFORE
    // its own button row (interleaved, not stacked).
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    const sessionHeader = markdowns.findIndex((m) => m.content === '**🧩 Session**');
    const chatHeader = markdowns.findIndex((m) => m.content === '**💬 Chat**');
    expect(sessionHeader).toBeGreaterThanOrEqual(0);
    expect(chatHeader).toBeGreaterThan(sessionHeader);
    expect(sessionHeader).toBeLessThan(card.elements.findIndex((el) => el === actions[1]));
    expect(chatHeader).toBeLessThan(card.elements.findIndex((el) => el === actions[2]));
    // The page indicator is a quiet note, not a bold line.
    const notes = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'note' }> => el.tag === 'note',
    );
    expect(notes.some((n) => n.elements[0]?.content.includes('page 1/2'))).toBe(true);
  });

  it('stamps command payloads on palette buttons', () => {
    const card = buildPanelCard('**Idle**', false, paletteCommands, 0);
    const pageAction = card.elements
      .filter((el): el is Extract<CardElement, { tag: 'action' }> => el.tag === 'action')
      .find((el) =>
        el.actions.some((a) => a.tag === 'button' && 'value' in a && a.value.kind === 'command'),
      );
    expect(pageAction).toBeDefined();
    const command = pageAction?.actions.find(
      (a): a is ButtonAction => a.tag === 'button' && a.value.kind === 'command',
    );
    expect(command?.value).toEqual({ kind: 'command', name: 'cancel' });
  });

  it('hides Stop unless running', () => {
    const idle = buildPanelCard('**Idle**', false, [], 0);
    const idleCore = idle.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(idleCore)).toEqual(['🔁 Retry last', '📋 Copy last']);
    const running = buildPanelCard('**Running**', true, [], 0);
    const runningCore = running.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(runningCore)).toEqual(['⏹ Stop current', '🔁 Retry last', '📋 Copy last']);
  });

  it('renders no palette section when there are no commands', () => {
    const card = buildPanelCard('**Idle**', false, [], 0);
    expect(
      card.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('Commands'),
      ),
    ).toBe(false);
  });
});

describe('buildPermissionPickerCard', () => {
  const presets = [
    {
      name: 'read-only',
      label: 'Read only',
      description: 'Sandbox read-only, approval ask.',
      current: false,
    },
    {
      name: 'workspace-write',
      label: 'workspace-write',
      description: 'Sandbox workspace-write, approval ask.',
      current: true,
    },
    {
      name: 'danger-full-access',
      label: 'danger-full-access',
      description: 'Sandbox danger-full-access, approval never.',
      current: false,
    },
  ];

  it('renders a select_static dropdown with all presets as options', () => {
    const card = buildPermissionPickerCard(presets);
    const action = card.elements.find((el) => el.tag === 'action');
    const select = selectOf(action);
    expect(select).toBeDefined();
    expect(select?.options.map((o) => o.value)).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ]);
    // The select is the repo-picker pattern: a marker payload, with the
    // chosen preset arriving in the callback's `option` field.
    expect(select?.value).toEqual({ kind: 'permission-pick' });
    expect(card.elements.filter((el) => el.tag === 'column_set')).toHaveLength(0);
  });

  it('preselects the current preset via initial_option', () => {
    const card = buildPermissionPickerCard(presets);
    const select = selectOf(card.elements.find((el) => el.tag === 'action'));
    expect(select?.initial_option).toBe('workspace-write');
    // The current preset is also spelled out in a quiet note.
    const note = card.elements.find((el) => el.tag === 'note');
    expect(note && 'elements' in note ? note.elements[0]?.content : '').toContain(
      '★ current: workspace-write',
    );
  });

  it('omits initial_option when the effective state is not an option (custom)', () => {
    const custom = presets.map((p) => ({ ...p, current: false }));
    const card = buildPermissionPickerCard(custom);
    const select = selectOf(card.elements.find((el) => el.tag === 'action'));
    expect(select?.initial_option).toBeUndefined();
    const note = card.elements.find((el) => el.tag === 'note');
    expect(note && 'elements' in note ? note.elements[0]?.content : '').toContain(
      'No preset selected yet',
    );
  });

  it('shows the empty state with no presets', () => {
    const card = buildPermissionPickerCard([]);
    expect(card.header?.title.content).toBe('🔐 Permission presets');
    expect(
      card.elements.some(
        (el) =>
          el.tag === 'markdown' && 'content' in el && el.content.includes('No presets configured'),
      ),
    ).toBe(true);
  });
});
