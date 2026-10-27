import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, queries } from './support/fakeDb';
import { chatHandler, chatTables, settingsRow, ChatTables } from './support/chatDb';
import { config } from '../src/config/env';
import { ApiKeyCrypto } from '../src/Services/ApiKeyCrypto';
import { ToolsManager } from '../src/Services/ToolsManager';
import { ChatController } from '../src/Controllers/ChatController';
import { ProviderController } from '../src/Controllers/ProviderController';
import { Ctx } from '../src/Support/Http';

/**
 * ChatController (backend/src/Controllers/ChatController.php) with a fake DB and a fake fetch:
 * the per-user key overlay on every path, and the chat-path parity points. Also the twins of
 * FreeTrialQuotaJevTest, ToolsForRequestTest and Controllers/LlmContextSnapshotTest.
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

/** The OpenAI streaming shape: one content delta, then usage, then [DONE]. */
function openaiStreams(text = 'verified') {
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200 });
  }) as any;
}

beforeEach(() => {
  seen = [];
  delete process.env.ANTHROPIC_API_KEY;
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

/** A stand-in Express Response: records status + JSON, or the SSE frames written. */
class FakeRes {
  statusCode = 200;
  jsonBody: any = undefined;
  frames = '';
  writableEnded = false;
  headers: Record<string, string> = {};
  status(c: number) {
    this.statusCode = c;
    return this;
  }
  json(b: any) {
    this.jsonBody = b;
    this.writableEnded = true;
    return this;
  }
  setHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  flushHeaders() {}
  write(s: string) {
    this.frames += s;
    return true;
  }
  end() {
    this.writableEnded = true;
  }
  on() {
    return this;
  }
  /** [event, data] pairs of the SSE frames. */
  events(): Array<[string, any]> {
    return this.frames
      .split('\n\n')
      .filter(Boolean)
      .map((f) => {
        const ev = /^event: (.*)$/m.exec(f)?.[1] ?? '';
        const data = f.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        try {
          return [ev, JSON.parse(data)] as [string, any];
        } catch {
          return [ev, data] as [string, any];
        }
      });
  }
}

const req = (body: Record<string, any>, extra: Record<string, any> = {}) =>
  ({ method: 'POST', path: '/api/v1/chat', headers: {}, query: {}, body, user_id: 7, auth_type: 'jwt', params: {}, socket: {}, ...extra }) as any;

async function chat(body: Record<string, any>, extra: Record<string, any> = {}): Promise<FakeRes> {
  const res = new FakeRes();
  await new ChatController().chat(req({ provider: 'openai', memory: false, ...body }, extra), res as any);
  return res;
}

const offered = () => (seen[0].body.tools ?? []).map((x: any) => x.function.name);

// ---- per-user overlay on each path ----

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

test('chat (non-streaming) sends the user own key, model and persona', async () => {
  t.packages.user = { providers: { openai: { enabled: true } } };
  ownKey('openai', 'sk-user', { system_prompt: 'my persona', base_url: 'https://gw.example' });
  t.models.push({ user_id: 7, provider: 'openai', model: 'my-model' });
  const res = await chat({ message: 'hi' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.text, 'ok');
  assert.equal(seen[0].url, 'https://gw.example/v1/chat');
  assert.equal(seen[0].headers.Authorization, 'Bearer sk-user');
  assert.equal(seen[0].body.model, 'my-model');
  assert.match(seen[0].body.messages[0].content, /my persona/);
});

test('verify streams the verifier answer with the user own key', async () => {
  openaiStreams();
  ownKey('openai', 'sk-user');
  const res = new FakeRes();
  await new ChatController().verify(req({ original_message: 'q', response_text: 'a', verifier_provider: 'openai' }), res as any);
  const events = res.events().map(([e]) => e);
  assert.equal(events[0], 'verification_start');
  assert.ok(events.includes('verifier_chunk'));
  assert.deepEqual(res.events().find(([e]) => e === 'verification_response')?.[1], { success: true, text: 'verified', verifier: 'openai' });
  assert.equal(events[events.length - 1], 'verification_complete');
  assert.equal(seen[0].headers.Authorization, 'Bearer sk-user');
});

// ---- chat-path parity ----

test('an app key without the chat scope is refused', async () => {
  const res = await chat({ message: 'hi' }, { auth_type: 'app_key', app_key_scopes: ['agents'] });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.jsonBody, { success: false, error: 'App key not authorized for chat (missing scope "chat")' });
  const ok = await chat({ message: 'hi' }, { auth_type: 'app_key', app_key_scopes: ['chat'] });
  assert.equal(ok.statusCode, 200);
});

test('an empty message is refused unless it continues a tool round', async () => {
  assert.equal((await chat({ message: '' })).statusCode, 400);
  assert.deepEqual((await chat({ message: '0' })).jsonBody, { success: false, error: 'Message is required' });
  const cont = await chat({ message: '', conversation_history: [{ role: 'assistant', content: 'x' }, { role: 'tool', content: 'r', tool_call_id: 'a' }] });
  assert.equal(cont.statusCode, 200);
});

test('a free user over the package quota gets QUOTA_EXCEEDED before any provider call', async () => {
  t.users[7] = { role: 'user', plan: 'free' };
  t.packages.user = { quota_tokens: 1000 };
  t.usage.push({ user_id: 7, provider: 'openai', total_tokens: 1200 });
  const res = await chat({ message: 'hi' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.code, 'QUOTA_EXCEEDED');
  assert.equal(res.jsonBody.error, 'Token quota reached. You have used 1,200 of 1,000 tokens. Please upgrade your plan to continue.');
  assert.deepEqual(res.jsonBody.usage, { total_tokens: 1200, quota: 1000 });
  assert.equal(seen.length, 0);
});

// FreeTrialQuotaJevTest
test('decision-model tokens do not count toward the quota', async () => {
  t.users[7] = { role: 'user', plan: 'free' };
  t.packages.user = { quota_tokens: 1000 };
  t.settings.push({ provider_key: 'jev', api_format: 'router', enabled: 1 }, { provider_key: 'acme', api_format: 'router', enabled: 1 });
  t.usage.push({ user_id: 7, provider: 'openai', total_tokens: 900 }, { user_id: 7, provider: 'jev', total_tokens: 5000 }, { user_id: 7, provider: 'acme', total_tokens: 5000 });
  assert.equal(await ChatController.checkFreeTrialQuota(7), null);
  t.usage[0].total_tokens = 1200;
  assert.equal((await ChatController.checkFreeTrialQuota(7))?.code, 'QUOTA_EXCEEDED');
});

test('paid plans, admins and uncapped packages have no quota', async () => {
  t.usage.push({ user_id: 7, provider: 'openai', total_tokens: 10 ** 9 });
  t.packages.user = { quota_tokens: 1 };
  assert.equal(await ChatController.checkFreeTrialQuota(7), null); // plan 'pro'
  t.users[7] = { role: 'admin', plan: 'free' };
  assert.equal(await ChatController.checkFreeTrialQuota(7), null);
  t.users[7] = { role: 'user', plan: 'free' };
  t.packages.user = {};
  assert.equal(await ChatController.checkFreeTrialQuota(7), null);
});

test('a free user over quota is refused on verify, compare and agent before streaming', async () => {
  t.users[7] = { role: 'user', plan: 'free' };
  t.packages.user = { quota_tokens: 1 };
  t.usage.push({ user_id: 7, provider: 'openai', total_tokens: 5 });
  const v = new FakeRes();
  await new ChatController().verify(req({ original_message: 'q', response_text: 'a', verifier_provider: 'openai' }), v as any);
  assert.equal(v.statusCode, 403);
  assert.equal(v.jsonBody.code, 'QUOTA_EXCEEDED');
  const c = new FakeRes();
  await new ChatController().compare(req({ message: 'q', compare_provider: 'openai' }), c as any);
  assert.equal(c.statusCode, 403);
  const a = await new ChatController().agent(ctx({ prompt: 'hi', provider: 'openai' }));
  assert.equal(a.status_code, 403);
  assert.equal(seen.length, 0);
});

test('SVG blocks in the history are replaced before the provider sees them', async () => {
  await chat({ message: 'hi', conversation_history: [{ role: 'assistant', content: 'see <svg width="1"><path d="M0"/></svg> done' }] });
  assert.ok(seen[0].body.messages.some((m: any) => m.content === 'see [SVG illustration omitted] done'));
});

test('a conversation turn offers the search tools and session_search', async () => {
  await chat({ message: 'hi' });
  const names = offered();
  for (const n of ['serpapi_search', 'brave_search', 'get_sec_filings', 'session_search']) assert.ok(names.includes(n), n);
});

test('a single-skill turn offers only run_skill_script + Task and forces run_skill_script', async () => {
  await chat({ message: 'make it', skill_metadata: { dir_name: 'html', scripts: ['scripts/create.py'] } });
  assert.deepEqual(offered(), ['run_skill_script', 'Task']);
  assert.deepEqual(seen[0].body.tool_choice, { type: 'function', function: { name: 'run_skill_script' } });
});

test('the non-streaming skill turn stops forcing after any tool round', async () => {
  await chat({
    message: '',
    skill_metadata: { dir_name: 'html', scripts: ['scripts/create.py'] },
    conversation_history: [
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'discover_skill', arguments: '{}' } }] },
      { role: 'tool', name: 'discover_skill', content: 'body', tool_call_id: 'a' },
    ],
  });
  assert.equal(seen[0].body.tool_choice, 'auto');
});

