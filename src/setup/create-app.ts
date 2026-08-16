/**
 * Create a Feishu self-built app from the console session and return its
 * credentials. The preferred path uses the console launcher's manifest
 * template (the app is born with bot capability, long connection, and base
 * event subscriptions); a definite rejection falls back to the bare
 * `app/create` endpoint. Configuration (scopes, events, callbacks) runs
 * through the shared configure flow, then a single version is published with
 * the creator's visibility so the app auto-enables. Mirrors botmux's
 * `createOpenPlatformAppWithClient`
 * (`_tmp/botmux/src/setup/open-platform-automation.ts`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { type OpenPlatformApiClient, OpenPlatformApiError } from './client.js';
import { configureFeishuApp } from './configure.js';
import { LONG_CONNECTION_EVENT_MODE } from './manifest.js';
import {
  buildAppVersionCreatePayload,
  buildManifestTemplateCreatePayload,
  extractVersionId,
  fetchOpenPlatformAppSecret,
  ONECLICK_APP_MANIFEST_TEMPLATE_ID,
} from './payloads.js';

/** Result of app creation. */
export interface CreateAppResult {
  readonly ok: boolean;
  readonly appId?: string;
  readonly appSecret?: string;
  readonly reason?: 'api_error' | 'missing_avatar' | 'event_verification_failed';
  readonly message?: string;
  /** Non-fatal issues from the configure step (skipped scopes etc.). */
  readonly warning?: string;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_=-]{24,}/g, '***');
}

// ── Minimal PNG encoder (solid-color icon, no image dependency). ────────────

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Build a solid-color RGBA PNG of the given size (used as the app icon). */
export function makePlaceholderIconPng(
  size = 64,
  rgb: readonly [number, number, number] = [22, 119, 255],
): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 4] = rgb[0];
    row[2 + x * 4] = rgb[1];
    row[3 + x * 4] = rgb[2];
    row[4 + x * 4] = 255;
  }
  const scanlines = Buffer.concat(Array.from({ length: size }, () => row));
  const idat = deflateSync(scanlines, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The bundled default avatar (serif "dsh" wordmark on the Feishu blue
 * gradient card). Resolved relative to the built lib/ so it works both from
 * a checkout and from an installed npm package (the `docs` directory ships
 * in the package `files`).
 */
export const DEFAULT_AVATAR_PATH = fileURLToPath(
  new URL('../../docs/assets/default-avatar.png', import.meta.url),
);

/** Read a PNG's pixel dimensions from its IHDR chunk; `null` when not a PNG. */
export function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(12) !== 0x49484452) return null; // chunk type "IHDR"
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** An avatar ready for upload. */
export interface AvatarSource {
  readonly buffer: Buffer;
  readonly filename: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Resolve the avatar to upload: an explicit file path when given and
 * present, else the bundled default avatar, else the solid-color placeholder.
 * @param avatarFilePath - optional user-provided avatar image (PNG).
 */
export function resolveAvatarBuffer(avatarFilePath?: string): AvatarSource {
  let buffer: Buffer | undefined;
  let filename = 'dsh-feishu.png';
  if (avatarFilePath !== undefined && avatarFilePath !== '' && existsSync(avatarFilePath)) {
    buffer = readFileSync(avatarFilePath);
    filename = basename(avatarFilePath);
  } else if (existsSync(DEFAULT_AVATAR_PATH)) {
    buffer = readFileSync(DEFAULT_AVATAR_PATH);
  }
  if (buffer === undefined) {
    buffer = makePlaceholderIconPng();
  }
  const dims = pngDimensions(buffer);
  return {
    buffer,
    filename,
    width: dims?.width ?? 64,
    height: dims?.height ?? 64,
  };
}

// ── App creation flow. ──────────────────────────────────────────────────────

/** True when the template endpoint definitively rejected (safe to fall back). */
function isDefiniteTemplateRejection(error: unknown): boolean {
  if (!(error instanceof OpenPlatformApiError)) return false;
  const payload = error.payload as { code?: unknown } | null;
  if (typeof payload?.code === 'number' && payload.code !== 0) return true;
  return /^HTTP 404\b/.test(error.message);
}

function pickPayloadString(payload: unknown, keys: readonly string[]): string | undefined {
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return pickPayloadString(data, keys);
  }
  return undefined;
}

/**
 * Create an app end to end: upload an icon, create via the template (falling
 * back to `app/create` on a definite rejection), configure through
 * {@link configureFeishuApp}, publish the first version with the creator's
 * visibility, and read back the secret.
 *
 * @param client - authenticated console client.
 * @param options - name, description, and the creator's user id (the first
 *   version must be visible to the creator or the app will not auto-enable).
 */
