import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from './support/fakeDb';
import { ProviderFactory } from '../src/Providers/ProviderFactory';
import { GrokProvider } from '../src/Providers/GrokProvider';
import { KimiProvider } from '../src/Providers/KimiProvider';
import { DeepSeekProvider } from '../src/Providers/DeepSeekProvider';
import { CustomProvider } from '../src/Providers/CustomProvider';
import { OpenAIProvider } from '../src/Providers/OpenAIProvider';
import { ClaudeProvider } from '../src/Providers/ClaudeProvider';
import { GeminiProvider } from '../src/Providers/GeminiProvider';
import { LLMProviderResolver } from '../src/Services/LLMProviderResolver';
import type { ProviderConfig } from '../src/Contracts/types';

/**
 * The PHP providers with no TS twin until now: GrokProvider, KimiProvider, DeepSeekProvider and
 * CustomProvider. Mirrors backend/tests/Unit/Providers/DeepSeekThinkingModelTest.php,
 * DeepSeekReplayReasoningTest.php and the grok/kimi/deepseek rows of ProviderEndpointOverrideTest.php,
 * plus request building, streaming and the tool loop. No network: fetch is replaced by a recorder.
 */

type Call = { url: string; body: any; headers: Record<string, string> };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

/** Answers each request with the next canned response (an object = JSON, a string = SSE body). */
function fakeFetch(...answers: Array<object | string | { status: number; body: string }>): void {
  calls = [];
  let i = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    const a = answers[Math.min(i++, answers.length - 1)];
    if (typeof a === 'string') {
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(a));
          c.close();
        },
      }), { status: 200 });
    }
    if ((a as any).status) return new Response((a as any).body, { status: (a as any).status });
    return new Response(JSON.stringify(a), { status: 200 });
  }) as any;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function cfg(key: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { provider_key: key, api_key: 'k', model: 'm', base_url: '', chat_endpoint: '', api_format: 'openai', max_tokens: 100, temperature: 0.7, system_prompt: 'sys', ...over };
}

function sink() {
  const events: Array<[string, any]> = [];
  return { events, send: (e: string, d: any) => events.push([e, d]), isAborted: false } as any;
}

const answer = (content: string, extra: Record<string, any> = {}) => ({ choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } });

