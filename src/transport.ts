/**
 * Feishu (Lark) transport over the official `@larksuiteoapi/node-sdk`.
 *
 * Two connections share the app credentials:
 * - a `WSClient` long connection (outbound only — no public endpoint, no
 *   public IP needed on the host) that delivers `im.message.receive_v1`
 *   events and, later, card action callbacks; and
 * - a `Client` used for outbound API calls (`message.create` /
 *   `message.patch`).
 *
 * The SDK resolves `{code, msg, data}` responses without throwing on
 * business errors, so every call asserts `code === 0` and throws a
 * {@link FeishuApiError} otherwise.
 *
 * @module @dsh-feishu/dsh-feishu/transport
 */

import { PassThrough } from 'node:stream';
import {
  Client,
  EventDispatcher,
  type HttpInstance,
  type RawCardActionEvent,
  type RawMessageEvent,
  WSClient,
} from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import type {
  CardAction,
  CardJson,
  ChatStats,
  FeishuMessage,
  FeishuTransport,
  InboundAttachment,
  SentCard,
} from './feishu/types.js';

/**
 * The HTTP instance the SDK's `Client` and `WSClient` use for every Feishu
 * call (REST + WS endpoint discovery).
 *
 * Two things the SDK's own `defaultHttpInstance` does that a bare axios
 * instance does not:
 * - its response interceptor unwraps `resp.data` (the JSON body) so
 *   `request()` resolves to `{code, data, msg}` — the SDK's callers
 *   destructure those fields directly (WS endpoint discovery fails with
 *   `code: undefined` otherwise); and
 * - the proxy: the default instance honors `http_proxy`/`https_proxy` env
 *   vars, which breaks both flows behind a proxy — follow-redirects dies
 *   with `Protocol "https:" not supported. Expected "http:"` (user report).
 *   Feishu is reached directly, so the proxy is disabled here.
 *
 * Both are mirrored below so this instance is a drop-in replacement.
 */
export const FEISHU_HTTP = axios.create({ proxy: false });
FEISHU_HTTP.interceptors.request.use(
  (req) => {
    if (req.headers && !req.headers['User-Agent']) req.headers['User-Agent'] = 'dsh-feishu';
    return req;
  },
  undefined,
  { synchronous: true },
);
FEISHU_HTTP.interceptors.response.use((resp) => {
  if ((resp.config as unknown as { $return_headers?: boolean }).$return_headers) {
    return { data: resp.data, headers: resp.headers };
  }
  return resp.data;
});

/** Minimal logger surface the transport needs. */
export interface TransportLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Debug tracing (printed only when FEISHU_DEBUG=1). */
  debug(message: string): void;
}

/**
 * The SDK's `Client.request` payload type, plus the `$return_headers` flag
 * the SDK's own generated download code passes (its public types omit it).
 */
type SdkRequestPayload = Parameters<Client['request']>[0] & { $return_headers?: boolean };

/** Credentials for the Feishu app. */
export interface LarkCredentials {
  readonly appId: string;
  readonly appSecret: string;
}

/** Options for {@link LarkTransport}. */
export interface LarkTransportOptions {
  readonly credentials: LarkCredentials;
  readonly logger?: TransportLogger;
}

/** A failed Feishu API call (non-zero `code`). */
export class FeishuApiError extends Error {
  readonly operation: string;
  readonly code: number;

  constructor(operation: string, code: number, message: string) {
    super(`feishu ${operation} failed: ${message} (code ${code})`);
    this.name = 'FeishuApiError';
    this.operation = operation;
    this.code = code;
  }
}

/** Strip `<at …>name</at>` mention placeholders from Feishu text content. */
const MENTION_PATTERN = /<at[^>]*>.*?<\/at>/g;

/** Message types the surface understands; everything else is ignored. */
const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'image', 'file']);

/** Parse an image/file message's content JSON into its attachment, or
 *  `undefined` when the content is malformed. */
