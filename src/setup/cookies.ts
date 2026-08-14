/**
 * RFC 6265 cookie jar for the Feishu Open Platform Web session. The console
 * automation authenticates by QR login and then drives the console's internal
 * `/developers/v1/*` APIs with the resulting cookies, so the jar must follow
 * redirects manually (Node `fetch` `redirect: 'manual'`) and persist the
 * `Set-Cookie` responses along the way.
 *
 * The flow mirrors botmux's open-platform automation
 * (`_tmp/botmux/src/setup/open-platform-automation.ts`); the cookie semantics
 * here are standard RFC 6265 behavior, reimplemented compactly.
 */

/** A stored cookie, as serialized to the session file. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Host-only cookies match exactly one host; domain cookies match subdomains. */
  hostOnly: boolean;
  /** Milliseconds epoch; session cookies have none. */
  expiresAt?: number;
  sameSite?: string;
}

/** Split a raw `Set-Cookie` header into individual cookie headers. */
export function splitSetCookieHeader(header: string | null): string[] {
  if (!header) return [];
  const parts: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < header.length; i += 1) {
    const slice = header.slice(Math.max(0, i - 8), i + 1).toLowerCase();
    if (slice.endsWith('expires=')) inExpires = true;
    if (inExpires && header[i] === ';') inExpires = false;
    if (!inExpires && header[i] === ',') {
      parts.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(header.slice(start).trim());
  return parts.filter(Boolean);
}

/** Parse one `Set-Cookie` header value into a stored cookie. */
export function parseSetCookie(responseUrl: string, header: string): StoredCookie | null {
  const url = new URL(responseUrl);
  const parts = header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const cookie: StoredCookie = {
    name: first.slice(0, eq),
    value: first.slice(eq + 1),
    domain: url.hostname,
    path: '/',
    secure: false,
    httpOnly: false,
    hostOnly: true,
  };
  for (const part of parts) {
    const partEq = part.indexOf('=');
    const key = (partEq >= 0 ? part.slice(0, partEq) : part).trim().toLowerCase();
    const value = partEq >= 0 ? part.slice(partEq + 1).trim() : '';
    if (key === 'domain' && value) {
      cookie.domain = value.toLowerCase();
      cookie.hostOnly = false;
    } else if (key === 'path' && value) {
      cookie.path = value;
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    } else if (key === 'expires' && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) cookie.expiresAt = parsed;
    } else if (key === 'max-age' && value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
    } else if (key === 'samesite' && value) {
      cookie.sameSite = value;
    }
  }
  return cookie;
}

/** Drop expired cookies; session cookies (no expiry) survive. */
export function pruneExpiredCookies(cookies: readonly StoredCookie[]): StoredCookie[] {
  const now = Date.now();
  return cookies.filter((cookie) => cookie.expiresAt === undefined || cookie.expiresAt > now);
}

function domainMatches(hostname: string, cookie: StoredCookie): boolean {
  const host = hostname.toLowerCase();
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  if (cookie.hostOnly) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** Build the `Cookie` header for a request URL from the jar. */
export function getCookieHeader(cookies: readonly StoredCookie[], requestUrl: string): string {
  const url = new URL(requestUrl);
  return pruneExpiredCookies(cookies)
    .filter((cookie) => {
      if (cookie.secure && url.protocol !== 'https:') return false;
      if (!domainMatches(url.hostname, cookie)) return false;
      return pathMatches(url.pathname || '/', cookie.path || '/');
    })
    .sort((a, b) => b.path.length - a.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/** Result of a jar-managed fetch: the final response and its URL. */
export interface JarFetchResult {
  readonly response: Response;
  readonly finalUrl: string;
}

const DEFAULT_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * A cookie jar that follows redirects manually so every `Set-Cookie` on the
 * way is captured, and sends the accumulated cookies on each hop.
 */
export class MutableCookieJar {
  private cookies: StoredCookie[];

  constructor(cookies: readonly StoredCookie[] = []) {
    this.cookies = pruneExpiredCookies(cookies);
  }

  /** Snapshot of the jar for persistence. */
  toJSON(): StoredCookie[] {
    this.cookies = pruneExpiredCookies(this.cookies);
    return this.cookies.map((cookie) => ({ ...cookie }));
  }

  /** GET a URL and return its final text. */
  async fetchText(fetcher: typeof fetch, url: string): Promise<string> {
    const result = await this.fetchRaw(fetcher, url, { method: 'GET' });
    return await result.response.text();
  }

  /** GET a URL and return its final text plus the final URL (post-redirects). */
  async fetchTextWithUrl(
    fetcher: typeof fetch,
    url: string,
  ): Promise<{ text: string; finalUrl: string }> {
    const result = await this.fetchRaw(fetcher, url, { method: 'GET' });
    return { text: await result.response.text(), finalUrl: result.finalUrl };
  }

  /**
   * Fetch one URL, following redirects manually while accumulating cookies.
   * @param fetcher - injectable fetch (defaults are passed by the caller).
   * @param url - request URL.
   * @param init - request options; `redirect` is forced to `manual`.
   * @param maxHops - redirect cap (default 10).
   */
  async fetchRaw(
    fetcher: typeof fetch,
    url: string,
    init: RequestInit = {},
    maxHops = 10,
  ): Promise<JarFetchResult> {
    let current = url;
    let referer: string | undefined;
    for (let hop = 0; hop <= maxHops; hop += 1) {
      const headers = new Headers(init.headers);
      const cookieHeader = getCookieHeader(this.cookies, current);
      if (cookieHeader) headers.set('cookie', cookieHeader);
      headers.set('user-agent', headers.get('user-agent') ?? DEFAULT_BROWSER_USER_AGENT);
      if (referer && !headers.has('referer')) headers.set('referer', referer);

      const response = await fetcher(current, { ...init, headers, redirect: 'manual' });
      this.loadFromResponse(current, response.headers);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { response, finalUrl: current };
        referer = current;
        current = new URL(location, current).toString();
        continue;
      }
      return { response, finalUrl: current };
    }
    throw new Error('Too many redirects while accessing the Feishu Open Platform');
  }

  private loadFromResponse(responseUrl: string, headers: Headers): void {
    const rawSetCookies =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : splitSetCookieHeader(headers.get('set-cookie'));
    for (const raw of rawSetCookies) {
      const cookie = parseSetCookie(responseUrl, raw);
      if (!cookie) continue;
      const idx = this.cookies.findIndex(
        (item) =>
          item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path,
      );
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) {
        if (idx >= 0) this.cookies.splice(idx, 1);
        continue;
      }
      if (idx >= 0) this.cookies[idx] = cookie;
      else this.cookies.push(cookie);
    }
    this.cookies = pruneExpiredCookies(this.cookies);
  }
}
