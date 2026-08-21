/**
 * Report artifacts: collect the screenshots / videos a run produced and write
 * a machine-readable manifest next to the Playwright HTML report. The walk is
 * pure (a directory listing) so it is unit-testable without a browser.
 *
 * @module e2e/lib/report
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
import { basename, dirname, join, relative } from 'node:path';

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
                  ...(firstError.location !== undefined ? { location: firstError.location } : {}),
                },
              }
            : {}),
          annotations: (result?.annotations ?? [])
            .filter((a) => a.description !== undefined)
            .map((a) => a.description as string),
          stdout: (result?.stdout ?? []).map((c) => c.text ?? ''),
          stderr: (result?.stderr ?? []).map((c) => c.text ?? ''),
          artifacts: [],
        });
      }
    }
  }
  return out;
}

/** Copy a case's attachments + scenario snapshots into its case dir. */
function populateCaseArtifacts(runDir: string, cases: E2eCase[]): void {
  // Attachment paths in the Playwright JSON are relative to runDir
  // (e.g. `playwright-output/<case>/test-finished-1.png`). Collect them per
  // case by scanning the playwright-output tree, since the JSON does not
  // tie attachments to cases directly.
  const outputDir = join(runDir, 'playwright-output');
  const byDir = new Map<string, { kind: 'screenshot' | 'video'; path: string; size: number }[]>();
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
        walk(full);
      } else {
        const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
        const kind = SCREENSHOT_EXT.has(ext)
          ? 'screenshot'
          : VIDEO_EXT.has(ext)
            ? 'video'
            : undefined;
        if (kind === undefined) continue;
        const parentDir = dirname(full);
        const list = byDir.get(parentDir) ?? [];
        list.push({ kind, path: full, size: stat.size });
        byDir.set(parentDir, list);
      }
    }
  };
  if (existsSync(outputDir)) walk(outputDir);

  for (const c of cases) {
    const caseDir = join(runDir, 'cases', c.caseId);
    mkdirSync(join(caseDir, 'screenshots'), { recursive: true });
    const artifacts: E2eCase['artifacts'] = [];
    // 1. attachments from the playwright-output tree
    for (const [dir, files] of byDir) {
      if (!dir.includes(c.caseId) && !c.caseId.includes('')) continue;
      for (const f of files) {
        const target =
          f.kind === 'video'
            ? join(caseDir, 'video.mp4')
            : join(caseDir, 'screenshots', basename(f.path));
        try {
          copyFileSync(f.path, target);
          artifacts.push({
            kind: f.kind,
            path: relative(caseDir, target),
            size: statSync(target).size,
          });
        } catch {
          // best effort — a missing artifact must not kill the report
        }
      }
    }
    // 2. the scenario's own key screenshots (runDir/screenshots/*.png)
    const shotsDir = join(runDir, 'screenshots');
    if (existsSync(shotsDir)) {
      for (const entry of readdirSync(shotsDir)) {
        if (!SCREENSHOT_EXT.has(entry.slice(entry.lastIndexOf('.')).toLowerCase())) continue;
        const target = join(caseDir, 'screenshots', entry);
        try {
          copyFileSync(join(shotsDir, entry), target);
          artifacts.push({
            kind: 'screenshot',
            path: relative(caseDir, target),
            size: statSync(target).size,
          });
        } catch {
          // best effort
        }
      }
    }
    c.artifacts.push(...artifacts);
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build the self-contained per-case HTML. */
export function caseHtml(c: E2eCase): string {
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
    : '<p>(no recording)</p>';
  const error = c.error
    ? `<pre class="error">${esc(c.error.message)}${c.error.location ? '\n\n  at ' + esc(c.error.location) : ''}</pre>`
    : '';
  const annotations = c.annotations.map((a) => `<li>${esc(a)}</li>`).join('');
  const stdout = c.stdout.length > 0 ? `<pre class="stdout">${esc(c.stdout.join('\n'))}</pre>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>${esc(c.title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;color:#222;line-height:1.5}
.status{font-weight:700;padding:.2rem .6rem;border-radius:4px;color:#fff}
.passed{background:#16a34a}.failed{background:#dc2626}.skipped{background:#64748b}.flaky{background:#d97706}
pre{background:#f4f4f5;padding:1rem;overflow:auto;border-radius:6px;font-size:.85rem}
pre.error{border-left:4px solid #dc2626}
img{max-width:100%;border:1px solid #e4e4e7;border-radius:6px}
video{max-width:100%;border:1px solid #e4e4e7;border-radius:6px}
table{border-collapse:collapse;margin:1rem 0}td,th{border:1px solid #e4e4e7;padding:.4rem .7rem;text-align:left}
a{color:#2563eb}
</style></head><body>
<h1>${esc(c.title)}</h1>
<p>Case <code>${esc(c.caseId)}</code> · <span class="status ${esc(c.status)}">${esc(c.status)}</span> · ${c.durationMs} ms · started ${esc(c.startedAt)}</p>
${error}
<h2>Annotations</h2>
${annotations ? '<ul>' + annotations + '</ul>' : '<p>(none)</p>'}
<h2>Screenshots</h2>
${shots || '<p>(none)</p>'}
<h2>Recording</h2>
${videoTag}
<h2>Artifacts</h2>
<table><tr><th>kind</th><th>path</th><th>size</th></tr>${c.artifacts.map((a) => `<tr><td>${a.kind}</td><td>${esc(a.path)}</td><td>${a.size}</td></tr>`).join('')}</table>
${stdout ? '<h2>stdout</h2>' + stdout : ''}
<p><a href="../summary.html">← back to summary</a></p>
</body></html>`;
}

/** Build the summary HTML with per-case links. */
export function summaryHtml(summary: E2eRunSummary): string {
  const rows = summary.cases
    .map(
      (c) =>
        `<tr><td><span class="status ${esc(c.status)}">${esc(c.status)}</span></td>` +
        `<td><a href="cases/${esc(c.caseId)}/report.html">${esc(c.title)}</a></td>` +
        `<td>${c.durationMs} ms</td></tr>`,
    )
    .join('\n');
  const env = Object.entries(summary.environment)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>E2E run ${esc(summary.runId)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;color:#222;line-height:1.5}
.status{font-weight:700;padding:.2rem .6rem;border-radius:4px;color:#fff}
.passed{background:#16a34a}.failed{background:#dc2626}.skipped{background:#64748b}.flaky{background:#d97706}
table{border-collapse:collapse;margin:1rem 0}td,th{border:1px solid #e4e4e7;padding:.4rem .7rem;text-align:left}
a{color:#2563eb}
</style></head><body>
<h1>E2E run ${esc(summary.runId)}</h1>
<p>Generated ${esc(summary.generatedAt)} · ${summary.total} cases: <span class="status passed">${summary.passed} passed</span> <span class="status failed">${summary.failed} failed</span> <span class="status skipped">${summary.skipped} skipped</span> <span class="status flaky">${summary.flaky} flaky</span></p>
<h2>Cases</h2>
<table><tr><th>status</th><th>case (click for the full report)</th><th>duration</th></tr>
${rows}</table>
<h2>Environment</h2>
<table>${env}</table>
</body></html>`;
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
