/**
 * Shared types for the Feishu transport seam: the normalized inbound message
 * shape and the transport contract the surface renders into.
 *
 * @module @dsh-feishu/dsh-feishu/feishu-types
 */

/** One inbound Feishu chat message normalized for the surface. */
export interface FeishuMessage {
  /** Feishu message id; the dedup key (stable across platform retries). */
  readonly messageId: string;
  /** The chat the message arrived in (group or p2p chat id). */
  readonly chatId: string;
  /** `p2p` (direct message) or `group` chat. */
  readonly chatType: 'p2p' | 'group';
  /** The sender's app-scoped open id (not portable across apps). */
  readonly senderOpenId: string;
  /** Plain text content, mentions stripped for group chats. */
  readonly text: string;
  /** Unix epoch milliseconds from the Feishu `create_time` string. */
  readonly createdAt: number;
}

/** Result of sending a card message. */
export interface SentCard {
  /** The created message id, used for later in-place updates. */
  readonly messageId: string;
}

/** Feishu interactive card JSON (schema 2.0) — the subset the surface emits. */
export interface CardJson {
  readonly schema: '2.0';
  readonly config?: { readonly wide_screen_mode?: boolean };
  readonly header?: {
    readonly title: { readonly tag: 'plain_text'; readonly content: string };
    /** Feishu card header template color. */
    readonly template: string;
  };
  /**
   * Schema-2.0 cards place elements inside the body block; root-level
   * `elements` is the v1 layout and Feishu rejects it (ErrCode 200621).
   */
  readonly body: {
    readonly direction: 'vertical';
    readonly elements: readonly CardElement[];
  };
}

/** One card element the surface emits. */
export type CardElement =
  | { readonly tag: 'markdown'; readonly content: string }
  | { readonly tag: 'hr' };

/** The transport seam the surface renders into. */
export interface FeishuTransport {
  /** Connect the long-lived channel and begin delivering messages. */
  start(): Promise<void>;
  /** Disconnect the channel. */
  stop(): Promise<void>;
  /** Register the single inbound-message handler (last registration wins). */
  onMessage(handler: (message: FeishuMessage) => void): void;
  /** Send a plain text message to a chat. */
  sendText(chatId: string, text: string): Promise<void>;
  /** Send an interactive card; resolves with the created message id. */
  sendCard(chatId: string, card: CardJson): Promise<SentCard>;
  /** Update an already-sent card in place (silent: no unread notification). */
  updateCard(messageId: string, card: CardJson): Promise<void>;
}
