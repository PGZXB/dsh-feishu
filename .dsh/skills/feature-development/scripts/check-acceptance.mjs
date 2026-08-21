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

const ROOT = new URL('../../../../', import.meta.url).pathname;
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

/**
 * Whether two features-doc versions differ only in ways the feature flow may
 * edit WITHOUT touching the catalog shape: rows may not be added or removed,
 * and a feature's NAME (first cell) may not change. Within those constraints
 * the flow may flip a row's status (📋 → ✅) and rewrite its description / UX
 * cells (correcting a feature that was scoped wrong). Anything that changes
 * row count, renames a feature, or flips a status the wrong way fails.
 */
function statusOnlyFlip(before, after) {
  const isTableRow = (line) => line.startsWith('|') && line.endsWith('|');
  const splitCells = (line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  // Row count must be identical: adding or removing a feature is a catalog
  // edit, not a feature-development change (same for non-table lines).
  if (beforeLines.length !== afterLines.length) return false;

  const beforeRows = new Map();
  const afterRows = new Map();
  for (let i = 0; i < beforeLines.length; i += 1) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (!isTableRow(b) || !isTableRow(a)) {
      if (b !== a) return false; // intro/header line changed → catalog edit
      continue;
    }
    const bCells = splitCells(b);
    const aCells = splitCells(a);
    if (bCells.length < 4 || aCells.length < 4) {
      if (b !== a) return false;
      continue;
    }
    beforeRows.set(bCells[0] ?? '', bCells);
    afterRows.set(aCells[0] ?? '', aCells);
  }
  if (beforeRows.size !== afterRows.size) return false; // added/removed a row

  for (const [name, bCells] of beforeRows) {
    const aCells = afterRows.get(name);
    if (aCells === undefined) return false; // renamed or removed a feature
    // Name (first cell) must not change — renaming is a catalog edit.
    if (bCells[0] !== aCells[0]) return false;
    // Status cell (last) may only stay or flip 📋 → ✅.
    const bStatus = bCells[bCells.length - 1];
    const aStatus = aCells[aCells.length - 1];
    if (bStatus !== aStatus && !(bStatus === '📋' && aStatus === '✅')) return false;
    // description / UX cells (middle) may change freely (re-scope correction).
  }
  return true;
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
  // Every behavior change must carry tests. Filename matching is too brittle
  // (a bridge feature lives in bridge.spec.ts, not index.spec.ts) — any
  // changed test file satisfies the requirement; the reviewer confirms
  // coverage on the human checklist.
  if (changedTests.length === 0) {
    fail('src/ changed but no test file changed — add/update tests');
  } else {
    pass(`tests updated (${changedTests.length} file(s))`);
  }
  // Features catalog is a separate process: a behavior change only flips an
  // existing row's status (📋 → ✅), never adds/removes/rewords a row. Verify
  // both docs changed and only status columns flipped (mechanically checkable).
  const featuresChanged = changed.filter(
    (f) => f === 'docs/features.md' || f === 'docs/features.zh.md',
  );
  if (featuresChanged.length === 0) {
    fail('src/ changed but docs/features.md or docs/features.zh.md not updated — flip the feature row to ✅');
  } else {
    let ok = true;
    for (const file of featuresChanged) {
      const before = git(['show', `${base}:${file}`]);
      const after = git(['show', `HEAD:${file}`]);
      if (!statusOnlyFlip(before, after)) {
        fail(`${file}: catalog shape changed — no row added/removed/renamed; a status flip (📋 → ✅) and description/UX corrections are allowed`);
        ok = false;
      }
    }
    if (ok) pass('docs/features.md (+ zh) updated: status-only flip');
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