test('a non-streaming multi-skill turn declares the catalog tool only, beside the server tools', async () => {
  await chat({ message: 'make a doc', available_skills: [{ dir_name: 'docx', description: 'Word', scripts: ['scripts/create.py'] }] });
  const names = offered();
  assert.ok(names.includes('run_skill_script'));
  assert.ok(!names.includes('discover_skill'));
  assert.ok(names.includes('serpapi_search'));
  assert.equal(seen[0].body.tool_choice, 'auto');
});

test('a workflow node tool filter is an exact allow-list, skill tools included', async () => {
  await chat({ message: 'hi', tools: [] });
  assert.equal(seen[0].body.tools, undefined);
  seen.length = 0;
  await chat({ message: 'hi', tools: ['search_assets'] });
  assert.deepEqual(offered(), ['search_assets']);
  seen.length = 0;
  await chat({ message: 'x', tools: ['brave_search'], skill_metadata: { dir_name: 'html', scripts: ['s.py'] } });
  assert.deepEqual(offered(), ['brave_search']);
});

test('the system prompt override is trimmed and a blank one keeps the persona', async () => {
  await chat({ message: 'hi', system_prompt: '  You route.  ' });
  const sys = seen[0].body.messages[0].content;
  assert.match(sys, /You route\./);
  assert.doesNotMatch(sys, /You route\.  |admin persona/);
  seen.length = 0;
  await chat({ message: 'hi', system_prompt: '   ' });
  assert.match(seen[0].body.messages[0].content, /admin persona/);
});

