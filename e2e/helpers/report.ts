/**
 * Report artifacts: collect the screenshots / videos a run produced and write
 * a machine-readable manifest next to the Playwright HTML report. The walk is
 * pure (a directory listing) so it is unit-testable without a browser.
 *
 * @module e2e/helpers/report
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';

/** One artifact the run produced. */
export interface E2eArtifact {
  readonly kind: 'screenshot' | 'video';
  /** Path relative to the report dir (stable across machines). */
  readonly path: string;
  /** Size in bytes. */
  readonly size: number;
}

/** The run manifest written to `reportDir/manifest.json`. */
export interface E2eManifest {
  readonly generatedAt: string;
  readonly artifacts: E2eArtifact[];
}

/** File extensions counted as screenshots / videos. */
const SCREENSHOT_EXT = new Set(['.png', '.jpg', '.jpeg']);
const VIDEO_EXT = new Set(['.webm', '.mp4']);

/**
 * Collect the artifacts under `reportDir` (recursively, excluding the
 * Playwright html output). Deterministic order: path ascending.
 * @param reportDir - the report output directory.
 * @returns the collected artifacts.
 */
export function collectArtifacts(reportDir: string): E2eArtifact[] {
  if (!existsSync(reportDir)) return [];
  const out: E2eArtifact[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync> | undefined;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat === undefined) continue;
      if (stat.isDirectory()) {
        if (entry === 'html') continue; // Playwright's html report, not an artifact
        walk(full);
      } else {
        const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
        const kind = SCREENSHOT_EXT.has(ext)
          ? 'screenshot'
          : VIDEO_EXT.has(ext)
            ? 'video'
            : undefined;
        if (kind !== undefined) {
          out.push({ kind, path: relative(reportDir, full), size: stat.size });
        }
      }
    }
  };
  walk(reportDir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Write the run manifest (`manifest.json`) into `reportDir`.
 * @param reportDir - the report output directory.
 * @param artifacts - artifacts to record (from {@link collectArtifacts}).
 */
export function writeManifest(reportDir: string, artifacts: E2eArtifact[]): void {
  mkdirSync(reportDir, { recursive: true });
  const manifest: E2eManifest = { generatedAt: new Date().toISOString(), artifacts };
  writeFileSync(join(reportDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// ── Run report generator ───────────────────────────────────────────────────
// Turns Playwright's JSON report into the standardized per-case + summary
// layout the suite ships:
//
//   <runDir>/
//     report.json           (Playwright's own JSON — the source of truth)
//     summary.json          run + per-case summary (machine-readable)
//     summary.html          run + per-case table, links into cases/ (human)
//     cases/<caseId>/
//       report.json         one case, everything we know about it
//       report.html         one case, self-contained (screenshots + video)
//       screenshots/*.png   the case's screenshots
//       video.mp4           the case's recording (mp4)

/** A parsed Playwright JSON report (the subset we consume). */
export interface PlaywrightReport {
  readonly stats?: {
    readonly startTime?: string;
    readonly duration?: number;
    readonly expected?: number;
    readonly skipped?: number;
    readonly unexpected?: number;
    readonly flaky?: number;
  };
  readonly errors?: readonly unknown[];
  readonly suites?: readonly PlaywrightSuite[];
}

interface PlaywrightSuite {
  readonly title?: string;
  readonly specs?: readonly {
    readonly title?: string;
    readonly tests?: readonly PlaywrightTest[];
  }[];
}

interface PlaywrightTest {
  readonly title?: string | null;
  readonly status?: string;
  readonly results?: readonly PlaywrightResult[];
}

interface PlaywrightResult {
  readonly status?: string;
  readonly duration?: number;
  readonly startTime?: string;
  readonly retry?: number;
  readonly errors?: readonly { message?: string; location?: string }[];
  readonly annotations?: readonly { type?: string; description?: string }[];
  readonly stdout?: readonly { text?: string }[];
  readonly stderr?: readonly { text?: string }[];
  readonly attachments?: readonly { name?: string; contentType?: string; path?: string }[];
}

/** One test case after normalization. */
export interface E2eCase {
  readonly caseId: string;
  readonly title: string;
  readonly status: 'passed' | 'failed' | 'skipped' | 'flaky';
  readonly durationMs: number;
  readonly startedAt: string;
  readonly retry: number;
  readonly error?: { readonly message: string; readonly location?: string };
  readonly annotations: readonly string[];
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** Playwright attachment paths for this case (absolute, from the JSON). */
  readonly attachmentPaths: readonly string[];
  /** Artifacts copied into the case dir, relative to it. */
  artifacts: { kind: 'screenshot' | 'video'; path: string; size: number }[];
}

/** The run summary written to `summary.json`. */
export interface E2eRunSummary {
  readonly runId: string;
  readonly generatedAt: string;
  readonly environment: Record<string, string>;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly flaky: number;
  readonly cases: readonly {
    readonly caseId: string;
    readonly title: string;
    readonly status: string;
    readonly durationMs: number;
    readonly report: string;
  }[];
}

/** Slugify a title into a stable, filesystem-safe case id. */
export function caseIdFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'case' : slug;
}

/** Read and parse the Playwright JSON report at `runDir/report.json`. */
export function readPlaywrightReport(runDir: string): PlaywrightReport {
  try {
    return JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')) as PlaywrightReport;
  } catch {
    return {};
  }
}

/** Flatten the report into normalized cases (one per test). */
export function flattenCases(report: PlaywrightReport): E2eCase[] {
  const out: E2eCase[] = [];
  for (const suite of report.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const title = spec.title ?? test.title ?? '(untitled)';
        const result = test.results?.[0];
        const statusRaw = result?.status ?? test.status ?? 'skipped';
        const status: E2eCase['status'] =
          statusRaw === 'expected'
            ? 'passed'
            : statusRaw === 'unexpected'
              ? 'failed'
              : (statusRaw as E2eCase['status']);
        const firstError = result?.errors?.find((e) => e.message !== undefined && e.message !== '');
        // Playwright's error.location is an OBJECT ({file, column, line}), not
        // a string — normalize it to "file:line" so the HTML escapes cleanly.
        const normalizeLocation = (loc: unknown): string | undefined => {
          if (typeof loc === 'string' && loc !== '') return loc;
          if (loc !== null && typeof loc === 'object') {
            const o = loc as Record<string, unknown>;
            const file = typeof o.file === 'string' ? o.file : undefined;
            const line = typeof o.line === 'number' ? o.line : undefined;
            return file !== undefined
              ? `${file}${line !== undefined ? `:${line}` : ''}`
              : undefined;
          }
          return undefined;
        };
        const errorLocation =
          firstError !== undefined ? normalizeLocation(firstError.location) : undefined;
        out.push({
          caseId: caseIdFromTitle(title),
          title,
          status,
          durationMs: Math.round(result?.duration ?? 0),
          startedAt: result?.startTime ?? report.stats?.startTime ?? new Date().toISOString(),
          retry: result?.retry ?? 0,
          ...(firstError !== undefined
            ? {
                error: {
                  message: firstError.message ?? 'unknown error',
                  ...(errorLocation !== undefined ? { location: errorLocation } : {}),
                },
              }
            : {}),
          annotations: (result?.annotations ?? [])
            .filter((a) => a.description !== undefined)
            .map((a) => a.description as string),
          stdout: (result?.stdout ?? []).map((c) => c.text ?? ''),
          stderr: (result?.stderr ?? []).map((c) => c.text ?? ''),
          attachmentPaths: (result?.attachments ?? [])
            .map((a) => a.path)
            .filter((p): p is string => p !== undefined && p !== ''),
          artifacts: [],
        });
      }
    }
  }
  return out;
}

/** Copy a case's attachments + scenario snapshots into its case dir. */
function populateCaseArtifacts(runDir: string, cases: E2eCase[]): void {
  for (const c of cases) {
    const caseDir = join(runDir, 'cases', c.caseId);
    mkdirSync(join(caseDir, 'screenshots'), { recursive: true });
    const artifacts: E2eCase['artifacts'] = [];
    // 1. Playwright attachments (per-case, from the JSON — authoritative).
    //    Video keeps a single file: prefer mp4 (the ffmpeg-converted copy),
    //    fall back to webm when no mp4 exists (E2E_VIDEO=webm or a failed
    //    conversion) so the recording is never silently dropped.
    const videos = (c.attachmentPaths ?? [])
      .map((p) => ({ path: p, kind: videoKind(p) }))
      .filter((a): a is { path: string; kind: 'video' } => a.kind === 'video');
    const videoPath =
      videos.find((v) => v.path.toLowerCase().endsWith('.mp4'))?.path ?? videos[0]?.path;
    if (videoPath !== undefined) {
      copyArtifact(videoPath, join(caseDir, 'video.mp4'), caseDir, artifacts);
    }
    for (const shot of (c.attachmentPaths ?? []).filter(
      (p) => screenshotKind(p) === 'screenshot',
    )) {
      copyArtifact(shot, join(caseDir, 'screenshots', basename(shot)), caseDir, artifacts);
    }
    // 2. the scenario's own key screenshots — named `N_<label>.png` at save
    //    time (per-page counter in feishu.ts) into a per-case subdir, so
    //    sorting by path IS capture order and cases never collide.
    const shotsDir = join(runDir, 'screenshots', c.caseId);
    if (existsSync(shotsDir)) {
      for (const entry of readdirSync(shotsDir)) {
        if (screenshotKind(entry) !== 'screenshot') continue;
        const target = join(caseDir, 'screenshots', entry);
        copyFileSync(join(shotsDir, entry), target);
        artifacts.push({
          kind: 'screenshot',
          path: relative(caseDir, target),
          size: statSync(target).size,
        });
      }
    }
    // 3. Deterministic display order: screenshots first (path embeds the
    //    capture-order prefix `N_`), then the video.
    artifacts.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'screenshot' ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    c.artifacts.push(...artifacts);
  }
}

/** Copy a source artifact into the case dir and record it. */
function copyArtifact(
  src: string,
  target: string,
  caseDir: string,
  artifacts: E2eCase['artifacts'],
): void {
  try {
    copyFileSync(src, target);
    artifacts.push({
      kind: screenshotKind(src) === 'screenshot' ? 'screenshot' : 'video',
      path: relative(caseDir, target),
      size: statSync(target).size,
    });
  } catch {
    // best effort — a missing artifact must not kill the report
  }
}

function videoKind(path: string): 'video' | undefined {
  return VIDEO_EXT.has(path.slice(path.lastIndexOf('.')).toLowerCase()) ? 'video' : undefined;
}

function screenshotKind(path: string): 'screenshot' | undefined {
  return SCREENSHOT_EXT.has(path.slice(path.lastIndexOf('.')).toLowerCase())
    ? 'screenshot'
    : undefined;
}

function esc(s: string): string {
  // Coerce non-strings (a normalized field could still be an object) — the
  // HTML must never crash the whole report on one bad value.
  const str = typeof s === 'string' ? s : String(s);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── HTML theme ─────────────────────────────────────────────────────────────
// The report mimics the Playwright HTML report's visual language: a dark
// sidebar listing the cases with status dots, a light main panel, and status
// chips colored per outcome. Everything is self-contained (inline CSS), so
// the pages open from the file system with no server.

const STATUS_COLORS: Record<string, string> = {
  passed: '#2da44e',
  failed: '#cf222e',
  skipped: '#6e7781',
  flaky: '#bf8700',
};

const REPORT_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#24292f;background:#f6f8fa}
a{color:#0969da;text-decoration:none}
a:hover{text-decoration:underline}
.shell{display:flex;min-height:100vh}
.sidebar{flex:0 0 300px;background:#1d1f25;color:#e6edf3;padding:1.25rem 0;overflow-y:auto}
.sidebar h1{font-size:1rem;margin:0 1.25rem 0.5rem;font-weight:600}
.sidebar .sub{font-size:.75rem;color:#8b949e;margin:0 1.25rem 1rem}
.case-list{list-style:none;margin:0;padding:0}
.case-list a{display:flex;align-items:center;gap:.5rem;padding:.5rem 1.25rem;color:#e6edf3;border-left:3px solid transparent}
.case-list a:hover{background:#262a33;text-decoration:none}
.case-list .dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto}
.case-list .case-title{flex:1;font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.case-list .dur{font-size:.7rem;color:#8b949e}
.case-list a.current{border-left-color:#58a6ff;background:#262a33}
.main{flex:1;padding:2rem 2.5rem;max-width:1100px}
h1.page{font-size:1.5rem;margin:0 0 .25rem}
.status-banner{display:flex;gap:1rem;margin:1rem 0 1.5rem;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:.4rem;padding:.35rem .7rem;border-radius:2rem;font-size:.8rem;font-weight:600;color:#fff}
.chip.passed{background:#2da44e}.chip.failed{background:#cf222e}.chip.skipped{background:#6e7781}.chip.flaky{background:#bf8700}
.status{display:inline-flex;align-items:center;gap:.35rem;font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.02em}
.status::before{content:'';width:9px;height:9px;border-radius:50%;background:currentColor}
.meta{color:#57606a;font-size:.85rem;margin:.25rem 0 1.5rem}
.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:1.25rem;margin-bottom:1.25rem}
.card h2{font-size:1rem;margin:0 0 .75rem}
table{border-collapse:collapse;width:100%;font-size:.85rem}
td,th{border-bottom:1px solid #d0d7de;padding:.45rem .6rem;text-align:left;vertical-align:top}
th{font-weight:600;color:#57606a}
tr:last-child td{border-bottom:none}
pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:.8rem;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8rem;line-height:1.5}
pre.error{border-left:4px solid #cf222e;background:#fff5f5}
pre.stdout{white-space:pre-wrap}
figure{margin:0 0 1rem}
figure img{max-width:100%;border:1px solid #d0d7de;border-radius:6px}
figcaption{font-size:.75rem;color:#57606a;margin-top:.3rem;font-family:ui-monospace,Menlo,Consolas,monospace}
video{max-width:100%;border:1px solid #d0d7de;border-radius:6px}
ul.annotations{padding-left:1.25rem;font-size:.85rem}
ul.annotations li{margin-bottom:.4rem}
.back{display:inline-block;margin-bottom:1rem;font-size:.85rem}
`;

function statusStyle(status: string): string {
  const color = STATUS_COLORS[status] ?? '#6e7781';
  return `color:${color}`;
}

function pageShell(title: string, sidebar: string, main: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(title)}</title>
<style>${REPORT_CSS}</style></head><body>
<div class="shell">
  <aside class="sidebar">${sidebar}</aside>
  <main class="main">${main}</main>
</div>
</body></html>`;
}

/** Build the self-contained per-case HTML (Playwright-report style). */
export function caseHtml(c: E2eCase): string {
  const sidebar = `
<h1>${esc(c.title)}</h1>
<p class="sub">case ${esc(c.caseId)}</p>
<ul class="case-list"><li><a href="../../summary.html">← back to run summary</a></li></ul>`;
  const shots = c.artifacts
    .filter((a) => a.kind === 'screenshot')
    .map(
      (a) =>
        `<figure><img src="${esc(a.path)}" alt="${esc(a.path)}"/><figcaption>${esc(a.path)}</figcaption></figure>`,
    )
    .join('\n');
  const video = c.artifacts.find((a) => a.kind === 'video');
  const videoTag = video
    ? `<video controls src="${esc(video.path)}"></video>`
    : '<p class="meta">(no recording)</p>';
  const error = c.error
    ? `<pre class="error">${esc(c.error.message)}${c.error.location ? `\n\n  at ${esc(c.error.location)}` : ''}</pre>`
    : '';
  const annotations = c.annotations.map((a) => `<li>${esc(a)}</li>`).join('');
  const stdout = c.stdout.length > 0 ? `<pre class="stdout">${esc(c.stdout.join('\n'))}</pre>` : '';
  const main = `
<a class="back" href="../../summary.html">← back to run summary</a>
<h1 class="page">${esc(c.title)}</h1>
<p class="meta"><span class="status" style="${statusStyle(c.status)}">${esc(c.status)}</span> · ${c.durationMs} ms · started ${esc(c.startedAt)}${c.retry > 0 ? ` · retry ${c.retry}` : ''}</p>
${error}
<div class="card"><h2>Annotations</h2>
${annotations ? `<ul class="annotations">${annotations}</ul>` : '<p class="meta">(none)</p>'}
</div>
<div class="card"><h2>Screenshots</h2>
${shots || '<p class="meta">(none)</p>'}
</div>
<div class="card"><h2>Recording</h2>
${videoTag}
</div>
<div class="card"><h2>Artifacts</h2>
<table><tr><th>kind</th><th>path</th><th>size</th></tr>${c.artifacts.map((a) => `<tr><td>${esc(a.kind)}</td><td>${esc(a.path)}</td><td>${a.size}</td></tr>`).join('')}</table>
</div>
${stdout ? `<div class="card"><h2>stdout</h2>${stdout}</div>` : ''}`;
  return pageShell(c.title, sidebar, main);
}

/** Build the summary HTML with per-case links (single entry point). */
export function summaryHtml(summary: E2eRunSummary): string {
  const rows = summary.cases
    .map(
      (c) =>
        `<li><a href="cases/${esc(c.caseId)}/report.html"><span class="dot" style="background:${STATUS_COLORS[c.status] ?? '#6e7781'}"></span><span class="case-title">${esc(c.title)}</span><span class="dur">${c.durationMs} ms</span></a></li>`,
    )
    .join('\n');
  const env = Object.entries(summary.environment)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('');
  const chips = [
    { key: 'passed', label: 'passed' },
    { key: 'failed', label: 'failed' },
    { key: 'skipped', label: 'skipped' },
    { key: 'flaky', label: 'flaky' },
  ]
    .map(
      ({ key, label }) =>
        `<span class="chip ${key}">${summary[key as keyof E2eRunSummary]} ${label}</span>`,
    )
    .join('');
  const sidebar = `
<h1>E2E run ${esc(summary.runId)}</h1>
<p class="sub">generated ${esc(summary.generatedAt)}</p>
<ul class="case-list">${rows}</ul>`;
  const main = `
<h1 class="page">Run ${esc(summary.runId)}</h1>
<p class="meta">Generated ${esc(summary.generatedAt)} · ${summary.total} case${summary.total === 1 ? '' : 's'}</p>
<div class="status-banner">${chips}</div>
<div class="card"><h2>Environment</h2>
<table>${env}</table>
</div>`;
  return pageShell(`E2E run ${summary.runId}`, sidebar, main);
}

/**
 * Generate the standardized run report layout in `runDir` from the
 * Playwright JSON report. Idempotent — safe to re-run.
 * @param runDir - the run directory containing `report.json`.
 * @param environment - key/value metadata to embed (node/playwright versions, config).
 */
export function generateRunReport(
  runDir: string,
  environment: Record<string, string> = {},
): E2eRunSummary {
  const report = readPlaywrightReport(runDir);
  const cases = flattenCases(report);
  populateCaseArtifacts(runDir, cases);

  const runId = basename(runDir);
  const summary: E2eRunSummary = {
    runId,
    generatedAt: new Date().toISOString(),
    environment,
    total: cases.length,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    flaky: cases.filter((c) => c.status === 'flaky').length,
    cases: cases.map((c) => ({
      caseId: c.caseId,
      title: c.title,
      status: c.status,
      durationMs: c.durationMs,
      report: `cases/${c.caseId}/report.json`,
    })),
  };

  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeFileSync(join(runDir, 'summary.html'), summaryHtml(summary), 'utf8');
  for (const c of cases) {
    const dir = join(runDir, 'cases', c.caseId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), `${JSON.stringify(c, null, 2)}\n`, 'utf8');
    writeFileSync(join(dir, 'report.html'), caseHtml(c), 'utf8');
  }
  // Keep the old manifest for tooling that already reads it.
  writeManifest(runDir, collectArtifacts(runDir));
  return summary;
}
