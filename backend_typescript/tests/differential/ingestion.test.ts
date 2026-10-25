/**
 * Differential tests for IngestionController — the ten `POST /api/v1/workflows/{id}/ingestion/*`
 * routes (routes.php 357-373). Twin of backend_python/tests/differential/test_ingestion.py.
 *
 * PHP live at DIFF_PHP_BASE, TS in-process. User 3.
 *
 * WORKFLOW_ID = 36 ("Battery News Report") — same workflow workflow_run.test.ts picks (a real,
 * user-3-owned workflow; canUserAccess only needs a real row — the ingestion endpoints never
 * touch the workflow's own graph/steps).
 *
 * Scope:
 *  - Validation cases (auth / missing id / access denied / bad body) for all ten routes: exact
 *    status+JSON (or, for the two SSE routes, exact bare-`data:`-frame sequence) parity, no
 *    external dependency, always run.
 *  - `loader-text` / `splitter-chunks` on `backend/tests/fixtures/loader-sample.pdf`: not gated
 *    on DIFF_INGESTION, but both dispatch through the registered "LangFS loader MCP" server
 *    (mcp_servers id 46, http://127.0.0.1:8077/ for user 3). A comparison of a connection-failure
 *    MESSAGE STRING (PHP curl text vs Node fetch text) is not part of this port's contract, so
 *    they are gated on an explicit reachability probe instead, skipping with the specific reason
 *    when the registered langfs server doesn't answer.
 *  - `store-chunks` / `store-find` / `run-stream` / `run-start` / `run-worker` WITH a store node
 *    (WRITES + need the vector-DB MCP too): gated on env DIFF_INGESTION=1 (Python's gate) AND
 *    DIFF_ALLOW_WRITES=1 (dtest.write). Their pure-loader-only validation/error paths (no store
 *    node configured) don't need that gate and ARE exercised below.
 *
 * WRITES: test_compile_happy_path_parity_code_field — `compile` writes the generated script into
 * each backend's langchain_runner/ directory (data.written), so it is a dtest.write in TS (Python
 * runs it ungated). The store round-trip (DIFF_INGESTION) is the other one.
 */
import path from 'node:path';
import fs from 'node:fs';
import { dtest, same, assert, ALLOW_WRITES, Harness } from './harness';
import { parseDataOnly, sameDataStream } from './sse';

const WORKFLOW_ID = 36;
const FIXTURE_PDF = path.resolve(__dirname, '..', '..', '..', 'backend', 'tests', 'fixtures', 'loader-sample.pdf');
const LANGFS_SERVER_ID = 46;
const LANGFS_URL = 'http://127.0.0.1:8077/';

async function langfsUp(): Promise<boolean> {
  try {
    const r = await fetch(LANGFS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'diff-probe', version: '1' } },
      }),
      signal: AbortSignal.timeout(3000),
    });
    await r.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// JSON-responding routes (plain `both()`/`same()` parity).
const JSON_ROUTES = ['node-code', 'compile', 'save-script', 'loader-text', 'splitter-chunks', 'store-chunks', 'store-find', 'run-start'];
// SSE-responding routes (bare `data:` frames — handled separately below).
const SSE_ROUTES = ['run-stream', 'run-worker'];
const ALL_ROUTES = [...JSON_ROUTES, ...SSE_ROUTES];

const ing = (route: string, id: number = WORKFLOW_ID) => `/api/v1/workflows/${id}/ingestion/${route}`;

// ============================================================================
// Validation parity — no external dependency, always runs
// ============================================================================

for (const route of ALL_ROUTES) {
  // Every route (SSE ones included) hits the shared auth middleware BEFORE the controller runs,
  // so this is a plain JSON 401 on both routes' families alike.
  dtest(`test_unauthenticated_parity[${route}]`, async (hx) => {
    same(...(await hx.both('POST', ing(route), { json: {}, auth: false })));
  });
}

for (const route of JSON_ROUTES) {
  dtest(`test_missing_workflow_id_parity[${route}]`, async (hx) => {
    same(...(await hx.both('POST', ing(route, 0), { json: {} })));
  });
}

