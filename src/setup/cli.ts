#!/usr/bin/env node
/**
 * dsh-feishu quick-setup CLI. Primary path: one Feishu QR scan → the Open
 * Platform automation creates (or reconfigures) the app, subscribes events
 * and card callbacks over the long connection, grants scopes, publishes a
 * version, and writes the credentials into a dsh profile. `--no-open-platform-auto`
 * keeps a manual fallback (paste credentials → config written → checklist).
 *
 * Mirrors botmux's `botmux setup` wizard
 * (`_tmp/botmux/src/setup/*`); the console automation uses the same internal
 * `/developers/v1/*` endpoints with a reusable cookie session.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { mergeBotProfile, promptBotProfile } from './bot-profile.js';
import { createOpenPlatformApiClient } from './client.js';
import { configureFeishuApp } from './configure.js';
import type { StoredCookie } from './cookies.js';
import { createFeishuOpenPlatformApp } from './create-app.js';
import { mergeGuidedConfig, promptGuidedConfig } from './guided-config.js';
import {
  APP_EVENTS,
  CARD_CALLBACKS,
  DEFAULT_APP_NAME,
  FEISHU_MANIFEST,
  SCOPES,
} from './manifest.js';
import { fetchOpenPlatformAppSecret, listOpenPlatformApps } from './payloads.js';
import {
  dshHome,
  type GuidedConfig,
  loadPatchRows,
  profilePatchPath,
  readFeishuGuidedConfig,
  writeProfileCredentials,
} from './profile-writer.js';
import { classifyFeishuLoginError, loginFeishuWebSession } from './qr-login.js';
import {
  feishuSessionFilePath,
  readStoredCookiesFromSessionFile,
  writeStoredCookiesToSessionFile,
} from './session.js';

interface CliOptions {
  newApp: boolean;
  appId?: string;
  list: boolean;
  appName?: string;
  profile: string;
  dshHomeDir: string;
  noAuto: boolean;
  lark: boolean;
  forceLogin: boolean;
  printEnv: boolean;
  verifyBoot: boolean;
  appSecret?: string;
  avatarFilePath?: string;
  description?: string;
  help: boolean;
}

/** Parse the setup CLI options. A leading `--` (the `pnpm run <script> --`
 *  arg separator, forwarded verbatim by pnpm ≥ 11) is skipped so the
 *  documented `pnpm run setup:feishu -- --new` command works on every
 *  pnpm version. Unknown options throw. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    newApp: false,
    list: false,
    profile: 'feishu-dev',
    dshHomeDir: dshHome(),
    noAuto: false,
    lark: false,
    forceLogin: false,
    printEnv: false,
    verifyBoot: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (i === 0 && arg === '--') continue;
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return next;
    };
    if (arg === '--new') opts.newApp = true;
    else if (arg === '--app-id') opts.appId = value();
    else if (arg === '--app-secret') opts.appSecret = value();
    else if (arg === '--list') opts.list = true;
    else if (arg === '--app-name') opts.appName = value();
    else if (arg === '--avatar') opts.avatarFilePath = value();
    else if (arg === '--description') opts.description = value();
    else if (arg === '--profile') opts.profile = value();
    else if (arg === '--dsh-home') opts.dshHomeDir = value();
    else if (arg === '--no-open-platform-auto') opts.noAuto = true;
    else if (arg === '--lark') opts.lark = true;
    else if (arg === '--force-login') opts.forceLogin = true;
    else if (arg === '--print-env') opts.printEnv = true;
    else if (arg === '--verify-boot') opts.verifyBoot = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

const USAGE = `dsh-feishu quick setup — minimize Feishu Open Platform web-console work.

Usage:
  node scripts/setup-feishu.mjs [options]

Options:
  --new                     create a new app (default when --app-id is absent)
  --app-id <id>             configure an existing app (cli_...)
  --app-secret <secret>     app secret (manual path only)
  --list                    list apps visible to the session, then exit
  --app-name <name>         name for a new app (prompted interactively when
                            omitted; default "${DEFAULT_APP_NAME}")
  --avatar <path>           avatar image (PNG) for the new app (prompted
                            when omitted; default: the bundled dsh wordmark)
  --description <text>      app description (prompted when omitted; default:
                            "A dsh agent surface on Feishu.")
  --profile <name>          dsh profile to write credentials into (default feishu-dev)
  --dsh-home <dir>          dsh home (default $DSH_HOME or ~/.dsh)
  --no-open-platform-auto   manual path: paste credentials, write config, print steps
  --lark                    Lark international console origin
  --force-login             ignore a cached session and scan a fresh QR
  --print-env               print export lines instead of writing the profile
  --verify-boot             after configuring, boot dsh and wait for the bridge
  --help                    show this help

The automatic path needs one Feishu QR scan (displayed in the terminal). It
creates/reconfigures the app, subscribes im.message.receive_v1 and
card.action.trigger over the long connection, grants the scopes
(${SCOPES.join(', ')}), publishes a version, and writes appId/appSecret into
the profile's cordis.patch.yml (backed up first).
`;

function log(message: string): void {
  process.stderr.write(`[setup] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[setup] error: ${message}\n`);
}

/**
 * The startup hint printed after setup completes. Matches the README's
 * install/run commands, which invoke dsh through npx.
 * @param profile - the configured dsh profile name.
 */
