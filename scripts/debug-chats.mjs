#!/usr/bin/env node
import { readFileSync } from 'node:fs';
for (const k of ['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','all_proxy','ALL_PROXY']) delete process.env[k];
const creds = JSON.parse(readFileSync('/state/creds.json', 'utf8'));
const BASE = 'https://open.feishu.cn';
const tok = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
}).then(r => r.json());
const H = { Authorization: `Bearer ${tok.tenant_access_token}` };
for (const qs of [
  '?page_size=50',
  '?page_size=50&sort_type=ByCreateTimeDesc',
  '?user_id_type=user_id&page_size=50',
  '?user_id_type=open_id&page_size=50',
]) {
  const r = await fetch(`${BASE}/open-apis/im/v1/chats${qs}`, { headers: H });
  const b = await r.json();
  const items = (b.data?.items ?? []).map(it => ({ id: it.chat_id, type: it.chat_type, name: it.name, user_id: it.user_id, owner: it.owner_id }));
  console.log(`QS ${qs || '(none)'} -> code=${b.code} msg=${b.msg ?? ''} items=${JSON.stringify(items)}`);
}
