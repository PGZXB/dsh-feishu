/**
 * Recursive project discovery for the `/repo` picker.
 *
 * Semantics replicate botmux's `project-scanner.ts` (the reference
 * implementation for repo-picking UX): walk up to `maxDepth` levels, skip
 * dot-directories and heavyweight dependency trees, treat a valid `.git`
 * marker (directory containing `HEAD`, or a gitfile for linked worktrees) as
 * a project, deduplicate by git common-dir and absolute path, and bound the
 * whole walk with a directory-count and wall-clock budget so a misconfigured
 * scan root (e.g. `~`) cannot stall the daemon.
 *
 * Unlike botmux (synchronous `readdirSync`/`execSync`), this module is
 * async — the surface runs in-process with dsh and must never block the
 * event loop.
 *
 * @module @dsh-feishu/dsh-feishu/projects
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A discovered project: a git checkout (or one of its linked worktrees). */
export interface ProjectInfo {
  /** Directory basename of the project's main checkout (stable label). */
  readonly name: string;
  /** Absolute path to the checkout (or linked worktree). */
  readonly path: string;
  /** `repo` = main checkout, `worktree` = linked worktree. */
  readonly type: 'repo' | 'worktree';
  /** Current ref: branch, tag, short SHA, or `unknown`. */
  readonly branch: string;
}

/** Options controlling one scan. */
export interface ProjectScanOptions {
  /** Include linked worktrees in the result. Defaults to true. */
  readonly includeWorktrees?: boolean;
  /** Hard cap on directories visited. Defaults to {@link DEFAULT_MAX_SCAN_DIRS}. */
  readonly maxScanDirs?: number;
  /** Wall-clock budget in ms. Defaults to {@link DEFAULT_MAX_SCAN_MS}. */
  readonly maxScanMs?: number;
  /**
   * Invoked once, after the walk, when a budget tripped (result may be
   * incomplete). `reason` says which cap tripped.
   */
  readonly onBudgetExceeded?: (info: {
    reason: 'dirs' | 'time';
    dirsVisited: number;
    baseDir: string;
  }) => void;
}

/** Upper bound on directories one scan visits before bailing out. */
export const DEFAULT_MAX_SCAN_DIRS = 4000;

/** Wall-clock budget for one scan; a normal projects root scans in well under a second. */
export const DEFAULT_MAX_SCAN_MS = 4000;

/** Directories skipped at every level (dot-dirs, dependency trees). */
const SKIP_ENTRIES = new Set(['node_modules', 'vendor', 'dist']);

/** Run git, returning trimmed stdout or `null` on any failure. `ceilingDir`,
 *  when given, is passed as `GIT_CEILING_DIRECTORIES` so git's upward
 *  repository discovery cannot escape the scan root — a fake/partial `.git`
 *  marker inside the root must never resolve to an ancestor repository
 *  outside it. */
async function runGit(
  args: readonly string[],
  cwd: string,
  ceilingDir?: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: 5000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        ...(ceilingDir !== undefined ? { GIT_CEILING_DIRECTORIES: ceilingDir } : {}),
      },
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** A `.git` entry that is a regular file (worktree gitlink) or a directory
 *  containing `HEAD`. Empty `.git/` dirs are rejected so the walk keeps
 *  recursing past stray markers. */
async function isValidGitMarker(parentDir: string): Promise<boolean> {
  const gitPath = join(parentDir, '.git');
  let stats: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    stats = await stat(gitPath);
  } catch {
    return false;
  }
  if (stats.isFile()) return true;
  if (stats.isDirectory()) {
    try {
      await stat(join(gitPath, 'HEAD'));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** `rev-parse --abbrev-ref HEAD` returns literal `HEAD` when detached —
 *  fall through to tag/SHA then. */
async function getGitRef(dir: string, ceilingDir?: string): Promise<string> {
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir, ceilingDir);
  if (branch && branch !== 'HEAD') return branch;
  const tag = await runGit(['describe', '--tags', '--exact-match', 'HEAD'], dir, ceilingDir);
  if (tag) return tag;
  const sha = await runGit(['rev-parse', '--short', 'HEAD'], dir, ceilingDir);
  return sha || 'unknown';
}

/** Shorten a detached-HEAD SHA for display. */
function describeDetachedHead(headSha: string): string {
  return headSha ? headSha.slice(0, 7) : 'unknown';
}

/** Sibling worktrees of one repo share a common-dir — the dedup key so main
 *  + linked checkouts aren't double-registered. Falls back to the dir itself
 *  when git is unavailable (e.g. in tests with synthetic `.git` markers). */
async function getGitCommonDir(dir: string, ceilingDir?: string): Promise<string> {
  const out = await runGit(['rev-parse', '--git-common-dir'], dir, ceilingDir);
  return out ? resolve(dir, out) : dir;
}

/** Parse `git worktree list --porcelain` into {path, branch} entries. */
function parseWorktreeList(output: string): { path: string; branch: string }[] {
  const entries: { path: string; branch: string }[] = [];
  let currentPath = '';
  let currentHead = '';
  let currentBranch = '';
  // The output is trimmed (no trailing newline); append a sentinel so the
  // final entry hits the empty-line flush branch below.
  for (const line of [...output.split('\n'), '']) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      currentHead = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === '' && currentPath !== '') {
      entries.push({
        path: currentPath,
        branch:
          currentBranch || (currentHead !== '' ? describeDetachedHead(currentHead) : 'unknown'),
      });
      currentPath = '';
      currentHead = '';
      currentBranch = '';
    }
  }
  return entries;
}

