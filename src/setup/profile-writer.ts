/**
 * Write the Feishu credentials into a dsh profile's `cordis.patch.yml` so the
 * surface boots configured. The patch file is a YAML list of rows
 * (`- id: … / name: … / config: …`); the `feishu` row's `config.appId` /
 * `config.appSecret` are updated idempotently, the row is created when
 * missing, and the original file is backed up before any change.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dump, load } from 'js-yaml';

/** Resolve the dsh home: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome(env = process.env): string {
  const override = env.DSH_HOME;
  if (override && override !== '') return override;
  return join(homedir(), '.dsh');
}

/** The `cordis.patch.yml` path for a profile under a dsh home. */
export function profilePatchPath(dshHomeDir: string, profileName: string): string {
  return join(dshHomeDir, 'profiles', profileName, 'cordis.patch.yml');
}

/** Credentials to write. */
export interface ProfileCredentials {
  readonly appId: string;
  readonly appSecret: string;
}

/** The guided surface options the setup wizard asks about (defaults on
 *  empty input). */
export interface GuidedConfig {
  /** `/repo` scan roots (one level deep); defaults to the home directory. */
  readonly repoRoots?: readonly string[];
  /** Group mention policy; defaults to `always`. */
  readonly groupMentionMode?: 'always' | 'never' | 'ambient' | 'topic';
  /** Refuse work until a working directory is chosen; defaults to true. */
  readonly requireWorkingDir?: boolean;
}

export interface WriteProfileResult {
  readonly changed: boolean;
  readonly path: string;
  readonly backupPath?: string;
}

type PatchRow = Record<string, unknown> & { id?: unknown };

/** Load a patch file as a row list; an empty/missing file is an empty list. */
export function loadPatchRows(filePath: string): PatchRow[] {
  if (!existsSync(filePath)) return [];
  const parsed = load(readFileSync(filePath, 'utf8'));
  if (parsed === undefined || parsed === null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a YAML list (profile patch must be a list of rows)`);
  }
  return parsed as PatchRow[];
}

/** The feishu row's guided options read back from a patch row list. */
export function readFeishuGuidedConfig(rows: PatchRow[]): GuidedConfig {
  const config = rows.find((row) => row.id === 'feishu')?.config as
    | Record<string, unknown>
    | undefined;
  if (config === undefined) return {};
  const roots =
    Array.isArray(config.repoRoots) && config.repoRoots.every((r) => typeof r === 'string')
      ? (config.repoRoots as string[])
      : Array.isArray(config.repoRoots)
        ? config.repoRoots.filter((r): r is string => typeof r === 'string')
        : undefined;
  const mode = config.groupMentionMode;
  const groupMentionMode =
    mode === 'always' || mode === 'never' || mode === 'ambient' || mode === 'topic'
      ? mode
      : undefined;
  const requireWorkingDir =
    typeof config.requireWorkingDir === 'boolean' ? config.requireWorkingDir : undefined;
  return {
    ...(roots !== undefined && roots.length > 0 ? { repoRoots: roots } : {}),
    ...(groupMentionMode !== undefined ? { groupMentionMode } : {}),
    ...(requireWorkingDir !== undefined ? { requireWorkingDir } : {}),
  };
}

/**
 * Update the `feishu` row of a patch row list with the given config values.
 * `guided` (the wizard's prompted options) is merged on both create and
 * update — a re-run of the wizard with fresh answers overrides those keys;
 * everything else in the row is preserved.
 * @returns a new array when changed, the same array when already present.
 */
export function upsertFeishuConfig(
  rows: PatchRow[],
  credentials: ProfileCredentials,
  guided: GuidedConfig | undefined = undefined,
): PatchRow[] {
  const feishu = rows.find((row) => row.id === 'feishu');
  if (feishu) {
    const config = (feishu.config ?? {}) as Record<string, unknown>;
    if (config.appId === credentials.appId && config.appSecret === credentials.appSecret) {
      return rows;
    }
    return rows.map((row) =>
      row.id === 'feishu'
        ? {
            ...row,
            config: {
              ...config,
              appId: credentials.appId,
              appSecret: credentials.appSecret,
              ...guided,
            },
          }
        : row,
    );
  }
  return [
    ...rows,
    {
      id: 'feishu',
      name: '@dsh-feishu/dsh-feishu',
      // A sensible default on first write (mirrors the dev profile): /repo
      // scans one level deep under repoRoots. The wizard's prompted options
      // (with their own defaults) win when present.
      config: {
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        ...(guided ?? { repoRoots: [homedir()] }),
      },
    },
  ];
}

/**
 * Write credentials into a profile's patch file (with a `.bak` backup).
 * @returns whether the file changed and the backup path (when one was made).
 */
export function writeProfileCredentials(
  dshHomeDir: string,
  profileName: string,
  credentials: ProfileCredentials,
  guided: GuidedConfig | undefined = undefined,
): WriteProfileResult {
  const path = profilePatchPath(dshHomeDir, profileName);
  const rows = loadPatchRows(path);
  const updated = upsertFeishuConfig(rows, credentials, guided);
  if (updated === rows) {
    return { changed: false, path };
  }
  const backupPath = `${path}.bak`;
  if (existsSync(path)) {
    renameSync(path, backupPath);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, dump(updated, { lineWidth: 100 }), 'utf8');
  return { changed: true, path, backupPath };
}
