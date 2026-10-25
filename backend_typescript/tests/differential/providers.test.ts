/**
 * Per-provider streaming AND non-streaming parity vs the live PHP backend — twin of
 * backend_python/tests/differential/test_providers.py. Two live LLM calls per backend per
 * configured provider (costs money) — run once per full run. No DB writes beyond what a chat turn
 * itself logs (usage rows), same as Python; not gated on DIFF_ALLOW_WRITES (Python has no gate).
 */
import { dtest, same, sameKeys, assert, Harness } from './harness';
import { normalizeUsage, sameStream } from './sse';

const CANDIDATES = ['openai', 'grok', 'kimi', 'deepseek', 'gemini', 'gamma4', 'glm'];

async function configured(hx: Harness): Promise<Set<string>> {
  const rows = await hx.primaryDb.fetchAll(
    "SELECT provider_key FROM system_llm_settings WHERE enabled = 1 AND api_key IS NOT NULL AND api_key <> ''",
  );
  return new Set(rows.map((r: any) => r.provider_key));
}

/**
 * normalizeUsage, plus floats — a derived per-token cost would otherwise differ run to run for the
 * same reason the token counts do. JS caveat: JSON.parse cannot tell `1.0` from `1`, so an
 * integral float collapses to 'int' (on both sides alike) where Python would say 'float'.
 */
function norm(d: any): any {
  const isFloat = (v: unknown) => typeof v === 'number' && !Number.isInteger(v);
  if (Array.isArray(d)) return d.map(norm);
  if (d && typeof d === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(normalizeUsage(d))) out[k] = isFloat(v) ? 'float' : norm(v);
    return out;
  }
  return isFloat(d) ? 'float' : d;
}

function body(provider: string, streaming = true) {
  return {
    message: 'Reply with exactly: hello world',
    provider,
    tools: [],
    memory: false,
    streaming,
    conversation_history: [],
  };
}

for (const provider of CANDIDATES) {
  dtest(`test_streaming_parity_live[${provider}]`, async (hx, t) => {
    if (!(await configured(hx)).has(provider)) return t.skip(`${provider} not configured in system_llm_settings`);
    const a = await hx.php.post('/api/v1/chat', { json: body(provider), headers: hx.h, timeoutMs: 180_000 });
    const b = await hx.ts.post('/api/v1/chat', { json: body(provider), headers: hx.h, timeoutMs: 180_000 });
    assert.ok(a.status === 200 && b.status === 200, `${a.status} ${b.status}\n${a.text}\n${b.text}`);
    const aCt = (a.headers.get('content-type') ?? '').split(';')[0];
    const bCt = (b.headers.get('content-type') ?? '').split(';')[0];
    assert.ok(aCt === 'text/event-stream' && bCt === 'text/event-stream', `${aCt} ${bCt}`);
    sameStream(a.text, b.text);
  });
}

for (const provider of CANDIDATES) {
  /**
   * Spec §6 asks for streaming AND non-streaming per provider. The generated text and the token
   * counts differ run to run, so parity here is the HTTP status, the JSON key ORDER (the result
   * dict contract), and the shape of `usage` — `normalizeUsage` collapses every int to 'int'.
   *
   * The status is compared, not pinned to 200: a live provider that is rate limited or whose model
   * host is down must produce the SAME status and the SAME humanized `error` string on both
   * backends, and that is exactly the error-path parity this suite otherwise cannot force (the
   * chat body carries no `model` override — see chat.test.ts test_streaming_error_parity_bad_key
   * and tracker row 59).
   */
  dtest(`test_non_streaming_parity_live[${provider}]`, async (hx, t) => {
    if (!(await configured(hx)).has(provider)) return t.skip(`${provider} not configured in system_llm_settings`);
    const a = await hx.php.post('/api/v1/chat', { json: body(provider, false), headers: hx.h, timeoutMs: 180_000 });
    const b = await hx.ts.post('/api/v1/chat', { json: body(provider, false), headers: hx.h, timeoutMs: 180_000 });
    assert.equal(a.status, b.status, `${a.status} ${b.status}\n${a.text}\n${b.text}`);
    const ja = a.json();
    const jb = b.json();
    sameKeys(ja, jb, 'result dict key order');
    for (const k of ['text', 'response_time', 'duration', 'elapsed']) { // generated text + timing fields
      delete ja[k];
      delete jb[k];
    }
    assert.deepStrictEqual(norm(jb), norm(ja));
  });
}

dtest('test_unknown_provider_still_not_found', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/chat', { json: { message: 'x', provider: 'no-such-provider', tools: [], memory: false } })));
});
