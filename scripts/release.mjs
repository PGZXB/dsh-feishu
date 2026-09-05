#!/usr/bin/env node
/**
 * Release driver for dsh-feishu, in two phases:
 *
 *   1. `node scripts/release.mjs prepare <major|minor|patch>`
 *      Run on a freshly cut `release/vX.Y.Z` branch: bump `package.json`,
 *      run the gates, commit `chore: release vX.Y.Z`, push the branch, and
 *      open the release PR against `main` (via `gh` when available, else
 *      print the compare URL). NO tag, NO publish — the release content is
 *      reviewed like any other change.
 *
 *   2. `node scripts/release.mjs tag`
 *      Run on an up-to-date, clean `main` AFTER the release PR is
 *      squash-merged: create the `v<version>` tag at HEAD (the version comes
 *      from `package.json` on merged main) and push it. The tag push
 *      triggers the Release workflow, which re-runs the gates, publishes to
 *      npm and creates the GitHub Release.
 *
 * WHY tag on `main` instead of the release branch: GitHub's generated
 * release notes (`--generate-notes`) resolve their "What's Changed" baseline
 * from the PREVIOUS tag reachable in the new tag's history. A tag cut on a
 * release branch that is later squash-merged never becomes an ancestor of
 * later commits, so every subsequent release silently falls back to an
 * ancient tag and lists months of unrelated PRs (the v0.2.x–v0.3.1 defect).
 * Tags cut on merged main keep the ancestry chain intact; the Release
 * workflow additionally refuses tags that are not on main.
 *
 * Releases are PREPARED only from a `release/*` branch — main is a
 * development branch and may carry unreleased work (e.g. the next dsh compat
 * pass), so the version bump must be cut from the exact commit that should
 * ship. Phase 2 runs on `main` because the tag must point at the merged,
 * reviewed state.
 *
 * Gates run through the local binaries (node scripts/run-gates.mjs) rather
 * than `pnpm run` so the script works in constrained shells where pnpm's
 * store check cannot open its SQLite database. Phase 1 also runs the
 * real-client E2E suite as a release acceptance step (see
 * docs/e2e-testing.md); the environment must be prepared once with
 * `pnpm run e2e:setup`.
 *
 * Usage:
 *   node scripts/release.mjs prepare <major|minor|patch>   # phase 1
 *   node scripts/release.mjs prepare --dry-run <bump>      # print what would happen
 *   node scripts/release.mjs prepare --skip-e2e <bump>     # skip the E2E acceptance
 *                                                          # (explicit escape hatch only)
 *   node scripts/release.mjs tag                           # phase 2 (after the PR merges)
 *   node scripts/release.mjs tag --dry-run
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [, , phase, ...rest] = process.argv;
const dryRun = rest.includes('--dry-run');
const skipE2E = rest.includes('--skip-e2e');
const bump = rest.find((arg) => arg === 'major' || arg === 'minor' || arg === 'patch');

if (phase !== 'prepare' && phase !== 'tag') {
  console.error(
    'usage: node scripts/release.mjs prepare <major|minor|patch>\n' +
      '       node scripts/release.mjs tag',
  );
  process.exit(1);
}
if (phase === 'prepare' && bump === undefined) {
  console.error('usage: node scripts/release.mjs prepare <major|minor|patch>');
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function run(command) {
  if (dryRun) {
    console.log(`[dry-run] would run: ${command}`);
    return;
  }
  execFileSync(command, { cwd: repoRoot, stdio: 'inherit', shell: true });
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const branch = git(['branch', '--show-current']);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

if (phase === 'prepare') {
  // ── Phase 1: bump, gate, commit, push, open the release PR ──────────────
  if (!branch.startsWith('release/')) {
    console.error(
      `refusing to prepare a release from branch "${branch}" — cut a release branch first:\n` +
        `  git checkout -b release/v${version} main`,
    );
    process.exit(1);
  }
  console.log(`preparing the release on branch ${branch}`);

  const pkgPath = 'package.json';
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  const next =
    bump === 'major'
      ? `${major + 1}.0.0`
      : bump === 'minor'
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;

  console.log(`dsh-feishu ${pkg.version} -> ${next}`);
  if (!dryRun) {
    pkg.version = next;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  // Gates exactly as CI runs them, via the local gate runner (direct binaries,
  // no pnpm store dependency — see the header comment).
  run('node scripts/run-gates.mjs');

  // Real-client E2E acceptance before every release: the unit/integration
  // gates mock the Feishu wire, so the release must also verify the real
  // long connection + browser client locally (see docs/e2e-testing.md).
  // Failing the E2E run aborts the release. `--skip-e2e` is an explicit
  // escape hatch for cases where the E2E environment cannot be provisioned
  // (e.g. no test account access) — never the default.
  if (!skipE2E) {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const stateDir = join(repoRoot, 'e2e', '.state');
    const e2eReady =
      existsSync(join(stateDir, 'creds.json')) &&
      existsSync(join(stateDir, 'web-session.json')) &&
      existsSync(join(stateDir, 'user.json'));
    if (!e2eReady) {
      console.error(
        '\n✗ E2E environment is not ready (missing creds.json / web-session.json / user.json in e2e/.state/).\n' +
          '  Run `pnpm run e2e:setup` once (QR scans with the test account), then re-run the release.\n' +
          '  Use `--skip-e2e` only if the E2E environment cannot be provisioned.',
      );
      process.exit(1);
    }
    console.log('\n── E2E acceptance (real feishu.cn web client) ──');
    run('pnpm run e2e:ui');
  }

  run(`git add package.json pnpm-lock.yaml`);
  run(`git commit -m "chore: release v${next}"`);
  run(`git push -u origin ${branch}`);

  const title = `chore: release v${next}`;
  const body =
    '## What\n' +
    `Bump the package version to \`${next}\` for the \`v${next}\` release.\n\n` +
    '## Why\n' +
    'Version bumps land on `main` through a reviewed release PR; the `v' +
    next +
    '` tag is cut on merged `main` afterwards (see docs/development.md → Publishing).\n\n' +
    '## Verification\n' +
    '- `node scripts/release.mjs prepare ' + bump + '` ran the full gate matrix locally.';
  if (dryRun) {
    console.log(`[dry-run] would open the release PR "${title}" against main`);
  } else if (execFileSync('bash', ['-lc', 'command -v gh || true'], { encoding: 'utf8' }).trim()) {
    run(
      `gh pr create --base main --head ${branch} --title "${title}" --body ${JSON.stringify(body)}`,
    );
  } else {
    console.log(
      `\n` +
        '`gh` is not installed — open the release PR manually:\n' +
        `  https://github.com/PGZXB/dsh-feishu/compare/main...${branch}`,
    );
  }
  console.log(
    `\nnext: review and squash-merge the release PR, then run\n` +
      `  node scripts/release.mjs tag\n` +
      `on updated main to cut the v${next} tag and trigger the publish.`,
  );
} else {
  // ── Phase 2: tag merged main, triggering the publish ────────────────────
  if (branch !== 'main') {
    console.error(
      `refusing to tag from branch "${branch}" — phase 2 runs on main, after the release PR merges.`,
    );
    process.exit(1);
  }
  if (!dryRun && git(['status', '--porcelain']) !== '') {
    console.error('main has uncommitted changes — commit or stash them first.');
    process.exit(1);
  }
  run('git fetch origin --tags');
  const remoteMain = git(['rev-parse', 'origin/main']);
  const head = git(['rev-parse', 'HEAD']);
  if (head !== remoteMain) {
    console.error(
      `local main (${head.slice(0, 8)}) is behind/ahead of origin/main (${remoteMain.slice(0, 8)}) — pull first.`,
    );
    process.exit(1);
  }
  const tag = `v${version}`;
  const existing = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  if (existing) {
    console.error(`tag ${tag} already exists on origin — bump the version with a new release PR.`);
    process.exit(1);
  }
  console.log(`tagging ${head.slice(0, 8)} (merged main) as ${tag} and pushing the tag`);
  run(`git tag ${tag}`);
  run(`git push origin ${tag}`);
  console.log(
    `\ntag ${tag} pushed — the Release workflow publishes to npm and creates the GitHub Release.\n` +
      `after the workflow goes green:\n` +
      `  1. verify https://github.com/PGZXB/dsh-feishu/actions and the npm dist-tag;\n` +
      `  2. bump \`dshFeishu.npmLatest\` to ${version} in dsh-version.json on main (one-line commit);\n` +
      `  3. skim the release's What's Changed — it must list exactly the PRs since the previous tag.`,
  );
}
