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

/** A card button action item. */
export interface ButtonAction {
  readonly tag: 'button';
  readonly text: { readonly tag: 'plain_text'; readonly content: string };
  readonly type?: 'primary' | 'danger' | 'default';
  /** Surface action payload, echoed back in the card callback. */
  readonly value: Record<string, string>;
  /**
   * Form-control marker (botmux v1 schema): `form_submit` / `form_reset`
   * buttons live INSIDE a root-level `form` element and their callback
   * carries the form's `form_value`. Omit for plain action buttons.
   */
  readonly action_type?: 'form_submit' | 'form_reset';
  /**
   * Required INSIDE a `form` container (Feishu rejects form buttons without
   * a name: ErrCode 200530 "the interactive element in the form container
   * must have a name" — user-tested). Ignored outside forms.
   */
  readonly name?: string;
}

/** A text-input control inside a root-level `form` (botmux v1 schema). */
export interface InputElement {
  readonly tag: 'input';
  /** Form value key; the submit callback carries `formValue[name]`. */
  readonly name: string;
  readonly default_value?: string;
  readonly placeholder?: { readonly tag: 'plain_text'; readonly content: string };
}

/**
 * A root-level `form` element (botmux v1 schema, verified on device): the
 * form may contain ONLY `input` + `form_submit` buttons — mixing in other
 * elements makes the whole card render empty. Labels stay OUTSIDE the form.
 */
export interface FormElement {
  readonly tag: 'form';
  readonly name: string;
  readonly elements: readonly (InputElement | ButtonAction)[];
}

/**
 * A `select_static` dropdown used AS an action item (inside an `action`
 * container — not a `form`, which Feishu silently drops in this card
 * layout). Choosing an option fires a card callback whose `option` field
 * carries the selected value.
 */
export interface SelectAction {
  readonly tag: 'select_static';
  readonly placeholder: { readonly tag: 'plain_text'; readonly content: string };
  /** The option value preselected on first render (must match an option
   *  `value`; omit to show the placeholder). */
  readonly initial_option?: string;
  readonly options: readonly {
    readonly text: { readonly tag: 'plain_text'; readonly content: string };
    readonly value: string;
  }[];
  /** Surface action payload, echoed back in the card callback. */
  readonly value: Record<string, string>;
}

/** A `div` element: a single lark_md text block inside a card column. */
export interface DivElement {
  readonly tag: 'div';
  readonly text: { readonly tag: 'lark_md'; readonly content: string };
}

/** Elements allowed inside a `column_set` column. */
export type ColumnElement =
  | { readonly tag: 'markdown'; readonly content: string }
  | DivElement
  | ButtonAction
  | { readonly tag: 'img'; readonly img_key: string };

/** One column inside a `column_set` row. */
export interface ColumnContainer {
  readonly tag: 'column';
  readonly width?: 'auto' | 'weighted';
  readonly weight?: number;
  readonly vertical_align?: 'center' | 'top' | 'bottom';
  readonly elements: readonly ColumnElement[];
}

/** One card element the surface emits. */
export type CardElement =
  | { readonly tag: 'markdown'; readonly content: string }
  | { readonly tag: 'hr' }
  | {
      readonly tag: 'action';
      readonly actions: readonly (ButtonAction | SelectAction)[];
    }
  | FormElement
  | {
      readonly tag: 'table';
      /** Max data rows per page; Feishu supports [1, 10], default 5. */
      readonly page_size?: number;
      readonly row_height?: 'low' | 'medium' | 'high';
      readonly header_style?: {
        readonly text_align?: 'left' | 'center' | 'right';
        readonly text_size?: 'normal' | 'notation_small' | 'notation' | 'paragraph';
        readonly background_style?: 'none' | 'grey' | 'blue' | 'green' | 'red' | 'yellow';
        readonly text_color?: 'default' | 'grey' | 'blue' | 'green' | 'red' | 'yellow';
        readonly bold?: boolean;
        readonly lines?: number;
      };
      /** Column definitions; at most 50 columns are rendered. */
      readonly columns: readonly {
        readonly name: string;
        readonly display_name: string;
        readonly width?: 'auto' | 'default' | number;
        readonly data_type?: 'text' | 'lark_md';
      }[];
      /** Data rows; each maps column names to cell content. */
      readonly rows: readonly Record<string, string>[];
    }
  | {
      readonly tag: 'note';
      readonly elements: readonly { readonly tag: 'plain_text'; readonly content: string }[];
    }
  | {
      readonly tag: 'column_set';
      readonly flex_mode?: 'none' | 'flow';
      readonly horizontal_spacing?: 'default' | 'small' | 'large';
      readonly columns: readonly ColumnContainer[];
    }
  | DivElement;

/**
 * One card button callback normalized for the surface. `value` is the
 * payload stamped on the button that was pressed.
 */
export interface CardAction {
  readonly messageId: string;
  readonly chatId: string;
  readonly operatorOpenId: string;
  readonly value: Record<string, string>;
  /** The option selected by a `select_static` dropdown action. */
  readonly option?: string;
  /** Values of form controls (select/input) when the button lives in a form. */
  readonly formValue?: Record<string, string>;
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
  /**
   * Upload `content` as a file message (im.v1.file.create → file_key →
   * im.v1.message.create with msg_type 'file'). Used by /export to deliver
   * the session log as a downloadable file — the Feishu equivalent of the
   * web's browser-download /export.
   */
  sendFile(chatId: string, fileName: string, content: string): Promise<void>;
  /**
   * Add an emoji reaction to a message (two-stage ack: 👀 on receive,
   * swapped to ✅/⚠️ on turn end). Resolves with the reaction id so the
   * surface can remove it later; `undefined` when the platform returns none.
   * Failures are logged by callers — the reaction is never load-bearing.
   */
  addReaction(messageId: string, emojiType: string): Promise<string | undefined>;
  /** Remove a reaction previously added by {@link addReaction}. */
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  /** Send an interactive card; resolves with the created message id. */
  sendCard(chatId: string, card: CardJson): Promise<SentCard>;
  /** Update an already-sent card in place (silent: no unread notification). */
  updateCard(messageId: string, card: CardJson): Promise<void>;
  /** Recall (delete) a previously sent message. Fire-and-forget-safe: never throws. */
  deleteMessage(messageId: string): Promise<void>;
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
  /**
   * Create a group chat with the given name and members (the bot becomes the
   * owner/creator). Resolves with the new chat id.
   */
  createGroup(name: string, memberOpenIds: readonly string[]): Promise<{ chatId: string }>;
  /**
   * Live connection state of the wire, for the `/feishu-status` diagnostic.
   * `undefined` when the transport does not track connection state (the
   * memory transport, test stubs).
   */
  connectionState?(): 'ready' | 'reconnecting' | 'error';
}
