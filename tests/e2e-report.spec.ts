import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectArtifacts, generateRunReport, writeManifest } from '../e2e/helpers/report.js';

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
    // Scenario snapshots live in a PER-CASE subdir, named `N_<label>.png` at
    // save time (per-page counter in feishu.ts) — the fixture mirrors that.
    mkdirSync(join(RUN, 'screenshots', 'send-help-slash-command-descriptions'), {
      recursive: true,
    });
    writeFileSync(
      join(RUN, 'screenshots', 'send-help-slash-command-descriptions', '1_help-reply.png'),
      'shot',
    );
    // Playwright attachments (per-case, from the JSON): one screenshot and
    // the video (webm + its mp4 conversion).
    mkdirSync(join(RUN, 'playwright-output', 'help-send-help-→-slash-command-descriptions'), {
      recursive: true,
    });
    writeFileSync(
      join(
        RUN,
        'playwright-output',
        'help-send-help-→-slash-command-descriptions',
        'test-finished-1.png',
      ),
      'auto',
    );
    writeFileSync(
      join(RUN, 'playwright-output', 'help-send-help-→-slash-command-descriptions', 'video.webm'),
      'vid',
    );
    writeFileSync(
      join(RUN, 'playwright-output', 'help-send-help-→-slash-command-descriptions', 'video.mp4'),
      'vid',
    );
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
                        attachments: [
                          {
                            name: 'screenshot',
                            contentType: 'image/png',
                            path: join(
                              RUN,
                              'playwright-output',
                              'help-send-help-→-slash-command-descriptions',
                              'test-finished-1.png',
                            ),
                          },
                          {
                            name: 'video',
                            contentType: 'video/webm',
                            path: join(
                              RUN,
                              'playwright-output',
                              'help-send-help-→-slash-command-descriptions',
                              'video.webm',
                            ),
                          },
                        ],
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
                        errors: [{ message: 'boom failed', location: 'e2e/helpers/x.ts:1' }],
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
    // The failing case's own page renders the error with its location, and
    // the summary links to it — assert on those, not on the bare word
    // "failed" (which appears in every summary's CSS/status chips).
    const boomHtml = readFileSync(join(RUN, 'cases', 'boom', 'report.html'), 'utf8');
    expect(boomHtml).toContain('boom failed');
    expect(boomHtml).toContain('e2e/helpers/x.ts:1');
    const summaryHtml = readFileSync(join(RUN, 'summary.html'), 'utf8');
    expect(summaryHtml).toContain('cases/boom/report.html');
  });

  it('keeps the recording when only webm exists (no mp4 conversion)', () => {
    // Replace the video attachment with a webm-only one (E2E_VIDEO=webm or a
    // failed ffmpeg conversion) — the recording must not be silently dropped.
    const report = JSON.parse(readFileSync(join(RUN, 'report.json'), 'utf8')) as {
      suites: { specs: { tests: { results: { attachments: unknown[] }[] }[] }[] }[];
    };
    const firstResult = report.suites?.[0]?.specs?.[0]?.tests?.[0]?.results?.[0];
    expect(firstResult).toBeDefined();
    const attachments = firstResult?.attachments ?? [];
    attachments.splice(0, attachments.length, {
      name: 'video',
      contentType: 'video/webm',
      path: join(
        RUN,
        'playwright-output',
        'help-send-help-→-slash-command-descriptions',
        'video.webm',
      ),
    });
    writeFileSync(join(RUN, 'report.json'), JSON.stringify(report));

    generateRunReport(RUN, {});
    const caseJson = JSON.parse(
      readFileSync(
        join(RUN, 'cases', 'send-help-slash-command-descriptions', 'report.json'),
        'utf8',
      ),
    ) as { artifacts: { kind: string; path: string }[] };
    // The webm is copied as video.mp4 (the case dir keeps a single video
    // file), so the case page still shows a recording.
    expect(caseJson.artifacts.some((a) => a.kind === 'video' && a.path === 'video.mp4')).toBe(true);
    expect(
      readFileSync(
        join(RUN, 'cases', 'send-help-slash-command-descriptions', 'report.html'),
        'utf8',
      ),
    ).toContain('<video');
  });

  it('isolates artifacts per case (no cross-case contamination)', () => {
    // Two cases, each with its own attachment paths — case A's screenshots
    // and video must not leak into case B's report.
    const report = JSON.parse(readFileSync(join(RUN, 'report.json'), 'utf8')) as {
      suites: { specs: { title: string; tests: { status: string; results: unknown[] }[] }[] }[];
    };
    const firstSuite = report.suites?.[0];
    const specA = firstSuite?.specs?.[0];
    expect(specA).toBeDefined();
    if (specA === undefined || firstSuite === undefined) return;
    specA.title = 'send /help → slash command descriptions';
    if (specA.tests?.[0]) {
      specA.tests[0].status = 'expected';
    }
    firstSuite.specs?.push({
      title: 'send /model → model picker card',
      tests: [
        {
          status: 'expected',
          results: [
            {
              status: 'expected',
              duration: 100,
              startTime: '2026-08-21T00:00:00.000Z',
              retry: 0,
              errors: [],
              annotations: [],
              stdout: [],
              stderr: [],
              attachments: [],
            },
          ],
        },
      ],
    });
    mkdirSync(join(RUN, 'playwright-output', 'help-send-help-→-slash-command-descriptions'), {
      recursive: true,
    });
    mkdirSync(join(RUN, 'playwright-output', 'help-send-model-→-model-picker-card'), {
      recursive: true,
    });
    writeFileSync(
      join(RUN, 'playwright-output', 'help-send-help-→-slash-command-descriptions', 'caseA.png'),
      'a',
    );
    writeFileSync(
      join(RUN, 'playwright-output', 'help-send-model-→-model-picker-card', 'caseB.png'),
      'b',
    );
    // Case A carries its own attachment; case B has none.
    const firstResult = firstSuite?.specs?.[0]?.tests?.[0]?.results?.[0] as
      | { attachments: unknown[] }
      | undefined;
    expect(firstResult).toBeDefined();
    if (firstResult === undefined) return;
    firstResult.attachments = [
      {
        name: 'screenshot',
        contentType: 'image/png',
        path: join(
          RUN,
          'playwright-output',
          'help-send-help-→-slash-command-descriptions',
          'caseA.png',
        ),
      },
    ];
    writeFileSync(join(RUN, 'report.json'), JSON.stringify(report));

    generateRunReport(RUN, {});
    const caseA = JSON.parse(
      readFileSync(
        join(RUN, 'cases', 'send-help-slash-command-descriptions', 'report.json'),
        'utf8',
      ),
    ) as { artifacts: { kind: string; path: string }[] };
    const caseB = JSON.parse(
      readFileSync(join(RUN, 'cases', 'send-model-model-picker-card', 'report.json'), 'utf8'),
    ) as { artifacts: { kind: string; path: string }[] };
    expect(caseA.artifacts.some((a) => a.path === 'screenshots/caseA.png')).toBe(true);
    expect(caseA.artifacts.some((a) => a.path === 'screenshots/caseB.png')).toBe(false);
    expect(caseB.artifacts).toEqual([]);
  });
});