/** List the main checkout + linked worktrees of one repo, or a single entry
 *  when git is unavailable. All entries share the main checkout's basename. */
async function scanRepoFromAnyWorktree(
  anyWorktreePath: string,
  options: ProjectScanOptions,
  ceilingDir?: string,
): Promise<ProjectInfo[]> {
  const fallback: ProjectInfo[] = [
    {
      name: basename(anyWorktreePath),
      path: anyWorktreePath,
      type: 'repo',
      branch: await getGitRef(anyWorktreePath, ceilingDir),
    },
  ];
  const output = await runGit(['worktree', 'list', '--porcelain'], anyWorktreePath, ceilingDir);
  if (output === null) return fallback;
  const entries = parseWorktreeList(output);
  if (entries.length === 0) return fallback;
  const first = entries[0];
  if (first === undefined) return fallback;
  const repoName = basename(first.path);
  const includeWorktrees = options.includeWorktrees !== false;
  return entries
    .filter((_entry, index) => includeWorktrees || index === 0)
    .map((entry, index) => ({
      name: repoName,
      path: entry.path,
      type: index === 0 ? ('repo' as const) : ('worktree' as const),
      branch: entry.branch,
    }));
}

function compareProjects(a: ProjectInfo, b: ProjectInfo): number {
  if (a.type !== b.type) return a.type === 'repo' ? -1 : 1;
  return a.name.localeCompare(b.name) || a.branch.localeCompare(b.branch);
}

/**
 * Recursively scan `baseDir` (up to `maxDepth` levels) for git checkouts.
 * @param baseDir - absolute directory to scan.
 * @param maxDepth - recursion depth cap; botmux's default is 3.
 * @param options - budgets and worktree control.
 * @returns discovered projects, sorted repos-first then by name.
 */
export async function scanProjects(
  baseDir: string,
  maxDepth = 3,
  options: ProjectScanOptions = {},
): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];
  const seenRepos = new Set<string>(); // by git common-dir
  const seenPaths = new Set<string>(); // by absolute path
  const maxScanDirs = options.maxScanDirs ?? DEFAULT_MAX_SCAN_DIRS;
  const maxScanMs = options.maxScanMs ?? DEFAULT_MAX_SCAN_MS;
  const deadline = Date.now() + maxScanMs;
  let dirsVisited = 0;
  let budgetReason: 'dirs' | 'time' | null = null;

  const overBudget = (): boolean => {
    if (dirsVisited >= maxScanDirs) {
      budgetReason ??= 'dirs';
      return true;
    }
    if (Date.now() >= deadline) {
      budgetReason ??= 'time';
      return true;
    }
    return false;
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || overBudget()) return;
    dirsVisited += 1;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // permission denied or missing
    }
    if (entries.includes('.git') && (await isValidGitMarker(dir))) {
      const commonDir = await getGitCommonDir(dir, baseDir);
      if (seenRepos.has(commonDir)) return;
      seenRepos.add(commonDir);
      for (const project of await scanRepoFromAnyWorktree(dir, options, baseDir)) {
        if (!seenPaths.has(project.path)) {
          seenPaths.add(project.path);
          projects.push(project);
        }
      }
      return; // a repo's internals aren't nested projects
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_ENTRIES.has(entry)) continue;
      if (overBudget()) return;
      const fullPath = join(dir, entry);
      try {
        if ((await stat(fullPath)).isDirectory()) {
          await walk(fullPath, depth + 1);
        }
      } catch {
        // permission denied or broken symlink
      }
    }
  };

  await walk(baseDir, 0);
  projects.sort(compareProjects);
  if (budgetReason) {
    options.onBudgetExceeded?.({
      reason: budgetReason,
      dirsVisited,
      baseDir,
    });
  }
  return projects;
}

/**
 * Scan several roots and merge, deduplicating by absolute path.
 * @param baseDirs - absolute directories to scan.
 * @param maxDepth - per-root recursion depth cap.
 * @param options - budgets and worktree control.
 * @returns merged projects, sorted repos-first then by name.
 */
export async function scanMultipleProjects(
  baseDirs: readonly string[],
  maxDepth = 3,
  options: ProjectScanOptions = {},
): Promise<ProjectInfo[]> {
  const seen = new Set<string>();
  const merged: ProjectInfo[] = [];
  for (const dir of baseDirs) {
    for (const project of await scanProjects(dir, maxDepth, options)) {
      if (!seen.has(project.path)) {
        seen.add(project.path);
        merged.push(project);
      }
    }
  }
  merged.sort(compareProjects);
  return merged;
}
