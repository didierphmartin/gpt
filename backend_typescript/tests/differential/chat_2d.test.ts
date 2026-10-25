/**
 * PHP-vs-TS parity for the Phase 2d chat endpoints (/agent, /verify, /compare) — twin of
 * backend_python/tests/differential/test_chat_2d.py.
 *
 * WRITES (TS-only marking): the three *_live_parity cases call real LLMs (cost) and the backends
 * record usage rows for them, so they are gated with dtest.write. The validation case is read-only.
 */
import { dtest, Client, same, sameKeys, assert } from './harness';
import { sameStream } from './sse';

const MSG = 'Reply with exactly: hello world';

dtest('test_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/agent', { json: { prompt: '', provider: 'claude' } })));
  same(...(await hx.both('POST', '/api/v1/agent', { json: { prompt: 'x' } })));
  same(...(await hx.both('POST', '/api/v1/agent', { json: { prompt: 'x', provider: 'no-such' } })));
  same(...(await hx.both('POST', '/api/v1/verify', { json: { original_message: 'q' } })));
  same(...(await hx.both('POST', '/api/v1/compare', { json: { message: 'q' } })));
});

dtest.write('test_agent_live_parity', async (hx) => {
  const [a, b] = await hx.both('POST', '/api/v1/agent', { json: { prompt: MSG, provider: 'claude' } });
  assert.ok(a.status === 200 && b.status === 200, `${a.status} ${b.status}`);
  const ja = a.json();
  const jb = b.json();
  sameKeys(ja, jb);
  assert.ok(ja.success === true && jb.success === true && ja.provider === jb.provider && ja.model === jb.model);
  assert.deepStrictEqual(Object.keys(jb.usage).sort(), Object.keys(ja.usage).sort());
});

async function stream(client: Client, path: string, body: unknown, token: string): Promise<[number, string, string]> {
  const r = await client.post(path, { json: body, headers: { Authorization: `Bearer ${token}` }, timeoutMs: 180_000 });
  return [r.status, r.headers.get('content-type') ?? '', r.text];
}

dtest.write('test_verify_live_parity', async (hx) => {
  const body = { original_message: MSG, response_text: 'hello world', verifier_provider: 'kimi' };
  const [sa, ca, a] = await stream(hx.php, '/api/v1/verify', body, hx.token);
  const [sb, cb, b] = await stream(hx.ts, '/api/v1/verify', body, hx.token);
  assert.ok(sa === 200 && sb === 200);
  assert.equal(ca.split(';')[0], 'text/event-stream');
  assert.equal(cb.split(';')[0], 'text/event-stream');
  sameStream(a, b, { ignoreResponseKeys: ['text'] });
});

dtest.write('test_compare_live_parity', async (hx) => {
  const body = { message: MSG, compare_provider: 'kimi', tools: [], memory: false, conversation_history: [] };
  const [sa, , a] = await stream(hx.php, '/api/v1/compare', body, hx.token);
  const [sb, , b] = await stream(hx.ts, '/api/v1/compare', body, hx.token);
  assert.ok(sa === 200 && sb === 200);
  sameStream(a, b, { ignoreResponseKeys: ['text'] });
});
