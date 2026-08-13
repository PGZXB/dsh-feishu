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

/** Durable mapping file shape. */
interface PersistedMap {
  version: 1;
  entries: Record<string, string>;
}

/** Mints a fresh session id for a chat (injectable for deterministic tests). */
export type SessionIdMinter = () => string;

/**
 * @param file - path of the durable JSON mapping file.
 * @param mint - session-id minter; defaults to `feishu-<epoch-ms>`.
 */
export class SessionMap {
  private readonly byChat = new Map<string, string>();
  private readonly bySession = new Map<string, string>();
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly mint: SessionIdMinter = () => `feishu-${Date.now()}`,
  ) {}

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
      if (parsed.version !== 1 || typeof parsed.entries !== 'object') return;
      for (const [chatId, sessionId] of Object.entries(parsed.entries)) {
        this.set(chatId, sessionId);
      }
    } catch {
      // Missing file (first run) or unreadable content: start empty.
    }
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
    this.byChat.set(chatId, sessionId);
    this.bySession.set(sessionId, chatId);
  }

  /**
   * Persist the mapping atomically: write a temp file beside the target,
   * then rename over it.
   */
  persist(): void {
    const data: PersistedMap = { version: 1, entries: Object.fromEntries(this.byChat) };
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