const sse = (...frames: object[]) => frames.map((f) => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n';

// ------------------------------------------------------------ factory + resolver

test('ProviderFactory picks the dedicated class per key, else CustomProvider (base_url required)', () => {
  assert.ok(ProviderFactory.create(cfg('grok')) instanceof GrokProvider);
  assert.ok(ProviderFactory.create(cfg('kimi')) instanceof KimiProvider);
  assert.ok(ProviderFactory.create(cfg('deepseek')) instanceof DeepSeekProvider);
  assert.ok(ProviderFactory.create(cfg('openai')) instanceof OpenAIProvider);
  assert.ok(ProviderFactory.create(cfg('claude', { api_format: 'anthropic' })) instanceof ClaudeProvider);
  assert.ok(ProviderFactory.create(cfg('anthropic')) instanceof ClaudeProvider);
  assert.ok(ProviderFactory.create(cfg('google')) instanceof GeminiProvider);
  assert.ok(ProviderFactory.create(cfg('glm', { base_url: 'https://api.z.ai/api/paas/v4' })) instanceof CustomProvider);
  assert.throws(() => ProviderFactory.create(cfg('gamma4')), /Provider 'gamma4' not found/);
});

test('resolver fills a blank kimi row with KimiProvider\'s defaults and carries streaming/supports_tools', async () => {
  installFakeDb((sql) => (sql.includes('system_llm_settings')
    ? [{ provider_key: 'kimi', api_key: 'k', model: '', base_url: '', chat_endpoint: '', api_format: null, max_tokens: null, temperature: null, system_prompt: null, display_name: '', streaming: 0, supports_tools: null }]
    : []));
  const c = (await LLMProviderResolver.getProviderConfig('kimi'))!;
  assert.equal(c.model, 'kimi-k2.6');
  assert.equal(c.temperature, 0.6);
  assert.equal(c.max_tokens, 32768);
  assert.equal(c.base_url, 'https://api.moonshot.ai');
  assert.equal(c.streaming, false);
  assert.equal(c.supports_tools, null);
});

// ------------------------------------------------------------ endpoint override (ProviderEndpointOverrideTest)

for (const [key, vendor, path] of [
  ['kimi', 'https://api.moonshot.ai', '/v1/chat/completions'],
  ['grok', 'https://api.x.ai', '/v1/chat/completions'],
  ['deepseek', 'https://api.deepseek.com', '/chat/completions'],
] as const) {
  test(`${key}: vendor link by default, the configured base_url otherwise`, async () => {
    fakeFetch(answer('hi'));
    await ProviderFactory.create(cfg(key)).chat({ message: 'q', conversation_history: [] });
    assert.equal(calls[0].url, vendor + path);
    fakeFetch(answer('hi'));
    await ProviderFactory.create(cfg(key, { base_url: 'https://gw.example/llm/' })).chat({ message: 'q', conversation_history: [] });
    assert.equal(calls[0].url, 'https://gw.example/llm' + path);
    assert.equal(calls[0].headers.Authorization, 'Bearer k');
  });
}

test('a provider without an API key is not available', async () => {
  await assert.rejects(new GrokProvider(cfg('grok', { api_key: '' })).chat({ message: 'q', conversation_history: [] }),
    /Provider 'grok' is not available \(check API key\)/);
});

// ------------------------------------------------------------ DeepSeek (DeepSeekThinkingModelTest / DeepSeekReplayReasoningTest)

test('DeepSeek thinking model ids', () => {
  assert.equal(DeepSeekProvider.isThinkingModel('deepseek-v4-pro'), true);
  assert.equal(DeepSeekProvider.isThinkingModel('deepseek-v4-flash'), true);
  assert.equal(DeepSeekProvider.isThinkingModel('deepseek-flash'), true);
  assert.equal(DeepSeekProvider.isThinkingModel('deepseek-chat'), false);
  assert.equal(DeepSeekProvider.isThinkingModel('deepseek-reasoner'), false);
});

test('deepseek-flash requests use thinking and drop temperature; legacy models keep temperature', async () => {
  fakeFetch(answer('a'));
  await new DeepSeekProvider(cfg('deepseek', { model: 'deepseek-flash', temperature: 0.1 })).chat({ message: 'hi', conversation_history: [] });
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled' });
  assert.equal('temperature' in calls[0].body, false);
  fakeFetch(answer('a'));
  await new DeepSeekProvider(cfg('deepseek', { model: 'deepseek-chat', temperature: 0.1 })).chat({ message: 'hi', conversation_history: [] });
  assert.equal('thinking' in calls[0].body, false);
  assert.equal(calls[0].body.temperature, 0.1);
});

test('DeepSeek V4 disables thinking for a forced tool, the off switch and a skill turn', async () => {
  const p = new DeepSeekProvider(cfg('deepseek', { model: 'deepseek-v4-pro' }));
  for (const [opts, want] of [
    [{ tool_choice: 'required' }, 'disabled'],
    [{ tool_choice: 'auto' }, 'enabled'],
    [{ thinking: 'off' }, 'disabled'],
    [{ skill_metadata: { dir_name: 'x', scripts: [] } }, 'disabled'],
    [{ skill_metadata: { dir_name: 'x', scripts: [] }, thinking: 'on' }, 'enabled'],
  ] as const) {
    fakeFetch(answer('a'));
    await p.chat({ message: 'hi', conversation_history: [], ...(opts as any) });
    assert.equal(calls[0].body.thinking.type, want, JSON.stringify(opts));
    assert.equal('temperature' in calls[0].body, want === 'disabled');
  }
});

test('DeepSeek replays an empty reasoning_content key on a tool-call turn without reasoning, and keeps one that has it', async () => {
  const p = new DeepSeekProvider(cfg('deepseek'));
  const tc = [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{}' } }];
  fakeFetch(answer('a'));
  await p.chat({ message: 'next question', conversation_history: [
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: '', tool_calls: tc },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ] });
  const a1 = calls[0].body.messages.find((m: any) => m.role === 'assistant');
  assert.equal(a1.reasoning_content, '');
  assert.deepEqual(Object.keys(a1), ['role', 'content', 'reasoning_content', 'tool_calls']);
  fakeFetch(answer('a'));
  await p.chat({ message: 'next question', conversation_history: [
    { role: 'assistant', content: '', reasoning_content: 'think', tool_calls: tc },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ] });
  assert.equal(calls[0].body.messages.find((m: any) => m.role === 'assistant').reasoning_content, 'think');
});

test('DeepSeek streams reasoning and surfaces it with a client-side tool call', async () => {
  fakeFetch(sse(
    { choices: [{ delta: { reasoning_content: 'let me ' } }] },
    { choices: [{ delta: { reasoning_content: 'think' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_skill_script', arguments: '{"a":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 6 } },
  ));
  const s = sink();
  const r = await new DeepSeekProvider(cfg('deepseek')).streamChat({ message: 'go', conversation_history: [] }, s);
  assert.equal(r.pending_client_tool_call, true);
  assert.equal(r.assistant_reasoning, 'let me think');
  assert.deepEqual(r.pending_tool_calls, [{ id: 'c1', name: 'run_skill_script', input: { a: 1 } }]);
  assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 6, total_tokens: 11, function_calls: 1 });
  const ev = s.events.find(([e]: any) => e === 'client_tool_call');
  assert.deepEqual(ev[1], { assistant_reasoning: 'let me think', assistant_text: '', tool_calls: r.pending_tool_calls });
  assert.deepEqual(s.events.filter(([e]: any) => e === 'progress').map(([, d]: any) => d),
    ['DeepSeek: Preparing request...', 'DeepSeek: Connecting to DeepSeek API...', 'DeepSeek: Thinking...', 'DeepSeek: Processing tool calls...']);
});

test('DeepSeek falls back to reasoning_content when content is empty', async () => {
  fakeFetch(answer('', { reasoning_content: 'only thoughts' }));
  const r = await new DeepSeekProvider(cfg('deepseek')).chat({ message: 'q', conversation_history: [] });
  assert.equal(r.text, 'only thoughts');
});

test('DeepSeek HTTP errors: rate limit, auth, and Guzzle\'s API error text', async () => {
  const p = new DeepSeekProvider(cfg('deepseek'));
  fakeFetch({ status: 429, body: '' });
  await assert.rejects(p.chat({ message: 'q', conversation_history: [] }), { message: 'Rate limited by deepseek. ' });
  fakeFetch({ status: 401, body: '' });
  await assert.rejects(p.chat({ message: 'q', conversation_history: [] }), { message: 'Authentication failed for deepseek. Please check your API key.' });
  fakeFetch({ status: 400, body: '{"error":{"message":"bad"}}' });
  await assert.rejects(p.chat({ message: 'q', conversation_history: [] }),
    { message: 'deepseek API error: Client error: `POST https://api.deepseek.com/chat/completions` resulted in a `400 Bad Request` response:\n{"error":{"message":"bad"}}' });
});

// ------------------------------------------------------------ Kimi

test('Kimi K2 forces the non-thinking sampling values unless the agent turns thinking on; K3 uses temperature 1', async () => {
  fakeFetch(answer('a'));
  await new KimiProvider(cfg('kimi', { model: 'kimi-k2.6' })).chat({ message: 'q', conversation_history: [] });
  assert.deepEqual([calls[0].body.thinking, calls[0].body.temperature, calls[0].body.top_p], [{ type: 'disabled' }, 0.6, 0.95]);
  fakeFetch(answer('a'));
  await new KimiProvider(cfg('kimi', { model: 'kimi-k2.6' })).chat({ message: 'q', conversation_history: [], thinking: 'on' });
  assert.deepEqual([calls[0].body.thinking, calls[0].body.temperature, 'top_p' in calls[0].body], [{ type: 'enabled' }, 1, false]);
  fakeFetch(answer('a'));
  await new KimiProvider(cfg('kimi', { model: 'kimi-k3-preview' })).chat({ message: 'q', conversation_history: [] });
  assert.equal(calls[0].body.temperature, 1);
  fakeFetch(answer('a'));
  await new KimiProvider(cfg('kimi', { model: 'moonshot-v1', temperature: 0.3 })).chat({ message: 'q', conversation_history: [] });
  assert.equal(calls[0].body.temperature, 0.3);
  assert.equal(calls[0].body.max_tokens, 100);
});

test('Kimi reports the API\'s own error message', async () => {
  fakeFetch({ status: 400, body: '{"error":{"message":"invalid temperature"}}' });
  await assert.rejects(new KimiProvider(cfg('kimi')).chat({ message: 'q', conversation_history: [] }), { message: 'kimi API error: invalid temperature' });
});

// ------------------------------------------------------------ Grok

test('Grok rounds temperature, always sends max_tokens, cleans tool schemas for xAI', async () => {
  fakeFetch(answer('a'));
  const p = new GrokProvider(cfg('grok', { temperature: 0.66 }));
  p.setFunctionExecutor({
    execute: async () => ({}), hasFunction: () => true, isMCPTool: () => false,
    getToolDefinitions: () => [{
      name: 't', description: 'd',
      input_schema: {
        $schema: 'x', type: 'object', required: [],
        properties: {
          a: {}, b: { type: 'string', default: 'z', items: {}, enum: [1, 'GEO/geo'] }, c: { type: 'integer', enum: ['1', '2'] }, d: { type: 'array', items: { type: 'string' } },
        },
      },
    }],
  });
  await p.chat({ message: 'q', conversation_history: [], tool_choice: { type: 'function', function: { name: 't' } } });
  const b = calls[0].body;
  assert.equal(b.temperature, 0.7);
  assert.equal(b.max_tokens, 100);
  assert.deepEqual(b.tool_choice, { type: 'function', function: { name: 't' } });
  assert.deepEqual(b.tools[0].function.parameters, {
    type: 'object',
    properties: {
      a: { type: 'string', description: '' }, b: { type: 'string' }, c: { type: 'integer', enum: [1, 2] }, d: { type: 'array', items: { type: 'string' } },
    },
  });
});

test('Grok reads the HTTP error from the body and throws on a stream error frame', async () => {
  fakeFetch({ status: 400, body: '{"error":{"message":"bad schema"}}' });
  await assert.rejects(new GrokProvider(cfg('grok')).chat({ message: 'q', conversation_history: [] }), { message: 'grok API error: API error: bad schema' });
  fakeFetch(sse({ error: { message: 'overloaded' } }));
  await assert.rejects(new GrokProvider(cfg('grok')).streamChat({ message: 'q', conversation_history: [] }, sink()), { message: 'grok API error: Stream error: overloaded' });
});

test('Grok tool loop: runs server tools, skips a third identical call, keeps the forced tool_choice', async () => {
  const toolTurn = answer('', { tool_calls: [{ id: 'x', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] });
  fakeFetch(toolTurn, toolTurn, toolTurn, answer('done'));
  const executed: any[] = [];
  const p = new GrokProvider(cfg('grok'));
  p.setFunctionExecutor({
    execute: async (n: string, a: any) => { executed.push([n, a]); return { status: 'pending', url: 'a/b' }; },
    hasFunction: () => true, isMCPTool: () => true, getToolDefinitions: () => [{ name: 'lookup', description: '', input_schema: { type: 'object', properties: { q: { type: 'integer' } } } }],
  });
  const r = await p.chat({ message: 'q', conversation_history: [], tool_choice: 'required' });
  assert.equal(r.text, 'done');
  assert.equal(executed.length, 2);
  assert.equal(r.usage.function_calls, 2);
  assert.deepEqual(r.functions_called, ['lookup', 'lookup']);
  assert.equal(r.mcp_calls_count, 2);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.body.tool_choice), ['required', 'required', 'required', 'required']);
  const tools = calls[3].body.messages.filter((m: any) => m.role === 'tool');
  assert.equal(tools[0].content, '{"status":"pending","url":"a\\/b","_hint":"This is an async operation. DO NOT call this tool again - the UI will automatically show progress and results."}');
  assert.match(tools[2].content, /"status":"skipped"/);
  assert.equal(r.usage.input_tokens, 12);
});

test('Grok switches the continuation to auto once complete_task marks the workflow complete', async () => {
  fakeFetch(answer('', { tool_calls: [{ id: 'x', type: 'function', function: { name: 'complete_task', arguments: '{}' } }] }), answer('bye'));
  const p = new GrokProvider(cfg('grok'));
  p.setFunctionExecutor({ execute: async () => ({ marker: '___WORKFLOW_COMPLETE___' }), hasFunction: () => true, isMCPTool: () => false, getToolDefinitions: () => [{ name: 'complete_task', description: '', input_schema: { type: 'object', properties: {} } }] });
  await p.chat({ message: 'q', conversation_history: [], tool_choice: 'required' });
  assert.deepEqual(calls.map((c) => c.body.tool_choice), ['required', 'auto']);
});

test('Grok streams every content chunk and uses its progress labels', async () => {
  fakeFetch(sse({ choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }));
  const s = sink();
  const r = await new GrokProvider(cfg('grok')).streamChat({ message: 'q', conversation_history: [] }, s);
  assert.equal(r.text, 'Hello');
  assert.deepEqual(s.events.filter(([e]: any) => e === 'chunk').map(([, d]: any) => d), ['Hel', 'lo']);
  assert.deepEqual(s.events.filter(([e]: any) => e === 'progress').map(([, d]: any) => d),
    ['Grok: Preparing request...', 'Grok: Connecting to xAI API...', 'Grok: Thinking...', 'Grok: Response ready.']);
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
});

test('a truncated stream emits usage_warning; high context emits context_high', async () => {
  fakeFetch(sse(
    { choices: [], usage: { prompt_tokens: 1600000, completion_tokens: 50 } },
    { choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] },
  ));
  const s = sink();
  await new GrokProvider(cfg('grok')).streamChat({ message: 'q', conversation_history: [] }, s);
  const warnings = s.events.filter(([e]: any) => e === 'usage_warning').map(([, d]: any) => d);
  assert.deepEqual(warnings, [
    { reason: 'context_high', provider: 'grok', model: 'm', input_tokens: 1600000, context_window: 2000000, percent: 80 },
    { reason: 'output_truncated', provider: 'grok', model: 'm', max_tokens: 100, output_tokens: 50 },
  ]);
});