export async function createFeishuOpenPlatformApp(
  client: OpenPlatformApiClient,
  options: { name: string; description?: string; creatorUserId: string; avatarFilePath?: string },
): Promise<CreateAppResult> {
  const name = options.name.trim();
  if (!name) {
    return { ok: false, reason: 'api_error', message: 'The app name must not be empty' };
  }
  if (!options.creatorUserId) {
    return {
      ok: false,
      reason: 'api_error',
      message: 'Missing creator user id; cannot enable the app on publish',
    };
  }
  const description = options.description?.trim() || 'A dsh agent surface on Feishu.';

  // Upload the app avatar: an explicit --avatar file, else the bundled
  // default avatar, else the solid-color placeholder.
  let avatar: string | undefined;
  try {
    const avatarSrc = resolveAvatarBuffer(options.avatarFilePath);
    const form = new FormData();
    form.append('file', new Blob([avatarSrc.buffer], { type: 'image/png' }), avatarSrc.filename);
    form.append('uploadType', '4'); // console enum: Icon
    form.append('isIsv', 'false'); // self-built app
    form.append('scale', JSON.stringify({ width: avatarSrc.width, height: avatarSrc.height }));
    const uploaded = await client.postForm('/developers/v1/app/upload/image', form);
    avatar = pickPayloadString(uploaded, ['url']);
  } catch (error) {
    return {
      ok: false,
      reason: 'api_error',
      message: `Uploading the app icon failed: ${safeErrorMessage(error)}`,
    };
  }
  if (!avatar) {
    return {
      ok: false,
      reason: 'missing_avatar',
      message: 'The Open Platform did not return an icon url',
    };
  }

  // Create the app; fall back to the bare endpoint on a definite rejection.
  let appId: string | undefined;
  try {
    const created = await client.postJson(
      '/developers/v1/manifest/upsert_by_template',
      buildManifestTemplateCreatePayload(name, description, avatar, crypto.randomUUID()),
    );
    const templateAppId = pickPayloadString(created, ['ClientID', 'clientID', 'clientId', 'appId']);
    if (!templateAppId?.startsWith('cli_')) {
      throw new Error('template creation returned success without a ClientID (result unknown)');
    }
    appId = templateAppId;
  } catch (error) {
    if (!isDefiniteTemplateRejection(error)) {
      return {
        ok: false,
        reason: 'api_error',
        message:
          `Template app creation failed with an unknown result (${safeErrorMessage(error)}); ` +
          'check the console for a duplicate app before retrying.',
      };
    }
    try {
      const created = await client.postJson('/developers/v1/app/create', {
        appSceneType: 0,
        name,
        desc: description,
        avatar,
        i18n: { zh_cn: { name, description } },
        primaryLang: 'zh_cn',
      });
      appId = pickPayloadString(created, ['ClientID', 'clientID', 'clientId', 'appId']);
    } catch (fallbackError) {
      return {
        ok: false,
        reason: 'api_error',
        message: `Creating the app failed: ${safeErrorMessage(fallbackError)}`,
      };
    }
  }
  if (!appId?.startsWith('cli_')) {
    return {
      ok: false,
      reason: 'api_error',
      message: 'The Open Platform did not return a ClientID',
    };
  }

  // Configure (scopes, events, callbacks, safe settings) without publishing,
  // then publish ONE version with the creator visible (auto-enables the app).
  try {
    await client.postJson(`/developers/v1/robot/switch/${appId}`, {
      clientId: appId,
      enable: true,
    });
    await client.postJson(`/developers/v1/event/switch/${appId}`, {
      clientId: appId,
      eventMode: LONG_CONNECTION_EVENT_MODE,
    });
    const configured = await configureFeishuApp(client, appId, { publish: false });
    if (!configured.ok) {
      const reason: 'api_error' | 'event_verification_failed' =
        configured.reason === 'event_verification_failed'
          ? 'event_verification_failed'
          : 'api_error';
      return { ok: false, reason, message: configured.message ?? 'Configuration failed', appId };
    }
    const warning = configured.warning;
    const versionCreated = await client.postJson(
      `/developers/v1/app_version/create/${appId}`,
      buildAppVersionCreatePayload('1.0.0', {
        departments: [],
        members: [options.creatorUserId],
        groups: [],
        isAll: 0,
      }),
    );
    const versionId = extractVersionId(versionCreated);
    if (!versionId) {
      return {
        ok: false,
        reason: 'api_error',
        message:
          'The enable version was created without a version id (a draft may remain); check the console.',
        appId,
      };
    }
    await client.postJson(`/developers/v1/publish/commit/${appId}/${versionId}`, {
      clientId: appId,
    });
    const appSecret = await fetchOpenPlatformAppSecret(client, appId);
    return {
      ok: true,
      appId,
      appSecret,
      ...(warning !== undefined ? { warning } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'api_error',
      message: `Configuring the new app failed: ${safeErrorMessage(error)}`,
      appId,
    };
  }
}

export { ONECLICK_APP_MANIFEST_TEMPLATE_ID };
