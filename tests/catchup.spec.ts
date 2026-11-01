/**
 * Unit tests for the reconnect catch-up: the replay source for messages that
 * arrived while the long connection was down.
 *
 * The `regression` cases encode field failures: a budget stop that advanced the
 * boundary, a live message hiding the gap before it, a recovery request consumed
 * by an older session, an inclusive-boundary eviction that re-delivered
 * messages, and a malformed page being mistaken for a terminal one.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Catchup, CatchupStore, normalizeApiMessage } from '../src/catchup.js';
import type { HistoryPage, RawHistoryItem } from '../src/feishu/types.js';

const NOW = Date.UTC(2026, 10, 1, 0, 0, 0);
const MINUTE = 60_000;

function item(
  id: string,
  createdAt: number,
  options: {
    sender?: 'user' | 'app';
    type?: string;
    text?: string;
    mentions?: readonly { id?: string; id_type?: string }[];
  } = {},
): RawHistoryItem {
  return {
    message_id: id,
    msg_type: options.type ?? 'text',
    create_time: String(createdAt),
    chat_id: 'oc_test',
    sender: { id: 'ou_user', sender_type: options.sender ?? 'user' },
    body: { content: JSON.stringify({ text: options.text ?? `msg ${id}` }) },
    ...(options.mentions === undefined ? {} : { mentions: options.mentions }),
  };
}

/** A transport serving pages keyed by token (`p<N>`); `undefined` is page 0. */
function pagedTransport(pages: readonly Partial<HistoryPage>[]) {
  const calls: { pageToken?: string }[] = [];
  return {
    calls,
    async listMessages(_chatId: string, range: { pageToken?: string }): Promise<HistoryPage> {
      calls.push({ ...(range.pageToken === undefined ? {} : { pageToken: range.pageToken }) });
      const index = range.pageToken === undefined ? 0 : Number(range.pageToken.replace('p', ''));
      const page = pages[Math.min(index, pages.length - 1)] ?? {};
      return {
        items: page.items ?? [],
        hasMore: page.hasMore,
        pageToken: page.pageToken,
      };
    },
  };
}

function singlePage(items: readonly RawHistoryItem[], overrides: Partial<HistoryPage> = {}) {
  return pagedTransport([{ items, hasMore: false, ...overrides }]);
}

function newStore(options?: { seenCap?: number }) {
  return new CatchupStore(
    join(mkdtempSync(join(tmpdir(), 'catchup-')), 'cursor.json'),
    undefined,
    options,
  );
}

function seed(store: CatchupStore, chatId: string, through: number) {
  store.apply(chatId, { scannedThrough: through, seen: new Map() });
}

