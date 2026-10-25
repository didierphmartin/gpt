import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from './support/fakeDb';
import { chatHandler, chatTables, settingsRow, ChatTables } from './support/chatDb';
import { config } from '../src/config/env';
import { ApiKeyCrypto } from '../src/Services/ApiKeyCrypto';
import { ChatController } from '../src/Controllers/ChatController';
import { Ctx } from '../src/Support/Http';

/**
 * ChatController (backend/src/Controllers/ChatController.php) with a fake DB and a fake fetch:
 * the per-user key overlay on every path, and the chat-path parity points.
 */

const realFetch = globalThis.fetch;
let t: ChatTables;
let seen: Array<{ url: string; headers: Record<string, string>; body: any }>;

/** Every provider call answers `text` in the OpenAI chat-completions shape. */
function openaiAnswers(text = 'ok') {
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 });
  }) as any;
}

beforeEach(() => {
  seen = [];
  t = chatTables({ settings: [settingsRow('openai')], users: { 7: { role: 'user', plan: 'pro' } } });
  installFakeDb(chatHandler(t));
  openaiAnswers();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = (body: Record<string, any>, userId: number | null = 7): Ctx => ({
  method: 'POST', uri: '/', headers: {}, query: {}, body, user_id: userId, auth_type: 'jwt', params: {}, remote_addr: '',
});

const ownKey = (provider: string, key: string, extra: Record<string, any> = {}) =>
  t.userKeys.push({ user_id: 7, provider, api_key: ApiKeyCrypto.encrypt(key, config.auth.jwtSecret), ...extra });

test('agent sends the user own key to the user own entry point', async () => {
  ownKey('openai', 'sk-user', { base_url: 'https://gw.example', chat_endpoint: '/v9/chat' });
  const r = await new ChatController().agent(ctx({ prompt: 'hi', provider: 'openai' }));
  assert.equal(r.success, true);
  assert.equal(seen[0].url, 'https://gw.example/v9/chat');
  assert.equal(seen[0].headers.Authorization, 'Bearer sk-user');
});

test('agent uses the system key without an override', async () => {
  await new ChatController().agent(ctx({ prompt: 'hi', provider: 'openai' }));
  assert.equal(seen[0].url, 'https://api.openai.test/v1/chat');
  assert.equal(seen[0].headers.Authorization, 'Bearer sys-openai');
});
