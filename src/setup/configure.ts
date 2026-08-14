/**
 * The Open Platform configuration flow for a Feishu app: bot capability,
 * long-connection event + card-callback subscriptions, scopes, safe settings,
 * and a version publish. Read-back verification is fail-closed on the two
 * critical subscriptions (`im.message.receive_v1` event and
 * `card.action.trigger` callback, both in long-connection mode) — a bot that
 * cannot receive messages or card clicks must never be reported as
 * configured. Mirrors botmux's `automateOpenPlatformSetup`
 * (`_tmp/botmux/src/setup/open-platform-automation.ts`).
 */

import { type OpenPlatformApiClient, openPlatformOwnerAccessDenied } from './client.js';
import { SCOPES } from './manifest.js';
import {
  buildAppVersionCreatePayload,
  buildCallbackSubscriptionPayload,
  buildEventSubscriptionPayload,
  buildSafeSettingPayload,
  buildScopeUpdatePayload,
  extractOpenPlatformCallbackState,
  extractOpenPlatformEventState,
  extractOpenPlatformScopeEntries,
  extractVersionId,
  LONG_CONNECTION_EVENT_MODE,
  mapManifestScopesToOpenPlatformIds,
  nextAppVersion,
  type OnlineVisibility,
  type OpenPlatformCallbackState,
  type OpenPlatformEventState,
  parseOnlineVisibility,
  REQUIRED_CALLBACKS,
  REQUIRED_EVENTS,
} from './payloads.js';

/** Outcome of the configure flow. */
export interface ConfigureResult {
  readonly ok: boolean;
  /** When `ok`, number of scopes granted (may be 0 when already granted). */
  readonly scopeCount?: number;
  /** When `ok`, number of event+callback subscriptions confirmed. */
  readonly subscribedEventCount?: number;
  /** Non-fatal issues (skipped scopes, partial event failures). */
  readonly warning?: string;
  /** Published version id, when the version was created. */
  readonly versionId?: string;
  /** Failure reason for diagnostics. */
  readonly reason?:
    | 'api_error'
    | 'event_verification_failed'
    | 'visibility_unreadable'
    | 'owner_session_mismatch';
  readonly message?: string;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_=-]{24,}/g, '***');
}

/**
 * Configure an existing Feishu app end to end.
 * @param client - authenticated console client.
 * @param appId - `cli_...` app id.
 * @param options - when `publish` is false the version steps are skipped.
 */
