/**
 * Backend group-chat creation for the E2E suite. Each test case runs in its
 * own group chat (name `<caseId>-<runId>`, globally unique per run), created
 * directly through the Feishu Open API — the exact `im.v1.chat.create` call
 * the plugin's `/group` command wraps (see `src/transport.ts` →
 * `createGroup`). The browser only ever OPENS the already-created group, so
 * parallel cases never share a chat page and no UI clicks create anything.
 *
 * Pure HTTP + pure string helpers — no browser — so the name logic and the
 * request construction are unit-testable.
 *
 * @module e2e/helpers/group
 */

/** Feishu Open Platform base URL (matches the plugin's apiBase default). */
const OPEN_BASE = 'https://open.feishu.cn';

/** Group names may not exceed 60 characters (Feishu platform limit). */
const GROUP_NAME_MAX = 60;

/** The app credentials group creation needs (a subset of E2eConfig). */
export interface E2eCredentials {
  readonly appId?: string;
  readonly appSecret?: string;
}

/**
 * Build the globally-unique group name for a case: `<caseId>-<runId>` with
 * the case part truncated so the whole name stays within Feishu's 60-char
 * limit (the runId suffix is kept whole — it is what makes the name unique).
 * @param caseId - filesystem-safe case id (`caseIdFromTitle` output).
 * @param runId - the run directory name (`.output/<runId>`).
 * @returns the group name, length ≤ 60.
 */
export function groupNameFor(caseId: string, runId: string): string {
  const suffix = `-${runId}`;
  const maxCase = Math.max(1, GROUP_NAME_MAX - suffix.length);
  const head = caseId.length > maxCase ? caseId.slice(0, maxCase) : caseId;
  return `${head}${suffix}`;
}

interface TenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface CreateChatResponse {
  code?: number;
  msg?: string;
  data?: { chat_id?: string };
}

/** A minimal Feishu API error carrying the HTTP/API code. */
export class FeishuApiError extends Error {
  constructor(
    readonly api: string,
    readonly code: number,
    msg: string,
  ) {
    super(`${api} failed (code ${code}): ${msg}`);
  }
}

/** Fetch a tenant_access_token for the bot app under test. */
async function tenantAccessToken(cfg: E2eCredentials, fetchImpl: typeof fetch): Promise<string> {
  if (cfg.appId === undefined || cfg.appSecret === undefined) {
    throw new Error('E2E_APP_ID / E2E_APP_SECRET are required to create a group chat');
  }
  const res = await fetchImpl(`${OPEN_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await readJson(res, 'auth.v3.tenant_access_token.internal')) as TenantTokenResponse;
  if (body.code !== 0 || body.tenant_access_token === undefined) {
    throw new FeishuApiError(
      'auth.v3.tenant_access_token.internal',
      body.code ?? -1,
      body.msg ?? 'unknown',
    );
  }
  return body.tenant_access_token;
}

/**
 * Create a group chat via `im.v1.chat.create`. The plugin's `/group` command
 * makes the FIRST member the owner (`owner_id = memberOpenIds[0]`, so the
 * requester owns the group); the E2E harness does the opposite — it keeps
 * the BOT as the group owner (no `owner_id`) so the case can disband the
 * group in its `finally` cleanup (`im.v1.chat.delete` requires the owner).
 * @param cfg - resolved E2E configuration (app credentials).
 * @param name - the group name (see {@link groupNameFor}).
 * @param memberOpenIds - members to invite (the test user's open id).
 * @param fetchImpl - fetch to use (defaults to global fetch; injectable in tests).
 * @returns the new chat id.
 */
export async function createGroup(
  cfg: E2eCredentials,
  name: string,
  memberOpenIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ chatId: string }> {
  if (name.length > GROUP_NAME_MAX) {
    throw new Error(`group name too long (${name.length} > ${GROUP_NAME_MAX}): ${name}`);
  }
  const token = await tenantAccessToken(cfg, fetchImpl);
  const res = await fetchImpl(`${OPEN_BASE}/open-apis/im/v1/chats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name,
      user_id_list: [...memberOpenIds],
      // No owner_id: the bot (creator) stays the owner, so the case can
      // disband the group afterwards. `/group` sets owner = first member;
      // the E2E harness deliberately differs for self-cleanup.
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await readJson(res, 'im.v1.chat.create')) as CreateChatResponse;
  const chatId = body.data?.chat_id;
  if (body.code !== 0 || chatId === undefined) {
    throw new FeishuApiError('im.v1.chat.create', body.code ?? -1, body.msg ?? 'unknown');
  }
  return { chatId };
}

/**
 * Delete a group chat (`im.v1.chat.delete`) — used by the setup probe to
 * verify the app can manage groups without leaving a chat behind.
 * @param cfg - resolved E2E configuration (app credentials).
 * @param chatId - the chat to delete.
 * @param fetchImpl - fetch to use (defaults to global fetch; injectable in tests).
 */
export async function deleteGroup(
  cfg: E2eCredentials,
  chatId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const token = await tenantAccessToken(cfg, fetchImpl);
  const res = await fetchImpl(`${OPEN_BASE}/open-apis/im/v1/chats/${chatId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await readJson(res, 'im.v1.chat.delete')) as { code?: number; msg?: string };
  if (body.code !== 0) {
    throw new FeishuApiError('im.v1.chat.delete', body.code ?? -1, body.msg ?? 'unknown');
  }
}

/** Parse a response body as JSON, surfacing non-JSON responses as API errors. */
async function readJson(res: Response, api: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new FeishuApiError(api, -1, `non-JSON response (HTTP ${res.status})`);
  }
}
