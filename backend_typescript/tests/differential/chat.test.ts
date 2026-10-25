/**
 * ChatController `/chat` PHP-vs-TS differential — twin of backend_python/tests/differential/test_chat.py.
 *
 * WRITES (TS-only marking): the two *_live cases call Claude for real (cost) and the backends record
 * usage rows for them, so they are gated with dtest.write; they also skip when no Claude key is in
 * system_llm_settings. The validation case is read-only; the bad-key case is a permanent skip.
 */
import { dtest, Harness, same, sameKeys, sameKeySet, skipCase, assert } from './harness';
import { sameStream, parseSse, payload } from './sse';

const BODY = { message: 'Reply with exactly: hello world', provider: 'claude', tools: [], memory: false, conversation_history: [] };

async function claudeKeyConfigured(hx: Harness): Promise<boolean> {
  const row = await hx.primaryDb.fetchOne("SELECT api_key FROM system_llm_settings WHERE provider_key = 'claude' AND enabled = 1");
  return Boolean(row && row.api_key);
}

dtest('test_validation_parity_no_llm', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/chat', { json: { message: '' } })));
  same(...(await hx.both('POST', '/api/v1/chat', { json: { message: 'x', tools: 'bad' } })));
  same(...(await hx.both('POST', '/api/v1/chat', { json: { message: 'x', provider: 'no-such-provider', tools: [], memory: false } })));
  same(...(await hx.both('POST', '/api/v1/chat', { json: {}, auth: false })));
});

dtest.write('test_regular_chat_parity_live', async (hx, t) => {
  if (!(await claudeKeyConfigured(hx))) return skipCase(t, 'no Claude key in system_llm_settings');
  const [a, b] = await hx.both('POST', '/api/v1/chat', { json: { ...BODY, streaming: false } });
  assert.ok(a.status === 200 && b.status === 200, `${a.text}\n${b.text}`);
  const ja = a.json();
  const jb = b.json();
  sameKeys(ja, jb);
  assert.ok(ja.provider === 'claude' && jb.provider === 'claude');
  sameKeySet(ja.usage, jb.usage);
  assert.ok(String(ja.text).toLowerCase().includes('hello world') && String(jb.text).toLowerCase().includes('hello world'));
});

dtest.write('test_streaming_chat_parity_live', async (hx, t) => {
  if (!(await claudeKeyConfigured(hx))) return skipCase(t, 'no Claude key in system_llm_settings');
  const h = { Authorization: `Bearer ${hx.token}` };
  const ra = await hx.php.post('/api/v1/chat', { json: { ...BODY, streaming: true }, headers: h });
  assert.ok((ra.headers.get('content-type') ?? '').startsWith('text/event-stream'));
  const rb = await hx.ts.post('/api/v1/chat', { json: { ...BODY, streaming: true }, headers: h });
  assert.ok((rb.headers.get('content-type') ?? '').startsWith('text/event-stream'));
  sameStream(ra.text, rb.text);
  const ea = parseSse(ra.text);
  const eb = parseSse(rb.text);
  // first progress string verbatim
  assert.equal(eb.filter(([e]) => e === 'progress')[0]?.[1], ea.filter(([e]) => e === 'progress')[0]?.[1]);
  assert.ok(payload(ea, 'response').success === true && payload(eb, 'response').success === true);
});

/**
 * Provider-error parity needs a provider that FAILS on both backends, and the chat request body has
 * no lever to force one: ChatController::chat / handleStreamingChat never read `$input['model']`
 * (only `agent()` does, ChatController.php:947), nor does the port. Enabling this would take a
 * throwaway `system_llm_settings` row (unroutable base_url or invalid api_key) in the shared
 * CONTEXTS DB the live backends read. Not done: see docs/backend-parity-tracker.md row 59.
 */
dtest('test_streaming_error_parity_bad_key', () => {}, {
  skip: 'needs a throwaway system_llm_settings row pointing at an unroutable host; see tracker row 59',
});