function parseAttachment(content: string, messageType: string): InboundAttachment | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, string>;
    if (messageType === 'image') {
      const key = parsed.image_key;
      if (typeof key === 'string' && key !== '') return { kind: 'image', key };
      return undefined;
    }
    const key = parsed.file_key;
    if (typeof key === 'string' && key !== '') {
      const name = parsed.file_name;
      return { kind: 'file', key, ...(typeof name === 'string' && name !== '' ? { name } : {}) };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a raw Feishu `im.message.receive_v1` payload into a surface
 * message, or `undefined` when the message is not a supported type.
 * Pure function — unit-testable without any SDK connection.
 * @param data - the raw event payload.
 * @returns the normalized message, or `undefined` to ignore.
 */
export function normalizeMessageEvent(data: RawMessageEvent): FeishuMessage | undefined {
  const message = data.message;
  if (!SUPPORTED_MESSAGE_TYPES.has(message.message_type)) return undefined;
  const senderOpenId = data.sender?.sender_id?.open_id ?? '';
  let text = '';
  let attachment: InboundAttachment | undefined;
  if (message.message_type === 'text') {
    try {
      const parsed = JSON.parse(message.content) as { text?: string };
      text = parsed.text ?? '';
    } catch {
      return undefined;
    }
    text = text.replace(MENTION_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  } else {
    attachment = parseAttachment(message.content, message.message_type);
    // A malformed image/file content (no key) is not a usable message.
    if (attachment === undefined) return undefined;
  }
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    senderOpenId,
    text,
    attachments: attachment === undefined ? [] : [attachment],
    mentions: (message.mentions ?? [])
      .map((mention) => mention.id?.open_id)
      .filter((id): id is string => id !== undefined && id !== ''),
    createdAt: Number(message.create_time) || Date.now(),
  };
}

/**
 * Normalize a raw `card.action.trigger` payload into a surface action, or
 * `undefined` when no actionable payload is present. Message/chat ids may be
 * nested under `context` (current v2 shape) or at the root (fallback).
 * Pure function — unit-testable without any SDK connection.
 * @param data - the raw card callback payload.
 * @returns the normalized action, or `undefined` to ignore.
 */
export function normalizeCardAction(data: RawCardActionEvent): CardAction | undefined {
  const messageId = data.context?.open_message_id ?? data.open_message_id;
  const chatId = data.context?.open_chat_id ?? data.open_chat_id;
  const operatorOpenId = data.operator?.open_id ?? '';
  const value = data.action?.value;
  if (
    messageId === undefined ||
    chatId === undefined ||
    typeof value !== 'object' ||
    value === null
  ) {
    return undefined;
  }
  const rawForm = (data.action as { form_value?: unknown } | undefined)?.form_value;
  const formValue =
    typeof rawForm === 'object' && rawForm !== null
      ? (rawForm as Record<string, string>)
      : undefined;
  const option = data.action?.option;
  return {
    messageId,
    chatId,
    operatorOpenId,
    value: value as Record<string, string>,
    ...(option !== undefined ? { option } : {}),
    ...(formValue !== undefined ? { formValue } : {}),
  };
}

/**
 * The Feishu transport: long-connection receive + API send/update.
 */
export class LarkTransport implements FeishuTransport {
  private readonly client: Client;
  private readonly ws: WSClient;
  private readonly dispatcher = new EventDispatcher({});
  private handler: ((message: FeishuMessage) => void) | undefined;
  private actionHandler: ((action: CardAction) => void) | undefined;
  private readonly logger: TransportLogger | undefined;
  private botOpenIdValue: string | undefined;
  private readonly statsCache = new Map<string, { stats: ChatStats; at: number }>();
  /** Live long-connection state, maintained by the WSClient callbacks. */
  private connectionStateValue: 'ready' | 'reconnecting' | 'error' = 'reconnecting';

  constructor(options: LarkTransportOptions) {
    const { appId, appSecret } = options.credentials;
    this.logger = options.logger;
    // axios's overloaded `request` doesn't satisfy the SDK's structural
    // `HttpInstance` statically (the SDK's own default is an AxiosInstance,
    // so the cast is safe at runtime).
    const httpInstance = FEISHU_HTTP as unknown as HttpInstance;
    this.client = new Client({ appId, appSecret, httpInstance });
    this.ws = new WSClient({
      appId,
      appSecret,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      httpInstance,
      onReady: () => {
        this.connectionStateValue = 'ready';
        this.logger?.info('feishu long connection ready');
        this.logger?.debug('transport ws state -> ready');
      },
      onError: (error) => {
        this.connectionStateValue = 'error';
        this.logger?.error(`feishu long connection failed: ${error.message}`);
        this.logger?.debug(`transport ws state -> error: ${error.message}`);
      },
      onReconnecting: () => {
        this.connectionStateValue = 'reconnecting';
        this.logger?.warn('feishu long connection reconnecting');
        this.logger?.debug('transport ws state -> reconnecting');
      },
      onReconnected: () => {
        this.connectionStateValue = 'ready';
        this.logger?.info('feishu long connection reconnected');
        this.logger?.debug('transport ws state -> ready (reconnected)');
      },
    });
  }

  /** The live long-connection state for the `/feishu-status` diagnostic. */
  connectionState(): 'ready' | 'reconnecting' | 'error' {
    return this.connectionStateValue;
  }

  /** Connect the long connection and begin delivering messages. */
  async start(): Promise<void> {
    this.dispatcher.register({
      'im.message.receive_v1': (data) => {
        const message = normalizeMessageEvent(data as RawMessageEvent);
        if (message !== undefined) this.handler?.(message);
        return undefined;
      },
      'card.action.trigger': (data: RawCardActionEvent) => {
        const action = normalizeCardAction(data);
        if (action !== undefined) this.actionHandler?.(action);
        // ACK with no UI update. Returning undefined produces a code-only
        // response the Feishu client rejects as an invalid ACK (botmux
        // lesson: the client can then re-render the card to a stale state —
        // exactly the "card reverted to working after opening details" bug).
        return {};
      },
    });
    await this.ws.start({ eventDispatcher: this.dispatcher });
    // Resolve the bot's own open id once the connection is up; the group
    // mention gate needs it to tell "the bot was mentioned" apart from
    // "someone else was mentioned".
    void this.resolveBotOpenId().catch((error: unknown) => {
      this.logger?.warn(`bot open id resolution failed: ${String(error)}`);
    });
  }

  /**
   * Create a group chat via `im.v1.chat.create`; the given members are
   * invited at creation time and the FIRST member (the requesting user from
   * `/group`) becomes the group owner, so the bot is not the owner.
   * @param name - the group name.
   * @param memberOpenIds - members to invite (open ids).
   * @returns the new chat id.
   */
  async createGroup(name: string, memberOpenIds: readonly string[]): Promise<{ chatId: string }> {
    const response = await this.client.im.v1.chat.create({
      data: {
        name,
        user_id_list: [...memberOpenIds],
        ...(memberOpenIds.length > 0 ? { owner_id: memberOpenIds[0] } : {}),
      },
      params: { user_id_type: 'open_id' },
    });
    this.assertOk(response, 'im.v1.chat.create');
    const chatId = response.data?.chat_id;
    if (chatId === undefined) {
      throw new FeishuApiError('im.v1.chat.create', -1, 'response carried no chat_id');
    }
    return { chatId };
  }

  /** Fetch and cache the bot's own open id (`bot/v3/info`). */
  private async resolveBotOpenId(): Promise<void> {
    const response = await this.client.request<{
      code?: number;
      msg?: string;
      data?: { open_id?: string };
    }>({ method: 'GET', url: '/open-apis/bot/v3/info' });
    const code = response?.code ?? -1;
    if (code !== 0) {
      throw new FeishuApiError('bot.v3.info', code, response?.msg ?? 'unknown error');
    }
    const openId = response.data?.open_id;
    if (openId !== undefined && openId !== '') this.botOpenIdValue = openId;
  }

  /** The bot's own open id, or `undefined` until resolved. */
  getBotOpenId(): string | undefined {
    return this.botOpenIdValue;
  }

  /**
   * Membership counts for a chat, cached for 5 minutes (`im.v1.chat.get`).
   * @param chatId - the chat id.
   * @returns counts, or `undefined` when the API is unavailable.
   */
  async chatStats(chatId: string): Promise<ChatStats | undefined> {
    const cached = this.statsCache.get(chatId);
    if (cached !== undefined && Date.now() - cached.at < 5 * 60_000) return cached.stats;
    try {
      const response = await this.client.im.v1.chat.get({ path: { chat_id: chatId } });
      const code = response.code ?? -1;
      if (code !== 0) return undefined;
      const userCount = Number(response.data?.user_count);
      const botCount = Number(response.data?.bot_count);
      if (!Number.isFinite(userCount) || !Number.isFinite(botCount)) return undefined;
      const stats: ChatStats = { userCount, botCount };
      this.statsCache.set(chatId, { stats, at: Date.now() });
      return stats;
    } catch {
      return undefined;
    }
  }

  /** Disconnect the long connection. */
  async stop(): Promise<void> {
    this.ws.close();
  }

  /** Register the single inbound-message handler (last registration wins). */
  onMessage(handler: (message: FeishuMessage) => void): void {
    this.handler = handler;
  }

  /** Register the single card-button handler (last registration wins). */
  onCardAction(handler: (action: CardAction) => void): void {
    this.actionHandler = handler;
  }

  /** Send a plain text message to a chat. */
  async sendText(chatId: string, text: string): Promise<void> {
    this.logger?.debug(`transport sendText -> ${chatId}: ${text.slice(0, 80)}`);
    await this.createMessage(chatId, 'text', JSON.stringify({ text }));
  }

  /** Upload a file and deliver it as a file message (`/export`). */
  async sendFile(chatId: string, fileName: string, content: string): Promise<void> {
    this.logger?.debug(`transport sendFile -> ${chatId}: ${fileName} (${content.length} chars)`);
    const uploaded = await this.client.im.v1.file.create({
      data: { file_type: 'stream', file_name: fileName, file: Buffer.from(content, 'utf8') },
    });
    // im.v1.file.create returns the data directly (`{file_key} | null`).
    const fileKey = uploaded === null ? undefined : uploaded.file_key;
    if (fileKey === undefined) {
      throw new FeishuApiError('im.v1.file.create', -1, 'response carried no file_key');
    }
    await this.createMessage(chatId, 'file', JSON.stringify({ file_key: fileKey }));
  }

  /** Add an emoji reaction to a message (two-stage ack). */
  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    this.logger?.debug(`transport addReaction ${messageId}: ${emojiType}`);
    const response = await this.client.im.v1.messageReaction.create({
      data: { reaction_type: { emoji_type: emojiType } },
      path: { message_id: messageId },
    });
    this.assertOk(response, 'im.v1.message.reaction.create');
    return response.data?.reaction_id;
  }

  /** Remove a reaction previously added by this bot. */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.logger?.debug(`transport removeReaction ${messageId}: ${reactionId}`);
    const response = await this.client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    this.assertOk(response, 'im.v1.message.reaction.delete');
  }

  /** Send an interactive card; resolves with the created message id. */
  async sendCard(chatId: string, card: CardJson): Promise<SentCard> {
    const response = await this.createMessage(chatId, 'interactive', JSON.stringify(card));
    const messageId = response.data?.message_id;
    if (messageId === undefined) {
      throw new FeishuApiError('im.v1.message.create', -1, 'response carried no message_id');
    }
    this.logger?.debug(
      `transport sendCard -> ${chatId}: ${messageId} (${card.header?.title?.content ?? '(no title)'})`,
    );
    return { messageId };
  }

  /** Update an already-sent card in place (silent: no unread notification). */
  async updateCard(messageId: string, card: CardJson): Promise<void> {
    this.logger?.debug(
      `transport updateCard ${messageId}: ${card.header?.title?.content ?? '(no title)'}`,
    );
    const response = await this.client.im.v1.message.patch({
      data: { content: JSON.stringify(card) },
      path: { message_id: messageId },
    });
    this.assertOk(response, 'im.v1.message.patch');
  }

  /** Recall (delete) a previously sent message; never throws (fire-and-forget). */
  async deleteMessage(messageId: string): Promise<void> {
    this.logger?.debug(`transport deleteMessage ${messageId}`);
    try {
      await this.client.im.v1.message.delete({ path: { message_id: messageId } });
    } catch (error: unknown) {
      this.logger?.warn(`message recall failed for ${messageId}: ${String(error)}`);
    }
  }

  /**
   * Download an inbound image message's bytes (`im.v1.image.get`). The image
   * resource endpoint returns the raw raster bytes (not JSON); the declared
   * media type is derived from the message event. Throws on unknown/stale
   * keys or a missing `im:resource` scope.
   */
  /**
   * Download an inbound image message's bytes via the message-resource
   * endpoint (`/messages/{message_id}/resources/{image_key}?type=image`).
   * User-sent images are only reachable here — `im.v1.image.get` can only
   * fetch bot-uploaded images. Routed through the raw client request (not
   * the generated `messageResource.get`, which sends `{}` as a GET body and
   * trips gateway 411s — botmux lesson).
   * @param messageId - the owning message's id.
   * @param key - the normalized `image_key`.
   */
  async downloadImage(
    messageId: string,
    key: string,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    this.logger?.debug(`transport downloadImage ${key} (message ${messageId})`);
    const bytes = await this.downloadMessageResource(messageId, key);
    // The resource endpoint does not echo the media type; default to png —
    // saveImage re-detects the real format from the bytes.
    return { data: bytes, mediaType: 'image/png' };
  }

  /**
   * Stream an inbound file message's body via the message-resource endpoint
   * (`/messages/{message_id}/resources/{file_key}?type=file`).
   * User-sent files are only reachable here — `im.v1.file.get` can only
   * fetch bot-uploaded files. Streamed (not buffered) because the resource
   * API serves files up to ~100 MB — the caller pipes the body straight to
   * disk (botmux lesson). The leading bytes are returned separately for type
   * sniffing and pushed back into the stream, so the caller can sniff the
   * extension and still consume the full body.
   * @param messageId - the owning message's id.
   * @param key - the normalized `file_key`.
   */
  async downloadFile(
    messageId: string,
    key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; head: Uint8Array }> {
    this.logger?.debug(`transport downloadFile ${key} (message ${messageId})`);
    const response = await this.client.request<{
      data?: NodeJS.ReadableStream;
      headers?: Record<string, string>;
    }>({
      method: 'GET',
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}`,
      params: { type: 'file' },
      responseType: 'stream',
      $return_headers: true,
    } as SdkRequestPayload);
    const stream = response?.data;
    if (stream === undefined) {
      throw new FeishuApiError(
        'im.v1.messageResource.get (file)',
        -1,
        'response carried no resource bytes',
      );
    }
    const contentType = response?.headers?.['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      // A JSON error envelope (e.g. 403 on a withdrawn message) — collect
      // the small body and surface the code instead of persisting it.
      const text = await collectStream(stream);
      const envelope = JSON.parse(text) as { code?: number; msg?: string };
      const code = envelope?.code ?? -1;
      if (code !== 0) {
        throw new FeishuApiError(
          'im.v1.messageResource.get (file)',
          code,
          envelope?.msg ?? 'unknown error',
        );
      }
    }
    // Peek the leading bytes for extension sniffing and relay the full body
    // through a PassThrough (readHead relays; unshift cannot re-arm an ended
    // source stream, and `read(size)` does not truncate Readable.from
    // chunks). The caller's downstream pipe reads the complete body.
    const { stream: relay, head } = await relayHead(stream, 16);
    return { stream: relay, head };
  }

  /**
   * GET one image message resource (`im.v1.messageResource.get`) as bytes.
   *
   * `$return_headers` makes the SDK surface the raw body plus its headers
   * (the SDK's own generated download code does the same). The response
   * interceptor unwraps `resp.data`, so with `responseType: 'arraybuffer'`
   * the body IS the bytes — there is no `{file: ...}` envelope to read.
   * A JSON error envelope (e.g. 403 on a withdrawn message) is detected
   * via the content type and surfaced as a {@link FeishuApiError}, never
   * injected as image bytes.
   */
  private async downloadMessageResource(messageId: string, key: string): Promise<Uint8Array> {
    const response = await this.client.request<{
      data?: Uint8Array | ArrayBuffer;
      headers?: Record<string, string>;
    }>({
      method: 'GET',
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}`,
      params: { type: 'image' },
      responseType: 'arraybuffer',
      $return_headers: true,
    } as SdkRequestPayload);
    const bytes = response?.data;
    if (bytes === undefined || bytes.byteLength === 0) {
      throw new FeishuApiError(
        'im.v1.messageResource.get (image)',
        -1,
        'response carried no resource bytes',
      );
    }
    const contentType = response?.headers?.['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      const envelope = JSON.parse(new TextDecoder().decode(bytes)) as {
        code?: number;
        msg?: string;
      };
      const code = envelope?.code ?? -1;
      if (code !== 0) {
        throw new FeishuApiError(
          'im.v1.messageResource.get (image)',
          code,
          envelope?.msg ?? 'unknown error',
        );
      }
    }
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  /** Create a message in a chat; assert the API succeeded. */
  private async createMessage(
    chatId: string,
    msgType: string,
    content: string,
  ): Promise<Awaited<ReturnType<Client['im']['v1']['message']['create']>>> {
    const response = await this.client.im.v1.message.create({
      data: { receive_id: chatId, msg_type: msgType, content },
      params: { receive_id_type: 'chat_id' },
    });
    this.assertOk(response, 'im.v1.message.create');
    return response;
  }

  private assertOk(
    response: { code?: number | undefined; msg?: string | undefined },
    operation: string,
  ): void {
    const code = response.code ?? -1;
    if (code !== 0) {
      throw new FeishuApiError(operation, code, response.msg ?? 'unknown error');
    }
  }
}

