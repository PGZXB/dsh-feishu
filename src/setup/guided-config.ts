/**
 * Guided setup prompts: the wizard asks the user for the surface options
 * that need a value up front (repoRoots / groupMentionMode /
 * requireWorkingDir), showing a default for each — an empty input (just
 * Enter) accepts the default. Non-interactive runs (stdin is not a TTY,
 * e.g. CI or scripts) skip the prompts and return no answers, so the
 * caller falls back to the defaults silently.
 *
 * The answer-to-config merge is a pure function (`mergeGuidedConfig`) so it
 * is fully unit-testable; prompting is a thin readline wrapper around it.
 *
 * @module @dsh-feishu/dsh-feishu/setup/guided-config
 */

import { createInterface } from 'node:readline';
import type { GuidedConfig } from './profile-writer.js';

/** One raw answer from the user; an empty string means "use the default". */
export interface GuidedAnswers {
  repoRoots?: string;
  groupMentionMode?: string;
  requireWorkingDir?: string;
}

const MENTION_MODES: readonly GuidedConfig['groupMentionMode'][] = [
  'always',
  'never',
  'ambient',
  'topic',
];

function parseBoolean(input: string): boolean | undefined {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'y' || trimmed === 'yes' || trimmed === 'true') return true;
  if (trimmed === 'n' || trimmed === 'no' || trimmed === 'false') return false;
  return undefined;
}

/**
 * Merge raw user answers onto defaults: an empty or invalid answer keeps
 * the default; valid answers override. Invalid input never errors — it just
 * falls back to the default (the prompt shows the accepted values).
 * @param answers - the raw inputs (empty string = default).
 * @param defaults - existing config or built-in defaults.
 * @returns the effective guided config (all three keys present).
 */
export function mergeGuidedConfig(answers: GuidedAnswers, defaults: GuidedConfig): GuidedConfig {
  const repoRootsRaw = answers.repoRoots?.trim() ?? '';
  const repoRoots =
    repoRootsRaw === ''
      ? defaults.repoRoots
      : repoRootsRaw
          .split(',')
          .map((root) => root.trim())
          .filter((root) => root !== '');

  const modeRaw = answers.groupMentionMode?.trim().toLowerCase() ?? '';
  const groupMentionMode =
    modeRaw === '' || !MENTION_MODES.includes(modeRaw as GuidedConfig['groupMentionMode'])
      ? defaults.groupMentionMode
      : (modeRaw as GuidedConfig['groupMentionMode']);

  const requireRaw = answers.requireWorkingDir?.trim() ?? '';
  const parsedRequire = parseBoolean(requireRaw);
  const requireWorkingDir =
    requireRaw === '' ? defaults.requireWorkingDir : (parsedRequire ?? defaults.requireWorkingDir);

  return {
    ...(repoRoots !== undefined ? { repoRoots: [...repoRoots] } : {}),
    ...(groupMentionMode !== undefined ? { groupMentionMode } : {}),
    ...(requireWorkingDir !== undefined ? { requireWorkingDir } : {}),
  };
}

/** One interactive prompt. */
interface PromptSpec {
  readonly label: string;
  readonly current: string;
}

function display(guided: GuidedConfig): PromptSpec[] {
  const roots = (guided.repoRoots ?? []).join(', ');
  return [
    {
      label: 'Project scan roots for /repo (comma-separated paths)',
      current: roots,
    },
    {
      label: 'Group mention mode (always | never | ambient | topic)',
      current: guided.groupMentionMode ?? 'always',
    },
    {
      label: 'Refuse work until a working directory is chosen (y/n)',
      current: guided.requireWorkingDir === false ? 'n' : 'y',
    },
  ];
}

/**
 * Ask the user for the guided surface options. Returns no answers when
 * stdin is not a TTY (CI / scripts) so nothing blocks.
 * @param defaults - the defaults shown (existing config or built-ins).
 * @returns raw answers; empty strings mean "use the default".
 */
export async function promptGuidedConfig(defaults: GuidedConfig): Promise<GuidedAnswers> {
  if (!process.stdin.isTTY) return {};
  const answers: GuidedAnswers = {};
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const spec of display(defaults)) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${spec.label} [${spec.current}]: `, resolve);
      });
      const trimmed = answer.trim();
      if (spec.label.startsWith('Project scan roots')) answers.repoRoots = trimmed;
      else if (spec.label.startsWith('Group mention mode')) answers.groupMentionMode = trimmed;
      else answers.requireWorkingDir = trimmed;
    }
  } finally {
    rl.close();
  }
  return answers;
}
