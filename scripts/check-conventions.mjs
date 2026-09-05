#!/usr/bin/env node
/**
 * Convention checks for dsh-feishu. Static, CI-runable, exit 1 on any
 * violation. Catches the field-proven mistakes before they reach a PR:
 *
 *  - git-tracked docs referencing internal-only artifacts (dead links to
 *    outsiders; the repo is public once pushed)
 *  - npm mirror URLs leaking into tracked lockfiles/workspace files (the
 *    mirror misses harness packages)
 *  - missing bilingual doc pairs (en + zh tracked docs must stay in sync)
 *  - non-conventional commit messages on the current branch head
 *  - @deepseek-ai packages listed under "dependencies" (they must be
 *    peerDependencies so the dsh host supplies one instance — a second
 *    physical copy breaks symbol-keyed module state and crashes tool calls)
 *
 * Usage:
 *   node scripts/check-conventions.mjs          # check everything
 *   node scripts/check-conventions.mjs --commits N   # check last N commits
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { relative, join } from 'node:path';
import { checkReadmeSync, loadTrack } from './version-track-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;

/** Print a violation and bump the failure counter. */
function fail(message) {
  failures += 1;
  console.error(`✗ ${message}`);
}

function pass(message) {
  console.log(`✓ ${message}`);
}

/** Run a git command and return trimmed stdout (throws on non-zero). */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** All git-tracked files. */
function trackedFiles() {
  return git(['ls-files']).split('\n').filter(Boolean);
}

const INTERNAL_PATTERNS = [
  // Git-ignored *local state* is a repo convention (_dev/, _tmp/ are fine as
  // directory conventions) — what outsiders cannot see is a pointer to a
  // specific private file, analysis, or report.
  /`_dev\/[a-zA-Z0-9._-]+\.(md|txt|log)`/,
  // Absolute developer-machine paths. Placeholder examples like
  // `/home/<user>/…` in a rule are allowed; a concrete username is not.
  /\/home\/[a-z0-9._-]+\/(?!\.\.\.)/,
  /\/Users\/[a-z0-9._-]+\/(?!\.\.\.)/,
  /C:\\Users\\[a-z0-9._-]+(?!\.\.\.)/,
  // "see the internal report" style dead links. The AGENTS.md rule that
  // bans these quotes the phrase as an example ("see the internal report"
  // is a dead link...) — that file's own rule line is the exception.
  /\binternal\s+(report|analysis|doc|note)s?\b/i,
  /\bprivate\s+(report|analysis|doc|note)s?\b/i,
];

/** Lines that restate the convention itself (rule definitions quoting the bad pattern). */
const RULE_SELF_REFERENCE =
  /\b(?:see the|never|do not|don'?t|not)\b[^.\n]*(internal|private)\s+(report|analysis|doc|note)s?\b/i;

function checkTrackedDocs() {
  const docFiles = trackedFiles().filter((f) =>
    f.endsWith('.md') || f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'),
  );
  let docFailures = 0;
  for (const file of docFiles) {
    // Skip files that legitimately document the local toolchain conventions.
    if (file === 'docs/development.md' || file === 'docs/development.zh.md') continue;
    const text = readFileSync(join(ROOT, file), 'utf8');
    const lines = text.split('\n');
    for (const [lineIndex, line] of lines.entries()) {
      for (const pattern of INTERNAL_PATTERNS) {
        const match = line.match(pattern);
        // The rule that bans these quotes them as examples ("see the
        // internal report is a dead link", "Never reference … private
        // reports"). A hit is exempt when the surrounding two lines carry
        // the rule's own framing (a ban verb or the quoted dead-link phrase).
        const context = lines.slice(Math.max(0, lineIndex - 1), lineIndex + 2).join(' ');
        const isRuleSelf = RULE_SELF_REFERENCE.test(context);
        if (match && !isRuleSelf) {
          docFailures += 1;
          fail(`${file}:${lineIndex + 1}: contains internal-only reference ${JSON.stringify(match[0])}`);
          break;
        }
      }
    }
  }
  if (docFailures === 0) pass(`tracked docs free of internal references (${docFiles.length} files checked)`);
}

const MIRROR_PATTERNS = [
  /registry\.npmmirror\.com/,
  /https?:\/\/registry\.npm\.taobao\.org/,
];

function checkNoMirrorLeaks() {
  const tracked = trackedFiles();
  let mirrorFailures = 0;
  for (const file of tracked) {
    if (!/\.(json|yaml|yml)$/.test(file)) continue;
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const pattern of MIRROR_PATTERNS) {
      if (pattern.test(text)) {
        mirrorFailures += 1;
        fail(`${file}: npm mirror registry URL leaked into a tracked file`);
        break;
      }
    }
  }
  if (mirrorFailures === 0) pass('no npm mirror URLs in tracked manifests');
}

