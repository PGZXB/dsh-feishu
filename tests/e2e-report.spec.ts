import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectArtifacts, generateRunReport, writeManifest } from '../e2e/lib/report.js';

const TMP = join(process.cwd(), '_dev', 'e2e-unit-tmp');

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, 'html'), { recursive: true });
  mkdirSync(join(TMP, 'screenshots'), { recursive: true });
  writeFileSync(join(TMP, 'html', 'index.html'), '<html></html>');
  writeFileSync(join(TMP, 'screenshots', 'help-reply.png'), 'x');
  writeFileSync(join(TMP, 'screenshots', 'note.txt'), 'not an artifact');
  writeFileSync(join(TMP, 'run.webm'), 'y');
  writeFileSync(join(TMP, 'run.mp4'), 'z');
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('e2e report artifacts', () => {
  it('collects screenshots and videos, skipping the html report and other files', () => {
    const artifacts = collectArtifacts(TMP);
    const kinds = artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(['screenshot', 'video', 'video']);
    expect(artifacts.every((a) => !a.path.startsWith('html/'))).toBe(true);
    expect(artifacts.every((a) => a.size > 0)).toBe(true);
    // deterministic order: path ascending
    const paths = artifacts.map((a) => a.path);
    expect(paths).toEqual([...paths].sort());
  });

  it('returns [] for a missing directory', () => {
    expect(collectArtifacts(join(TMP, 'nope'))).toEqual([]);
  });

  it('writes a manifest.json', () => {
    const artifacts = collectArtifacts(TMP);
    writeManifest(TMP, artifacts);
    const manifest = JSON.parse(readFileSync(join(TMP, 'manifest.json'), 'utf8')) as {
      generatedAt: string;
      artifacts: { kind: string; path: string; size: number }[];
    };
    expect(manifest.generatedAt).toBeTruthy();
    expect(manifest.artifacts.length).toBe(artifacts.length);
    expect(manifest.artifacts[0]).toHaveProperty('path');
  });
});

describe('e2e run report generator', () => {
  const RUN = join(TMP, 'run-report');

  beforeEach(() => {
    rmSync(RUN, { recursive: true, force: true });
    mkdirSync(join(RUN, 'screenshots'), { recursive: true });
    mkdirSync(join(RUN, 'playwright-output', 'send-help'), { recursive: true });
    // Scenario snapshots are named `N_<label>.png` at save time (per-page
    // counter in feishu.ts) — the fixture mirrors that.
    writeFileSync(join(RUN, 'screenshots', '1_help-reply.png'), 'shot');
    writeFileSync(join(RUN, 'playwright-output', 'send-help', 'test-finished-1.png'), 'auto');
    writeFileSync(join(RUN, 'playwright-output', 'send-help', 'video.webm'), 'vid');
    writeFileSync(join(RUN, 'playwright-output', 'send-help', 'video.mp4'), 'vid');
    writeFileSync(
      join(RUN, 'report.json'),
      JSON.stringify({
        stats: {
          startTime: '2026-08-21T00:00:00.000Z',
          duration: 6400,
          expected: 1,
          skipped: 0,
          unexpected: 0,
          flaky: 0,
        },
        suites: [
          {
            title: 'help.spec.js',
            specs: [
              {
                title: 'send /help → slash command descriptions',
                tests: [
                  {
                    status: 'expected',
                    results: [
                      {
                        status: 'expected',
                        duration: 6400,
                        startTime: '2026-08-21T00:00:00.100Z',
                        retry: 0,
                        errors: [],
                        annotations: [
                          { type: 'evidence', description: 'bot reply: dsh-feishu commands:' },
                        ],
                        stdout: [],
                        stderr: [],
                        attachments: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
  });

  it('generates per-case and summary outputs', () => {
    const summary = generateRunReport(RUN, { node: 'v22', chat: 'Test Bot' });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.cases[0]?.caseId).toBe('send-help-slash-command-descriptions');

    const summaryJson = JSON.parse(readFileSync(join(RUN, 'summary.json'), 'utf8')) as {
      cases: { report: string }[];
    };
    expect(summaryJson.cases[0]?.report).toBe(
      'cases/send-help-slash-command-descriptions/report.json',
    );

    const caseJson = JSON.parse(
      readFileSync(
        join(RUN, 'cases', 'send-help-slash-command-descriptions', 'report.json'),
        'utf8',
      ),
    ) as { status: string; annotations: string[]; artifacts: { kind: string; path: string }[] };
    expect(caseJson.status).toBe('passed');
    expect(caseJson.annotations).toContain('bot reply: dsh-feishu commands:');
    // Scenario snapshots are already numbered in capture order at save time
    // (1_help-reply.png, 2_…); Playwright's own capture keeps its name. The
    // report sorts screenshots first (numbered ones lead, in order), then
    // the video.
    const shotPaths = caseJson.artifacts.filter((a) => a.kind === 'screenshot').map((a) => a.path);
    expect(shotPaths.length).toBe(2);
    expect(shotPaths[0]).toBe('screenshots/1_help-reply.png');
    expect(shotPaths[1]).toBe('screenshots/test-finished-1.png');
    expect(caseJson.artifacts.some((a) => a.path === 'video.mp4')).toBe(true);

    const caseHtml = readFileSync(
      join(RUN, 'cases', 'send-help-slash-command-descriptions', 'report.html'),
      'utf8',
    );
    expect(caseHtml).toContain('<video');
    expect(caseHtml).toContain('1_help-reply.png');
    // The case page lives at cases/<caseId>/report.html; the summary is two
    // levels up.
    expect(caseHtml).toContain('href="../../summary.html"');
    expect(caseHtml).not.toContain('href="../summary.html"');

    const summaryHtml = readFileSync(join(RUN, 'summary.html'), 'utf8');
    expect(summaryHtml).toContain('cases/send-help-slash-command-descriptions/report.html');
    expect(summaryHtml).toContain('v22');
  });

  it('flags failing cases', () => {
    writeFileSync(
      join(RUN, 'report.json'),
      JSON.stringify({
        stats: {
          startTime: '2026-08-21T00:00:00.000Z',
          duration: 10,
          expected: 0,
          skipped: 0,
          unexpected: 1,
          flaky: 0,
        },
        suites: [
          {
            specs: [
              {
                title: 'boom',
                tests: [
                  {
                    status: 'unexpected',
                    results: [
                      {
                        status: 'unexpected',
                        duration: 10,
                        startTime: '2026-08-21T00:00:00.000Z',
                        retry: 0,
                        errors: [{ message: 'boom failed', location: 'e2e/lib/x.ts:1' }],
                        annotations: [],
                        stdout: [],
                        stderr: [],
                        attachments: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const summary = generateRunReport(RUN, {});
    expect(summary.failed).toBe(1);
    const caseJson = JSON.parse(
      readFileSync(join(RUN, 'cases', 'boom', 'report.json'), 'utf8'),
    ) as { status: string; error: { message: string } };
    expect(caseJson.status).toBe('failed');
    expect(caseJson.error.message).toBe('boom failed');
    expect(readFileSync(join(RUN, 'summary.html'), 'utf8')).toContain('failed');
  });
});
