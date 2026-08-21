#!/usr/bin/env node
/**
 * Release driver for dsh-feishu: bump the version, verify the gates, tag,
 * and push BOTH the release branch and the tag so the Release workflow
 * publishes.
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>   # e.g. node scripts/release.mjs patch
 *   node scripts/release.mjs --dry-run <bump>      # print what would happen
 *   node scripts/release.mjs --skip-e2e <bump>     # skip the E2E acceptance
 *                                                  # (explicit escape hatch only)
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
 * store check cannot open its SQLite database. After the gates, the
 * real-client E2E suite runs as a release acceptance step (see
 * docs/e2e-testing.md); the environment must be prepared once with
 * `pnpm run e2e:setup`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

// Real-client E2E acceptance before every release: the unit/integration
// gates mock the Feishu wire, so the release must also verify the real
// long connection + browser client locally (see docs/e2e-testing.md).
// The environment is prepared once with `pnpm run e2e:setup` (QR scans);
// afterwards `e2e:ui` is hands-free and idempotent. Failing the E2E run
// aborts the release. `--skip-e2e` is an explicit escape hatch for cases
// where the E2E environment cannot be provisioned (e.g. no test account
// access) — never the default.
const skipE2E = args.includes('--skip-e2e');
if (!skipE2E) {
  const { existsSync } = await import('node:fs');
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

// Tag and push BOTH the release branch and the tag; the release workflow
// publishes from the tag.
run(`git add package.json pnpm-lock.yaml`);
run(`git commit -m "chore: release v${next}"`);
run(`git tag v${next}`);
run(`git push -u origin ${branch}`);
run(`git push origin v${next}`);

console.log(`\npushed branch ${branch} and tag v${next} — the Release workflow (NPM_TOKEN) publishes to npm and creates the GitHub Release.`);