test('numeric-string max_tokens / temperature overrides apply on the non-streaming path', async () => {
  await chat({ message: 'hi', max_tokens: '123', temperature: '0.2' });
  assert.equal(seen[0].body.max_tokens, 123);
  assert.equal(seen[0].body.temperature, 0.2);
});

test('client tools keep only the browser-resolved names, description capped at 2048 bytes', () => {
  const s = { type: 'object', properties: {} };
  const out = ChatController.sanitizeClientTools([
    { name: 'webmcp_tab.click', description: 'x'.repeat(3000), input_schema: s },
    { name: 'route_to', input_schema: s },
    { name: 'webmcp_' + 'a'.repeat(121), input_schema: s },
    { name: 'evil', input_schema: s },
    { name: 'save_workflow' },
    'nope',
  ]);
  assert.deepEqual(out.map((x) => x.name), ['webmcp_tab.click', 'route_to']);
  assert.equal(out[0].description?.length, 2048);
  assert.equal(out[1].description, '');
});

test('the streaming multi-skill turn forces discover_skill only for an attached document and a deliverable verb', () => {
  const skills = [{ dir_name: 'docx', description: 'Word', scripts: ['s.py'] }];
  const plan = (msg: string, history: any[] = []) => (ChatController as any).skillPlan('stream', 'claude', msg, history, null, skills);
  const att = '[The user attached the following document(s)]\n...\n';
  assert.deepEqual(plan(att + 'please fix the title').toolChoice, { type: 'function', function: { name: 'discover_skill' } });
  assert.equal(plan(att + 'what is this about?').toolChoice, undefined);
  assert.equal(plan('please fix the title').toolChoice, undefined);
  assert.equal(plan(att + 'fix it', [{ role: 'tool', content: 'r' }]).toolChoice, undefined);
  assert.deepEqual(plan('x').tools.map((x: any) => x.name), ['discover_skill', 'run_skill_script']);
  assert.equal(plan('x').serverTools, 'all');
});