const DOC_PAIRS = [
  ['README.md', 'README.zh.md'],
  ['docs/features.md', 'docs/features.zh.md'],
  ['docs/development.md', 'docs/development.zh.md'],
  ['docs/architecture.md', 'docs/architecture.zh.md'],
  ['docs/feishu-setup.md', 'docs/feishu-setup.zh.md'],
  ['docs/ux-specification.md', 'docs/ux-specification.zh.md'],
  ['docs/pitfalls.md', 'docs/pitfalls.zh.md'],
];

function checkDocPairs() {
  const tracked = new Set(trackedFiles());
  let pairFailures = 0;
  for (const [en, zh] of DOC_PAIRS) {
    if (tracked.has(en) && !tracked.has(zh)) {
      pairFailures += 1;
      fail(`${en} is tracked but its Chinese counterpart ${zh} is missing`);
    } else if (tracked.has(zh) && !tracked.has(en)) {
      pairFailures += 1;
      fail(`${zh} is tracked but its English counterpart ${en} is missing`);
    }
  }
  if (pairFailures === 0) pass('all bilingual doc pairs are tracked together');
}

const COMMIT_RE = /^(feat|fix|docs|test|refactor|chore|perf|style|ci)(\([a-z0-9-]+\))?: .+/;

function checkCommits(count) {
  const log = git(['log', `-${count}`, '--pretty=%s']).split('\n').filter(Boolean);
  let commitFailures = 0;
  for (const subject of log) {
    // Squash-merge titles carry a trailing " (#NN)"; strip it for the check.
    const base = subject.replace(/\s+\(#\d+\)$/, '');
    if (!COMMIT_RE.test(base)) {
      commitFailures += 1;
      fail(`commit message not conventional: ${JSON.stringify(subject)}`);
    }
  }
  if (commitFailures === 0) pass(`last ${log.length} commit message(s) are conventional`);
}

function checkMainTreeClean() {
  const status = git(['status', '--porcelain']);
  if (status !== '') {
    fail('main working tree has uncommitted changes — feature work belongs in a worktree');
  } else {
    pass('main working tree is clean');
  }
}

function checkMinimumReleaseAge() {
  // pnpm 11 defaults minimumReleaseAge to 1440 min (24 h) and rejects any
  // lockfile entry published within the last day — a freshly released
  // transitive dep breaks `pnpm install` for everyone. The repo pins
  // minimumReleaseAge: 0 in pnpm-workspace.yaml to lift that; the check
  // guards the config from being dropped or reverted.
  const workspace = join(ROOT, 'pnpm-workspace.yaml');
  if (!existsSync(workspace)) {
    fail('pnpm-workspace.yaml missing — cannot verify minimumReleaseAge');
    return;
  }
  const text = readFileSync(workspace, 'utf8');
  if (!/^minimumReleaseAge:\s*0\s*$/m.test(text)) {
    fail('pnpm-workspace.yaml must set `minimumReleaseAge: 0` (pnpm 11 otherwise rejects <24h-old lockfile entries)');
  } else {
    pass('pnpm-workspace.yaml pins minimumReleaseAge: 0');
  }
}

function checkVersionTrack() {
  const track = loadTrack(ROOT);
  if (track.error) {
    fail(track.error);
    return;
  }
  const errors = checkReadmeSync(ROOT, track);
  for (const error of errors) fail(error);
  if (errors.length === 0) {
    pass(`dsh-version.json tracks dsh @latest=${track.stable} / @next=${track.next} and the README Notes match`);
  }
}

const args = process.argv.slice(2);
const commitFlag = args.find((a) => a.startsWith('--commits='));
const commitCount = commitFlag ? Number(commitFlag.split('=')[1]) : 5;

/**
 * @deepseek-ai harness packages must be peerDependencies, never dependencies.
 * The dsh host keeps a flat symlink fallback so every consumer loads ONE
 * instance; pnpm installing a @deepseek-ai package as a real dependency places
 * a SECOND copy in the profile's node_modules, which shadows the host symlink.
 * Module-identity state keyed by a module-local Symbol (the dsh-tools
 * scheduler) then mismatches between the two copies → tool calls crash with
 * "Cannot read properties of undefined (reading 'prepare')". The dsh-TUI
 * surface keeps every @deepseek-ai/* package out of dependencies, and so do we.
 */
function checkHarnessPackagesArePeerDeps() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const deps = pkg.dependencies ?? {};
  const offenders = Object.keys(deps).filter((name) => name.startsWith('@deepseek-ai/'));
  if (offenders.length > 0) {
    fail(
      `@deepseek-ai packages are in "dependencies" (must be peerDependencies; a second copy breaks tool calls): ${offenders.join(', ')}`,
    );
  } else {
    pass('@deepseek-ai packages are peerDependencies (no double-install, dsh-TUI-aligned)');
  }
}

/**
 * The lockfile must resolve every @deepseek-ai package to exactly ONE
 * instance (one packages: key). A version fork of a base package
 * (@deepseek-ai/cordis, @deepseek-ai/schemastery, …) makes pnpm's peer
 * hashing fork the whole dsh-agent graph, so dsh-tools loads multiple times
 * in one process; its module-local Symbol scheduler key then splits identity
 * and every tool call dies with "Cannot read properties of undefined
 * (reading 'prepare')" — even though every harness package is correctly a
 * peerDependency. Run `pnpm dedupe` to converge; see docs/pitfalls.md
 * ("Version forks of the base packages").
 */
function checkSingleDshInstancePerPackage() {
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const keys = new Map();
  // Quoted packages: keys only — `  '@deepseek-ai/cordis@4.0.2(...peers...)':`.
  // The suffix after the first `(` lists PEERS, not versions; capture the
  // key's own name and version (the text before the first `'` or `(`).
  for (const match of lock.matchAll(/^[ \t]*'?(@deepseek-ai\/[a-z0-9-]+)@([^(':]+)['(:]/gm)) {
    const [, name, version] = match;
    const versions = keys.get(name) ?? new Set();
    versions.add(version);
    keys.set(name, versions);
  }
  const forks = [...keys.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => `${name}@${[...versions].join(' + ')}`);
  if (forks.length > 0) {
    fail(
      `@deepseek-ai packages resolve to multiple versions in pnpm-lock.yaml (run \`pnpm dedupe\`; version forks split dsh-tools instances and break tool calls): ${forks.join(', ')}`,
    );
  } else if (keys.size === 0) {
    fail('pnpm-lock.yaml lists no @deepseek-ai packages — is it a real lockfile?');
  } else {
    pass(`every @deepseek-ai package resolves to a single version (${keys.size} packages)`);
  }
}

checkTrackedDocs();
checkNoMirrorLeaks();
checkDocPairs();
checkCommits(commitCount);
checkMinimumReleaseAge();
checkVersionTrack();
checkHarnessPackagesArePeerDeps();
checkSingleDshInstancePerPackage();
checkMainTreeClean();

if (failures > 0) {
  console.error(`\n${failures} convention violation(s) — fix before committing.`);
  process.exit(1);
}
console.log('\nAll convention checks passed.');
