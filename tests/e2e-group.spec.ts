import { describe, expect, it } from 'vitest';
import { createGroup, deleteGroup, FeishuApiError, groupNameFor } from '../e2e/helpers/group.js';

describe('groupNameFor', () => {
  it('joins caseId and runId with a dash', () => {
    expect(groupNameFor('send-help', '2026-08-21T08-24-33-553Z')).toBe(
      'send-help-2026-08-21T08-24-33-553Z',
    );
  });

  it('truncates the case part to keep the name within 60 chars', () => {
    const longCase = 'send-help-slash-command-descriptions'.repeat(2); // 86 chars
    const name = groupNameFor(longCase, '2026-08-21T08-24-33-553Z'); // runId is 20 chars
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith('-2026-08-21T08-24-33-553Z')).toBe(true);
    // the case part is truncated (keeps the head), not the runId
    expect(name.startsWith('send-help-slash-command-descr')).toBe(true);
    expect(name).not.toContain('send-help-slash-command-descriptions-2026');
  });

  it('keeps short names unchanged', () => {
    const name = groupNameFor('abc', 'run1');
    expect(name).toBe('abc-run1');
    expect(name.length).toBeLessThanOrEqual(60);
  });
});

describe('createGroup / deleteGroup', () => {
  const cfg = { appId: 'cli_x', appSecret: 'secret' };

  it('posts to im.v1.chat.create with the tenant token and members', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init: init ?? {} });
      if (u.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't0k3n' }), {
          status: 200,
        });
      }
      if (u.includes('/im/v1/chats')) {
        return new Response(JSON.stringify({ code: 0, data: { chat_id: 'oc_x' } }), {
          status: 200,
        });
      }
      throw new Error(`unexpected url ${u}`);
    }) as typeof fetch;

    const { chatId } = await createGroup(cfg, 'my-group', ['ou_user'], fetchImpl);
    expect(chatId).toBe('oc_x');

    const chat = calls.find((c) => c.url.includes('/im/v1/chats'));
    expect(chat).toBeDefined();
    expect(chat?.init.method).toBe('POST');
    expect(chat?.init.headers).toMatchObject({ Authorization: 'Bearer t0k3n' });
    // No owner_id: the bot (creator) stays the owner so the case can
    // disband the group afterwards (im.v1.chat.delete needs the owner).
    expect(JSON.parse(String(chat?.init.body))).toEqual({
      name: 'my-group',
      user_id_list: ['ou_user'],
    });
  });

  it('propagates API errors', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't0k3n' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ code: 99991661, msg: 'chat not found' }), {
        status: 200,
      });
    }) as typeof fetch;

    await expect(createGroup(cfg, 'g', ['ou_u'], fetchImpl)).rejects.toThrow(FeishuApiError);
    await expect(createGroup(cfg, 'g', ['ou_u'], fetchImpl)).rejects.toThrow(/99991661/);
  });

  it('rejects names longer than 60 chars before calling the API', async () => {
    const fetchImpl = (async () => {
      throw new Error('must not be called');
    }) as typeof fetch;
    await expect(createGroup(cfg, 'x'.repeat(61), ['ou_u'], fetchImpl)).rejects.toThrow(/too long/);
  });

  it('deletes via im.v1.chat.delete', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't0k3n' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as typeof fetch;

    await deleteGroup(cfg, 'oc_x', fetchImpl);
    expect(calls).toContain('DELETE https://open.feishu.cn/open-apis/im/v1/chats/oc_x');
  });
});