test('skill plans per path: grok/deepseek get required, the comparer multi-skill gets MCP only', () => {
  const md = { dir_name: 'html', scripts: ['s.py'] };
  const sp = (path: string, provider: string, history: any[] = [], skills: any[] = []) =>
    (ChatController as any).skillPlan(path, provider, 'm', history, skills.length ? null : md, skills);
  assert.equal(sp('stream', 'Grok').toolChoice, 'required');
  assert.equal(sp('compare', 'deepseek').toolChoice, 'required');
  assert.deepEqual(sp('regular', 'grok').toolChoice, { type: 'function', function: { name: 'run_skill_script' } });
  assert.equal(sp('stream', 'claude').serverTools, 'none');
  // Only a run_skill_script round ends forcing on the streaming path.
  assert.ok(sp('stream', 'claude', [{ role: 'tool', name: 'discover_skill' }]).toolChoice);
  assert.equal(sp('stream', 'claude', [{ role: 'tool', name: 'run_skill_script' }]).toolChoice, undefined);
  const multi = sp('compare', 'claude', [], [{ dir_name: 'd', description: '', scripts: ['s.py'] }]);
  assert.equal(multi.serverTools, 'mcp');
  assert.deepEqual(multi.tools.map((x: any) => x.name), ['discover_skill', 'run_skill_script']);
});

// ToolsForRequestTest — the offered server tools per policy.
test('executorFor: default merges, a skill turn offers none, a filter keeps exactly the named tools', () => {
  const tm = new ToolsManager();
  tm.registerFunction('serpapi_search', () => ({}), {});
  tm.registerFunction('search_assets', () => ({}), {});
  const set = { toolsManager: tm, mcpLoader: null };
  const names = (e: any) => e.getToolDefinitions().map((d: any) => d.name);
  const ex = (ChatController as any).executorFor;
  assert.deepEqual(names(ex(set, 'all')), ['serpapi_search', 'search_assets']);
  assert.deepEqual(names(ex(set, 'none')), []);
  assert.deepEqual(names(ex(set, 'mcp')), []);
  assert.deepEqual(names(ex(set, 'all', [])), []);
  assert.deepEqual(names(ex(set, 'none', ['search_assets'])), ['search_assets']);
});

