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
  /**
   * Open ids of mentioned members (the bot's own open id included when it is
   * mentioned). `@all` entries carry no open id and are excluded. Empty for
   * p2p messages and for group messages without mentions.
   */
  readonly mentions: readonly string[];
  /** Unix epoch milliseconds from the Feishu `create_time` string. */
  readonly createdAt: number;
}

/** Result of sending a card message. */
export interface SentCard {
  /** The created message id, used for later in-place updates. */
  readonly messageId: string;
}

/**
 * Feishu interactive card JSON — the v1 layout the surface emits.
 *
 * The surface deliberately uses the legacy (v1) layout — root-level
 * `elements`, no `schema` field — because that is the only layout that
 * supports interactive `action` buttons (schema-2.0 cards reject the
 * `action` tag with ErrCode 200861; botmux uses the same v1 layout for its
 * control cards).
 */
export interface CardJson {
  readonly schema?: '2.0';
  readonly config?: { readonly wide_screen_mode?: boolean };
  readonly header?: {
    readonly title: { readonly tag: 'plain_text'; readonly content: string };
    /** Feishu card header template color. */
    readonly template: string;
  };
  readonly elements: readonly CardElement[];
}

/** One card element the surface emits. */
export type CardElement =
  | { readonly tag: 'markdown'; readonly content: string }
  | { readonly tag: 'hr' }
  | {
      readonly tag: 'action';
      readonly actions: readonly {
        readonly tag: 'button';
        readonly text: { readonly tag: 'plain_text'; readonly content: string };
        readonly type?: 'primary' | 'danger' | 'default';
        /** Surface action payload, echoed back in the card callback. */
        readonly value: Record<string, string>;
      }[];
    };

/**
 * One card button callback normalized for the surface. `value` is the
 * payload stamped on the button that was pressed.
 */
export interface CardAction {
  readonly messageId: string;
  readonly chatId: string;
  readonly operatorOpenId: string;
  readonly value: Record<string, string>;
}

/** Group membership counts, used for the 1-person-1-bot solo relaxation. */
export interface ChatStats {
  readonly userCount: number;
  readonly botCount: number;
}

/** The transport seam the surface renders into. */
export interface FeishuTransport {
  /** Connect the long-lived channel and begin delivering messages. */
  start(): Promise<void>;
  /** Disconnect the channel. */
  stop(): Promise<void>;
  /** Register the single inbound-message handler (last registration wins). */
  onMessage(handler: (message: FeishuMessage) => void): void;
  /** Register the single card-button handler (last registration wins). */
  onCardAction(handler: (action: CardAction) => void): void;
  /** Send a plain text message to a chat. */
  sendText(chatId: string, text: string): Promise<void>;
  /** Send an interactive card; resolves with the created message id. */
  sendCard(chatId: string, card: CardJson): Promise<SentCard>;
  /** Update an already-sent card in place (silent: no unread notification). */
  updateCard(messageId: string, card: CardJson): Promise<void>;
  /**
   * Membership counts for a chat, or `undefined` when unknown/unavailable.
   * Used for the 1-person-1-bot solo relaxation of the group mention gate.
   */
  chatStats(chatId: string): Promise<ChatStats | undefined>;
  /**
   * The bot's own open id, or `undefined` until resolved (fetched lazily at
   * start). Used to detect whether a group message mentions the bot.
   */
  getBotOpenId(): string | undefined;
}
