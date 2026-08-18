#!/usr/bin/env node
/**
 * Automated acceptance check for the feature-development skill. Run inside a
 * feature worktree (branch feat/<name>) before opening the PR. Verifies the
 * checklist items that are mechanically checkable from the branch's diff
 * against origin/main; the human-only items (spec quality, brainstormed
 * scenarios) stay on the SKILL checklist.
 *
 * Usage:
 *   node .dsh/skills/feature-development/scripts/check-acceptance.mjs
 *
 * Exits 1 on any failure. Prints a pass/fail per checklist item.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../..', import.meta.url).pathname;
let failures = 0;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function fail(msg) {
  failures += 1;
  console.error(`✗ ${msg}`);
}
function pass(msg) {
  console.log(`✓ ${msg}`);
}

// Branch shape: must be a feature branch, not main.
const branch = git(['branch', '--show-current']);
if (branch === 'main' || branch === '') {
  fail('not on a feature branch — run this inside the feature worktree');
} else {
  pass(`on feature branch ${branch}`);
}

// Diff surface against the merge base.
const base = git(['merge-base', 'HEAD', 'origin/main']);
const changed = git(['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
const changedSet = new Set(changed);
const changedSrc = changed.filter((f) => f.startsWith('src/'));
const changedTests = changed.filter((f) => f.startsWith('tests/'));
const changedDocs = changed.filter((f) => f.startsWith('docs/'));
const touchedReadme = changed.some((f) => f === 'README.md' || f === 'README.zh.md');

if (changedSrc.length === 0) {
  pass('no src/ changes (docs/tooling-only PR)');
} else {
  // Every src change should carry a co-located test.
  const missingTests = changedSrc.filter((f) => {
    const base = f.replace(/^src\//, '').replace(/\.ts$/, '');
    return !changedTests.some((t) => t.includes(base.replace(/\//g, '/')));
  });
  if (missingTests.length > 0) {
    fail(`src changes without a changed test: ${missingTests.join(', ')}`);
  } else {
    pass('every changed src module has a changed test');
  }
  // Features doc should be touched when behavior changes.
  if (!changedDocs.some((f) => f.includes('features'))) {
    fail('src/ changed but docs/features.md (+ zh) not updated — update the feature row');
  } else {
    pass('docs/features.md (+ zh) updated');
  }
  // CHANGELOG entry expected.
  if (!changed.includes('CHANGELOG.md')) {
    fail('src/ changed but CHANGELOG.md [Unreleased] not updated');
  } else {
    pass('CHANGELOG.md updated');
  }
  // UX spec expected for behavior changes.
  if (!changedDocs.some((f) => f.includes('ux-specification'))) {
    fail('behavior change but docs/ux-specification.md not updated (spec-first)');
  } else {
    pass('docs/ux-specification.md updated');
  }
}

// Feishu manifest sync: a scope/event/callback change must touch the manifest.
const manifestChanged = changed.includes('src/setup/feishu-manifest.json');
if (manifestChanged) {
  if (!changedDocs.some((f) => f.includes('feishu-setup'))) {
    fail('feishu-manifest.json changed but docs/feishu-setup.md not updated');
  } else {
    pass('manifest + feishu-setup docs in sync');
  }
}

// README gate.
if (touchedReadme) {
  fail('README.md / README.zh.md changed — maintainer review REQUIRED before merge (hold the PR)');
} else {
  pass('no README changes (auto-merge allowed if CI green)');
}

// Working tree must be clean before PR.
const status = git(['status', '--porcelain']);
if (status !== '') {
  fail(`working tree not clean:\n${status}`);
} else {
  pass('working tree clean');
}

if (failures > 0) {
  console.error(`\n${failures} acceptance failure(s) — see the SKILL checklist for the human-only items.`);
  process.exit(1);
}
console.log('\nAcceptance checks passed (human-only items: spec quality, brainstormed scenario coverage).');
