/**
 * Payload builders and response extractors for the Open Platform console's
 * `/developers/v1/*` internal APIs, mirroring the console frontend and
 * botmux's open-platform automation. Each builder/extractor is pure and unit
 * tested; the automation flows in `configure.ts` / `create-app.ts` call them.
 */

import type { OpenPlatformApiClient } from './client.js';
import { APP_EVENTS, CARD_CALLBACKS, LONG_CONNECTION_EVENT_MODE } from './manifest.js';

/** Console app-catalog template id for the "one-click agent" launcher. */
export const ONECLICK_APP_MANIFEST_TEMPLATE_ID = 'developer_console';

/** Build the scope-update payload (console `updateScope`). */
export function buildScopeUpdatePayload(
  appId: string,
  mapped: { tenantScopeIds: readonly string[]; userScopeIds: readonly string[] },
): Record<string, unknown> {
  return {
    clientId: appId,
    appScopeIDs: mapped.tenantScopeIds,
    userScopeIDs: mapped.userScopeIds,
    scopeIds: [],
    operation: 'add',
    isDeveloperPanel: true,
  };
}

/** Build the safe-settings payload (empty redirect whitelist = unrestricted). */
export function buildSafeSettingPayload(appId: string): Record<string, unknown> {
  return { clientId: appId, redirectURL: [] };
}

/** Build the incremental event-subscription payload (console `updateEvent`). */
export function buildEventSubscriptionPayload(
  appId: string,
  eventMode: number,
  appEvents: readonly string[],
  userEvents: readonly string[] = [],
  events: readonly string[] = [],
): Record<string, unknown> {
  return {
    clientId: appId,
    operation: 'add',
    events,
    appEvents,
    userEvents,
    eventMode,
  };
}

/** Build the incremental callback-subscription payload (console `updateCallback`). */
export function buildCallbackSubscriptionPayload(
  appId: string,
  callbackMode: number,
  callbacks: readonly string[],
): Record<string, unknown> {
  return {
    clientId: appId,
    operation: 'add',
    callbacks,
    callbackMode,
  };
}

/** Build the manifest-template create payload (console "one-click" launcher). */
export function buildManifestTemplateCreatePayload(
  name: string,
  description: string,
  avatar: string,
  cid: string,
): Record<string, unknown> {
  return {
    appManifestTemplateID: ONECLICK_APP_MANIFEST_TEMPLATE_ID,
    createAppUserCustomField: {
      i18n: { zh_cn: { name, description } },
      avatar,
      primaryLang: 'zh_cn',
    },
    cid,
    HTTPHead: {},
  };
}

/**
 * Build the app-version create payload. `visibleSuggest` is FULL-OVERWRITE:
 * for an existing app the caller must read the online visibility
 * (`/developers/v1/visible/online`) and pass it through; for a brand-new app
 * pass the creator's member id so the version auto-enables on publish.
 */
export function buildAppVersionCreatePayload(
  appVersion: string,
  visibleSuggest: {
    departments: readonly string[];
    members: readonly string[];
    groups: readonly string[];
    isAll: number;
  },
): Record<string, unknown> {
  return {
    appVersion,
    mobileDefaultAbility: 'bot',
    pcDefaultAbility: 'bot',
    changeLog: 'Initial bot release.',
    visibleSuggest: {
      departments: [...visibleSuggest.departments],
      members: [...visibleSuggest.members],
      groups: [...visibleSuggest.groups],
      isAll: visibleSuggest.isAll,
    },
    blackVisibleSuggest: {
      departments: [],
      members: [],
      groups: [],
      isAll: 0,
    },
  };
}

/** Visibility structure as read back from `/developers/v1/visible/online`. */
export interface OnlineVisibility {
  readonly visibleSuggest: {
    departments: readonly string[];
    members: readonly string[];
    groups: readonly string[];
    isAll: number;
  };
  readonly blackVisibleSuggest: {
    departments: readonly string[];
    members: readonly string[];
    groups: readonly string[];
    isAll: number;
  };
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

function uniqueStrings(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === 'string' && value !== ''),
    ),
  ];
}

function asVisibilityGroup(value: unknown): {
  departments: string[];
  members: string[];
  groups: string[];
  isAll: number;
} {
  const record = asRecord(value);
  const stringArray = (key: string): string[] => {
    const raw = record[key];
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
  };
  const isAll = typeof record.isAll === 'number' ? record.isAll : 0;
  return {
    departments: stringArray('departments'),
    members: stringArray('members'),
    groups: stringArray('groups'),
    isAll,
  };
}

/**
 * Parse the online-visibility payload. Fails loud (throws) when the shape is
 * unexpected: the caller must never publish a version that silently resets
 * the visibility of an existing app.
 */