describe('catch-up scan semantics', () => {
  it('initialises the boundary on first sight instead of replaying history', async () => {
    const store = newStore();
    const transport = singlePage([item('om_old', NOW - 60 * MINUTE)]);
    const delivered: string[] = [];
    const catchup = new Catchup({
      transport,
      store,
      deliver: (m) => {
        delivered.push(m.messageId);
      },
      now: () => NOW,
    });
    expect(await catchup.run(['oc_test'])).toBe(0);
    expect(delivered).toEqual([]);
    expect(store.scannedThrough('oc_test')).toBe(NOW);
    expect(transport.calls).toHaveLength(0);
  });

  it('replays only user text and advances only after a complete scan', async () => {
    const store = newStore();
    const boundary = NOW - 10 * MINUTE;
    seed(store, 'oc_test', boundary);
    const transport = singlePage([
      item('om_before', boundary - 5000),
      item('om_text', boundary + MINUTE, { text: 'missed one' }),
      item('om_bot', boundary + 2 * MINUTE, { sender: 'app' }),
      item('om_file', boundary + 3 * MINUTE, { type: 'file' }),
      item('om_after', boundary + 4 * MINUTE, { text: 'missed two' }),
    ]);
    const delivered: string[] = [];
    const catchup = new Catchup({
      transport,
      store,
      deliver: (m) => {
        delivered.push(m.messageId);
      },
      now: () => NOW,
    });
    expect(await catchup.run(['oc_test'])).toBe(2);
    expect(delivered).toEqual(['om_text', 'om_after']);
    expect(store.scannedThrough('oc_test')).toBe(NOW);
    expect(store.session('oc_test')).toBeUndefined();
  });

  it('regression: a budget stop does not advance the boundary', async () => {
    const store = newStore();
    const boundary = NOW - 10 * MINUTE;
    seed(store, 'oc_test', boundary);
    const items = Array.from({ length: 5 }, (_, i) => item(`om_${i}`, boundary + (i + 1) * MINUTE));
    const catchup = new Catchup({
      transport: singlePage(items),
      store,
      deliver: () => {},
      maxMessages: 2,
      now: () => NOW,
    });
    try {
      expect(await catchup.run(['oc_test'])).toBe(2);
      expect(store.scannedThrough('oc_test')).toBe(boundary);
      expect(store.session('oc_test')).toBeDefined();
    } finally {
      catchup.dispose();
    }
  });

  it('regression: a backlog drains automatically and converges', async () => {
    const store = newStore();
    const boundary = NOW - 10 * MINUTE;
    seed(store, 'oc_test', boundary);
    const items = Array.from({ length: 60 }, (_, i) =>
      item(`om_${i}`, boundary + 5 * MINUTE, { text: `t${i}` }),
    );
    const delivered: string[] = [];
    const catchup = new Catchup({
      transport: singlePage(items),
      store,
      deliver: (m) => {
        delivered.push(m.messageId);
      },
      maxMessages: 10,
      followUpDelayMs: 5,
      now: () => NOW,
    });
    try {
      await catchup.run(['oc_test']);
      const deadline = Date.now() + 3000;
      while (store.session('oc_test') !== undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(delivered).toHaveLength(60);
      expect(new Set(delivered).size).toBe(60);
      expect(store.session('oc_test')).toBeUndefined();
    } finally {
      catchup.dispose();
    }
  });

  it('clamps a gap longer than the window', async () => {
    const store = newStore();
    seed(store, 'oc_test', NOW - 30 * 24 * 60 * MINUTE);
    const transport = singlePage([]);
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const catchup = new Catchup({
      transport,
      store,
      deliver: () => {},
      logger,
      windowMs: 6 * 60 * MINUTE,
      now: () => NOW,
    });
    await catchup.run(['oc_test']);
    const call = transport.calls[0] as unknown as { startTimeSec?: number };
    expect(call).toBeDefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('regression: pages full of non-user messages still reach the text behind them', async () => {
    const store = newStore();
    const boundary = NOW - 10 * MINUTE;
    seed(store, 'oc_test', boundary);
    const transport = pagedTransport([
      {
        items: [
          item('om_bot1', boundary + 1, { sender: 'app' }),
          item('om_bot2', boundary + 2, { sender: 'app' }),
        ],
        hasMore: true,
        pageToken: 'p1',
      },
      { items: [item('om_user', boundary + 3, { text: 'behind the cards' })], hasMore: false },
    ]);
    const delivered: string[] = [];
    const catchup = new Catchup({
      transport,
      store,
      deliver: (m) => {
        delivered.push(m.messageId);
      },
      now: () => NOW,
    });
    expect(await catchup.run(['oc_test'])).toBe(1);
    expect(delivered).toEqual(['om_user']);
    expect(transport.calls).toHaveLength(2);
  });

  it('regression: two messages sharing one timestamp are both delivered', async () => {
    const store = newStore();
    const boundary = NOW - 10 * MINUTE;
    seed(store, 'oc_test', boundary);
    const same = boundary + 5 * MINUTE;
    const catchup = new Catchup({
      transport: singlePage([item('om_a', same), item('om_b', same)]),
      store,
      deliver: () => {},
      now: () => NOW,
    });
    expect(await catchup.run(['oc_test'])).toBe(2);
  });

  it('regression: a reordered page is handled by id, not by position', async () => {
    const store = newStore();
    const boundary = NOW - 10 * MINUTE;
    seed(store, 'oc_test', boundary);
    const pages = [
      [item('om_a', boundary + 1000), item('om_b', boundary + 2000), item('om_c', boundary + 3000)],
      [item('om_b', boundary + 2000), item('om_c', boundary + 3000), item('om_a', boundary + 1000)],
      [item('om_c', boundary + 3000), item('om_a', boundary + 1000), item('om_b', boundary + 2000)],
    ];
    let call = 0;
    const transport = {
      async listMessages(): Promise<HistoryPage> {
        const items = pages[Math.min(call, pages.length - 1)] ?? [];
        call += 1;
        return { items, hasMore: false, pageToken: undefined };
      },
    };
    const delivered: string[] = [];
    const catchup = new Catchup({
      transport,
      store,
      deliver: (m) => {
        delivered.push(m.messageId);
      },
      maxMessages: 1,
      now: () => NOW,
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        await catchup.run(['oc_test']);
        if (store.session('oc_test') === undefined) break;
      }
      expect(delivered.sort()).toEqual(['om_a', 'om_b', 'om_c']);
    } finally {
      catchup.dispose();
    }
  });

  it('regression: a recovery request during a session is not consumed by it', async () => {
    const store = newStore();
    const T0 = NOW - 60 * MINUTE;
    seed(store, 'oc_test', T0);
    let clock = NOW;
    let call = 0;
    const transport = {
      async listMessages(): Promise<HistoryPage> {
        call += 1;
        if (call === 1) {
          clock = NOW + 30_000;
          void catchup.run(['oc_test']);
          return {
            items: [item('om_old1', T0 + 1000), item('om_old2', T0 + 2000)],
            hasMore: false,
            pageToken: undefined,
          };
        }
        if (call === 2) {
          return {
            items: [item('om_old1', T0 + 1000), item('om_old2', T0 + 2000)],
            hasMore: false,
            pageToken: undefined,
          };
        }
        return { items: [item('om_new', NOW + 20_000)], hasMore: false, pageToken: undefined };
      },
    };
    const delivered: string[] = [];
    const catchup = new Catchup({
      transport,
      store,
      deliver: (m) => {
        delivered.push(m.messageId);
      },
      maxMessages: 1,
      rerunDelayMs: 5,
      followUpDelayMs: 5,
      now: () => clock,
    });
    try {
      await catchup.run(['oc_test']);
      const deadline = Date.now() + 3000;
      while ((store.scannedThrough('oc_test') ?? 0) < NOW + 30_000 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(delivered.sort()).toEqual(['om_new', 'om_old1', 'om_old2']);
    } finally {
      catchup.dispose();
    }
  });

  it('regression: hasMore without a token keeps the session', async () => {
    const store = newStore();
    const boundary = NOW - 10 * MINUTE;
    seed(store, 'oc_test', boundary);
    const transport = pagedTransport([{ items: [item('om_1', boundary + MINUTE)], hasMore: true }]);
    const catchup = new Catchup({ transport, store, deliver: () => {}, now: () => NOW });
    try {
      await catchup.run(['oc_test']);
      expect(store.scannedThrough('oc_test')).toBe(boundary);
      expect(store.session('oc_test')).toBeDefined();
    } finally {
      catchup.dispose();
    }
  });

  it('regression: a short or empty page without has_more is not terminal', async () => {
    for (const items of [[item('om_1', NOW - 9 * MINUTE)], []] as const) {
      const store = newStore();
      const boundary = NOW - 10 * MINUTE;
      seed(store, 'oc_test', boundary);
      const transport = pagedTransport([{ items: [...items], hasMore: undefined }]);
      const catchup = new Catchup({ transport, store, deliver: () => {}, now: () => NOW });
      try {
        await catchup.run(['oc_test']);
        expect(store.scannedThrough('oc_test')).toBe(boundary);
        expect(store.session('oc_test')).toBeDefined();
      } finally {
        catchup.dispose();
      }
    }
  });

  it('an explicit has_more:false empty page completes', async () => {
    const store = newStore();
    const boundary = NOW - 10 * MINUTE;
    seed(store, 'oc_test', boundary);
    const transport = pagedTransport([{ items: [], hasMore: false }]);
    const catchup = new Catchup({ transport, store, deliver: () => {}, now: () => NOW });
    try {
      await catchup.run(['oc_test']);
      expect(store.scannedThrough('oc_test')).toBe(NOW);
      expect(store.session('oc_test')).toBeUndefined();
    } finally {
      catchup.dispose();
    }
  });

  it('regression: boundary ids survive a persist/reload and are not re-delivered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catchup-'));
    const file = join(dir, 'cursor.json');
    const boundary = NOW - 10 * MINUTE;
    const items = [item('om_a', NOW - 5 * MINUTE), item('om_b', NOW - 4 * MINUTE)];

    const store = new CatchupStore(file);
    seed(store, 'oc_test', boundary);
    const first: string[] = [];
    const catchup = new Catchup({
      transport: singlePage(items),
      store,
      deliver: (m) => {
        first.push(m.messageId);
      },
      maxMessages: 1,
      now: () => NOW,
    });
    try {
      await catchup.run(['oc_test']);
    } finally {
      catchup.dispose();
    }
    expect(first).toEqual(['om_a']);
    store.flush();

    const reloaded = new CatchupStore(file);
    reloaded.load();
    const second: string[] = [];
    const catchup2 = new Catchup({
      transport: singlePage(items),
      store: reloaded,
      deliver: (m) => {
        second.push(m.messageId);
      },
      now: () => NOW,
    });
    try {
      await catchup2.run(['oc_test']);
    } finally {
      catchup2.dispose();
    }
    expect(second).toEqual(['om_b']);
  });
});

describe('normalizeApiMessage', () => {
  it('rejects non-user and non-text items', () => {
    expect(
      normalizeApiMessage(item('om_1', NOW, { sender: 'app' }), 'oc_test', 'p2p'),
    ).toBeUndefined();
    expect(
      normalizeApiMessage(item('om_2', NOW, { type: 'image' }), 'oc_test', 'p2p'),
    ).toBeUndefined();
    expect(
      normalizeApiMessage(
        { ...item('om_3', NOW), body: { content: 'not json' } },
        'oc_test',
        'p2p',
      ),
    ).toBeUndefined();
  });

  it('reads the history API mention shape (string id) and keeps @bot', () => {
    const message = normalizeApiMessage(
      item('om_group', NOW, {
        text: '<at id="ou_bot"></at> help',
        mentions: [
          { id: 'ou_bot', id_type: 'open_id' },
          { id: 'ou_other', id_type: 'open_id' },
          { id: '', id_type: 'open_id' },
        ],
      }),
      'oc_group',
      'group',
    );
    expect(message?.mentions).toEqual(['ou_bot', 'ou_other']);
    expect(message?.text).toBe('help');
  });
});

describe('CatchupStore', () => {
  it('persists v4 state and migrates v1/v2/v3 files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catchup-'));
    const file = join(dir, 'cursor.json');
    const store = new CatchupStore(file);
    seed(store, 'oc_a', NOW);
    store.recordSeen('oc_a', 'om_1', NOW);
    store.saveSession('oc_a', { since: NOW, end: NOW + 1000, pageToken: 'p1' });
    store.flush();
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number;
      cursors: Record<
        string,
        { scannedThrough: number; session?: { pageToken?: string }; seen: Record<string, number> }
      >;
    };
    expect(raw.version).toBe(4);
    expect(raw.cursors.oc_a?.session?.pageToken).toBe('p1');
    expect(raw.cursors.oc_a?.seen.om_1).toBe(NOW);

    const legacy = join(dir, 'legacy.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, cursors: { oc_b: NOW - 5000 } }));
    const v1 = new CatchupStore(legacy);
    v1.load();
    expect(v1.scannedThrough('oc_b')).toBe(NOW - 5000);

    const v2file = join(dir, 'v2.json');
    writeFileSync(
      v2file,
      JSON.stringify({
        version: 2,
        cursors: { oc_c: { scannedThrough: NOW - 1000, seenIds: ['om_x'] } },
      }),
    );
    const v2 = new CatchupStore(v2file);
    v2.load();
    expect(v2.hasSeen('oc_c', 'om_x')).toBe(true);

    const v3file = join(dir, 'v3.json');
    writeFileSync(
      v3file,
      JSON.stringify({
        version: 3,
        cursors: {
          oc_d: {
            scannedThrough: NOW - 1000,
            seen: { om_y: NOW - 2000 },
            session: { since: NOW - 1000, end: NOW, offset: 7, pageToken: 'p9' },
          },
        },
      }),
    );
    const v3 = new CatchupStore(v3file);
    v3.load();
    expect(v3.session('oc_d')?.pageToken).toBe('p9');
    expect((v3.session('oc_d') as unknown as { offset?: number }).offset).toBeUndefined();
  });

  it('evicts only ids strictly behind the boundary', () => {
    const store = newStore({ seenCap: 10 });
    seed(store, 'oc_a', NOW);
    for (let i = 0; i < 30; i += 1) store.recordSeen('oc_a', `om_${i}`, NOW);
    expect(store.hasSeen('oc_a', 'om_29')).toBe(true);

    const behind = newStore({ seenCap: 10 });
    seed(behind, 'oc_b', NOW);
    for (let i = 0; i < 30; i += 1) behind.recordSeen('oc_b', `om_${i}`, NOW - 5000);
    expect((behind.get('oc_b')?.seen.size ?? 0) <= 10).toBe(true);
  });
});