/** Create a transport for the given credentials. */
export function createLarkTransport(
  credentials: LarkCredentials,
  logger?: TransportLogger,
): FeishuTransport {
  return new LarkTransport({ credentials, ...(logger === undefined ? {} : { logger }) });
}

/**
 * Peek the first `size` bytes of a stream and relay the FULL body through a
 * `PassThrough`, so the caller can sniff the head and still consume every
 * byte downstream.
 *
 * Why not unshift? A source that ends right after one chunk (`Readable.from`
 * with a single element, as tests seed) becomes `readableEnded` once drained,
 * and `unshift` on an ended stream silently drops the data. A relay keeps the
 * head as a copy while the pass-through delivers the body independently of
 * the source's lifecycle.
 *
 * Resolves with fewer than `size` head bytes if the source ends first.
 */
async function relayHead(
  stream: NodeJS.ReadableStream,
  size: number,
): Promise<{ stream: PassThrough; head: Uint8Array }> {
  const relay = new PassThrough();
  const headChunks: Buffer[] = [];
  let headTotal = 0;
  // Forward every chunk into the relay while stashing the leading bytes.
  stream.on('data', (chunk: Buffer) => {
    if (headTotal < size) {
      const want = size - headTotal;
      headChunks.push(chunk.length > want ? chunk.subarray(0, want) : chunk);
      headTotal += Math.min(chunk.length, want);
    }
    relay.write(chunk);
  });
  stream.on('end', () => relay.end());
  stream.on('error', (error: Error) => relay.destroy(error));
  // Wait until the head is filled or the source is done.
  await new Promise<void>((resolve) => {
    if (headTotal >= size) return resolve();
    stream.once('end', resolve);
    stream.once('error', () => resolve());
  });
  return { stream: relay, head: new Uint8Array(Buffer.concat(headChunks)) };
}

/** Concatenate byte chunks into one Uint8Array. */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Collect an entire stream's bytes as a UTF-8 string (error envelopes only). */
async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(concatBytes(chunks));
}
