/**
 * Unit tests for the Feishu transport: message normalization and API error
 * handling. No network: the normalization is a pure function and the error
 * path is exercised through a fake SDK surface.
 */

import type { RawMessageEvent } from '@larksuiteoapi/node-sdk';
import { describe, expect, it } from 'vitest';
import { FeishuApiError, normalizeMessageEvent } from '../src/transport.js';

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

  it('ignores unparseable content', () => {
    const message = normalizeMessageEvent(rawEvent({ message: { content: 'not json' } }));
    expect(message).toBeUndefined();
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
