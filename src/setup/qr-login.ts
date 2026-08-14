/**
 * Feishu Web QR login: initialize `/accounts/qrlogin/init`, render the QR in
 * the terminal, poll `/accounts/qrlogin/polling` until the scan completes,
 * follow the cross-login redirect, and return the resulting cookie jar.
 * Mirrors botmux's `loginFeishuWebSession`
 * (`_tmp/botmux/src/setup/open-platform-automation.ts`).
 */

import qrcode from 'qrcode-terminal';
import { MutableCookieJar, type StoredCookie } from './cookies.js';

const FEISHU_ACCOUNTS_ORIGIN = 'https://accounts.feishu.cn';
const FEISHU_APP_ID = '12';
const FEISHU_COMMON_HEADERS = {
  'x-api-version': '1.0.28',
  'x-device-info':
    'device_id=0;device_name=Chrome;device_os=Mac;device_model=Chrome;lark_version=;' +
    'channel=Release;package_name=feishu;tt_app_id=1658;is_dpop_support=true;is_iframe=false',
};

/** Terminal QR input payload: the console renders `{qrlogin:{token}}`. */
export function buildFeishuQrPayload(token: string): string {
  return JSON.stringify({ qrlogin: { token } });
}

/** Human text for a QR polling status code. */
export function mapFeishuQrPollingStatus(status: number | null): string {
  if (status === 2) return 'scanned — confirm on your phone';
  if (status === 5) return 'QR code expired';
  return 'waiting for the Feishu scan';
}

/** Login-flow outcomes for error classification. */
export type FeishuLoginFailureReason =
  | 'login_failed'
  | 'qr_expired'
  | 'timeout'
  | 'network'
  | 'invalid_session';

class FeishuWebSessionError extends Error {
  constructor(
    message: string,
    readonly reason: FeishuLoginFailureReason,
  ) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  }
  return undefined;
}

function assertFeishuApiOk(payload: unknown, message: string): void {
  const record = asRecord(payload);
  if (record.code === 0) return;
  const msg = pickString(record, ['message', 'msg']) ?? 'unknown error';
  throw new FeishuWebSessionError(`${message}: ${msg}`, 'login_failed');
}

interface QrInitResult {
  flowKey: string;
  token: string;
}

async function initFeishuQrLogin(
  session: MutableCookieJar,
  fetcher: typeof fetch,
  authorizeUrl: string,
): Promise<QrInitResult> {
  const endpoint =
    `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/init` +
    `?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`;
  const { response } = await session.fetchRaw(fetcher, endpoint, {
    method: 'POST',
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ biz_type: null, redirect_uri: authorizeUrl }),
  });
  const data = (await response.json()) as unknown;
  assertFeishuApiOk(data, 'Feishu QR init failed');
  const stepInfo = asRecord(asRecord(asRecord(data).data).step_info);
  const token = pickString(stepInfo, ['token']);
  const flowKey = response.headers.get('x-flow-key') ?? '';
  if (!flowKey || !token) {
    throw new FeishuWebSessionError('Feishu QR init missing flow key or token', 'login_failed');
  }
  return { flowKey, token };
}

interface QrPollResult {
  nextStep: string | null;
  status: number | null;
  crossLoginUri: string | null;
}

async function pollFeishuQrLogin(
  session: MutableCookieJar,
  fetcher: typeof fetch,
  flowKey: string,
): Promise<QrPollResult> {
  const endpoint =
    `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/polling` +
    `?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`;
  const { response } = await session.fetchRaw(fetcher, endpoint, {
    method: 'POST',
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      'x-flow-key': flowKey,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ biz_type: null }),
  });
  const data = (await response.json()) as unknown;
  assertFeishuApiOk(data, 'Feishu QR polling failed');
  const payload = asRecord(asRecord(data).data);
  const stepInfo = asRecord(payload.step_info);
  return {
    nextStep: pickString(payload, ['next_step']) ?? null,
    status: typeof stepInfo.status === 'number' ? stepInfo.status : null,
    crossLoginUri: pickString(stepInfo, ['cross_login_uri']) ?? null,
  };
}

