#!/usr/bin/env node
/**
 * Release driver for dsh-feishu: bump the version, verify the gates, tag,
 * and push BOTH the release branch and the tag so the Release workflow
 * publishes.
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>   # e.g. node scripts/release.mjs patch
 *   node scripts/release.mjs --dry-run <bump>      # print what would happen
 *
 * Releases happen ONLY from a `release/*` branch (e.g. release/v0.2.1):
 * main is a development branch and may carry unreleased work, so a release
 * must be cut from a frozen release branch cut off the intended commit.
 * The script refuses to run on main or a feature branch. It pushes the
 * release branch AND the `v*` tag to origin — the actual npm publish +
 * GitHub Release run from the tag via .github/workflows/release.yml
 * (NPM_TOKEN secret).
 *
 * Gates run through the local binaries (node scripts/run-gates.mjs) rather
 * than `pnpm run` so the script works in constrained shells where pnpm's
 * store check cannot open its SQLite database.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [, , ...args] = process.argv;
const dryRun = args.includes('--dry-run');
const bump = args.find((arg) => arg === 'major' || arg === 'minor' || arg === 'patch');

if (bump === undefined) {
  console.error('usage: node scripts/release.mjs [--dry-run] <major|minor|patch>');
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function run(command, extra) {
  if (dryRun) {
    console.log(`[dry-run] would run: ${command}`);
    return;
  }
  execFileSync(command, extra ?? [], { cwd: repoRoot, stdio: 'inherit', shell: true });
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

// Gates exactly as CI runs them, via the local gate runner (direct binaries,
// no pnpm store dependency — see the header comment).
run('node scripts/run-gates.mjs');

// Tag and push BOTH the release branch and the tag; the release workflow
// publishes from the tag.
run(`git add package.json pnpm-lock.yaml`);
run(`git commit -m "chore: release v${next}"`);
run(`git tag v${next}`);
run(`git push -u origin ${branch}`);
run(`git push origin v${next}`);

console.log(`\npushed branch ${branch} and tag v${next} — the Release workflow (NPM_TOKEN) publishes to npm and creates the GitHub Release.`);
