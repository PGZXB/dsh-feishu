/**
 * Feishu Open Platform console API client: loads a console page with the
 * session cookies, extracts `window.csrfToken` and the final origin (some
 * tenants redirect the console to open.larkoffice.com), then issues
 * `POST /developers/v1/*` calls the same way the console frontend does.
 * Mirrors botmux's `createOpenPlatformApiClient`
 * (`_tmp/botmux/src/setup/open-platform-automation.ts`).
 */

import { MutableCookieJar, type StoredCookie } from './cookies.js';
import {
  extractOpenPlatformCsrfToken,
  extractOpenPlatformSessionIdentity,
  type FeishuWebSessionIdentity,
} from './session.js';

/** Error carrying the console API payload for diagnostics. */
export class OpenPlatformApiError extends Error {
  constructor(
    message: string,
    readonly payload: unknown,
    readonly status: number,
  ) {
    super(message);
  }
}

function summarizeOpenPlatformPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload);
  const record = payload as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ['code', 'msg', 'message', 'error', 'error_msg']) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return JSON.stringify(summary).slice(0, 500);
}

/** Console client surface used by the automation flows. */
export interface OpenPlatformApiClient {
  readonly apiOrigin: string;
  postJson(path: string, body?: unknown): Promise<unknown>;
  postForm(path: string, body: FormData): Promise<unknown>;
}

export type OpenPlatformClientResult =
  | { ok: true; client: OpenPlatformApiClient; identity?: FeishuWebSessionIdentity }
  | { ok: false; reason: 'missing_csrf' | 'network'; message: string };

/** Create a console client for the given session cookies. */
export async function createOpenPlatformApiClient(
  cookies: readonly StoredCookie[],
  options: { fetchImpl?: typeof fetch } = {},
): Promise<OpenPlatformClientResult> {
  const fetcher = options.fetchImpl ?? fetch;
  const session = new MutableCookieJar(cookies);
  let csrfToken: string | null = null;
  let apiOrigin = 'https://open.feishu.cn';
  let referer = `${apiOrigin}/app`;
  let identity: FeishuWebSessionIdentity | undefined;
  try {
    const page = await session.fetchTextWithUrl(fetcher, `${apiOrigin}/app`);
    apiOrigin = new URL(page.finalUrl).origin;
    referer = page.finalUrl;
    csrfToken = extractOpenPlatformCsrfToken(page.text);
    identity = extractOpenPlatformSessionIdentity(page.text) ?? undefined;
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      message: `Failed to load the Open Platform page: ${safeErrorMessage(error)}`,
    };
  }
  if (!csrfToken) {
    return {
      ok: false,
      reason: 'missing_csrf',
      message:
        'The Open Platform page did not return window.csrfToken; the Web session may be ' +
        'expired or not fully logged in',
    };
  }

  const request = async (
    path: string,
    body?: RequestInit['body'],
    contentType?: string,
  ): Promise<unknown> => {
    const url = `${apiOrigin}${path}`;
    const { response } = await session.fetchRaw(fetcher, url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: apiOrigin,
        referer,
        'x-csrf-token': csrfToken,
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    let data: unknown = null;
    try {
      data = (await response.json()) as unknown;
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new OpenPlatformApiError(
        `HTTP ${response.status} ${path}: ${summarizeOpenPlatformPayload(data)}`,
        data,
        response.status,
      );
    }
    if (
      data &&
      typeof data === 'object' &&
      typeof (data as { code?: unknown }).code === 'number' &&
      (data as { code: number }).code !== 0
    ) {
      throw new OpenPlatformApiError(
        `code=${(data as { code: number }).code} msg=${(data as { msg?: string; message?: string }).msg ?? (data as { message?: string }).message ?? ''}`,
        data,
        response.status,
      );
    }
    return data;
  };

  const postJson = async (path: string, body?: unknown): Promise<unknown> =>
    request(
      path,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? undefined : 'application/json',
    );
  const postForm = async (path: string, body: FormData): Promise<unknown> => request(path, body);

  return {
    ok: true,
    client: { apiOrigin, postJson, postForm },
    ...(identity !== undefined ? { identity } : {}),
  };
}

/** True when the console denied access to the app (not an automation bug). */
export function openPlatformOwnerAccessDenied(error: unknown): boolean {
  if (!(error instanceof OpenPlatformApiError)) return false;
  const payload = error.payload as { code?: unknown } | null;
  return error.status === 403 && payload?.code === 10003;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_=-]{24,}/g, '***');
}
