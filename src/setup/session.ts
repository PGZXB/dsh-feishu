/**
 * Feishu Open Platform Web-session persistence: read/write the cookie jar to
 * a machine-level file (`~/.dsh-feishu/feishu-session.json`, overridable via
 * `DSH_FEISHU_SESSION`) and extract the console page's `window.csrfToken` /
 * `window.user` identity. Reusing a cached session means a later run needs no
 * new QR scan.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pruneExpiredCookies, type StoredCookie } from './cookies.js';

/** Default location of the reusable Feishu Web session file. */
export function feishuSessionFilePath(env = process.env): string {
  const override = env.DSH_FEISHU_SESSION;
  if (override && override !== '') return override;
  return join(homedir(), '.dsh-feishu', 'feishu-session.json');
}

/** Read stored cookies from the session file; `null` when absent or corrupt. */
export function readStoredCookiesFromSessionFile(filePath: string): StoredCookie[] | null {
  if (!existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const cookies = (parsed as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) return null;
  return pruneExpiredCookies(
    cookies.filter(isStoredCookieRecord).map((cookie) => ({ ...(cookie as StoredCookie) })),
  );
}

/** Persist cookies atomically (temp file + rename) with 0600 permissions. */
export function writeStoredCookiesToSessionFile(
  filePath: string,
  cookies: readonly StoredCookie[],
): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify({ cookies: pruneExpiredCookies(cookies) }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Temp cleanup is best-effort.
    }
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

/** Extract `window.csrfToken` from an Open Platform console page. */
export function extractOpenPlatformCsrfToken(html: string): string | null {
  const match =
    html.match(/\bwindow\.csrfToken\s*=\s*(['"])([^'"]+)\1/) ??
    html.match(/\bcsrfToken\s*:\s*(['"])([^'"]+)\1/);
  return match?.[2] ?? null;
}

/** The logged-in user/tenant, as written into `window.user` by the console. */
export interface FeishuWebSessionIdentity {
  readonly userId: string;
  readonly userName: string;
  readonly email?: string;
  readonly tenantId: string;
  readonly tenantName: string;
}

function extractBalancedJsonObject(input: string, start: number): string | null {
  if (input[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * Extract the console's `window.user` identity. Only stable display fields
 * are kept; used to show who is logged in and to supply the creator user id
 * for the first version's visibility.
 */
export function extractOpenPlatformSessionIdentity(html: string): FeishuWebSessionIdentity | null {
  const marker = /\bwindow\.user\s*=\s*/g;
  const match = marker.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  const json = extractBalancedJsonObject(html, start);
  if (!json) return null;
  let user: Record<string, unknown>;
  try {
    user = asRecord(JSON.parse(json));
  } catch {
    return null;
  }
  const userId = pickString(user, ['id', 'userId', 'user_id']);
  const userName =
    pickString(user, ['name', 'userName', 'user_name']) ??
    pickString(asRecord(user.displayName), ['value']);
  const tenantId = pickString(user, ['tenantId', 'tenant_id']);
  const tenantName =
    pickString(asRecord(user.tenantDisplayName), ['value']) ??
    pickString(user, ['tenantName', 'tenant_name']);
  if (!userId || !userName || !tenantId || !tenantName) return null;
  const email = pickString(user, ['email']);
  return { userId, userName, ...(email ? { email } : {}), tenantId, tenantName };
}

function isStoredCookieRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cookie = value as Partial<StoredCookie>;
  return (
    typeof cookie.name === 'string' &&
    typeof cookie.value === 'string' &&
    typeof cookie.domain === 'string' &&
    typeof cookie.path === 'string' &&
    typeof cookie.secure === 'boolean' &&
    typeof cookie.httpOnly === 'boolean' &&
    typeof cookie.hostOnly === 'boolean'
  );
}
