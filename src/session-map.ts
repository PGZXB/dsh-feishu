/**
 * Durable chat ↔ session mapping.
 *
 * One Feishu chat maps to one dsh session ("a chat is a session"). The map
 * persists as a small JSON file (atomic temp-file + rename writes) so a
 * daemon restart can resume every chat's session. Reverse lookup routes
 * agent-side events (approvals, questions, streaming) back to the chat.
 *
 * @module @dsh-feishu/dsh-feishu/session-map
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Durable mapping file shape (v2 adds per-chat working directories). */
interface PersistedMap {
  version: 1 | 2;
  entries: Record<string, string>;
  cwds?: Record<string, string>;
}

/** Mints a fresh session id for a chat (injectable for deterministic tests). */
export type SessionIdMinter = () => string;

/**
 * @param file - path of the durable JSON mapping file.
 * @param mint - session-id minter; defaults to `feishu-<epoch-ms>`.
 * @param logger - optional logger for binding changes (debug tracing; printed
 *   only when FEISHU_DEBUG=1).
 */
export class SessionMap {
  private readonly byChat = new Map<string, string>();
  private readonly bySession = new Map<string, string>();
  private readonly cwds = new Map<string, string>();
  private loaded = false;
  private readonly logger:
    | { debug(message: string): void; warn(message: string): void }
    | undefined;

  constructor(
    private readonly file: string,
    private readonly mint: SessionIdMinter = () => `feishu-${Date.now()}`,
    logger?: { debug(message: string): void; warn(message: string): void },
  ) {
    this.logger = logger;
  }

  /**
   * Load persisted mappings. A missing or unreadable file is a no-op; a
   * malformed file logs nothing here (callers surface it) and leaves the map
   * empty.
   */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as PersistedMap;
      if ((parsed.version !== 1 && parsed.version !== 2) || typeof parsed.entries !== 'object') {
        return;
      }
      for (const [chatId, sessionId] of Object.entries(parsed.entries)) {
        this.set(chatId, sessionId);
      }
      if (parsed.version >= 2 && parsed.cwds !== undefined) {
        for (const [chatId, cwd] of Object.entries(parsed.cwds)) {
          this.cwds.set(chatId, cwd);
        }
      }
    } catch {
      // Missing file (first run) or unreadable content: start empty.
    }
    this.logger?.debug(`session map: loaded ${this.byChat.size} chat binding(s) from ${this.file}`);
  }

  /**
   * Ensure a chat has a session id, minting (and durably persisting) one
   * when absent.
   * @param chatId - the Feishu chat id.
   * @returns the session id bound to the chat.
   */
  ensure(chatId: string): string {
    const existing = this.byChat.get(chatId);
    if (existing !== undefined) return existing;
    const sessionId = this.mint();
    this.logger?.debug(`session map: minted ${sessionId} for chat ${chatId}`);
    this.set(chatId, sessionId);
    this.persist();
    return sessionId;
  }

  /**
   * Look up the session id for a chat.
   * @param chatId - the Feishu chat id.
   * @returns the bound session id, or `undefined`.
   */
  get(chatId: string): string | undefined {
    return this.byChat.get(chatId);
  }

  /**
   * Reverse lookup: the chat owning a session.
   * @param sessionId - the dsh session id.
   * @returns the bound chat id, or `undefined`.
   */
  chatFor(sessionId: string): string | undefined {
    return this.bySession.get(sessionId);
  }

  /**
   * Set (and persist) the working directory a chat's sessions are created
   * in. Applies to sessions created after the change.
   * @param chatId - the Feishu chat id.
   * @param cwd - the absolute working directory.
   */
  setCwd(chatId: string, cwd: string): void {
    const previous = this.cwds.get(chatId);
    if (previous !== cwd) {
      this.logger?.debug(`session map: chat ${chatId} cwd ${previous ?? '(none)'} -> ${cwd}`);
    }
    this.cwds.set(chatId, cwd);
    this.persist();
  }

  /**
   * The working directory pinned for a chat, or `undefined` when unset (the
   * deployment default applies).
   * @param chatId - the Feishu chat id.
   */
  cwdFor(chatId: string): string | undefined {
    return this.cwds.get(chatId);
  }

  /**
   * Bind a chat to a session id, replacing any prior binding (both
   * directions are kept consistent).
   * @param chatId - the Feishu chat id.
   * @param sessionId - the dsh session id.
   */
  set(chatId: string, sessionId: string): void {
    const previous = this.byChat.get(chatId);
    if (previous !== undefined && previous !== sessionId) this.bySession.delete(previous);
    const priorChat = this.bySession.get(sessionId);
    if (priorChat !== undefined && priorChat !== chatId) this.byChat.delete(priorChat);
    if (previous !== sessionId) {
      this.logger?.debug(
        `session map: chat ${chatId} ${previous === undefined ? '' : `was ${previous}, `}now ${sessionId}`,
      );
    }
    this.byChat.set(chatId, sessionId);
    this.bySession.set(sessionId, chatId);
  }

  /**
   * Rebinding recovery: bind a chat to a fresh session id, replacing the
   * previous binding (both directions are kept consistent) and persisting.
   * Used when the mapped session became unusable (e.g. an id collision).
   * @param chatId - the Feishu chat id.
   * @returns the fresh session id.
   */
  remint(chatId: string): string {
    const sessionId = this.mint();
    this.logger?.debug(`session map: remint chat ${chatId} -> fresh session ${sessionId}`);
    this.set(chatId, sessionId);
    this.persist();
    return sessionId;
  }

  /**
   * Persist the mapping atomically: write a temp file beside the target,
   * then rename over it.
   */
  persist(): void {
    const data: PersistedMap = {
      version: 2,
      entries: Object.fromEntries(this.byChat),
      cwds: Object.fromEntries(this.cwds),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /** All chat ids in the map. */
  chats(): string[] {
    return [...this.byChat.keys()];
  }

  /** Number of mapped chats. */
  get size(): number {
    return this.byChat.size;
  }
}
