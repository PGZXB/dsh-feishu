/**
 * Unit tests for Feishu rich-text (`post`) serialization: order-preserving
 * markdown-ish text with inline attachment placeholders, and the ordered
 * attachment list.
 */

import { describe, expect, it } from 'vitest';
import { serializePost } from '../src/rich-text.js';

describe('serializePost', () => {
  it('serializes a mixed text+image+video post preserving element order', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [{ tag: 'text', text: 'First line:', style: ['bold'] }],
        [{ tag: 'img', image_key: 'img_1' }],
        [
          { tag: 'text', text: 'Second: ' },
          { tag: 'text', text: 'under', style: ['underline'] },
        ],
        [{ tag: 'media', file_key: 'file_v', image_key: 'img_cover' }],
      ],
    });
    const result = serializePost(content);
    expect(result?.text).toBe('**First line:**\n<image 1>\nSecond: <u>under</u>\n<video 2>');
    expect(result?.attachments).toEqual([
      { kind: 'image', key: 'img_1' },
      { kind: 'file', key: 'file_v' },
    ]);
  });

  it('maps links, at-mentions, code blocks, hr, and styles', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [
          { tag: 'text', text: 'bold', style: ['bold'] },
          { tag: 'text', text: 'struck', style: ['lineThrough'] },
        ],
        [{ tag: 'a', href: 'https://x.dev', text: 'link' }],
        [{ tag: 'at', user_id: 'ou_1', user_name: 'Alice' }],
        [{ tag: 'code_block', language: 'PYTHON', text: 'print(1)' }],
        [{ tag: 'hr' }],
      ],
    });
    expect(serializePost(content)?.text).toBe(
      '**bold**~~struck~~\n[link](https://x.dev)\n@Alice\n```PYTHON\nprint(1)\n```\n---',
    );
  });

  it('prefers the client-authored md field with image tokens rewritten to placeholders', () => {
    const content = JSON.stringify({
      title: '',
      md: '**Bold** text\n\n![img](img_1)\n\n![video](file_v)',
      content: [
        [{ tag: 'img', image_key: 'img_1' }],
        [{ tag: 'media', file_key: 'file_v', image_key: 'img_c' }],
      ],
    });
    const result = serializePost(content);
    expect(result?.text).toContain('**Bold** text');
    expect(result?.text).toContain('<image 1>');
    expect(result?.text).toContain('<video 2>');
    expect(result?.attachments).toEqual([
      { kind: 'image', key: 'img_1' },
      { kind: 'file', key: 'file_v' },
    ]);
  });

  it('returns the md text alone when it carries no attachments', () => {
    const content = JSON.stringify({
      title: '',
      md: 'Just **formatted** text',
      content: [],
    });
    expect(serializePost(content)).toEqual({ text: 'Just **formatted** text', attachments: [] });
  });

  it('skips unknown tags (forward-compat) without breaking the rest', () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'fancy_new_tag', something: 'x' }], [{ tag: 'text', text: 'survives' }]],
    });
    expect(serializePost(content)?.text).toBe('survives');
  });

  it('returns undefined for malformed JSON', () => {
    expect(serializePost('not json')).toBeUndefined();
  });

  it('returns undefined when there is no text and no attachments', () => {
    expect(serializePost(JSON.stringify({ title: '', content: [] }))).toBeUndefined();
  });

  it('emotion elements render as their emoji type', () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'emotion', emoji_type: 'THUMBSUP' }]],
    });
    expect(serializePost(content)?.text).toBe('THUMBSUP');
  });
});
