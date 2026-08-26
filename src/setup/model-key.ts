/**
 * The optional model-API-key step of the quick-setup tool.
 *
 * Quick setup writes the Feishu app credentials into the profile, but the
 * agent also needs a model API key (`DEEPSEEK_API_KEY`). DSH web stores one
 * through its Models page via the in-process `ctx.credentials` seam; a
 * Feishu-only user never opens that page, so the wizard offers the same step
 * on the terminal — WITHOUT coupling to any storage format: it writes the
 * answer into the dsh home's `.env`, which dsh itself loads into the ambient
 * environment at every boot, from where the plugin's boot promotion stores
 * it into the credentials seam through the seam interface (resolve first —
 * an explicitly exported key or a web-configured one always wins).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The env var name carrying the model API key (the plugin's default). */
export const MODEL_KEY_ENV = 'DEEPSEEK_API_KEY';

/** The user env layer file inside a dsh home. */
export function modelKeyEnvPath(dshHomeDir: string): string {
  return join(dshHomeDir, '.env');
}

/** Where an already-configured model key was detected; drives the skip message. */
export type ModelKeySource = 'environment' | 'previous-run';

/** The `.env` line prefix for the model key. */
function envLinePrefix(): string {
  return `${MODEL_KEY_ENV}=`;
}

/** Whether the dsh home's user env layer already sets the key. */
function envFileHasKey(dshHomeDir: string): boolean {
  try {
    return readFileSync(modelKeyEnvPath(dshHomeDir), 'utf8')
      .split('\n')
      .some((line) => line.startsWith(envLinePrefix()));
  } catch {
    return false;
  }
}

/**
 * Detect an already-configured model API key through non-format-coupled
 * signals only: the documented ambient environment contract, and our own
 * artifact from a previous run. A web-configured key is deliberately NOT
 * probed (that would mean parsing the provider's private store); prompting
 * once more is harmless because the boot promotion never overwrites the
 * stored value.
 * @param dshHomeDir - the dsh home directory.
 * @param env - the environment to probe (defaults to `process.env`).
 * @returns where the key was detected, or `undefined` when not configured.
 */
export function findModelKey(
  dshHomeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelKeySource | undefined {
  const value = env[MODEL_KEY_ENV];
  if (value !== undefined && value !== '') return 'environment';
  if (envFileHasKey(dshHomeDir)) return 'previous-run';
  return undefined;
}

/** The result of {@link upsertModelKey}. */
export interface ModelKeyWriteResult {
  /** The `.env` path written (or left untouched). */
  readonly path: string;
  /** Whether the file content changed. */
  readonly changed: boolean;
}

/**
 * Upsert `NAME=value` into the dsh home's user env layer: create the file
 * with owner-only permissions when missing, replace an existing entry for
 * the name in place, or append one — every other line stays untouched.
 * @param dshHomeDir - the dsh home directory.
 * @param value - the secret to store.
 * @returns whether the file content changed.
 */
export function upsertModelKey(dshHomeDir: string, value: string): ModelKeyWriteResult {
  const path = modelKeyEnvPath(dshHomeDir);
  const line = `${MODEL_KEY_ENV}=${value}`;
  let lines: string[] | undefined;
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    lines = undefined;
  }
  if (lines === undefined) {
    mkdirSync(dshHomeDir, { recursive: true });
    writeFileSync(path, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    return { path, changed: true };
  }
  const index = lines.findIndex((candidate) => candidate.startsWith(envLinePrefix()));
  if (index >= 0 && lines[index] === line) return { path, changed: false };
  let content: string;
  if (index >= 0) {
    lines[index] = line;
    content = lines.join('\n');
  } else {
    content = lines.join('\n');
    if (content !== '' && !content.endsWith('\n')) content += '\n';
    content += `${line}\n`;
  }
  writeFileSync(path, content, 'utf8');
  return { path, changed: true };
}
