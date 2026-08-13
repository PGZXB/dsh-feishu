/**
 * Unit tests for the Feishu transport: message normalization and API error
 * handling. No network: the normalization is a pure function and the error
 * path is exercised through a fake SDK surface.
 */

import type { RawMessageEvent } from '@larksuiteoapi/node-sdk';
import { describe, expect, it } from 'vitest';
import { FeishuApiError, normalizeCardAction, normalizeMessageEvent } from '../src/transport.js';

/** A minimal raw event with the fields the normalizer reads. */
function rawEvent(
  overrides: {
    sender?: Partial<RawMessageEvent['sender']>;
    message?: Partial<RawMessageEvent['message']>;
  } = {},
): RawMessageEvent {
  return {
    sender: { sender_id: { open_id: 'ou_user' }, ...overrides.sender },
    message: {
      message_id: 'om_msg1',
      create_time: '1700000000000',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      ...overrides.message,
    },
  } as RawMessageEvent;
}

describe('normalizeMessageEvent', () => {
  it('normalizes a p2p text message', () => {
    const message = normalizeMessageEvent(rawEvent());
    expect(message).toEqual({
      messageId: 'om_msg1',
      chatId: 'oc_chat',
      chatType: 'p2p',
      senderOpenId: 'ou_user',
      text: 'hello',
      mentions: [],
      createdAt: 1_700_000_000_000,
    });
  });

  it('classifies group chats', () => {
    const message = normalizeMessageEvent(rawEvent({ message: { chat_type: 'group' } }));
    expect(message?.chatType).toBe('group');
  });

  it('strips mention placeholders and trims', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: { content: JSON.stringify({ text: 'hi <at user_id="ou_x">@bot</at> there' }) },
      }),
    );
    expect(message?.text).toBe('hi there');
  });

  it('ignores non-text message types', () => {
    const message = normalizeMessageEvent(rawEvent({ message: { message_type: 'image' } }));
    expect(message).toBeUndefined();
  });

  it('extracts mention open ids', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: {
          mentions: [
            { key: '@_user_1', id: { open_id: 'ou_user' }, name: 'user' },
            { key: '@_user_2', id: { open_id: 'ou_other' }, name: 'other' },
            { key: 'all', id: {} },
          ],
        },
      }),
    );
    expect(message?.mentions).toEqual(['ou_user', 'ou_other']);
  });

  it('ignores unparseable content', () => {
    const message = normalizeMessageEvent(rawEvent({ message: { content: 'not json' } }));
    expect(message).toBeUndefined();
  });
});

describe('normalizeCardAction', () => {
  it('normalizes the v2 context-nested shape', () => {
    const action = normalizeCardAction({
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
      operator: { open_id: 'ou_1' },
      action: { value: { kind: 'stop' } },
    } as never);
    expect(action).toEqual({
      messageId: 'om_1',
      chatId: 'oc_1',
      operatorOpenId: 'ou_1',
      value: { kind: 'stop' },
    });
  });

  it('falls back to top-level ids', () => {
    const action = normalizeCardAction({
      open_message_id: 'om_1',
      open_chat_id: 'oc_1',
      operator: { open_id: 'ou_1' },
      action: { value: { kind: 'copy' } },
    } as never);
    expect(action?.messageId).toBe('om_1');
    expect(action?.chatId).toBe('oc_1');
  });

  it('returns undefined without actionable ids or a value object', () => {
    expect(normalizeCardAction({} as never)).toBeUndefined();
    expect(
      normalizeCardAction({ open_message_id: 'om_1', open_chat_id: 'oc_1' } as never),
    ).toBeUndefined();
  });
});

describe('FeishuApiError', () => {
  it('carries the operation and code', () => {
    const error = new FeishuApiError('im.v1.message.create', 23, 'rate limited');
    expect(error.name).toBe('FeishuApiError');
    expect(error.code).toBe(23);
    expect(error.message).toContain('rate limited');
  });
});
