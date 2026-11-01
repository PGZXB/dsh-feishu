/**
 * Unit tests for the history-response validation and the transport health
 * snapshot. No network: both surfaces are pure.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PING_TIMEOUT_SEC,
  FeishuApiError,
  LarkTransport,
  parseMessageListResponse,
} from '../src/transport.js';

describe('parseMessageListResponse', () => {
  it('accepts a valid empty terminal page', () => {
    const page = parseMessageListResponse({ code: 0, data: { has_more: false } });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('accepts a normal page with items and a token', () => {
    const page = parseMessageListResponse({
      code: 0,
      data: { items: [{ message_id: 'om_1' }], has_more: true, page_token: 'p2' },
    });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.pageToken).toBe('p2');
  });

  it('rejects a success envelope without data', () => {
    expect(() => parseMessageListResponse({ code: 0 })).toThrow(FeishuApiError);
    expect(() => parseMessageListResponse({ code: 0, data: null })).toThrow(FeishuApiError);
    expect(() => parseMessageListResponse(undefined)).toThrow(FeishuApiError);
  });

  it('rejects structurally invalid fields instead of returning an empty page', () => {
    expect(() => parseMessageListResponse({ code: 0, data: { items: 'nope' } })).toThrow(
      FeishuApiError,
    );
    expect(() => parseMessageListResponse({ code: 0, data: { has_more: 'false' } })).toThrow(
      FeishuApiError,
    );
    expect(() => parseMessageListResponse({ code: 0, data: { page_token: 42 } })).toThrow(
      FeishuApiError,
    );
  });

  it('leaves a missing has_more as undefined (not terminal)', () => {
    const page = parseMessageListResponse({ code: 0, data: { items: [] } });
    expect(page.hasMore).toBeUndefined();
  });
});

describe('LarkTransport health', () => {
  it('enables the liveness watchdog by default', () => {
    const transport = new LarkTransport({
      credentials: { appId: 'cli_0123456789abcdef', appSecret: 'secret' },
    });
    expect(transport.health()).toMatchObject({
      state: 'reconnecting',
      readyAt: null,
      generation: 0,
      lastError: null,
      pingTimeoutSec: DEFAULT_PING_TIMEOUT_SEC,
    });
  });

  it('honours pingTimeoutSec: 0 (explicit opt-out)', () => {
    const transport = new LarkTransport({
      credentials: { appId: 'cli_0123456789abcdef', appSecret: 'secret' },
      pingTimeoutSec: 0,
    });
    expect(transport.health().pingTimeoutSec).toBe(0);
  });
});
