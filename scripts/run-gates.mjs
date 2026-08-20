#!/usr/bin/env node
/**
 * Run the full gate matrix exactly as CI does, checking every exit code.
 *
 * The recurring failure mode this script kills: piping a gate through
 * `| tail` or reading only the last line can mask a non-zero exit, and
 * `biome check --write` only applies safe fixes — a local "green" is not
 * CI green. Every gate here runs with stdio inherited (no pipes) and its
 * real exit code is checked before the next one starts.
 *
 * Gates invoke the binaries directly (node_modules/.bin) rather than
 * through `pnpm run`, so pnpm's dependency-status check — which can fail
 * when the pnpm store lives outside the workspace — never blocks a gate.
 *
 * Usage:
 *   node scripts/run-gates.mjs               # lint, typecheck, build, test
 *   node scripts/run-gates.mjs --no-test     # skip the (slow) test gate
 *   node scripts/run-gates.mjs --test-only   # run only the test gate
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'node_modules', '.bin');
const bin = (name) => {
  const win = join(BIN, `${name}.cmd`);
  return existsSync(win) ? win : join(BIN, name);
};

const args = process.argv.slice(2);
const noTest = args.includes('--no-test');
const testOnly = args.includes('--test-only');

const testEnv = {
  FEISHU_INT_REQUIRED: '1',
  // The integration suites resolve the dsh CLI from DSH_BIN first, then
  // PATH. Pin it to the worktree's own CLI — a stale dsh on PATH (e.g. an
  // old npx cache) silently runs the tests against the wrong version and
  // fails with confusing errors (rc.6 CLI + rc.8 code: "signal.
  // addEventListener is not a function").
  DSH_BIN: bin('dsh'),
};
const GATES = testOnly
  ? [{ name: 'test (FEISHU_INT_REQUIRED=1)', cmd: bin('vitest'), argv: ['run'], env: testEnv }]
  : [
      { name: 'lint (biome check)', cmd: bin('biome'), argv: ['check', 'src', 'tests'] },
      { name: 'typecheck (tsc --noEmit)', cmd: bin('tsc'), argv: ['--noEmit'] },
      { name: 'build (tsc emit)', cmd: bin('tsc'), argv: ['-p', 'tsconfig.build.json'] },
      ...(noTest
        ? []
        : [{ name: 'test (FEISHU_INT_REQUIRED=1)', cmd: bin('vitest'), argv: ['run'], env: testEnv }]),
    ];

let failed = false;
for (const gate of GATES) {
  process.stdout.write(`\n▶ ${gate.name}...\n`);
  const result = spawnSync(gate.cmd, gate.argv, {
    stdio: 'inherit',
    env: { ...process.env, ...gate.env },
  });
  if (result.status !== 0) {
    console.error(`✗ ${gate.name} FAILED (exit ${result.status})`);
    failed = true;
    break;
  }
  console.log(`✓ ${gate.name} passed`);
}

if (failed) {
  console.error('\nGates failed — see output above.');
  process.exit(1);
}
console.log('\nAll gates passed.');
