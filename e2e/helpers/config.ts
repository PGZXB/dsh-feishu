/**
 * E2E configuration: everything the UI harness needs, resolved from
 * environment variables with sensible defaults. A pure module — no browser,
 * no side effects — so the parsing and validation are unit-testable.
 *
 * Env keys (all optional):
 * - `E2E_RUN_ID` — the run directory name (`.output/<runId>`); used to build
 *   the per-case group names (defaults to the report dir's basename)
 * - `E2E_USER_OPEN_ID` — the test user's Feishu open id; the backend group
 *   creation invites this user (setup extracts it from the web session)
 * - `E2E_APP_ID` / `E2E_APP_SECRET` — the bot app under test (the launcher
 *   also accepts the plugin's own `FEISHU_APP_ID` / `FEISHU_APP_SECRET`)
 * - `E2E_HEADED=1` — run with a visible browser window
 * - `E2E_VIDEO=off|webm|mp4` — video policy (default `mp4`)
 * - `E2E_SCREENSHOTS=off|on|failure` — screenshot policy (default `on`)
 * - `E2E_REPORT_DIR` — run output directory (default `<repo>/e2e/.output/latest`)
 * - `E2E_SESSION_STATE` — browser session state file (default
 *   `<repo>/e2e/.state/web-session.json`)
 * - `E2E_BASE_URL` — Feishu web base URL (default `https://www.feishu.cn/`)
 *
 * @module e2e/lib/config
 */

import { basename, join } from 'node:path';

/** Video output policy. `webm` is Playwright's native recording; `mp4`
 * additionally converts the recording with ffmpeg (needs the e2e docker
 * image or a system ffmpeg). */
export type E2eVideo = 'off' | 'webm' | 'mp4';

/** Screenshot policy. */
export type E2eScreenshots = 'off' | 'on' | 'failure';

/** Resolved E2E configuration. */
export interface E2eConfig {
  /** Run id — the `.output/<runId>` directory name; group names embed it. */
  readonly runId: string;
  /** The test user's Feishu open id (backend group creation invites them). */
  readonly userOpenId?: string;
  /** Feishu app id of the bot under test. */
  readonly appId?: string;
  /** Feishu app secret of the bot under test. */
  readonly appSecret?: string;
  /** Run the browser headless (default true; `E2E_HEADED=1` shows a window). */
  readonly headless: boolean;
  /** Video policy. */
  readonly video: E2eVideo;
  /** Screenshot policy. */
  readonly screenshots: E2eScreenshots;
  /** Report output directory (screenshots, videos, html, manifest). */
  readonly reportDir: string;
  /** Browser session state file (cookies + localStorage). */
  readonly sessionState: string;
  /** Feishu web base URL. */
  readonly baseUrl: string;
  /** Default wait timeout in ms (default 30 000). */
  readonly timeoutMs: number;
}

function envString(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** Repo-relative default location: `<cwd>/e2e/.<leaf...>` — cwd is the repo
 *  root both locally and inside the docker image (launcher mounts it with
 *  `-w`). These are the git-ignored state/output dirs. */
function repoStatePath(...leaf: string[]): string {
  return join(process.cwd(), 'e2e', ...leaf);
}

function parseVideo(value: string | undefined): E2eVideo {
  if (value === 'off' || value === 'webm' || value === 'mp4') return value;
  if (value === undefined || value === '') return 'mp4';
  throw new Error(`E2E_VIDEO must be off|webm|mp4, got "${value}"`);
}

function parseScreenshots(value: string | undefined): E2eScreenshots {
  if (value === 'off' || value === 'on' || value === 'failure') return value;
  if (value === undefined || value === '') return 'on';
  throw new Error(`E2E_SCREENSHOTS must be off|on|failure, got "${value}"`);
}

/**
 * Resolve the E2E configuration from the environment.
 * @param env - environment to read (defaults to `process.env`).
 * @returns the validated configuration.
 * @throws when an env value is malformed.
 */
export function loadE2eConfig(env: NodeJS.ProcessEnv = process.env): E2eConfig {
  const timeoutRaw = envString(env, 'E2E_TIMEOUT_MS');
  const timeoutMs = timeoutRaw === undefined ? 30_000 : Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`E2E_TIMEOUT_MS must be a positive number, got "${timeoutRaw}"`);
  }
  const appId = envString(env, 'E2E_APP_ID', 'FEISHU_APP_ID');
  const appSecret = envString(env, 'E2E_APP_SECRET', 'FEISHU_APP_SECRET');
  const userOpenId = envString(env, 'E2E_USER_OPEN_ID');
  const reportDir = envString(env, 'E2E_REPORT_DIR') ?? repoStatePath('.output', 'latest');
  // The run id is the `.output/<runId>` dir name (unique per run). When a
  // concrete report dir was given, its basename IS the run id; the default
  // (`.../latest` symlink) falls back to a fresh timestamp.
  const runId =
    envString(env, 'E2E_RUN_ID') ??
    (reportDir === repoStatePath('.output', 'latest')
      ? new Date().toISOString().replace(/[:.]/g, '-')
      : basename(reportDir));
  return {
    runId,
    ...(userOpenId !== undefined ? { userOpenId } : {}),
    ...(appId !== undefined ? { appId } : {}),
    ...(appSecret !== undefined ? { appSecret } : {}),
    headless: envString(env, 'E2E_HEADED') !== '1',
    video: parseVideo(envString(env, 'E2E_VIDEO')),
    screenshots: parseScreenshots(envString(env, 'E2E_SCREENSHOTS')),
    reportDir,
    sessionState:
      envString(env, 'E2E_SESSION_STATE') ?? repoStatePath('.state', 'web-session.json'),
    baseUrl: envString(env, 'E2E_BASE_URL') ?? 'https://www.feishu.cn/',
    timeoutMs,
  };
}
