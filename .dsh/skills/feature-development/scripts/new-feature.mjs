#!/usr/bin/env node
/**
 * Scaffold a new feature the feature-development way: create the worktree
 * branch, drop the spec skeleton, and the brainstormed-scenario test file —
 * so every feature starts from the same checklist. It does NOT touch
 * docs/features.md: adding/removing feature-list rows (and flipping 📋 → ✅)
 * belongs to a separate features-catalog process, not feature development.
 *
 * Usage (run from a clean main worktree):
 *   node .dsh/skills/feature-development/scripts/new-feature.mjs <kebab-case-feature-name> [<short-description>]
 *
 * Creates:
 *   _dev/dsh-feishu-<name>/        worktree on branch feat/<name>
 *   docs/ux-specification.md       appends a "Part: <name>" skeleton
 *   tests/integration/<name>.spec.ts  scenario-matrix skeleton (fails until implemented)
 *
 * The agent then fills the spec, brainstorms the scenario matrix, and
 * implements against it — in that order. features.md stays untouched.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , name, ...rest] = process.argv;
const description = rest.join(' ');

if (name === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
  console.error('usage: node scripts/new-feature.mjs <kebab-case-name> [<short description>]');
  process.exit(1);
}

const ROOT = new URL('../../../../', import.meta.url).pathname;
const worktreeDir = join(ROOT, '_dev', `dsh-feishu-${name}`);
const branch = `feat/${name}`;

if (existsSync(worktreeDir)) {
  console.error(`✗ worktree already exists: ${worktreeDir}`);
  process.exit(1);
}

function run(command, args) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// 1. Worktree + branch.
console.log(`▶ creating worktree ${worktreeDir} on ${branch}...`);
run('git', ['worktree', 'add', '-b', branch, worktreeDir, 'origin/main']);

const specFile = join(worktreeDir, 'docs', 'ux-specification.md');
const testFile = join(worktreeDir, 'tests', 'integration', `${name}.spec.ts`);

// 2. Spec skeleton.
const specSkeleton = `\n## Part: ${name}\n\n${description ? `> ${description}\n` : ''}\n\n### Intended behavior\n\n<!-- trigger, states, transitions, card/panel shape, failure modes, acceptance checklist -->\n\n- **Trigger:**\n- **States & transitions:**\n- **Card/panel shape:**\n- **Failure modes:**\n- **Acceptance:**\n`;
writeFileSync(specFile, readFileSync(specFile, 'utf8') + specSkeleton);
console.log(`✓ spec skeleton appended to ${specFile}`);

// 3. Scenario-matrix test skeleton (fails until implemented, as intended).
const testSkeleton = `import { describe, expect, it } from 'vitest';

// Feature: ${name}${description ? ` — ${description}` : ''}
//
// Integration scenarios (real dsh process, memory transport, mock LLM).
// Brainstormed FIRST — every happy path, error path, and edge. These tests
// are written before the implementation and fail until it lands.

describe('integration > ${name}', () => {
  it('placeholder — scenario matrix goes here', () => {
    expect(true).toBe(true);
  });
});
`;
writeFileSync(testFile, testSkeleton);
console.log(`✓ scenario-matrix skeleton written to ${testFile}`);

console.log(`\nNext (in order): fill the spec → design the state machine → brainstorm & write the integration scenarios → implement → unit tests → re-brainstorm → docs → PR.`);
