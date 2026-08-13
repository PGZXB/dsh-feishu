/**
 * Unit tests for the recursive project scanner.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_SCAN_DIRS, scanMultipleProjects, scanProjects } from '../src/projects.js';

const SCRATCH = join(process.cwd(), '_dev', 'test-projects');

function makeRepo(rel: string): string {
  const dir = join(SCRATCH, rel);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

function makeDir(rel: string): string {
  const dir = join(SCRATCH, rel);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('scanProjects', () => {
  it('finds git checkouts up to the depth cap', async () => {
    const top = makeRepo('top'); // depth 1
    const nested = makeRepo('mid/inner'); // depth 2
    const depth3 = makeRepo('x/y/z'); // depth 3 — at the cap, found
    makeDir('mid/plain');
    const deep = makeRepo('a/b/c/deep'); // depth 4 — beyond the cap
    const projects = await scanProjects(SCRATCH);
    const paths = projects.map((p) => p.path).sort();
    expect(paths).toContain(top);
    expect(paths).toContain(nested);
    expect(paths).toContain(depth3);
    expect(paths).not.toContain(deep);
  });

  it('skips dot-dirs and dependency directories', async () => {
    makeRepo('top');
    makeRepo('.hidden');
    makeRepo('proj/node_modules/dep');
    makeRepo('proj/vendor/lib');
    makeRepo('proj/dist/bundle');
    makeRepo('proj/src/real');
    const projects = await scanProjects(SCRATCH);
    const paths = projects.map((p) => p.path).sort();
    expect(paths).toEqual([join(SCRATCH, 'proj/src/real'), join(SCRATCH, 'top')]);
  });

  it('accepts a gitfile (linked worktree) as a project marker', async () => {
    const dir = makeDir('wt');
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    const projects = await scanProjects(SCRATCH);
    expect(projects.map((p) => p.path)).toEqual([dir]);
  });

  it('ignores empty .git directories so the walk keeps recursing', async () => {
    const stray = makeDir('stray');
    mkdirSync(join(stray, '.git'), { recursive: true }); // no HEAD
    const real = makeRepo('stray/real');
    const projects = await scanProjects(SCRATCH);
    expect(projects.map((p) => p.path)).toEqual([real]);
  });

  it('deduplicates by absolute path across multiple roots', async () => {
    const repo = makeRepo('shared');
    const projects = await scanMultipleProjects([SCRATCH, join(SCRATCH, 'shared')]);
    expect(projects.filter((p) => p.path === repo)).toHaveLength(1);
  });

  it('surfaces the git ref as the branch name', async () => {
    makeRepo('top');
    const projects = await scanProjects(SCRATCH);
    expect(projects[0]?.branch).toBeDefined();
    expect(projects[0]?.name).toBe('top');
    expect(projects[0]?.type).toBe('repo');
  });

  it('reports a budget trip via onBudgetExceeded', async () => {
    for (let i = 0; i < 5; i += 1) makeRepo(`d${i}/r${i}`);
    let reason: 'dirs' | 'time' | undefined;
    const projects = await scanProjects(SCRATCH, 3, {
      maxScanDirs: 1,
      onBudgetExceeded: (info) => {
        reason = info.reason;
      },
    });
    expect(reason).toBe('dirs');
    expect(projects.length).toBeLessThan(5);
  });

  it('caps the walk with the default dir budget', async () => {
    expect(DEFAULT_MAX_SCAN_DIRS).toBeGreaterThan(0);
    for (let i = 0; i < 20; i += 1) makeRepo(`bulk${i}`);
    const projects = await scanProjects(SCRATCH);
    expect(projects.length).toBe(20);
  });
});
