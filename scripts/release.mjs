#!/usr/bin/env node
/**
 * Release driver for dsh-feishu: bump the version, verify the gates, tag,
 * and print the publish instructions.
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>   # e.g. node scripts/release.mjs minor
 *   node scripts/release.mjs --dry-run <bump>      # print what would happen
 *
 * The actual npm publish + GitHub Release run from the `v*` tag via
 * .github/workflows/release.yml (NPM_TOKEN secret).
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

// Tag and push; the release workflow publishes from the tag.
run(`git add package.json pnpm-lock.yaml`);
run(`git commit -m "chore: release v${next}"`);
run(`git tag v${next}`);
run('git push origin main --tags');

console.log(`\npushed v${next} — the Release workflow (NPM_TOKEN) publishes to npm and creates the GitHub Release.`);