export function parseOnlineVisibility(payload: unknown): OnlineVisibility {
  const data = asRecord(asRecord(payload).data);
  const visible = asVisibilityGroup(data.visibleSuggest ?? data.visible_suggest);
  const black = asVisibilityGroup(data.blackVisibleSuggest ?? data.black_visible_suggest);
  if (
    visible.departments.length === 0 &&
    visible.members.length === 0 &&
    visible.groups.length === 0 &&
    !Object.hasOwn(data, 'visibleSuggest') &&
    !Object.hasOwn(data, 'visible_suggest')
  ) {
    throw new Error('visibility payload missing visibleSuggest');
  }
  return {
    visibleSuggest: visible,
    blackVisibleSuggest: black,
  };
}

/** Event-subscription state as read back from `/developers/v1/event/:appId`. */
export interface OpenPlatformEventState {
  readonly eventMode?: number;
  /** All subscribed events (generic + app/user buckets). */
  readonly events: string[];
  readonly appEvents: string[];
  readonly userEvents: string[];
}

/** Callback-subscription state as read back from `/developers/v1/callback/:appId`. */
export interface OpenPlatformCallbackState {
  readonly callbackMode?: number;
  readonly callbacks: string[];
}

function extractEventIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value
      .map((item) => (typeof item === 'string' ? item : pickString(asRecord(item), ['id'])))
      .filter((item): item is string => item !== undefined),
  );
}

function extractEventIdsFromDetails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.flatMap((group) => extractEventIds(asRecord(group).items)));
}

/** Parse the event-state payload (console `getEvent`). */
export function extractOpenPlatformEventState(payload: unknown): OpenPlatformEventState {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const appEvents = uniqueStrings([
    ...extractEventIds(data.appEvents),
    ...extractEventIdsFromDetails(data.appEventDetails),
  ]);
  const userEvents = uniqueStrings([
    ...extractEventIds(data.userEvents),
    ...extractEventIdsFromDetails(data.userEventDetails),
  ]);
  const genericEvents = uniqueStrings([
    ...extractEventIds(data.events),
    ...extractEventIdsFromDetails(data.eventDetails),
  ]);
  const eventMode =
    typeof data.eventMode === 'number' && Number.isFinite(data.eventMode)
      ? data.eventMode
      : undefined;
  return {
    ...(eventMode !== undefined ? { eventMode } : {}),
    events: uniqueStrings([...genericEvents, ...appEvents, ...userEvents]),
    appEvents,
    userEvents,
  };
}

/** Parse the callback-state payload (console `getCallback`). */
export function extractOpenPlatformCallbackState(payload: unknown): OpenPlatformCallbackState {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const callbackMode =
    typeof data.callbackMode === 'number' && Number.isFinite(data.callbackMode)
      ? data.callbackMode
      : undefined;
  return {
    ...(callbackMode !== undefined ? { callbackMode } : {}),
    callbacks: extractEventIds(data.callbacks),
  };
}

/** A scope entry from the console catalog. */
export interface OpenPlatformScopeEntry {
  readonly id: string;
  readonly name?: string;
  readonly bucket?: 'tenant' | 'user';
}

function collectScopeEntries(
  value: unknown,
  bucket: 'tenant' | 'user' | undefined,
  out: OpenPlatformScopeEntry[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScopeEntries(item, bucket, out);
    return;
  }
  const record = asRecord(value);
  const id = pickString(record, ['scope_id', 'scopeId', 'id']);
  if (id)
    out.push({
      id,
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(bucket ? { bucket } : {}),
    });
  if (record.data) collectScopeEntries(record.data, bucket, out);
  if (record.tenant) collectScopeEntries(record.tenant, 'tenant', out);
  if (record.user) collectScopeEntries(record.user, 'user', out);
  if (record.scopes) collectScopeEntries(record.scopes, bucket, out);
  if (record.list) collectScopeEntries(record.list, bucket, out);
}