// ------------------------------------------------------------ Custom

test('CustomProvider: display-name progress, auto tool_choice, no streaming unless enabled, glm thinking off', async () => {
  fakeFetch(answer('hello'));
  const p = new CustomProvider(cfg('glm', { base_url: 'https://api.z.ai/api/paas/v4/', api_key: '' }));
  p.setFunctionExecutor({ execute: async () => ({}), hasFunction: () => true, isMCPTool: () => false, getToolDefinitions: () => [{ name: 't', description: '', input_schema: undefined as any }] });
  const s = sink();
  const r = await p.streamChat({ message: 'q', conversation_history: [], tool_choice: 'required', image_attachments: [{ mime_type: 'image/png', data: 'AA', name: 'i' }] }, s);
  assert.equal(r.text, 'hello');
  assert.equal(calls[0].url, 'https://api.z.ai/api/paas/v4/chat/completions');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].body.tool_choice, 'auto');
  assert.deepEqual(calls[0].body.tools[0].function.parameters, { type: 'object', properties: [] });
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  assert.equal(calls[0].body.stream, undefined);
  assert.deepEqual(calls[0].body.messages.at(-1), { role: 'user', content: 'q' });
  assert.deepEqual(s.events, [
    ['progress', 'Glm: Preparing Glm request...'],
    ['progress', 'Glm: Connecting to Glm API...'],
    ['progress', 'Glm: Response ready.'],
    ['chunk', 'hello'],
  ]);
});