for (const route of JSON_ROUTES) {
  // A workflow id that doesn't exist / isn't accessible to user 3.
  dtest(`test_access_denied_parity[${route}]`, async (hx) => {
    same(...(await hx.both('POST', ing(route, 999999999), { json: {} })));
  });
}

dtest('test_node_code_unknown_kind_parity', async (hx) => {
  same(...(await hx.both('POST', ing('node-code'), { json: { node_type: 'bogus', config: {} } })));
});

dtest('test_node_code_happy_path_parity', async (hx) => {
  same(...(await hx.both('POST', ing('node-code'), {
    json: { node_type: 'loader', config: { provider: 'local', path: 'a.pdf', is_dir: false, types: ['pdf'] } },
  })));
});

dtest('test_node_code_stages_happy_path_parity', async (hx) => {
  same(...(await hx.both('POST', ing('node-code'), {
    json: {
      stages: [
        { node_type: 'start' },
        { node_type: 'loader', config: { provider: 'local', path: 'a.pdf' } },
        { node_type: 'splitter', config: { chunk_size: 800, overlap: 100 } },
      ],
    },
  })));
});

dtest.write('test_compile_happy_path_parity_code_field', async (hx) => {
  const [a, b] = await hx.both('POST', ing('compile'), {
    json: {
      loader: { provider: 'local', path: 'a.pdf' },
      splitter: { chunk_size: 500, overlap: 50 },
      vectorstore: { provider: 'qdrant', collection: 'diff_test_docs' },
    },
  });
  // `data.path`/`data.written` depend on each backend's own on-disk langchain_runner/ directory
  // permissions (both target the SAME filename, but "did the write succeed on THIS host/user"
  // isn't part of the ported logic under test) — the generated `code`/`filename` fields (the
  // actual compiler output) are compared exactly.
  assert.ok(a.status === 200 && b.status === 200, `${a.status} ${b.status}\n${a.text}\n${b.text}`);
  const ja = a.json();
  const jb = b.json();
  assert.ok(ja.success === true && jb.success === true);
  assert.equal(jb.data.code, ja.data.code);
  assert.equal(jb.data.filename, ja.data.filename);
});

dtest('test_save_script_empty_code_parity', async (hx) => {
  same(...(await hx.both('POST', ing('save-script'), { json: { code: '' } })));
});

dtest('test_loader_text_empty_path_parity', async (hx) => {
  same(...(await hx.both('POST', ing('loader-text'), { json: { config: { path: '' } } })));
});

dtest('test_splitter_chunks_empty_path_parity', async (hx) => {
  same(...(await hx.both('POST', ing('splitter-chunks'), { json: { loader: { path: '' } } })));
});

dtest('test_store_chunks_no_store_selected_parity', async (hx) => {
  // Never reaches the vector-store MCP dispatch — no DIFF_INGESTION gate needed.
  same(...(await hx.both('POST', ing('store-chunks'), { json: { loader: { path: 'a.pdf' }, vectorstore: {} } })));
});

dtest('test_store_find_empty_query_parity', async (hx) => {
  same(...(await hx.both('POST', ing('store-find'), { json: { query: '' } })));
});

dtest('test_run_start_empty_path_parity', async (hx) => {
  same(...(await hx.both('POST', ing('run-start'), { json: { loader: { path: '' } } })));
});

// ============================================================================
// run-stream / run-worker (SSE) validation parity
// ============================================================================

async function bothStream(hx: Harness, p: string, json: unknown): Promise<[string, string, string, string]> {
  const a = await hx.php.post(p, { json, headers: hx.h });
  const b = await hx.ts.post(p, { json, headers: hx.h });
  return [a.text, b.text, a.headers.get('content-type') ?? '', b.headers.get('content-type') ?? ''];
}

