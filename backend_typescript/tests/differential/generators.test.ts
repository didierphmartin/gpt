/**
 * Differential tests for WorkflowController's code-generator endpoints -- `generate-python`,
 * `generate-adk`, `generate-maf`, `generate-nooa` (WorkflowController.php:240-467) — twin of
 * backend_python/tests/differential/test_generators.py.
 *
 * Enumerates EVERY workflow of user 3 (`SELECT id FROM agent_workflows WHERE user_id = 3`) x each
 * of the 4 generators x each query-string mode (default JSON, `?download=1`, and -- generate-python
 * only -- `?a2a=1`), asserting the response JSON is equal AND the code is byte-equal between the
 * two backends. No LLM calls: generation is pure graph-to-source compilation. Read-only.
 *
 * Timestamp normalisation: PythonEmitHelpers.php:650 stamps every generated module docstring with
 * `date('Y-m-d H:i:s T')` (real wall clock), so PHP's own oracle (GeneratedDocParityTest.php:102)
 * only pattern-matches that line. `normalize` replaces it with a fixed placeholder on both sides --
 * the only normalisation applied.
 *
 * A byte mismatch (outside the Generated: line) means the TS generator has a bug -- fix the
 * generator, never the test or the output.
 */
import { dtest, DIFF_USER_ID, Harness, Resp, assert } from './harness';

/** `both()` with a couple of retries on a transient timeout (large ?download=1 responses). */
async function bothRetrying(hx: Harness, method: string, path: string, retries = 2): Promise<[Resp, Resp]> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await hx.both(method, path);
    } catch (e: any) {
      if (e?.name !== 'TimeoutError' && e?.cause?.name !== 'TimeoutError') throw e;
      last = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw last;
}

const GENERATE_ENDPOINTS: Array<[string, boolean]> = [
  ['generate-python', true], // (path segment, supports ?a2a=1)
  ['generate-adk', false],
  ['generate-maf', false],
  ['generate-nooa', false],
];

// Mirrors GeneratedDocParityTest.php:102's pattern exactly.
const GENERATED_RE = /Generated: {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ by the SynergyAI workflow editor/g;
const GENERATED_PLACEHOLDER = 'Generated:  <normalized-timestamp> by the SynergyAI workflow editor';

function normalize(obj: any): any {
  if (typeof obj === 'string') return obj.replace(GENERATED_RE, GENERATED_PLACEHOLDER);
  if (Array.isArray(obj)) return obj.map(normalize);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = normalize(v);
    return out;
  }
  return obj;
}

/** `same()` with the Generated: timestamp line normalised on both sides. */
function sameNormalized(a: Resp, b: Resp): void {
  assert.equal(a.status, b.status, `status php=${a.status} ts=${b.status}\nphp: ${a.text.slice(0, 2000)}\nts: ${b.text.slice(0, 2000)}`);
  assert.deepStrictEqual(normalize(b.json()), normalize(a.json()));
}

async function workflowIds(hx: Harness): Promise<number[]> {
  const rows = await hx.primaryDb.fetchAll('SELECT id FROM agent_workflows WHERE user_id = ? ORDER BY id', [DIFF_USER_ID]);
  return rows.map((r) => Number(r.id));
}

dtest('test_generate_endpoints_not_found_parity', async (hx) => {
  for (const [path] of GENERATE_ENDPOINTS) sameNormalized(...(await hx.both('GET', `/api/v1/workflows/999999999/${path}`)));
});

dtest('test_generate_endpoints_unauthenticated_parity', async (hx) => {
  for (const [path] of GENERATE_ENDPOINTS) sameNormalized(...(await hx.both('GET', `/api/v1/workflows/1/${path}`, { auth: false })));
});

/** Default JSON mode: {success, data: {filename, code}, status_code}. */
dtest('test_generate_all_workflows_default_mode_parity', async (hx) => {
  const ids = await workflowIds(hx);
  assert.ok(ids.length, 'user 3 has no workflows to enumerate');
  const mismatches: string[] = [];
  for (const wfId of ids) {
    for (const [path] of GENERATE_ENDPOINTS) {
      const [a, b] = await hx.both('GET', `/api/v1/workflows/${wfId}/${path}`);
      try {
        sameNormalized(a, b);
      } catch (e: any) {
        mismatches.push(`${path} wf=${wfId}: ${e.message}`);
      }
    }
  }
  assert.ok(!mismatches.length, mismatches.join('\n'));
});

/** ?download=1: raw text/x-python body, Content-Type + Content-Disposition headers, no JSON envelope. */
dtest('test_generate_all_workflows_download_mode_parity', async (hx) => {
  const ids = await workflowIds(hx);
  assert.ok(ids.length);
  const mismatches: string[] = [];
  for (const wfId of ids) {
    for (const [path] of GENERATE_ENDPOINTS) {
      const [a, b] = await bothRetrying(hx, 'GET', `/api/v1/workflows/${wfId}/${path}?download=1`);
      if (a.status !== b.status) {
        mismatches.push(`${path} wf=${wfId}: status ${a.status} != ${b.status}`);
        continue;
      }
      if (a.status !== 200) continue; // error path -- still JSON, compared by the default-mode test
      for (const hdr of ['content-type', 'content-disposition']) {
        if (a.headers.get(hdr) !== b.headers.get(hdr)) {
          mismatches.push(`${path} wf=${wfId}: ${hdr} ${JSON.stringify(a.headers.get(hdr))} != ${JSON.stringify(b.headers.get(hdr))}`);
        }
      }
      const aNorm = a.text.replace(GENERATED_RE, GENERATED_PLACEHOLDER);
      const bNorm = b.text.replace(GENERATED_RE, GENERATED_PLACEHOLDER);
      if (aNorm !== bNorm) mismatches.push(`${path} wf=${wfId}: byte mismatch in downloaded source (${a.bytes.length} vs ${b.bytes.length} bytes)`);
    }
  }
  assert.ok(!mismatches.length, mismatches.join('\n'));
});

/** ?a2a=1 (generate-python only): always JSON {success, data: {root, files: [{path, code}, ...]}}. */
dtest('test_generate_python_all_workflows_a2a_mode_parity', async (hx) => {
  const ids = await workflowIds(hx);
  assert.ok(ids.length);
  const mismatches: string[] = [];
  for (const wfId of ids) {
    const [a, b] = await hx.both('GET', `/api/v1/workflows/${wfId}/generate-python?a2a=1`);
    try {
      sameNormalized(a, b);
    } catch (e: any) {
      mismatches.push(`generate-python a2a wf=${wfId}: ${e.message}`);
    }
  }
  assert.ok(!mismatches.length, mismatches.join('\n'));
});