export function startHint(profile: string): string {
  return `Start with: npx @deepseek-ai/dsh --profile ${profile}`;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Resolve the dsh CLI binary: $DSH_BIN, then `dsh` on PATH. */
function resolveDshBin(): string | undefined {
  if (process.env.DSH_BIN !== undefined && process.env.DSH_BIN !== '') return process.env.DSH_BIN;
  const probe = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim() !== '') return probe.stdout.trim();
  return undefined;
}

/**
 * Boot `dsh --profile <name>` with the credentials and wait for the bridge.
 * @returns true when the surface reported ready within the deadline.
 */
async function verifyBoot(
  dshHomeDir: string,
  profileName: string,
  credentials: { appId: string; appSecret: string },
  timeoutMs = 60_000,
): Promise<boolean> {
  const bin = resolveDshBin();
  if (!bin) {
    logError('dsh CLI not found ($DSH_BIN or dsh on PATH); skipping boot verification');
    return false;
  }
  return await new Promise<boolean>((resolvePromise) => {
    const child = spawn(bin, ['--profile', profileName], {
      env: {
        ...process.env,
        DSH_HOME: dshHomeDir,
        FEISHU_APP_ID: credentials.appId,
        FEISHU_APP_SECRET: credentials.appSecret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolvePromise(false);
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes('[feishu] bridge ready')) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolvePromise(true);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
  });
}

/** Validate app credentials via the public tenant-token endpoint. */
async function validateCredentials(
  appId: string,
  appSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const response = await fetchImpl(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
    );
    const data = (await response.json()) as { code?: number; msg?: string };
    if (data.code === 0) return { ok: true };
    return {
      ok: false,
      message: `tenant token rejected: ${data.msg ?? `code ${String(data.code)}`}`,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** The guided options to write: existing profile config as the prompt
 *  defaults (or built-ins), overlaid with the user's answers. Non-TTY runs
 *  (CI / scripts) skip the prompts and keep the defaults. */
async function resolveGuidedConfig(options: CliOptions): Promise<GuidedConfig> {
  const existing = readFeishuGuidedConfig(
    loadPatchRows(profilePatchPath(options.dshHomeDir, options.profile)),
  );
  const defaults: GuidedConfig = {
    repoRoots: existing.repoRoots ?? [homedir()],
    groupMentionMode: existing.groupMentionMode ?? 'always',
    requireWorkingDir: existing.requireWorkingDir ?? true,
  };
  if (options.printEnv) return defaults;
  const answers = await promptGuidedConfig(defaults);
  return mergeGuidedConfig(answers, defaults);
}

/** Write credentials (and the guided options) to the profile or print
 *  export lines. */
async function deliverCredentials(
  options: CliOptions,
  credentials: { appId: string; appSecret: string },
): Promise<void> {
  if (options.printEnv) {
    process.stdout.write(`export FEISHU_APP_ID=${credentials.appId}\n`);
    process.stdout.write(`export FEISHU_APP_SECRET=${credentials.appSecret}\n`);
    return;
  }
  const guided = await resolveGuidedConfig(options);
  const result = writeProfileCredentials(options.dshHomeDir, options.profile, credentials, guided);
  if (result.changed) {
    log(
      `wrote appId/appSecret into ${result.path}${result.backupPath ? ` (backup: ${result.backupPath})` : ''}`,
    );
  } else {
    log(`credentials already present in ${result.path}`);
  }
}

/** Print the manual web-console checklist (used by the fallback path). */
function printManualChecklist(appId: string): void {
  process.stderr.write(`\nRemaining steps in the Feishu Open Platform console for ${appId}:\n`);
  process.stderr.write(`  1. App Features → Bot: enable the bot.\n`);
  process.stderr.write(
    `  2. Events & Callbacks → Events: choose "Long connection" and subscribe:\n`,
  );
  process.stderr.write(`     ${APP_EVENTS.join(', ')}\n`);
  process.stderr.write(
    `  3. Events & Callbacks → Card callbacks: choose "Long connection" and subscribe:\n`,
  );
  process.stderr.write(`     ${CARD_CALLBACKS.join(', ')}\n`);
  process.stderr.write(
    `  4. Permissions: add ${SCOPES.join(', ')} (the manifest JSON below lists them).\n`,
  );
  process.stderr.write(`  5. Create a version and publish it — choose "visible to me only" for\n`);
  process.stderr.write(`     instant approval (no administrator wait).\n`);
}

/** The manual fallback: no browser session, paste credentials, write config. */
async function runManualSetup(options: CliOptions): Promise<void> {
  let appId = options.appId;
  let appSecret = options.appSecret;
  if (!appId) appId = await prompt('Feishu app id (cli_...): ');
  if (!appId) throw new Error('app id is required');
  if (!appSecret) appSecret = await prompt('Feishu app secret: ');
  if (!appSecret) throw new Error('app secret is required');

  log('validating credentials against the Feishu API…');
  const validation = await validateCredentials(appId, appSecret);
  if (!validation.ok) {
    throw new Error(`credentials look invalid: ${validation.message ?? 'unknown error'}`);
  }
  await deliverCredentials(options, { appId, appSecret });
  printManualChecklist(appId);

  const manifestPath = join(process.cwd(), 'feishu-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(FEISHU_MANIFEST, null, 2), 'utf8');
  log(`manifest written to ${manifestPath}`);

  if (options.verifyBoot) {
    log('verifying the boot…');
    const ready = await verifyBoot(options.dshHomeDir, options.profile, { appId, appSecret });
    if (!ready) logError('boot verification timed out (check the long connection / network)');
    else log('bridge ready — the surface is live');
  }
  process.stdout.write(`\nDone. Configured manually; ${startHint(options.profile)}.\n`);
}

/** The automatic path: QR session → create/configure → publish → credentials. */
async function runAutoSetup(options: CliOptions): Promise<void> {
  const sessionFile = feishuSessionFilePath();

  // Reuse a cached session when it still works; otherwise scan a fresh QR.
  let cookies: StoredCookie[] | null = null;
  if (!options.forceLogin) {
    const cached = readStoredCookiesFromSessionFile(sessionFile);
    if (cached && cached.length > 0) {
      const probe = await createOpenPlatformApiClient(cached);
      if (probe.ok) {
        cookies = cached;
        log('reusing the cached Feishu Web session');
      } else if (probe.reason === 'network') {
        throw new Error(`cannot reach the Open Platform: ${probe.message}`);
      } else {
        log(`cached session expired (${probe.message}); scanning a fresh QR`);
      }
    }
  }
  if (!cookies) {
    log('scan the QR below with the Feishu app to continue');
    try {
      cookies = await loginFeishuWebSession({ maxWaitMs: 180_000 });
      writeStoredCookiesToSessionFile(sessionFile, cookies);
      log('session saved for reuse');
    } catch (error) {
      throw new Error(
        `QR login failed (${classifyFeishuLoginError(error)}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const clientResult = await createOpenPlatformApiClient(cookies);
  if (!clientResult.ok) {
    throw new Error(clientResult.message);
  }
  const { client } = clientResult;
  if (clientResult.identity) {
    log(`logged in as ${clientResult.identity.userName} · ${clientResult.identity.tenantName}`);
  }

  if (options.list) {
    const apps = await listOpenPlatformApps(client);
    for (const app of apps) {
      process.stdout.write(`${app.clientId}\t${app.name}\n`);
    }
    return;
  }

  // Target: create a new app, or reconfigure an existing one.
  let appId: string;
  let appSecret: string;
  if (options.newApp || options.appId === undefined) {
    if (!clientResult.identity) {
      throw new Error(
        'cannot create an app without the session identity; re-run with --force-login',
      );
    }
    // Bot profile: CLI flags win, else guided prompts (stdin), else defaults.
    const botInputs = {
      ...(options.appName !== undefined ? { appName: options.appName } : {}),
      ...(options.avatarFilePath !== undefined ? { avatarFilePath: options.avatarFilePath } : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
    };
    const profile = mergeBotProfile(botInputs, await promptBotProfile(botInputs));
    log(`creating a new app "${profile.name}"…`);
    const created = await createFeishuOpenPlatformApp(client, {
      name: profile.name,
      creatorUserId: clientResult.identity.userId,
      ...(profile.avatarFilePath !== undefined ? { avatarFilePath: profile.avatarFilePath } : {}),
      ...(profile.description !== undefined ? { description: profile.description } : {}),
    });
    if (!created.ok || !created.appId || !created.appSecret) {
      throw new Error(created.message ?? 'app creation failed');
    }
    appId = created.appId;
    appSecret = created.appSecret;
    log(`app created and enabled: ${appId}`);
  } else {
    appId = options.appId;
    log(`configuring existing app ${appId}…`);
    const configured = await configureFeishuApp(client, appId, { publish: true });
    if (!configured.ok) {
      throw new Error(configured.message ?? 'configuration failed');
    }
    if (configured.warning) log(`warning: ${configured.warning}`);
    log(
      `scopes granted: ${configured.scopeCount ?? 0}; subscriptions confirmed: ${configured.subscribedEventCount ?? 0}`,
    );
    if (configured.versionId) log(`version published: ${configured.versionId}`);
    appSecret = await fetchOpenPlatformAppSecret(client, appId);
  }

  await deliverCredentials(options, { appId, appSecret });

  if (options.verifyBoot) {
    log('verifying the boot…');
    const ready = await verifyBoot(options.dshHomeDir, options.profile, { appId, appSecret });
    if (!ready) logError('boot verification timed out (check the long connection / network)');
    else log('bridge ready — the surface is live');
  }
  process.stdout.write(`\nDone. App ${appId} configured for profile '${options.profile}'.\n`);
  process.stdout.write(`${startHint(options.profile)}\n`);
}

/** CLI entry point. */
export async function main(argv: readonly string[]): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!options.printEnv && !existsSync(profilePatchPath(options.dshHomeDir, options.profile))) {
    const parent = resolve(profilePatchPath(options.dshHomeDir, options.profile), '..');
    logError(
      `profile '${options.profile}' not found under ${parent}. Create it first, e.g. with: dsh plugin --profile ${options.profile} add link:<checkout>`,
    );
    process.exitCode = 2;
    return;
  }
  try {
    if (options.noAuto) {
      await runManualSetup(options);
    } else {
      await runAutoSetup(options);
    }
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// Direct execution (bin entry): run main; imported launchers call main() themselves.
// `process.argv[1]` is the SYMLINK path when the bin link is executed, so
// realpath it before comparing — otherwise the entry check silently skips
// main() and the CLI exits with no output (user report: setup did nothing).
const entryPath = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main(process.argv.slice(2));
}
