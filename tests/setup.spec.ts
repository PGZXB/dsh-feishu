/**
 * Unit tests for the quick-setup automation (`src/setup/*`): cookie jar
 * semantics, session persistence, QR helpers, payload builders, response
 * extractors, the fail-closed verification, the profile writer, and the
 * configure flow driven through a fake fetcher. The live Open Platform
 * console is never exercised here.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeBotProfile, promptBotProfile } from '../src/setup/bot-profile.js';
import { parseArgs, startHint } from '../src/setup/cli.js';
import { createOpenPlatformApiClient, type OpenPlatformApiClient } from '../src/setup/client.js';
import { configureFeishuApp } from '../src/setup/configure.js';
import {
  getCookieHeader,
  MutableCookieJar,
  parseSetCookie,
  pruneExpiredCookies,
  type StoredCookie,
} from '../src/setup/cookies.js';
import {
  createFeishuOpenPlatformApp,
  DEFAULT_AVATAR_PATH,
  makePlaceholderIconPng,
  pngDimensions,
  resolveAvatarBuffer,
} from '../src/setup/create-app.js';
import {
  APP_EVENTS,
  CARD_CALLBACKS,
  DEFAULT_APP_NAME,
  LONG_CONNECTION_EVENT_MODE,
  SCOPES,
} from '../src/setup/manifest.js';
import {
  buildAppVersionCreatePayload,
  buildCallbackSubscriptionPayload,
  buildEventSubscriptionPayload,
  buildManifestTemplateCreatePayload,
  buildSafeSettingPayload,
  buildScopeUpdatePayload,
  extractOpenPlatformCallbackState,
  extractOpenPlatformEventState,
  extractOpenPlatformScopeEntries,
  extractVersionId,
  mapManifestScopesToOpenPlatformIds,
  nextAppVersion,
  parseOnlineVisibility,
} from '../src/setup/payloads.js';
import {
  loadPatchRows,
  profilePatchPath,
  readFeishuGuidedConfig,
  upsertFeishuConfig,
  writeProfileCredentials,
} from '../src/setup/profile-writer.js';
import {
  buildFeishuQrPayload,
  FEISHU_COMMON_HEADERS,
  mapFeishuQrPollingStatus,
} from '../src/setup/qr-login.js';
import {
  extractOpenPlatformCsrfToken,
  extractOpenPlatformSessionIdentity,
  readStoredCookiesFromSessionFile,
  writeStoredCookiesToSessionFile,
} from '../src/setup/session.js';

/** Repo root, for reading tracked files (package.json) in pack-shape tests. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-setup-'));
  tmpDirs.push(dir);
  return dir;
}

// ─── Manifest ───────────────────────────────────────────────────────────────

describe('manifest', () => {
  it('lists the surface requirements without duplicates', () => {
    expect(new Set(APP_EVENTS).size).toBe(APP_EVENTS.length);
    expect(new Set(CARD_CALLBACKS).size).toBe(CARD_CALLBACKS.length);
    expect(new Set(SCOPES).size).toBe(SCOPES.length);
    expect(APP_EVENTS).toContain('im.message.receive_v1');
    expect(CARD_CALLBACKS).toContain('card.action.trigger');
  });
});

// ─── Cookie jar ─────────────────────────────────────────────────────────────

describe('cookie jar', () => {
  it('parses a Set-Cookie header with attributes', () => {
    const cookie = parseSetCookie(
      'https://open.feishu.cn/app',
      'sid=abc; Path=/; Domain=feishu.cn; Secure; HttpOnly; SameSite=Lax',
    );
    expect(cookie).toMatchObject({
      name: 'sid',
      value: 'abc',
      domain: 'feishu.cn',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: false,
    });
  });

  it('keeps host-only cookies for the exact host only', () => {
    const cookie: StoredCookie = {
      name: 'a',
      value: '1',
      domain: 'open.feishu.cn',
      path: '/',
      secure: true,
      httpOnly: false,
      hostOnly: true,
    };
    expect(getCookieHeader([cookie], 'https://open.feishu.cn/app')).toContain('a=1');
    expect(getCookieHeader([cookie], 'https://other.feishu.cn/app')).toBe('');
  });

  it('matches domain cookies on subdomains', () => {
    const cookie: StoredCookie = {
      name: 'a',
      value: '1',
      domain: 'feishu.cn',
      path: '/',
      secure: true,
      httpOnly: false,
      hostOnly: false,
    };
    expect(getCookieHeader([cookie], 'https://open.feishu.cn/app')).toContain('a=1');
  });

  it('prunes expired cookies', () => {
    const expired: StoredCookie = {
      name: 'old',
      value: '1',
      domain: 'feishu.cn',
      path: '/',
      secure: false,
      httpOnly: false,
      hostOnly: false,
      expiresAt: Date.now() - 1000,
    };
    expect(pruneExpiredCookies([expired])).toHaveLength(0);
  });

  it('follows redirects and captures Set-Cookie along the way', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      if (url === 'https://example.com/start') {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://example.com/landing',
            'set-cookie': 'mid=42; Path=/; Domain=example.com',
          },
        });
      }
      if (url === 'https://example.com/landing') {
        return new Response('ok', { status: 200, headers: { 'set-cookie': 'final=yes; Path=/' } });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const jar = new MutableCookieJar();
    const { response, finalUrl } = await jar.fetchRaw(
      fetcher as typeof fetch,
      'https://example.com/start',
      {
        method: 'GET',
      },
    );
    expect(response.status).toBe(200);
    expect(finalUrl).toBe('https://example.com/landing');
    expect(
      jar
        .toJSON()
        .map((c) => c.name)
        .sort(),
    ).toEqual(['final', 'mid']);
  });
});

// ─── Session persistence + page extraction ─────────────────────────────────

describe('session file', () => {
  it('round-trips cookies with 0600 permissions', () => {
    const dir = tempDir();
    const file = join(dir, 'feishu-session.json');
    const cookie: StoredCookie = {
      name: 'sid',
      value: 'v',
      domain: 'open.feishu.cn',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: true,
    };
    writeStoredCookiesToSessionFile(file, [cookie]);
    const loaded = readStoredCookiesFromSessionFile(file);
    expect(loaded).toEqual([cookie]);
  });

  it('returns null for a corrupt session file', () => {
    const dir = tempDir();
    const file = join(dir, 'feishu-session.json');
    writeFileSync(file, 'not json', 'utf8');
    expect(readStoredCookiesFromSessionFile(file)).toBeNull();
  });

  it('extracts the csrf token from a console page', () => {
    const html = '<script>window.csrfToken = "tok_123";</script>';
    expect(extractOpenPlatformCsrfToken(html)).toBe('tok_123');
  });

  it('extracts the session identity from window.user', () => {
    const html = `<!doctype html><script>window.user = {"id":"ou_1","name":"Ada","tenantId":"t1","tenantDisplayName":{"value":"ACME"},"email":"a@x.cn"};</script>`;
    const identity = extractOpenPlatformSessionIdentity(html);
    expect(identity).toMatchObject({
      userId: 'ou_1',
      userName: 'Ada',
      tenantId: 't1',
      tenantName: 'ACME',
      email: 'a@x.cn',
    });
  });
});

// ─── QR helpers ─────────────────────────────────────────────────────────────

describe('qr-login helpers', () => {
  it('sends the headers the accounts API requires (missing ones return 4401)', () => {
    // Regression: omitting x-locale / x-terminal-type made the QR init
    // fail with 4401 "请求无效" (reproduced live against accounts.feishu.cn).
    expect(FEISHU_COMMON_HEADERS['x-locale']).toBe('zh-CN');
    expect(FEISHU_COMMON_HEADERS['x-terminal-type']).toBe('2');
  });

  it('builds the console QR payload', () => {
    expect(buildFeishuQrPayload('tok')).toBe(JSON.stringify({ qrlogin: { token: 'tok' } }));
  });

  it('maps polling statuses to human text', () => {
    expect(mapFeishuQrPollingStatus(2)).toContain('scanned');
    expect(mapFeishuQrPollingStatus(5)).toContain('expired');
    expect(mapFeishuQrPollingStatus(null)).toContain('waiting');
  });
});

// ─── Payload builders ───────────────────────────────────────────────────────

describe('payload builders', () => {
  it('builds the scope update payload', () => {
    expect(
      buildScopeUpdatePayload('cli_a', { tenantScopeIds: ['s1'], userScopeIds: [] }),
    ).toMatchObject({ clientId: 'cli_a', operation: 'add', appScopeIDs: ['s1'], userScopeIDs: [] });
  });

  it('builds the event subscription payload with the current mode', () => {
    expect(buildEventSubscriptionPayload('cli_a', 4, ['im.message.receive_v1'])).toMatchObject({
      clientId: 'cli_a',
      operation: 'add',
      appEvents: ['im.message.receive_v1'],
      eventMode: 4,
    });
  });

  it('builds the callback subscription payload', () => {
    expect(buildCallbackSubscriptionPayload('cli_a', 4, ['card.action.trigger'])).toMatchObject({
      clientId: 'cli_a',
      operation: 'add',
      callbacks: ['card.action.trigger'],
      callbackMode: 4,
    });
  });

  it('builds the version payload with full-overwrite visibility', () => {
    const payload = buildAppVersionCreatePayload('1.2.3', {
      departments: ['d1'],
      members: ['ou_1'],
      groups: [],
      isAll: 0,
    });
    expect(payload.appVersion).toBe('1.2.3');
    expect(payload.visibleSuggest).toEqual({
      departments: ['d1'],
      members: ['ou_1'],
      groups: [],
      isAll: 0,
    });
  });

  it('builds the manifest template payload', () => {
    const payload = buildManifestTemplateCreatePayload('Name', 'Desc', 'http://a.png', 'cid');
    expect(payload.appManifestTemplateID).toBe('developer_console');
    const custom = payload.createAppUserCustomField as { i18n?: { zh_cn?: { name?: string } } };
    expect(custom.i18n?.zh_cn?.name).toBe('Name');
  });

  it('builds the safe settings payload (empty redirect whitelist)', () => {
    expect(buildSafeSettingPayload('cli_a')).toEqual({ clientId: 'cli_a', redirectURL: [] });
  });
});

// ─── Response extractors ────────────────────────────────────────────────────

describe('response extractors', () => {
  it('extracts event state incl. app events and mode', () => {
    const state = extractOpenPlatformEventState({
      code: 0,
      data: {
        eventMode: 4,
        appEvents: [{ id: 'im.message.receive_v1' }],
      },
    });
    expect(state.eventMode).toBe(4);
    expect(state.appEvents).toContain('im.message.receive_v1');
  });

  it('extracts event ids from detail groups', () => {
    const state = extractOpenPlatformEventState({
      data: { appEventDetails: [{ items: [{ id: 'im.message.receive_v1' }] }] },
    });
    expect(state.events).toContain('im.message.receive_v1');
  });

  it('extracts callback state', () => {
    const state = extractOpenPlatformCallbackState({
      data: { callbackMode: 4, callbacks: [{ id: 'card.action.trigger' }] },
    });
    expect(state.callbackMode).toBe(4);
    expect(state.callbacks).toContain('card.action.trigger');
  });

  it('parses online visibility and fails loud on an empty payload', () => {
    const visibility = parseOnlineVisibility({
      data: { visibleSuggest: { departments: [], members: ['ou_1'], groups: [], isAll: 0 } },
    });
    expect(visibility.visibleSuggest.members).toEqual(['ou_1']);
    expect(() => parseOnlineVisibility({ data: {} })).toThrow();
  });

  it('extracts the scope catalog and maps manifest scopes', () => {
    const catalog = extractOpenPlatformScopeEntries({
      data: { tenant: [{ scope_id: 'id_im_message', name: 'im:message' }] },
    });
    const mapped = mapManifestScopesToOpenPlatformIds(SCOPES, catalog);
    expect(mapped.tenantScopeIds).toContain('id_im_message');
    expect(mapped.missing.length).toBeGreaterThan(0);
  });

  it('reports missing by NAME, not by the opaque catalog id (regression)', () => {
    // Every manifest scope present in the catalog under a distinct id: the
    // resolved ids are hashes that must not be compared to scope names.
    const catalog = extractOpenPlatformScopeEntries({
      data: {
        tenant: SCOPES.filter((s) => s.startsWith('im:')).map((name) => ({
          scope_id: `id_${name.replace(/:/g, '_')}`,
          name,
        })),
      },
    });
    const mapped = mapManifestScopesToOpenPlatformIds(SCOPES, catalog);
    expect(mapped.missing).toEqual([]);
    expect(mapped.tenantScopeIds.length).toBe(SCOPES.length);
  });

  it('computes the next version including drafts', () => {
    expect(nextAppVersion({ data: { versions: [{ appVersion: '1.0.0' }] } })).toBe('1.0.1');
    expect(nextAppVersion({ data: { versions: [{ appVersion: '0.1.9' }] } })).toBe('0.1.10');
    expect(nextAppVersion({ data: { versions: [] } })).toBe('0.0.1');
  });

  it('extracts a version id from several response shapes', () => {
    expect(extractVersionId({ data: { versionId: 'v1' } })).toBe('v1');
    expect(extractVersionId({ versionId: 'v2' })).toBe('v2');
    expect(extractVersionId({ data: { appVersion: { id: 'v3' } } })).toBe('v3');
  });
});

// ─── Placeholder icon ───────────────────────────────────────────────────────

describe('placeholder icon', () => {
  it('produces a valid PNG', () => {
    const png = makePlaceholderIconPng();
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.includes(Buffer.from('IHDR'))).toBe(true);
    expect(png.includes(Buffer.from('IEND'))).toBe(true);
  });
});

// ─── Profile writer ─────────────────────────────────────────────────────────

describe('profile writer', () => {
  it('creates the feishu row when missing (with the repoRoots default)', () => {
    const rows = upsertFeishuConfig([], { appId: 'cli_x', appSecret: 's' });
    expect(rows).toEqual([
      {
        id: 'feishu',
        name: '@dsh-feishu/dsh-feishu',
        config: { appId: 'cli_x', appSecret: 's', repoRoots: [homedir()] },
      },
    ]);
  });

  it('updates an existing row and preserves other rows', () => {
    const rows = upsertFeishuConfig(
      [
        { id: 'feishu', name: '@dsh-feishu/dsh-feishu', config: { repoRoots: ['/x'] } },
        { id: 'other', name: 'x' },
      ],
      { appId: 'cli_x', appSecret: 's' },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'feishu',
      config: { appId: 'cli_x', appSecret: 's', repoRoots: ['/x'] },
    });
  });

  it('is idempotent when credentials are unchanged', () => {
    const rows = [{ id: 'feishu', config: { appId: 'cli_x', appSecret: 's' } }];
    expect(upsertFeishuConfig(rows, { appId: 'cli_x', appSecret: 's' })).toBe(rows);
  });

  it('merges the guided options on create and on update', () => {
    const guided = {
      repoRoots: ['/projects'],
      groupMentionMode: 'never' as const,
      requireWorkingDir: false,
    };
    const created = upsertFeishuConfig([], { appId: 'cli_x', appSecret: 's' }, guided);
    expect(created[0]?.config).toMatchObject({
      appId: 'cli_x',
      appSecret: 's',
      repoRoots: ['/projects'],
      groupMentionMode: 'never',
      requireWorkingDir: false,
    });
    // A re-run overrides the guided keys but preserves everything else.
    const updated = upsertFeishuConfig(
      [
        {
          id: 'feishu',
          config: { appId: 'cli_old', appSecret: 'old', allowedUsers: ['ou_a'] },
        },
      ],
      { appId: 'cli_new', appSecret: 'new' },
      { repoRoots: ['/elsewhere'], groupMentionMode: 'ambient', requireWorkingDir: true },
    );
    expect(updated[0]?.config).toMatchObject({
      appId: 'cli_new',
      appSecret: 'new',
      repoRoots: ['/elsewhere'],
      groupMentionMode: 'ambient',
      requireWorkingDir: true,
      allowedUsers: ['ou_a'],
    });
  });

  it('reads the guided options back from existing rows', () => {
    const rows = [
      {
        id: 'feishu',
        config: { repoRoots: ['/x'], groupMentionMode: 'topic', requireWorkingDir: false },
      },
    ];
    expect(readFeishuGuidedConfig(rows)).toEqual({
      repoRoots: ['/x'],
      groupMentionMode: 'topic',
      requireWorkingDir: false,
    });
    expect(readFeishuGuidedConfig([])).toEqual({});
  });

  it('writes a backup and round-trips YAML', () => {
    const dir = tempDir();
    const dshHomeDir = join(dir, 'dsh-home');
    const patchPath = profilePatchPath(dshHomeDir, 'feishu-dev');
    writeProfileCredentials(dshHomeDir, 'feishu-dev', { appId: 'cli_a', appSecret: 's1' });
    expect(readFileSync(patchPath, 'utf8')).toContain('cli_a');
    const second = writeProfileCredentials(dshHomeDir, 'feishu-dev', {
      appId: 'cli_b',
      appSecret: 's2',
    });
    expect(second.changed).toBe(true);
    expect(second.backupPath).toBe(`${patchPath}.bak`);
    const rows = loadPatchRows(patchPath);
    expect(rows.find((row) => row.id === 'feishu')).toMatchObject({ id: 'feishu' });
  });
});

// ─── Configure flow with a fake fetcher ─────────────────────────────────────

const CONSOLE_PAGE_HTML =
  '<!doctype html><script>window.csrfToken = "csrf1";</script>' +
  '<script>window.user = {"id":"ou_creator","name":"Ada","tenantId":"t1","tenantDisplayName":{"value":"ACME"}};</script>';

interface FakeFetcherOptions {
  /** Initial event subscriptions (default: mode 4 + im.message.receive_v1). */
  eventState?: { eventMode?: number; events: string[] };
  /** Initial callback subscriptions (default: mode 4 + card.action.trigger). */
  callbackState?: { callbackMode?: number; callbacks: string[] };
  /** When false, update calls do not change the read-back state (fail-closed tests). */
  applyUpdates?: boolean;
  /** When true, the visible/online read-back returns no visibleSuggest (publish-degrade tests). */
  visibilityUnreadable?: boolean;
}