test('CustomProvider streams when the row enables it and skips tools when supports_tools is off', async () => {
  fakeFetch(sse({ choices: [{ delta: { content: 'ok' } }] }));
  const p = new CustomProvider(cfg('gamma4', { base_url: 'http://h:8000/v1', streaming: true, supports_tools: false, display_name: 'Gamma 4' }));
  p.setFunctionExecutor({ execute: async () => ({}), hasFunction: () => true, isMCPTool: () => false, getToolDefinitions: () => [{ name: 't', description: '', input_schema: {} }] });
  const s = sink();
  const r = await p.streamChat({ message: 'q', conversation_history: [] }, s);
  assert.equal(r.text, 'ok');
  assert.equal(calls[0].body.tools, undefined);
  assert.equal(calls[0].body.temperature, 0.7);
  assert.equal(s.events[0][1], 'Gamma 4: Preparing Gamma 4 request...');
});

test('B3 continuation: a trailing tool result with no new message sends no empty user turn', async () => {
  fakeFetch(answer('a'));
  await new KimiProvider(cfg('kimi')).chat({ message: '', conversation_history: [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'run_skill_script', input: {} }] },
    { role: 'tool', tool_call_id: 'c1', name: 'run_skill_script', content: { ok: true } },
  ] });
  const m = calls[0].body.messages;
  assert.deepEqual(m.slice(1), [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_skill_script', arguments: '[]' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}', name: 'run_skill_script' },
  ]);
  assert.match(m[0].content, /^Current date: \d{4}-\d{2}-\d{2} \(\w+\)\.\n\nsys$/);
});