// LlmContextSnapshotTest
test('the context snapshot lists what was sent', () => {
  const snap = ChatController.buildLlmContextSnapshot(
    'claude',
    'claude-sonnet-4-5',
    { message: '', conversation_history: [], system_prompt: 'You are a dispatcher.', client_tools: [{ name: 'route_to', description: 'Route it', input_schema: { type: 'object' } }] },
    [{ name: 'mcp_lookup_users', description: 'Look up', input_schema: {} }],
    [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }],
    'refund please',
    { max_tokens: 4096, temperature: 0.7 },
  );
  assert.equal(snap.provider, 'claude');
  assert.equal(snap.model, 'claude-sonnet-4-5');
  assert.equal(snap.system_prompt, 'You are a dispatcher.');
  assert.equal(snap.max_tokens, 4096);
  assert.equal(snap.temperature, 0.7);
  assert.deepEqual(snap.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
  assert.equal(snap.messages[2].content, 'refund please');
  assert.deepEqual(snap.tools, [
    { name: 'mcp_lookup_users', description: 'Look up', source: 'server' },
    { name: 'route_to', description: 'Route it', source: 'client' },
  ]);
  assert.ok(snap.estimated_tokens > 0);
  assert.equal(snap.memory_included, false);
});

test('the context snapshot reports memory and skill flags', () => {
  const snap = ChatController.buildLlmContextSnapshot('openai', null, { message: '', conversation_history: [], memory_context: 'likes tea', skill_content: '# Skill' }, [], [], 'hi', { max_tokens: null, temperature: null });
  assert.equal(snap.memory_included, true);
  assert.equal(snap.memory_context, 'likes tea');
  assert.equal(snap.skill_included, true);
  assert.equal(snap.skill_content, '# Skill');
  assert.deepEqual(snap.tools, []);
  assert.equal(snap.model, null);
});

test("an unknown provider is 'not found' on the chat path, as LLMManager::chat says", async () => {
  const res = await chat({ message: 'x', provider: 'no-such-provider', tools: [] });
  assert.equal(res.jsonBody.error, "Provider 'no-such-provider' not found");
});

test("providers/switch says an unknown provider 'is not available', as AIPortfolioAssistant::setProvider", async () => {
  const r = await new ProviderController().switch(ctx({ provider: 'no-such-provider' }));
  assert.equal(r.status_code, 400);
  assert.equal(r.error, "Provider 'no-such-provider' is not available");
});

test('verify names an unavailable verifier', async () => {
  const res = new FakeRes();
  await new ChatController().verify(req({ original_message: 'q', response_text: 'a', verifier_provider: 'nope' }), res as any);
  assert.deepEqual(res.events().find(([e]) => e === 'verification_error')?.[1], { message: "Verifier provider 'nope' not available" });
  assert.deepEqual(res.events().pop(), ['verification_complete', { status: 'error' }]);
});

test('compare gives the comparer the skill tools only, no webMCP tools and no persona override', async () => {
  openaiStreams('compared');
  const res = new FakeRes();
  await new ChatController().compare(
    req({
      message: 'make it',
      compare_provider: 'openai',
      system_prompt: 'ignored',
      skill_metadata: { dir_name: 'html', scripts: ['s.py'] },
      client_tools: [{ name: 'webmcp_x', input_schema: { type: 'object' } }],
    }),
    res as any,
  );
  assert.deepEqual(seen[0].body.tools.map((x: any) => x.function.name), ['run_skill_script', 'Task']);
  assert.match(seen[0].body.messages[0].content, /admin persona/);
  assert.equal(res.events().find(([e]) => e === 'compare_response')?.[1].text, 'compared');
});

test('the streaming chat answers over SSE and logs usage with a session id', async () => {
  openaiStreams('streamed');
  const res = new FakeRes();
  await new ChatController().chat(req({ provider: 'openai', memory: false, message: 'hi', streaming: true }), res as any);
  const resp = res.events().filter(([e]) => e === 'response').pop()?.[1];
  assert.equal(resp.success, true);
  assert.equal(resp.text, 'streamed');
  await new Promise((r) => setTimeout(r, 20));
  const insert = queries.find((q) => q.sql.includes('INSERT INTO llm_usage_transactions'));
  assert.ok(insert, 'usage logged');
  assert.match(String(insert!.parameters[1]), /^chat_[0-9a-f]{13}\.\d{8}$/);
});
