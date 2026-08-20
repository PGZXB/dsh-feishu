#!/usr/bin/env node
/**
 * Release driver for dsh-feishu: bump the version, verify the gates, tag,
 * and push the tag so the Release workflow publishes.
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>   # e.g. node scripts/release.mjs patch
 *   node scripts/release.mjs --dry-run <bump>      # print what would happen
 *
 * Releases happen ONLY from a `release/*` branch (e.g. release/v0.2.1):
 * main is a development branch and may carry unreleased work, so a release
 * must be cut from a frozen release branch cut off the intended commit.
 * The script refuses to run on main or a feature branch, and pushes only
 * the tag (never the branch) — the actual npm publish + GitHub Release run
 * from the `v*` tag via .github/workflows/release.yml (NPM_TOKEN secret).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , ...args] = process.argv;
const dryRun = args.includes('--dry-run');
const bump = args.find((arg) => arg === 'major' || arg === 'minor' || arg === 'patch');

if (bump === undefined) {
  console.error('usage: node scripts/release.mjs [--dry-run] <major|minor|patch>');
  process.exit(1);
}

function run(command, extra) {
  if (dryRun) {
    console.log(`[dry-run] would run: ${command}`);
    return;
  }
  execFileSync(command, extra ?? [], { stdio: 'inherit', shell: true });
}

// Releases are cut from a frozen `release/*` branch, never from main (which
// is a development branch and may hold unreleased work).
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
if (!branch.startsWith('release/')) {
  console.error(
    `refusing to release from branch "${branch}" — cut a release branch first:\n` +
      `  git checkout -b release/vX.Y.Z <commit>`,
  );
  process.exit(1);
}
console.log(`releasing from branch ${branch}`);

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

// Gates exactly as CI runs them.
run('pnpm run lint');
run('pnpm run typecheck');
run('pnpm run build');
run('FEISHU_INT_REQUIRED=1 pnpm run test');

// Tag and push ONLY the tag (the release branch stays local to the
// developer); the release workflow publishes from the tag.
run(`git add package.json pnpm-lock.yaml`);
run(`git commit -m "chore: release v${next}"`);
run(`git tag v${next}`);
run(`git push origin v${next}`);

console.log(`\npushed tag v${next} — the Release workflow (NPM_TOKEN) publishes to npm and creates the GitHub Release.`);