/** Render a QR code as terminal text (small, compact). */
export function renderTerminalQr(payload: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(payload, { small: true }, (qr) => resolve(qr)));
}

/** Validate a freshly obtained cookie jar against the Feishu web. */
async function validateFeishuWebSession(
  cookies: readonly StoredCookie[],
  fetcher: typeof fetch,
): Promise<boolean> {
  if (cookies.length === 0) return false;
  const session = new MutableCookieJar(cookies);
  try {
    const { response } = await session.fetchRaw(fetcher, 'https://ask.feishu.cn/', {
      method: 'GET',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Options for {@link loginFeishuWebSession}. */
export interface FeishuQrLoginOptions {
  /** Callback receiving the terminal QR text (default: print to stderr). */
  onQrCode?: (info: { qrText: string; qrPayload: string }) => void | Promise<void>;
  /** Status text callback (waiting / scanned / expired). */
  onStatus?: (message: string) => void | Promise<void>;
  /** Poll interval (default 1500 ms). */
  pollIntervalMs?: number;
  /** Max wait for the scan (default 180 s). */
  maxWaitMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

function defaultPrintFeishuQrCode(info: { qrText: string }): void {
  process.stderr.write('\nScan with the Feishu app to log in to the Open Platform:\n\n');
  process.stderr.write(`${info.qrText}\n`);
  process.stderr.write(
    'If this environment cannot display a QR code, re-run with --no-open-platform-auto ' +
      'to configure manually.\n\n',
  );
}

/**
 * Run the full QR login and return a validated cookie jar.
 * @returns cookies on success.
 * @throws {@link FeishuWebSessionError} with a classification reason.
 */
export async function loginFeishuWebSession(
  options: FeishuQrLoginOptions = {},
): Promise<StoredCookie[]> {
  const fetcher = options.fetchImpl ?? fetch;
  const session = new MutableCookieJar();
  const redirectUrl = 'https://ask.feishu.cn/';
  const qrInit = await initFeishuQrLogin(session, fetcher, redirectUrl);
  const qrPayload = buildFeishuQrPayload(qrInit.token);
  const qrText = await renderTerminalQr(qrPayload);
  const onQrCode = options.onQrCode ?? defaultPrintFeishuQrCode;
  await onQrCode({ qrText, qrPayload });

  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const maxWaitMs = options.maxWaitMs ?? 180_000;
  const start = Date.now();
  let lastStatusMessage = '';
  for (;;) {
    if (Date.now() - start > maxWaitMs) {
      throw new FeishuWebSessionError('Timed out waiting for the Feishu scan', 'timeout');
    }
    const poll = await pollFeishuQrLogin(session, fetcher, qrInit.flowKey);
    if (poll.nextStep === 'enter_app') {
      if (poll.crossLoginUri) {
        await session.fetchRaw(fetcher, poll.crossLoginUri, { method: 'GET' });
      }
      await session.fetchRaw(fetcher, redirectUrl, { method: 'GET' });
      const cookies = session.toJSON();
      if (!(await validateFeishuWebSession(cookies, fetcher))) {
        throw new FeishuWebSessionError(
          'Scan completed but no reusable Web session was obtained',
          'invalid_session',
        );
      }
      return cookies;
    }
    const statusMessage = mapFeishuQrPollingStatus(poll.status);
    if (options.onStatus && statusMessage !== lastStatusMessage) {
      lastStatusMessage = statusMessage;
      await options.onStatus(statusMessage);
    }
    if (poll.status === 5) {
      throw new FeishuWebSessionError('QR code expired', 'qr_expired');
    }
    await sleep(pollIntervalMs);
  }
}

/** Classify an unexpected login error into a failure reason. */
export function classifyFeishuLoginError(err: unknown): FeishuLoginFailureReason {
  if (err instanceof FeishuWebSessionError) return err.reason;
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|超时/i.test(message)) return 'timeout';
  if (/expired|过期/i.test(message)) return 'qr_expired';
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network/i.test(message))
    return 'network';
  return 'login_failed';
}
