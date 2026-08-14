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

import {
  Client,
  EventDispatcher,
  type RawCardActionEvent,
  type RawMessageEvent,
  WSClient,
} from '@larksuiteoapi/node-sdk';
import type {
  CardAction,
  CardJson,
  ChatStats,
  FeishuMessage,
  FeishuTransport,
  SentCard,
} from './feishu/types.js';

/** Minimal logger surface the transport needs. */
export interface TransportLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

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
const SUPPORTED_MESSAGE_TYPE = 'text';

/**
 * Normalize a raw Feishu `im.message.receive_v1` payload into a surface
 * message, or `undefined` when the message is not a supported type.
 * Pure function — unit-testable without any SDK connection.
 * @param data - the raw event payload.
 * @returns the normalized message, or `undefined` to ignore.
 */
export function normalizeMessageEvent(data: RawMessageEvent): FeishuMessage | undefined {
  const message = data.message;
  if (message.message_type !== SUPPORTED_MESSAGE_TYPE) return undefined;
  const senderOpenId = data.sender?.sender_id?.open_id ?? '';
  let text = '';
  try {
    const parsed = JSON.parse(message.content) as { text?: string };
    text = parsed.text ?? '';
  } catch {
    return undefined;
  }
  text = text.replace(MENTION_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    senderOpenId,
    text,
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

  constructor(options: LarkTransportOptions) {
    const { appId, appSecret } = options.credentials;
    this.logger = options.logger;
    this.client = new Client({ appId, appSecret });
    this.ws = new WSClient({
      appId,
      appSecret,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      onReady: () => this.logger?.info('feishu long connection ready'),
      onError: (error) => this.logger?.error(`feishu long connection failed: ${error.message}`),
      onReconnecting: () => this.logger?.warn('feishu long connection reconnecting'),
      onReconnected: () => this.logger?.info('feishu long connection reconnected'),
    });
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
   * Create a group chat via `im.v1.chat.create`; the bot is the creator and
   * the given members are invited at creation time.
   * @param name - the group name.
   * @param memberOpenIds - members to invite (open ids).
   * @returns the new chat id.
   */
  async createGroup(name: string, memberOpenIds: readonly string[]): Promise<{ chatId: string }> {
    const response = await this.client.im.v1.chat.create({
      data: { name, user_id_list: [...memberOpenIds] },
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
    await this.createMessage(chatId, 'text', JSON.stringify({ text }));
  }

  /** Upload a file and deliver it as a file message (`/export`). */
  async sendFile(chatId: string, fileName: string, content: string): Promise<void> {
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
    const response = await this.client.im.v1.messageReaction.create({
      data: { reaction_type: { emoji_type: emojiType } },
      path: { message_id: messageId },
    });
    this.assertOk(response, 'im.v1.message.reaction.create');
    return response.data?.reaction_id;
  }

  /** Remove a reaction previously added by this bot. */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
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
    return { messageId };
  }

  /** Update an already-sent card in place (silent: no unread notification). */
  async updateCard(messageId: string, card: CardJson): Promise<void> {
    const response = await this.client.im.v1.message.patch({
      data: { content: JSON.stringify(card) },
      path: { message_id: messageId },
    });
    this.assertOk(response, 'im.v1.message.patch');
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