export async function configureFeishuApp(
  client: OpenPlatformApiClient,
  appId: string,
  options: { publish?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<ConfigureResult> {
  const postJson = client.postJson;
  const warnings: string[] = [];

  // ── Scopes (non-fatal: some tenants cannot grant individual scopes). ──
  let scopeCount = 0;
  try {
    const catalogPayload = await postJson(`/developers/v1/scope/all/${appId}`);
    const catalog = extractOpenPlatformScopeEntries(catalogPayload);
    const mapped = mapManifestScopesToOpenPlatformIds(SCOPES, catalog);
    if (mapped.missing.length > 0) {
      warnings.push(`scopes not in the catalog (skipped): ${mapped.missing.join(', ')}`);
    }
    if (mapped.tenantScopeIds.length + mapped.userScopeIds.length > 0) {
      try {
        await postJson(
          `/developers/v1/scope/update/${appId}`,
          buildScopeUpdatePayload(appId, mapped),
        );
        scopeCount = mapped.tenantScopeIds.length + mapped.userScopeIds.length;
      } catch (error) {
        warnings.push(`granting scopes failed: ${safeErrorMessage(error)}`);
      }
    }
  } catch (error) {
    if (openPlatformOwnerAccessDenied(error)) {
      return {
        ok: false,
        reason: 'owner_session_mismatch',
        message: `The session cannot manage app ${appId} (not the owner?)`,
      };
    }
    warnings.push(`reading the scope catalog failed: ${safeErrorMessage(error)}`);
  }

  // ── Bot + long-connection event mode (fatal: without them no messages). ──
  try {
    await postJson(`/developers/v1/robot/switch/${appId}`, { clientId: appId, enable: true });
    await postJson(`/developers/v1/event/switch/${appId}`, {
      clientId: appId,
      eventMode: LONG_CONNECTION_EVENT_MODE,
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'api_error',
      message: `Enabling the bot or long-connection events failed: ${safeErrorMessage(error)}`,
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    };
  }

  // ── Events: read → add missing → re-read → verify (fail-closed). ──
  let eventState: OpenPlatformEventState | undefined;
  try {
    eventState = extractOpenPlatformEventState(
      await postJson(`/developers/v1/event/${appId}`, { needEventDetail: true }),
    );
  } catch (error) {
    warnings.push(`reading event subscriptions failed: ${safeErrorMessage(error)}`);
  }
  const hasEvent = (name: string): boolean => Boolean(eventState?.events.includes(name));
  const missingAppEvents = REQUIRED_EVENTS.filter((name) => !hasEvent(name));
  if (missingAppEvents.length > 0) {
    const eventMode = eventState?.eventMode ?? LONG_CONNECTION_EVENT_MODE;
    try {
      await postJson(
        `/developers/v1/event/update/${appId}`,
        buildEventSubscriptionPayload(appId, eventMode, missingAppEvents),
      );
    } catch {
      for (const name of missingAppEvents) {
        try {
          await postJson(
            `/developers/v1/event/update/${appId}`,
            buildEventSubscriptionPayload(appId, eventMode, [name]),
          );
        } catch (inner) {
          warnings.push(`subscribing event ${name} failed: ${safeErrorMessage(inner)}`);
        }
      }
    }
    try {
      eventState = extractOpenPlatformEventState(
        await postJson(`/developers/v1/event/${appId}`, { needEventDetail: true }),
      );
    } catch (error) {
      warnings.push(`re-reading event subscriptions failed: ${safeErrorMessage(error)}`);
    }
  }
  const missingBaselineEvents = REQUIRED_EVENTS.filter((name) => !hasEvent(name));
  if (missingBaselineEvents.length > 0) {
    warnings.push(`events not confirmed: ${missingBaselineEvents.join(', ')}`);
  }

  // ── Card callbacks: separate channel; switch + add + verify (fail-closed). ──
  let callbackState: OpenPlatformCallbackState | undefined;
  try {
    callbackState = extractOpenPlatformCallbackState(
      await postJson(`/developers/v1/callback/${appId}`, {}),
    );
  } catch (error) {
    warnings.push(`reading callback subscriptions failed: ${safeErrorMessage(error)}`);
  }
  if (callbackState && callbackState.callbackMode !== LONG_CONNECTION_EVENT_MODE) {
    try {
      await postJson(`/developers/v1/callback/switch/${appId}`, {
        clientId: appId,
        callbackMode: LONG_CONNECTION_EVENT_MODE,
      });
      callbackState = extractOpenPlatformCallbackState(
        await postJson(`/developers/v1/callback/${appId}`, {}),
      );
    } catch (error) {
      warnings.push(`switching callbacks to long connection failed: ${safeErrorMessage(error)}`);
    }
  }
  let missingCallbacks = REQUIRED_CALLBACKS.filter(
    (name) => !callbackState?.callbacks.includes(name),
  );
  if (missingCallbacks.length > 0) {
    try {
      await postJson(
        `/developers/v1/callback/update/${appId}`,
        buildCallbackSubscriptionPayload(
          appId,
          callbackState?.callbackMode ?? LONG_CONNECTION_EVENT_MODE,
          missingCallbacks,
        ),
      );
    } catch (error) {
      warnings.push(`subscribing card callbacks failed: ${safeErrorMessage(error)}`);
    }
    try {
      callbackState = extractOpenPlatformCallbackState(
        await postJson(`/developers/v1/callback/${appId}`, {}),
      );
    } catch (error) {
      warnings.push(`re-reading callback subscriptions failed: ${safeErrorMessage(error)}`);
    }
    missingCallbacks = REQUIRED_CALLBACKS.filter(
      (name) => !callbackState?.callbacks.includes(name),
    );
  }

  const subscribedEventCount =
    REQUIRED_EVENTS.filter((name) => hasEvent(name)).length +
    REQUIRED_CALLBACKS.filter((name) => callbackState?.callbacks.includes(name)).length;
  const warning = warnings.length > 0 ? warnings.join('; ') : undefined;

  // Fail-closed: the two critical subscriptions and the long-connection modes.
  const criticalIssues: string[] = [...missingBaselineEvents, ...missingCallbacks];
  if (eventState?.eventMode !== LONG_CONNECTION_EVENT_MODE) {
    criticalIssues.push(
      `event mode=${eventState?.eventMode ?? 'unknown'} (need ${LONG_CONNECTION_EVENT_MODE})`,
    );
  }
  if (callbackState?.callbackMode !== LONG_CONNECTION_EVENT_MODE) {
    criticalIssues.push(
      `callback mode=${callbackState?.callbackMode ?? 'unknown'} (need ${LONG_CONNECTION_EVENT_MODE})`,
    );
  }
  if (criticalIssues.length > 0) {
    return {
      ok: false,
      reason: 'event_verification_failed',
      message:
        `Critical subscriptions did not take effect (${criticalIssues.join('; ')}); ` +
        'the bot would receive neither messages nor card clicks. Fix in the Open Platform ' +
        'console (Events & Callbacks → Long connection) and re-run.',
      ...(warning !== undefined ? { warning } : {}),
      ...(subscribedEventCount !== undefined ? { subscribedEventCount } : {}),
    };
  }

  if (options.publish === false) {
    return {
      ok: true,
      scopeCount,
      ...(warning !== undefined ? { warning } : {}),
      ...(subscribedEventCount !== undefined ? { subscribedEventCount } : {}),
    };
  }

  // ── Version publish (visibility full-overwrite protection). ──
  try {
    await postJson(`/developers/v1/safe_setting/update/${appId}`, buildSafeSettingPayload(appId));
    let visibility: OnlineVisibility;
    try {
      visibility = parseOnlineVisibility(
        await postJson(`/developers/v1/visible/online/${appId}`, {}),
      );
    } catch (error) {
      return {
        ok: false,
        reason: 'visibility_unreadable',
        message:
          `Cannot read the app's current visibility (${safeErrorMessage(error)}); aborted the publish ` +
          'rather than reset it. Publish the version manually in the console.',
        ...(warning !== undefined ? { warning } : {}),
        ...(subscribedEventCount !== undefined ? { subscribedEventCount } : {}),
      };
    }
    const versionList = await postJson(`/developers/v1/app_version/list/${appId}`, {});
    const appVersion = nextAppVersion(versionList);
    const versionPayload = buildAppVersionCreatePayload(appVersion, visibility.visibleSuggest);
    versionPayload.blackVisibleSuggest = visibility.blackVisibleSuggest;
    const created = await postJson(`/developers/v1/app_version/create/${appId}`, versionPayload);
    const versionId = extractVersionId(created);
    if (!versionId) {
      return {
        ok: false,
        reason: 'api_error',
        message:
          'The Open Platform created a version draft but returned no version id; publish manually.',
        ...(warning !== undefined ? { warning } : {}),
        ...(subscribedEventCount !== undefined ? { subscribedEventCount } : {}),
      };
    }
    await postJson(`/developers/v1/publish/commit/${appId}/${versionId}`, { clientId: appId });
    return {
      ok: true,
      scopeCount,
      versionId,
      ...(warning !== undefined ? { warning } : {}),
      ...(subscribedEventCount !== undefined ? { subscribedEventCount } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'api_error',
      message: `Open Platform configuration failed: ${safeErrorMessage(error)}`,
      ...(warning !== undefined ? { warning } : {}),
      ...(subscribedEventCount !== undefined ? { subscribedEventCount } : {}),
    };
  }
}