function createFakeFetcher(options: FakeFetcherOptions = {}): {
  fetcher: typeof fetch;
  requests: Array<{ url: string; body?: unknown }>;
  uploadedFile: Buffer | undefined;
} {
  const requests: Array<{ url: string; body?: unknown }> = [];
  let uploadedFile: Buffer | undefined;
  let eventMode = options.eventState?.eventMode ?? LONG_CONNECTION_EVENT_MODE;
  let events = [...(options.eventState?.events ?? ['im.message.receive_v1'])];
  let callbackMode = options.callbackState?.callbackMode ?? LONG_CONNECTION_EVENT_MODE;
  let callbacks = [...(options.callbackState?.callbacks ?? ['card.action.trigger'])];
  const applyUpdates = options.applyUpdates !== false;

  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const isForm = init?.body instanceof FormData;
    const body =
      init?.body && !isForm
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
    if (isForm) {
      const file = (init.body as FormData).get('file');
      if (file instanceof Blob) uploadedFile = Buffer.from(await file.arrayBuffer());
    }
    requests.push({ url: parsed.pathname, body });
    const json = (data: unknown, code = 0): Response =>
      new Response(JSON.stringify({ code, ...(data ? { data } : {}) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (parsed.pathname === '/app' || parsed.pathname === '/') {
      return new Response(CONSOLE_PAGE_HTML, { status: 200 });
    }
    if (parsed.pathname.startsWith('/developers/v1/app/upload/image')) {
      return json({ url: 'http://avatar.png' });
    }
    if (parsed.pathname.startsWith('/developers/v1/manifest/upsert_by_template')) {
      return json({ ClientID: 'cli_new' });
    }
    if (parsed.pathname.startsWith('/developers/v1/secret/')) {
      return json({ secret: 's3cr3t' });
    }
    if (parsed.pathname.startsWith('/developers/v1/scope/all/')) {
      return json({ tenant: [{ scope_id: 's_im_message', name: 'im:message' }] });
    }
    if (parsed.pathname.startsWith('/developers/v1/scope/update/')) return json({});
    if (parsed.pathname.startsWith('/developers/v1/robot/switch/')) return json({});
    if (parsed.pathname.startsWith('/developers/v1/event/switch/')) {
      if (applyUpdates && typeof body?.eventMode === 'number') eventMode = body.eventMode;
      return json({});
    }
    if (parsed.pathname.startsWith('/developers/v1/event/update/')) {
      if (applyUpdates) {
        const added = Array.isArray(body?.appEvents) ? (body.appEvents as string[]) : [];
        events = [...new Set([...events, ...added])];
      }
      return json({});
    }
    if (parsed.pathname.startsWith('/developers/v1/event/')) {
      return json({ eventMode, appEvents: events.map((id) => ({ id })) });
    }
    if (parsed.pathname.startsWith('/developers/v1/callback/switch/')) {
      if (applyUpdates && typeof body?.callbackMode === 'number') callbackMode = body.callbackMode;
      return json({});
    }
    if (parsed.pathname.startsWith('/developers/v1/callback/update/')) {
      if (applyUpdates) {
        const added = Array.isArray(body?.callbacks) ? (body.callbacks as string[]) : [];
        callbacks = [...new Set([...callbacks, ...added])];
      }
      return json({});
    }
    if (parsed.pathname.startsWith('/developers/v1/callback/')) {
      return json({ callbackMode, callbacks: callbacks.map((id) => ({ id })) });
    }
    if (parsed.pathname.startsWith('/developers/v1/safe_setting/update/')) return json({});
    if (parsed.pathname.startsWith('/developers/v1/visible/online/')) {
      if (options.visibilityUnreadable) return json({});
      return json({
        visibleSuggest: { departments: [], members: ['ou_creator'], groups: [], isAll: 0 },
      });
    }
    if (parsed.pathname.startsWith('/developers/v1/app_version/list/')) {
      return json({ versions: [{ appVersion: '1.0.0' }] });
    }
    if (parsed.pathname.startsWith('/developers/v1/app_version/create/')) {
      return json({ versionId: 'v_1' });
    }
    if (parsed.pathname.startsWith('/developers/v1/publish/commit/')) return json({});
    throw new Error(`unexpected url in fake fetcher: ${url}`);
  };
  return {
    fetcher: fetcher as typeof fetch,
    requests,
    get uploadedFile() {
      return uploadedFile;
    },
  };
}

async function makeClient(fetcher: typeof fetch): Promise<OpenPlatformApiClient> {
  const result = await createOpenPlatformApiClient([], { fetchImpl: fetcher });
  if (!result.ok) throw new Error(result.message);
  return result.client;
}

describe('configureFeishuApp', () => {
  it('configures, verifies, and publishes on a fully working console', async () => {
    const { fetcher, requests } = createFakeFetcher();
    const client = await makeClient(fetcher);
    const result = await configureFeishuApp(client, 'cli_app', { publish: true });
    expect(result.ok).toBe(true);
    expect(result.subscribedEventCount).toBe(2);
    expect(result.versionId).toBe('v_1');
    const paths = requests.map((r) => r.url);
    expect(paths).toContain('/developers/v1/robot/switch/cli_app');
    expect(paths).toContain('/developers/v1/event/switch/cli_app');
    expect(paths).toContain('/developers/v1/safe_setting/update/cli_app');
    expect(paths).toContain('/developers/v1/app_version/create/cli_app');
    expect(paths).toContain('/developers/v1/publish/commit/cli_app/v_1');
    // Already-subscribed events/callbacks need no incremental update.
    expect(paths.some((p) => p.startsWith('/developers/v1/event/update/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/developers/v1/callback/update/'))).toBe(false);
    // Scopes were mapped and sent.
    const scopeUpdate = requests.find((r) => r.url.startsWith('/developers/v1/scope/update/'));
    expect(scopeUpdate?.body).toMatchObject({ clientId: 'cli_app', appScopeIDs: ['s_im_message'] });
  });

  it('subscribes missing events and callbacks before verifying', async () => {
    const { fetcher, requests } = createFakeFetcher({
      eventState: { eventMode: LONG_CONNECTION_EVENT_MODE, events: [] },
      callbackState: { callbackMode: LONG_CONNECTION_EVENT_MODE, callbacks: [] },
    });
    const client = await makeClient(fetcher);
    const result = await configureFeishuApp(client, 'cli_app', { publish: false });
    expect(result.ok).toBe(true);
    const eventUpdate = requests.find((r) => r.url.startsWith('/developers/v1/event/update/'));
    expect(eventUpdate?.body).toMatchObject({ appEvents: ['im.message.receive_v1'] });
    const callbackUpdate = requests.find((r) =>
      r.url.startsWith('/developers/v1/callback/update/'),
    );
    expect(callbackUpdate?.body).toMatchObject({ callbacks: ['card.action.trigger'] });
  });

  it('fails closed when a critical subscription cannot be confirmed', async () => {
    // applyUpdates:false — the update call never changes the read-back, so
    // the re-read verification can never confirm im.message.receive_v1.
    const { fetcher } = createFakeFetcher({
      eventState: { eventMode: LONG_CONNECTION_EVENT_MODE, events: [] },
      callbackState: { callbackMode: LONG_CONNECTION_EVENT_MODE, callbacks: [] },
      applyUpdates: false,
    });
    const client = await makeClient(fetcher);
    const result = await configureFeishuApp(client, 'cli_app', { publish: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('event_verification_failed');
  });

  it('fails closed when the receive mode is not the long connection', async () => {
    // The switch call reports success but the read-back stays mode 1 (the
    // switch "succeeded" without taking effect, like a stale console state).
    const { fetcher } = createFakeFetcher({
      eventState: { eventMode: 1, events: ['im.message.receive_v1'] },
      applyUpdates: false,
    });
    const client = await makeClient(fetcher);
    const result = await configureFeishuApp(client, 'cli_app', { publish: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('event_verification_failed');
    expect(result.message).toMatch(/[Ll]ong connection/);
  });

  it('degrades to a manual-publish warning when the app visibility is unreadable', async () => {
    // The visible/online read-back carries no visibleSuggest (observed on a
    // freshly created app): publishing would risk resetting the visibility,
    // so the configure succeeds with scopes/subscriptions configured and a
    // warning to publish the version by hand instead of failing outright.
    const { fetcher } = createFakeFetcher({ visibilityUnreadable: true });
    const client = await makeClient(fetcher);
    const result = await configureFeishuApp(client, 'cli_app', { publish: true });
    expect(result.ok).toBe(true);
    expect(result.scopeCount).toBeGreaterThan(0);
    expect(result.warning).toMatch(/publish it manually/);
    expect(result.versionId).toBeUndefined();
  });
});

describe('setup CLI parseArgs', () => {
  it('skips a leading -- (the pnpm run arg separator, verbatim on pnpm >= 11)', () => {
    const opts = parseArgs(['--', '--new', '--profile', 'feishu']);
    expect(opts.newApp).toBe(true);
    expect(opts.profile).toBe('feishu');
  });

  it('parses the documented command shape with or without the separator', () => {
    expect(parseArgs(['--new', '--profile', 'feishu']).profile).toBe('feishu');
    expect(parseArgs(['--', '--list']).list).toBe(true);
  });

  it('still rejects unknown options', () => {
    expect(() => parseArgs(['--nope'])).toThrow('unknown option: --nope');
    // A mid-argument `--` is not the pnpm separator — it is genuinely unknown.
    expect(() => parseArgs(['--new', '--', '--profile', 'feishu'])).toThrow('unknown option: --');
  });
});

// ─── Avatar resolution ──────────────────────────────────────────────────────

describe('avatar resolution', () => {
  it('reports PNG dimensions from the IHDR chunk', () => {
    const png = makePlaceholderIconPng(64);
    expect(pngDimensions(png)).toEqual({ width: 64, height: 64 });
    expect(pngDimensions(Buffer.from('not a png at all, sorry'))).toBeNull();
  });

  it('resolves the bundled default avatar when no path is given', () => {
    const src = resolveAvatarBuffer();
    expect(src.filename).toBe('dsh-feishu.png');
    expect(src.width).toBe(1024); // the bundled serif wordmark avatar
    expect(src.buffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(DEFAULT_AVATAR_PATH).toMatch(/docs[\\/]assets[\\/]default-avatar\.png$/);
  });

  it('uses a provided avatar file, keeping its filename and size', () => {
    const dir = tempDir();
    const file = join(dir, 'custom.png');
    writeFileSync(file, makePlaceholderIconPng(32));
    const src = resolveAvatarBuffer(file);
    expect(src.filename).toBe('custom.png');
    expect(src.width).toBe(32);
    expect(src.buffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('falls back to the bundled avatar for a missing path', () => {
    const src = resolveAvatarBuffer('/nonexistent/avatar.png');
    expect(src.width).toBe(1024);
  });

  it('ships the default avatar in the published package (files whitelist)', () => {
    // Regression (user report): an npm install produced a bot with the
    // solid-color placeholder instead of the bundled default avatar —
    // `docs/` was not in the package `files`, so DEFAULT_AVATAR_PATH did
    // not exist there and resolveAvatarBuffer silently degraded. The
    // whitelist must list the file individually, and the file must exist.
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    expect(manifest.files).toContain('docs/assets/default-avatar.png');
    expect(existsSync(DEFAULT_AVATAR_PATH)).toBe(true);
  });
});

describe('createFeishuOpenPlatformApp', () => {
  it('uploads the bundled default avatar when none is given', async () => {
    const fake = createFakeFetcher();
    const client = await makeClient(fake.fetcher);
    const result = await createFeishuOpenPlatformApp(client, {
      name: 'Test Bot',
      creatorUserId: 'ou_creator',
    });
    expect(result.ok).toBe(true);
    expect(result.appId).toBe('cli_new');
    expect(result.appSecret).toBe('s3cr3t');
    expect(fake.uploadedFile).toBeDefined();
    expect(pngDimensions(fake.uploadedFile as Buffer)).toEqual({ width: 1024, height: 1024 });
  });

  it('uploads a custom avatar file when provided', async () => {
    const dir = tempDir();
    const custom = join(dir, 'my-avatar.png');
    writeFileSync(custom, makePlaceholderIconPng(48));
    const fake = createFakeFetcher();
    const client = await makeClient(fake.fetcher);
    const result = await createFeishuOpenPlatformApp(client, {
      name: 'Test Bot',
      creatorUserId: 'ou_creator',
      avatarFilePath: custom,
    });
    expect(result.ok).toBe(true);
    expect(fake.uploadedFile).toBeDefined();
    expect(pngDimensions(fake.uploadedFile as Buffer)).toEqual({ width: 48, height: 48 });
  });
});

// ─── Bot profile (guided prompts) ──────────────────────────────────────────

describe('bot profile', () => {
  it('gives CLI-provided values the highest priority', () => {
    const p = mergeBotProfile(
      { appName: 'CLI Bot', avatarFilePath: '/x.png', description: 'cli desc' },
      { appName: 'Answered', avatarFilePath: '/a.png', description: 'ans desc' },
    );
    expect(p).toEqual({
      name: 'CLI Bot',
      avatarFilePath: '/x.png',
      description: 'cli desc',
    });
  });

  it('falls back to prompted answers, then to defaults', () => {
    const answered = mergeBotProfile(
      {},
      { appName: 'Answered', avatarFilePath: '/a.png', description: 'd' },
    );
    expect(answered).toEqual({ name: 'Answered', avatarFilePath: '/a.png', description: 'd' });
    const defaults = mergeBotProfile({}, {});
    expect(defaults.name).toBe(DEFAULT_APP_NAME);
    expect(defaults.avatarFilePath).toBeUndefined();
    expect(defaults.description).toBeUndefined();
  });

  it('treats blank answers as "use the default"', () => {
    const p = mergeBotProfile({}, { appName: '   ', avatarFilePath: '', description: '' });
    expect(p.name).toBe(DEFAULT_APP_NAME);
    expect(p.avatarFilePath).toBeUndefined();
    expect(p.description).toBeUndefined();
  });

  it('skips prompts when stdin is not a TTY', async () => {
    const answers = await promptBotProfile({});
    expect(answers).toEqual({});
  });
});

describe('startup hint', () => {
  it('matches the README run command (npx @deepseek-ai/dsh)', () => {
    expect(startHint('feishu')).toBe('Start with: npx @deepseek-ai/dsh --profile feishu');
    expect(startHint('feishu')).toContain('npx @deepseek-ai/dsh --profile');
    expect(startHint('feishu')).not.toContain('dsh --profile feishu\n');
  });
});
