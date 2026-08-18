#!/usr/bin/env node
/**
 * PR mergeability gate: CI green AND (no README change OR maintainer review
 * recorded). The README gate comes from AGENTS.md — README.md / README.zh.md
 * are maintainer-gated, so a PR touching them must carry an explicit review
 * marker (a commit whose subject starts with `review:` or a branch named
 * `*-reviewed`), otherwise it must NOT be auto-merged.
 *
 * Usage (run in the PR branch worktree):
 *   node scripts/check-mergeable.mjs                # local gates assumed green
 *   node scripts/check-mergeable.mjs --ci=github    # also check the live PR via GitHub API
 *
 * Exit 0 = auto-mergeable; 1 = must hold for maintainer review.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const HEAD = args.find((a) => a.startsWith('--head='))?.split('=')[1] ?? 'HEAD';
const OWNER_REPO = 'PGZXB/dsh-feishu';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`✗ ${msg}`);
};
const pass = (msg) => console.log(`✓ ${msg}`);

// 0. Must run in a feature branch, never main.
const branch = git(['branch', '--show-current']);
if (branch === 'main' || branch === '') {
  fail('refusing to judge main itself — run this in a feature branch worktree');
}

// 1. Base = merge base with origin/main.
const base = git(['merge-base', 'HEAD', 'origin/main']);
const changed = git(['diff', '--name-only', base, HEAD]).split('\n').filter(Boolean);

// 2. CI status. Without --ci=github we assume the local gates were run
//    (`pnpm run gates`); with it, query the live PR through the GitHub API.
if (args.includes('--ci=github')) {
  const tokenPath = join(ROOT, '_dev', 'gh-token');
  if (!existsSync(tokenPath)) {
    fail('--ci=github requested but no _dev/gh-token');
  } else {
    const token = readFileSync(tokenPath, 'utf8').trim();
    const pr = githubFindOpenPr(branch, token);
    if (pr === null) {
      fail(`no open PR found for branch ${branch}`);
    } else {
      const state = githubPrMergeableState(pr, token);
      if (state === 'clean') {
        pass(`PR #${pr} is mergeable-clean (checks green)`);
      } else {
        fail(`PR #${pr} is not mergeable-clean (state: ${state})`);
      }
    }
  }
} else {
  pass('CI assumed green locally — run `pnpm run gates` before this (or pass --ci=github to check the live PR)');
}

// 3. README gate: maintainer-gated; a review marker unblocks auto-merge.
const touchedReadme = changed.some((f) => f === 'README.md' || f === 'README.zh.md');
if (touchedReadme) {
  const subjects = git(['log', '--pretty=%s', `${base}..${HEAD}`]).split('\n');
  const reviewed = subjects.some((s) => /^review:/i.test(s))
    || /-reviewed$/.test(branch);
  if (reviewed) {
    pass('README changed AND maintainer review marker found — mergeable');
  } else {
    fail('README.md / README.zh.md changed without a review marker (a `review:` commit or `*-reviewed` branch) — HOLD for maintainer review');
  }
} else {
  pass('no README changes — auto-merge allowed');
}

if (failures > 0) {
  console.error(`\n${failures} mergeability block(s) — do NOT auto-merge; hold for maintainer review.`);
  process.exit(1);
}
console.log('\nMergeable: auto-merge allowed once CI is green.');
process.exit(0);

// --- GitHub API helpers (--ci=github only) ---

function githubApi(path, token) {
  const out = execFileSync('curl', ['-s', '-H', `Authorization: Bearer ${token}`, `https://api.github.com${path}`], { encoding: 'utf8' });
  return JSON.parse(out);
}

function githubFindOpenPr(branch, token) {
  const list = githubApi(`/repos/${OWNER_REPO}/pulls?state=open&head=${OWNER_REPO.split('/')[0]}:${branch}`, token);
  return Array.isArray(list) && list.length > 0 ? list[0].number : null;
}

function githubPrMergeableState(number, token) {
  const pr = githubApi(`/repos/${OWNER_REPO}/pulls/${number}`, token);
  return pr.mergeable_state;
}