dtest('test_run_stream_validation_parity', async (hx) => {
  for (const p of ['/api/v1/workflows/999999999/ingestion/run-stream', '/api/v1/workflows/0/ingestion/run-stream']) {
    const [a, b, aCt, bCt] = await bothStream(hx, p, {});
    assert.ok(aCt.startsWith('text/event-stream'), `php content-type ${aCt}`);
    assert.ok(bCt.startsWith('text/event-stream'), `ts content-type ${bCt}`);
    sameDataStream(a, b);
    const frames = parseDataOnly(a);
    assert.equal(frames[frames.length - 1], '[DONE]');
  }
});

dtest('test_run_stream_empty_source_parity', async (hx) => {
  const [a, b] = await bothStream(hx, ing('run-stream'), { loader: { path: '' } });
  sameDataStream(a, b);
});

dtest('test_run_worker_invalid_run_id_parity', async (hx) => {
  const [a, b] = await bothStream(hx, ing('run-worker'), { run_id: 'not-hex' });
  sameDataStream(a, b);
});

dtest('test_run_worker_run_not_found_parity', async (hx) => {
  const [a, b] = await bothStream(hx, ing('run-worker'), { run_id: 'a'.repeat(16) }); // well-formed but never created by run-start
  sameDataStream(a, b);
});

// ============================================================================
// loader-text / splitter-chunks on the PDF fixture — gated on the langfs server's actual
// reachability (see header)
// ============================================================================

let langfsProbe: Promise<boolean> | null = null;
async function langfsUnavailable(): Promise<string | null> {
  if (!fs.existsSync(FIXTURE_PDF)) return `fixture PDF not found: ${FIXTURE_PDF}`;
  langfsProbe ??= langfsUp();
  if (!(await langfsProbe)) {
    return `LangFS loader MCP (mcp_servers id ${LANGFS_SERVER_ID}, ${LANGFS_URL}) not reachable ` +
      '-- loader-text/splitter-chunks need it to enumerate/read the fixture PDF';
  }
  return null;
}

dtest('test_loader_text_fixture_pdf_parity', async (hx, t) => {
  const why = await langfsUnavailable();
  if (why) return t.skip(why);
  const body = { config: { provider: 'local', path: FIXTURE_PDF, is_dir: false, types: ['pdf'], storage_mcp_id: String(LANGFS_SERVER_ID) } };
  same(...(await hx.both('POST', ing('loader-text'), { json: body })));
});

dtest('test_splitter_chunks_fixture_pdf_parity', async (hx, t) => {
  const why = await langfsUnavailable();
  if (why) return t.skip(why);
  const body = {
    loader: { provider: 'local', path: FIXTURE_PDF, is_dir: false, types: ['pdf'], storage_mcp_id: String(LANGFS_SERVER_ID) },
    splitter: { chunk_size: 800, overlap: 100 },
  };
  same(...(await hx.both('POST', ing('splitter-chunks'), { json: body })));
});

// ============================================================================
// store-chunks / store-find / run-stream / run-start / run-worker WITH a store node — WRITES,
// gated on env DIFF_INGESTION=1 (and DIFF_ALLOW_WRITES=1)
// ============================================================================

const DIFF_INGESTION = process.env.DIFF_INGESTION === '1';
const INGESTION_REASON =
  'set DIFF_INGESTION=1 to run store-node cases for store-chunks/store-find/run-stream/' +
  'run-start/run-worker (need live langfs + a vector-DB MCP server, and WRITE real vectors ' +
  'to a shared collection)';

dtest.write('test_store_write_and_find_roundtrip_parity', async (_hx, t) => {
  t.skip('DIFF_INGESTION=1 is set, but no differential-safe collection-isolation strategy is wired up ' +
    'yet for these WRITE routes (each call mutates a shared vector-DB collection, and PHP/TS ' +
    'each running it would double-write) -- left as an explicit, documented opt-in gap rather than ' +
    'risking cross-run collection pollution.');
}, { skip: !DIFF_INGESTION ? INGESTION_REASON : !ALLOW_WRITES ? 'writes data; set DIFF_ALLOW_WRITES=1 to run' : undefined });