/** Extract the deduplicated scope catalog from `/developers/v1/scope/all/:appId`. */
export function extractOpenPlatformScopeEntries(payload: unknown): OpenPlatformScopeEntry[] {
  const out: OpenPlatformScopeEntry[] = [];
  collectScopeEntries(payload, undefined, out);
  const seen = new Set<string>();
  return out.filter((entry) => {
    const key = `${entry.bucket ?? 'any'}:${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Map manifest scope names to catalog ids; names absent from the catalog are reported. */
export function mapManifestScopesToOpenPlatformIds(
  scopes: readonly string[],
  catalog: readonly OpenPlatformScopeEntry[],
): { tenantScopeIds: string[]; userScopeIds: string[]; missing: string[] } {
  const tenant = scopes.filter((scope) => scope.startsWith('im:'));
  const user = scopes.filter((scope) => !scope.startsWith('im:'));
  const idsFor = (names: readonly string[], bucket: 'tenant' | 'user'): string[] =>
    names
      .map(
        (name) =>
          catalog.find(
            (entry) => entry.bucket === bucket && (entry.id === name || entry.name === name),
          )?.id,
      )
      .filter((id): id is string => id !== undefined);
  const found = new Set<string>([...idsFor(tenant, 'tenant'), ...idsFor(user, 'user')]);
  return {
    tenantScopeIds: idsFor(tenant, 'tenant'),
    userScopeIds: idsFor(user, 'user'),
    missing: scopes.filter((scope) => !found.has(scope)),
  };
}

/** Compute the next patch version (max existing triple + 1); includes drafts. */
export function nextAppVersion(payload: unknown): string {
  const data = asRecord(asRecord(payload).data);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const triples = versions
    .map((item) => pickString(asRecord(item), ['appVersion']))
    .filter((version): version is string => version !== undefined)
    .map((version) => version.split('.').map((part) => Number.parseInt(part, 10)))
    .filter((parts) => parts.length === 3 && parts.every((part) => Number.isFinite(part)));
  if (triples.length === 0) return '0.0.1';
  const max = triples.reduce((a, b) => {
    for (let i = 0; i < 3; i += 1) {
      const aPart = a[i] ?? 0;
      const bPart = b[i] ?? 0;
      if (bPart !== aPart) return bPart > aPart ? b : a;
    }
    return a;
  });
  return [max[0] ?? 0, max[1] ?? 0, (max[2] ?? 0) + 1].join('.');
}

/** Extract the version id from `app_version/create` (several response shapes). */
export function extractVersionId(payload: unknown): string | undefined {
  const direct = pickString(asRecord(payload), ['versionId', 'version_id', 'id']);
  if (direct) return direct;
  const data = asRecord(asRecord(payload).data);
  return (
    pickString(data, ['versionId', 'version_id', 'id']) ??
    pickString(asRecord(data.appVersion), ['versionId', 'version_id', 'id'])
  );
}

/** A self-built app listed by `/developers/v1/app/list`. */
export interface OpenPlatformAppSummary {
  readonly clientId: string;
  readonly name: string;
  readonly description?: string;
}

/** List apps visible to the current session (console `getAppList`). */
export async function listOpenPlatformApps(
  client: OpenPlatformApiClient,
  options: { pageSize?: number; maxApps?: number } = {},
): Promise<OpenPlatformAppSummary[]> {
  const pageSize = options.pageSize ?? 100;
  const maxApps = options.maxApps ?? 500;
  const out: OpenPlatformAppSummary[] = [];
  for (let cursor = 0; cursor < maxApps; cursor += pageSize) {
    const payload = await client.postJson('/developers/v1/app/list', {
      Count: pageSize,
      Cursor: cursor,
      QueryFilter: {},
    });
    const record = asRecord(payload);
    const data = asRecord(record.data);
    const apps = Array.isArray(data.apps)
      ? data.apps
      : Array.isArray(record.apps)
        ? (record.apps as unknown[])
        : [];
    for (const item of apps) {
      const rec = asRecord(item);
      const clientId = pickString(rec, ['clientId', 'client_id', 'appId', 'app_id', 'appID']);
      if (!clientId?.startsWith('cli_')) continue;
      const name = pickString(rec, ['name', 'appName', 'app_name']) ?? clientId;
      const description = pickString(rec, ['description', 'desc', 'appDesc', 'app_desc']);
      out.push({ clientId, name, ...(description ? { description } : {}) });
    }
    const totalCount =
      typeof data.totalCount === 'number'
        ? data.totalCount
        : typeof record.totalCount === 'number'
          ? (record.totalCount as number)
          : undefined;
    if (apps.length < pageSize) break;
    if (totalCount !== undefined && cursor + pageSize >= totalCount) break;
  }
  return out;
}

/** Read an app's secret (read-only; never hits the reset endpoints). */
export async function fetchOpenPlatformAppSecret(
  client: OpenPlatformApiClient,
  clientId: string,
): Promise<string> {
  const payload = await client.postJson(`/developers/v1/secret/${clientId}`, {});
  const record = asRecord(payload);
  const secret = pickString(asRecord(record.data), ['secret']) ?? pickString(record, ['secret']);
  if (!secret) throw new Error('The Open Platform did not return a secret field');
  return secret;
}

/** The surface's required subscriptions; used by the fail-closed check. */
export const REQUIRED_EVENTS = APP_EVENTS;
export const REQUIRED_CALLBACKS = CARD_CALLBACKS;
export { LONG_CONNECTION_EVENT_MODE };
